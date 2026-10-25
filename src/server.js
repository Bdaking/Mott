const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const connect = require('./db');
const { ensureDb } = require('./db');
const { HttpError } = require('./utils/errors');

const app = express();
app.set('trust proxy', 1);
app.set('etag', false); // no 304 responses: some phones/clients treat a body-less 304 as an error ("Something went wrong")
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // *.vimeo.com: the admin page uploads videos straight to Vimeo (tus)
      connectSrc: ["'self'", 'https://*.vimeo.com'],
      imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com', 'https://i.vimeocdn.com'],
      mediaSrc: ["'self'", 'https://res.cloudinary.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      // Helmet adds "upgrade-insecure-requests" by default. On plain http://<LAN-IP>:4000 that makes the browser
      // rewrite /admin/app.js to https:// and the admin page stays blank. Only use it behind real HTTPS.
      upgradeInsecureRequests: config.isProd ? [] : null,
    },
  },
  strictTransportSecurity: config.isProd,
}));
app.use(cors({ origin: config.corsOrigins.length ? config.corsOrigins : false }));
app.use(morgan(config.isProd ? 'combined' : 'dev', { skip: (req) => req.path.includes('/stream/') }));

app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ ok: true, db: require('mongoose').connection.readyState === 1 }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', ensureDb); // every API call first makes sure MongoDB is connected (503 with a clear message if not)
// Serverless has no timers: an external pinger / Vercel Cron can call this to refresh Vimeo processing status.
app.get('/api/cron/poll', async (req, res) => {
  if (config.cronSecret && req.headers.authorization !== `Bearer ${config.cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
  await require('./services/processingPoller').runOnce().catch((e) => console.error('cron poll', e.message));
  res.json({ ok: true });
});
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40 }), require('./routes/auth'));
app.use('/api/me', require('./routes/me'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/billing'));
app.use('/api', require('./routes/playback'));
app.use('/api', require('./routes/catalog'));

app.use('/admin', express.static(path.join(__dirname, '../web/admin')));
app.get('/', (req, res) => res.redirect('/admin/'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.name === 'MulterError') return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 100 MB)' : err.message, code: 'UPLOAD' });
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body', code: 'VALIDATION' });
  if (/^Mongo(Server|Network|Parse)?(Selection)?(Timeout)?Error|MongooseError/.test(err.name) && !err.code) {
    console.error('Database error:', err.message);
    return res.status(503).json({ error: 'The server cannot reach its database right now. Please try again in a moment.', code: 'DB_UNAVAILABLE' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (!require('./services/vimeo').configured()) console.warn('WARNING: VIMEO_ACCESS_TOKEN is not set. Video upload and playback are disabled.');
if (!require('./services/cloudinary').configured()) console.warn('WARNING: CLOUDINARY_* is not set. Image uploads are disabled.');
if (config.payments.enabled) console.warn('NOTICE: payments run on the built-in DUMMY gateway (test cards only, no real money).');
if (config.otp.devMode) console.warn('WARNING: OTP_DEV_MODE is on. One-time codes are printed here instead of being sent.');

// Used by Vercel (serverless): the platform calls the exported app, there is no listen() and no setInterval.
module.exports = app;

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.message ? e.message : e));

if (require.main === module) {
  const start = () => connect().then(async () => {
    await require('./services/subscriptions').ensurePlans();
    require('./services/processingPoller').start();
    app.listen(config.port, '0.0.0.0', () => {
      console.log(`OTT API listening on port ${config.port}`);
      console.log(`  Admin panel (this computer): http://localhost:${config.port}/admin`);
      const nets = Object.values(require('os').networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal);
      for (const n of nets) console.log(`  From your phone (same Wi-Fi):  http://${n.address}:${config.port}/health   <- open this in the phone browser to test the connection`);
    });
  });
  // If Atlas is unreachable at boot (Wi-Fi blip, DNS), keep retrying instead of exiting.
  const boot = (attempt = 1) => start().catch((e) => {
    console.error(`Startup failed (attempt ${attempt}): ${e.message}`);
    if (/ENOTFOUND|ETIMEOUT|ECONNREFUSED|ServerSelection|querySrv/i.test(e.message) && attempt < 20) {
      console.error('  -> Cannot reach MongoDB. Check internet / Atlas Network Access / try DNS 8.8.8.8. Retrying in 5 s...');
      return setTimeout(() => boot(attempt + 1), 5000);
    }
    process.exit(1);
  });
  boot();
}
