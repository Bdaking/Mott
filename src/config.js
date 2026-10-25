require('dotenv').config();
const e = process.env;
const need = (n) => {
  if (!e[n]) throw new Error(`Missing required environment variable ${n}. Copy .env.example to .env and fill it in.`);
  return e[n];
};
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const port = Number(e.PORT) || 4000;
const isProd = e.NODE_ENV === 'production';

const config = {
  port,
  isProd,
  mongoUri: need('MONGODB_URI'),
  jwtSecret: need('JWT_SECRET'),
  jwtRefreshSecret: need('JWT_REFRESH_SECRET'),
  adminJwtSecret: need('ADMIN_JWT_SECRET'),
  publicUrl: (e.PUBLIC_API_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  corsOrigins: (e.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

  // One account = one active device. A second device is refused while the first one is "active",
  // i.e. not logged out and seen within SESSION_IDLE_MINUTES.
  session: {
    accessTtl: e.ACCESS_TOKEN_TTL || '15m',
    refreshDays: num(e.REFRESH_TOKEN_DAYS, 30),
    idleMinutes: num(e.SESSION_IDLE_MINUTES, 30),
    playerBeatSeconds: 20,
    playerStaleSeconds: 90,
  },
  otp: {
    ttlSeconds: num(e.OTP_TTL_SECONDS, 300),
    resendSeconds: num(e.OTP_RESEND_SECONDS, 30),
    maxAttempts: num(e.OTP_MAX_ATTEMPTS, 5),
    maxPerHour: num(e.OTP_MAX_PER_HOUR, 5),
    defaultCountryCode: e.DEFAULT_COUNTRY_CODE || '+91',
    devMode: e.OTP_DEV_MODE === 'true' && !isProd, // prints the OTP in the server console instead of sending it
  },
  smtp: { host: e.SMTP_HOST, port: num(e.SMTP_PORT, 587), user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.SMTP_FROM || e.SMTP_USER },
  // Optional HTTPS email API (recommended on Vercel: faster and more reliable than SMTP). https://resend.com
  resend: { apiKey: e.RESEND_API_KEY, from: e.RESEND_FROM || 'Cinema <onboarding@resend.dev>' },
  sms: {
    twilioSid: e.TWILIO_ACCOUNT_SID, twilioToken: e.TWILIO_AUTH_TOKEN, twilioFrom: e.TWILIO_FROM,
    twilioVerifySid: e.TWILIO_VERIFY_SERVICE_SID, // optional: Twilio Verify (works for India without buying a sender number)
    fast2smsKey: e.FAST2SMS_API_KEY,               // optional: India-only SMS (OTP route)
  },
  cronSecret: e.CRON_SECRET || '',

  vimeo: {
    accessToken: e.VIMEO_ACCESS_TOKEN,
    clientId: e.VIMEO_CLIENT_ID,
    clientSecret: e.VIMEO_CLIENT_SECRET,
    privacyView: e.VIMEO_PRIVACY_VIEW || 'unlisted', // 'disable' (Hidden from Vimeo) needs a Vimeo Pro/Business plan
    embedDomain: e.VIMEO_EMBED_DOMAIN || '',         // host of PUBLIC_API_URL by default
  },
  cloudinary: {
    cloudName: e.CLOUDINARY_CLOUD_NAME,
    apiKey: e.CLOUDINARY_API_KEY,
    apiSecret: e.CLOUDINARY_API_SECRET,
    folder: e.CLOUDINARY_FOLDER || 'cinema',
  },
  // Payments. 'dummy' = built-in fake gateway that accepts ONLY documented test cards (no money moves).
  // In production the dummy gateway stays off unless you explicitly set PAYMENTS_ALLOW_DUMMY_IN_PRODUCTION=true.
  payments: {
    mode: (e.PAYMENTS_MODE || 'dummy').toLowerCase(),
    allowDummyInProduction: e.PAYMENTS_ALLOW_DUMMY_IN_PRODUCTION === 'true',
    latencyMs: num(e.PAYMENTS_DUMMY_LATENCY_MS, 1200),
  },
  // How the player delivers video.
  //   'embed' = Vimeo's own player, quality capped through its JavaScript API (any Vimeo plan; iOS's system player may ignore the cap).
  //   'files' = our own <video> page fed ONLY the MP4 renditions the plan allows (strict on iOS and Android; needs Vimeo Pro/Business and
  //             the `video_files` token scope).
  //   'auto'  = iPhones/iPads use 'files', everything else uses 'embed' (recommended once your Vimeo plan supports files).
  // PLAYER_STRICT=true: if 'files' is wanted but Vimeo gives no files, playback is refused instead of silently ignoring the plan's quality cap.
  playerDelivery: (e.PLAYER_DELIVERY || 'embed').toLowerCase(),
  playerStrict: e.PLAYER_STRICT === 'true',
};

config.payments.enabled = config.payments.mode === 'dummy' && (!isProd || config.payments.allowDummyInProduction);

if (isProd) {
  for (const [n, v] of [['JWT_SECRET', config.jwtSecret], ['JWT_REFRESH_SECRET', config.jwtRefreshSecret], ['ADMIN_JWT_SECRET', config.adminJwtSecret]]) {
    if (v.length < 32 || /change-me/i.test(v)) throw new Error(`${n} must be a long random value in production.`);
  }
}
module.exports = config;
