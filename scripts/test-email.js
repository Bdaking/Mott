// Sends ONE real sign-in email so you can confirm real (non-test-mode) login works.
//   npm run test:email -- you@gmail.com
require('dotenv').config();
const config = require('../src/config');
const notify = require('../src/services/notify');
(async () => {
  const to = process.argv[2];
  if (!to || !to.includes('@')) throw new Error('Usage: npm run test:email -- you@example.com');
  if (!notify.emailConfigured()) throw new Error('SMTP_HOST / SMTP_USER / SMTP_PASS are not all set in backend/.env');
  console.log(`Checking SMTP login (${config.smtp.host}:${config.smtp.port} as ${config.smtp.user}) ...`);
  await notify.verifyEmail();
  console.log('SMTP login OK. Sending a test email ...');
  const wasDev = config.otp.devMode; config.otp.devMode = false;
  await notify.sendOtp(to.toLowerCase(), '123456');
  config.otp.devMode = wasDev;
  console.log(`Sent. Check the inbox (and spam) of ${to}. The code in it is 123456 (test only).`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); if (/Invalid login|535|Username and Password/i.test(e.message)) console.error('Gmail needs a 16-letter APP PASSWORD (Google Account > Security > 2-Step Verification > App passwords), not your normal password.'); process.exit(1); });
