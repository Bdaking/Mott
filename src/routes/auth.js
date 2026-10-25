// Passwordless sign-in: one-time code to an email or mobile number (same flow as the app's login screens).
const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const config = require('../config');
const { User, OtpCode } = require('../models');
const validate = require('../middleware/validate');
const { requireUser } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/errors');
const { sendOtp, channels } = require('../services/notify');
const sessions = require('../services/sessions');

const userDto = (u) => ({ id: String(u._id), name: u.name || '', email: u.email || null, phone: u.phone || null });

// "name@x.com" -> email; "98765 43210" / "+9198..." -> E.164 phone.
function normalise(raw) {
  const v = String(raw).trim();
  if (v.includes('@')) {
    const email = v.toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120) throw new HttpError(400, 'Enter a valid email address', 'VALIDATION');
    return email;
  }
  let d = v.replace(/[\s()-]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (!d.startsWith('+')) d = config.otp.defaultCountryCode + d.replace(/^0+/, '');
  if (!/^\+[1-9]\d{7,14}$/.test(d)) throw new HttpError(400, 'Enter a valid mobile number', 'VALIDATION');
  if (d.startsWith('+91') && !/^\+91[6-9]\d{9}$/.test(d)) throw new HttpError(400, 'Enter a valid 10-digit Indian mobile number', 'VALIDATION');
  return d;
}
const hashCode = (identifier, code) => crypto.createHmac('sha256', config.jwtSecret).update(`${identifier}|${code}`).digest('hex');
const safeEqual = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

const ipLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });
router.use(ipLimit);

// Tells the app which login methods work right now.
router.get('/config', (req, res) => res.json(channels()));

router.post('/otp/request', validate(z.object({ identifier: z.string().min(3).max(120) })), asyncHandler(async (req, res) => {
  const identifier = normalise(req.body.identifier);
  const prev = await OtpCode.findOne({ identifier }).sort({ sentAt: -1 });
  if (prev) {
    const wait = Math.ceil((prev.sentAt.getTime() + config.otp.resendSeconds * 1000 - Date.now()) / 1000);
    if (wait > 0) throw new HttpError(429, `Please wait ${wait}s before requesting another code`, 'OTP_WAIT');
  }
  // Hourly cap per identifier (kept in a rolling counter on the latest doc to avoid another collection).
  const sentLastHour = await OtpCode.countDocuments({ identifier, sentAt: { $gt: new Date(Date.now() - 3600000) } });
  if (sentLastHour >= config.otp.maxPerHour) throw new HttpError(429, 'Too many codes requested. Try again in an hour.', 'OTP_LIMIT');

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  // Fail BEFORE touching the database when this channel is not set up (clear message instead of "Something went wrong").
  const ch = channels();
  if (identifier.includes('@') ? !ch.email : !ch.sms) {
    throw new HttpError(503, identifier.includes('@') ? 'Email sign-in is not set up on the server yet.' : 'Mobile-number login is not available yet. Please sign in with your email.', 'NOT_CONFIGURED');
  }
  const doc = await OtpCode.create({ identifier, codeHash: hashCode(identifier, code), expiresAt: new Date(Date.now() + config.otp.ttlSeconds * 1000) });
  try { await sendOtp(identifier, code); } catch (err) { await OtpCode.deleteOne({ _id: doc._id }); throw err; } // the user's previous (still valid) code stays usable
  // Only the newest code is valid: expire all older ones once the new one has really been delivered.
  await OtpCode.updateMany({ identifier, _id: { $ne: doc._id }, expiresAt: { $gt: new Date() } }, { expiresAt: new Date() });
  // devCode is only sent while OTP_DEV_MODE=true (never in production): lets you test on a phone without reading the server console.
  res.json({ ok: true, channel: identifier.includes('@') ? 'email' : 'sms', resendInSec: config.otp.resendSeconds, expiresInSec: config.otp.ttlSeconds, ...(config.otp.devMode ? { devCode: code } : {}) });
}));

router.post('/otp/verify', validate(z.object({
  identifier: z.string().min(3).max(120),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  deviceId: z.string().min(16).max(100),
  deviceName: z.string().max(80).optional(),
  platform: z.string().max(20).optional(),
  replaceOther: z.boolean().optional(), // "sign out my other device and continue here"
})), asyncHandler(async (req, res) => {
  const identifier = normalise(req.body.identifier);
  const otp = await OtpCode.findOne({ identifier, expiresAt: { $gt: new Date() } }).sort({ sentAt: -1 });
  if (!otp) throw new HttpError(400, 'That code has expired. Request a new one.', 'OTP_EXPIRED');
  if (otp.attempts >= config.otp.maxAttempts) throw new HttpError(429, 'Too many wrong attempts. Request a new code.', 'OTP_LOCKED');
  if (!safeEqual(otp.codeHash, hashCode(identifier, req.body.code))) {
    await OtpCode.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
    throw new HttpError(400, 'Incorrect code. Please try again.', 'OTP_INVALID');
  }

  const field = identifier.includes('@') ? 'email' : 'phone';
  let user = await User.findOne({ [field]: identifier });
  if (user && !user.isActive) throw new HttpError(403, 'This account has been blocked. Please contact support.', 'BLOCKED');

  // One-device rule: refused (code kept valid) while the account is active on a different device.
  const created = !user;
  if (!user) user = new User({ [field]: identifier });
  if (created) await user.validate();
  const s = await sessions.startSession(user, { deviceId: req.body.deviceId, deviceName: req.body.deviceName, platform: req.body.platform, ip: req.ip, replaceOther: req.body.replaceOther === true });
  if (created) {
    try { await user.save(); } catch (err) {
      await sessions.revoke(s.session._id, 'logout');
      if (err.code === 11000) throw new HttpError(409, 'Please try again', 'RETRY');
      throw err;
    }
  }
  await OtpCode.deleteMany({ identifier });
  res.json({ accessToken: s.accessToken, refreshToken: s.refreshToken, user: userDto(user), newUser: created });
}));

router.post('/refresh', validate(z.object({ refreshToken: z.string().min(20), deviceId: z.string().min(16).max(100) })), asyncHandler(async (req, res) => {
  const r = await sessions.refreshSession(req.body.refreshToken, req.body.deviceId);
  const user = await User.findById(r.userId);
  if (!user || !user.isActive) { await sessions.revokeAllForUser(r.userId, 'blocked'); throw new HttpError(403, 'This account has been blocked. Please contact support.', 'BLOCKED'); }
  res.json({ accessToken: r.accessToken, refreshToken: r.refreshToken });
}));

router.post('/logout', requireUser, asyncHandler(async (req, res) => {
  await sessions.revoke(req.session._id, 'logout');
  res.json({ ok: true });
}));

router.get('/me', requireUser, asyncHandler(async (req, res) => {
  const sub = await require('../services/subscriptions').getActive(req.user._id);
  res.json({ user: userDto(req.user), device: { name: req.session.deviceName, platform: req.session.platform, since: req.session.createdAt }, subscription: require('../services/subscriptions').subDto(sub) });
}));

module.exports = router;
