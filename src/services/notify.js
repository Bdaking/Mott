// Delivers one-time codes by email (Resend API or SMTP) or SMS (Twilio / Twilio Verify / Fast2SMS).
// In OTP_DEV_MODE the code is printed to the server console and returned to the app instead.
const config = require('../config');
const { HttpError } = require('../utils/errors');

const resendConfigured = () => Boolean(config.resend.apiKey);
const smtpConfigured = () => Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);
const emailConfigured = () => resendConfigured() || smtpConfigured();
const twilioConfigured = () => Boolean(config.sms.twilioSid && config.sms.twilioToken && (config.sms.twilioFrom || config.sms.twilioVerifySid));
const fast2smsConfigured = () => Boolean(config.sms.fast2smsKey);
const smsConfigured = () => twilioConfigured() || fast2smsConfigured();

// Short fetch with a hard timeout so a slow provider can never hang the app.
async function timedFetch(url, opts = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

/* ---------------- email ---------------- */
let transporter;
function mailer() {
  if (!smtpConfigured()) throw new HttpError(503, 'Email sending is not configured on the server', 'NOT_CONFIGURED');
  if (!transporter) {
    const { host, port, user, pass } = config.smtp;
    transporter = require('nodemailer').createTransport({
      host, port, secure: port === 465,
      // Gmail app passwords are shown as "abcd efgh ijkl mnop"; the spaces are not part of the password.
      auth: { user, pass: /gmail/i.test(host) ? String(pass).replace(/\s+/g, '') : pass },
      pool: true, maxConnections: 2, maxMessages: 50,   // keep the TLS connection open: the 2nd+ email is much faster than the 1st
      family: 4,                                         // force IPv4: avoids the multi-second IPv6 fallback on Windows
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, dnsTimeout: 8000,
    });
  }
  return transporter;
}
const verifyEmail = () => (resendConfigured() ? Promise.resolve(true) : mailer().verify()); // used by the admin System check

const emailParts = (code) => {
  const mins = Math.round(config.otp.ttlSeconds / 60);
  return {
    subject: `${code} is your Cinema sign-in code`,
    text: `Your Cinema sign-in code is ${code}.\nIt expires in ${mins} minutes. Do not share it with anyone.\nIf you did not ask for this, you can ignore this email.`,
    html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:420px;margin:auto;padding:24px;background:#0F0F14;color:#F1EEE8;border-radius:14px">
      <div style="letter-spacing:4px;font-weight:800;color:#F5B83D">CINEMA</div>
      <p style="margin:18px 0 6px">Your sign-in code</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#fff">${code}</div>
      <p style="color:#8D8B98;font-size:13px;margin-top:18px">It expires in ${mins} minutes. Never share this code. If you did not ask for it, ignore this email.</p></div>`,
  };
};

async function sendEmailResend(to, code) {
  const res = await timedFetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resend.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.resend.from, to: [to], ...emailParts(code) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.error(`Resend email failed (${res.status}): ${body.message || JSON.stringify(body)}`);
    // Without a verified domain Resend only delivers to the account owner's own address.
    if (res.status === 403 || res.status === 422) throw new HttpError(502, 'Email could not be sent. The sender domain is not verified yet (Resend test mode only emails the account owner).', 'OTP_SEND_FAILED');
    throw new Error(`Resend ${res.status}`);
  }
}
async function sendEmailSmtp(to, code) {
  await mailer().sendMail({ from: config.smtp.from ? `"Cinema" <${config.smtp.from}>` : undefined, to, ...emailParts(code) });
}
async function sendEmail(to, code) {
  if (!emailConfigured()) throw new HttpError(503, 'Email sign-in is not set up on the server yet.', 'NOT_CONFIGURED');
  // Resend first (HTTPS, fast); if it fails and SMTP is also configured, fall back to SMTP.
  if (resendConfigured()) {
    try { return await sendEmailResend(to, code); }
    catch (err) { if (!smtpConfigured()) throw err; console.error('Resend failed, falling back to SMTP:', err.message); }
  }
  return sendEmailSmtp(to, code);
}

/* ---------------- SMS ---------------- */
async function sendSmsTwilio(to, code) {
  const { twilioSid, twilioToken, twilioFrom } = config.sms;
  const res = await timedFetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: twilioFrom, Body: `${code} is your Cinema sign-in code. It expires in ${Math.round(config.otp.ttlSeconds / 60)} minutes. Do not share it.` }),
  });
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  console.error(`Twilio SMS failed (${res.status}, code ${body.code}): ${body.message}`);
  if (body.code === 21608) throw new HttpError(502, 'SMS could not be sent: this Twilio trial account can only text verified numbers. Sign in with your email instead, or verify the number in Twilio.', 'SMS_FAILED');
  if (body.code === 21211 || body.code === 21614) throw new HttpError(400, 'That mobile number is not valid.', 'VALIDATION');
  if (body.code === 21408) throw new HttpError(502, 'SMS to this country is not enabled on the Twilio account (Twilio > Messaging > Geo permissions).', 'SMS_FAILED');
  throw new Error(`Twilio ${res.status}/${body.code}`);
}

// India: Fast2SMS "otp" route sends "Your OTP is NNNNNN" and needs no DLT template for testing (small wallet recharge required).
async function sendSmsFast2sms(to, code) {
  const national = to.replace(/^\+91/, '');
  if (!/^[6-9]\d{9}$/.test(national) || !to.startsWith('+91')) throw new HttpError(400, 'Fast2SMS only sends to Indian mobile numbers. Sign in with email instead.', 'VALIDATION');
  const url = `https://www.fast2sms.com/dev/bulkV2?authorization=${encodeURIComponent(config.sms.fast2smsKey)}&route=otp&variables_values=${code}&flash=0&numbers=${national}`;
  const res = await timedFetch(url, { method: 'GET', headers: { 'cache-control': 'no-cache' } });
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.return === true) return;
  console.error(`Fast2SMS failed (${res.status}): ${body.message || JSON.stringify(body)}`);
  throw new Error(`Fast2SMS ${res.status}`);
}

async function sendSms(to, code) {
  if (!smsConfigured()) throw new HttpError(503, 'Mobile-number login is not available yet. Please sign in with your email.', 'NOT_CONFIGURED');
  let lastErr;
  // Indian numbers: try Fast2SMS first if configured (cheapest), then Twilio. Others: Twilio.
  const order = [];
  if (fast2smsConfigured() && to.startsWith('+91')) order.push(sendSmsFast2sms);
  if (twilioConfigured() && config.sms.twilioFrom) order.push(sendSmsTwilio);
  for (const fn of order) {
    try { return await fn(to, code); } catch (err) { lastErr = err; if (!(err instanceof HttpError) || err.code === 'SMS_FAILED') console.error('SMS provider failed:', err.message); }
  }
  throw lastErr || new HttpError(503, 'Mobile-number login is not available for this number. Please sign in with your email.', 'NOT_CONFIGURED');
}

async function sendOtp(identifier, code) {
  const isEmail = identifier.includes('@');
  if (config.otp.devMode) { console.log(`[OTP_DEV_MODE] code for ${identifier}: ${code}`); return; }
  const attempt = () => (isEmail ? sendEmail(identifier, code) : sendSms(identifier, code));
  try {
    try { await attempt(); }
    catch (err) {
      if (err instanceof HttpError) throw err;
      console.error(`OTP delivery attempt 1 failed (${err.message}); retrying once...`);
      await attempt(); // one automatic retry for transient network errors (the most common cause of "works sometimes")
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('OTP delivery failed:', err.message);
    throw new HttpError(502, isEmail ? 'Could not send the email. Please try again in a moment.' : 'Could not send the SMS. Please try again, or sign in with your email.', 'OTP_SEND_FAILED');
  }
}

// Which login methods work right now (the app reads this to guide the user instead of showing "Something went wrong").
const channels = () => ({ email: config.otp.devMode || emailConfigured(), sms: config.otp.devMode || smsConfigured(), devMode: config.otp.devMode });

module.exports = { sendOtp, emailConfigured, smsConfigured, verifyEmail, channels, twilioConfigured, fast2smsConfigured, resendConfigured, smtpConfigured };
