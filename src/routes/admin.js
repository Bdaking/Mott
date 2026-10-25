const router = require('express').Router();
const os = require('os');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const mongoose = require('mongoose');
const config = require('../config');
const { Admin, User, Movie, WatchHistory, Watchlist, Session, Plan, Subscription, Payment } = require('../models');
const { requireAdmin, signAdminToken } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { asyncHandler, HttpError } = require('../utils/errors');
const sessions = require('../services/sessions');
const subs = require('../services/subscriptions');
const notify = require('../services/notify');
const { MOVIE_LEVELS } = require('../utils/constants');
const vimeo = require('../services/vimeo');
const cloud = require('../services/cloudinary');
const { cleanUrl } = require('../services/serializers');

const isId = (id) => /^[a-f\d]{24}$/i.test(id);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ---- login (public) ---- */
router.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20 }),
  validate(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const admin = await Admin.findOne({ email: req.body.email });
    if (!admin || !(await bcrypt.compare(req.body.password, admin.passwordHash))) throw new HttpError(401, 'Wrong email or password');
    res.json({ token: signAdminToken(admin), admin: { name: admin.name, email: admin.email } });
  }));

router.use(requireAdmin);

/* ---- dashboard ---- */
router.get('/stats', asyncHandler(async (req, res) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [users, movies, published, processing, failed, activeSubs, byPlan, revAll, revMonth] = await Promise.all([
    User.countDocuments(), Movie.countDocuments(), Movie.countDocuments({ published: true }),
    Movie.countDocuments({ 'processing.status': { $in: ['uploading', 'processing'] } }),
    Movie.countDocuments({ 'processing.status': 'failed' }),
    Subscription.countDocuments({ expiresAt: { $gt: now } }),
    Subscription.aggregate([{ $match: { expiresAt: { $gt: now } } }, { $group: { _id: '$plan', n: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { status: 'succeeded', method: { $ne: 'admin_grant' } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $match: { status: 'succeeded', method: { $ne: 'admin_grant' }, paidAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
  ]);
  const plans = await Plan.find().sort({ rank: 1 });
  const counts = new Map(byPlan.map((x) => [String(x._id), x.n]));
  res.json({
    users, movies, published, processing, failed, activeSubs,
    revenue: revAll[0]?.total || 0, revenueMonth: revMonth[0]?.total || 0,
    byPlan: plans.map((p) => ({ key: p.key, name: p.name, maxQuality: p.maxQuality, subscribers: counts.get(String(p._id)) || 0 })),
  });
}));

/* ---- system check: are the database, Vimeo and Cloudinary reachable with the keys in .env? ---- */
router.get('/diagnostics', asyncHandler(async (req, res) => {
  const out = {
    server: { publicUrl: config.publicUrl, nodeEnv: process.env.NODE_ENV || 'development', otpDevMode: config.otp.devMode },
    payments: { enabled: config.payments.enabled, mode: config.payments.mode },
    player: { delivery: config.playerDelivery, strict: config.playerStrict },
    login: { devMode: config.otp.devMode, email: { configured: notify.emailConfigured(), ok: false }, sms: { configured: notify.smsConfigured() } },
    database: { ok: mongoose.connection.readyState === 1 },
    vimeo: { configured: vimeo.configured(), ok: false },
    cloudinary: { configured: cloud.configured(), ok: false },
  };
  await Promise.all([
    vimeo.ping().then((r) => Object.assign(out.vimeo, { ok: true }, r)).catch((e) => { out.vimeo.error = e.message; }),
    cloud.ping().then(() => { out.cloudinary.ok = true; }).catch((e) => { out.cloudinary.error = e.message; }),
    notify.emailConfigured() ? notify.verifyEmail().then(() => { out.login.email.ok = true; }).catch((e) => { out.login.email.error = e.message; }) : null,
  ]);
  res.json(out);
}));

/* ---- movies ---- */
const movieBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  year: z.number().int().min(1900).max(2100).nullable(),
  durationMin: z.number().int().min(1).max(1000).nullable(),
  genres: z.array(z.string().trim().min(1).max(40)).max(10),
  language: z.string().trim().max(40),
  certificate: z.string().trim().max(10),
  director: z.string().trim().max(100),
  cast: z.array(z.string().trim().min(1).max(60)).max(30),
  featured: z.boolean(),
  minPlanRank: z.number().int().min(0).max(3),
}).partial().required({ title: true });

const adminMovie = (m) => ({
  id: String(m._id), title: m.title, description: m.description, year: m.year ?? null, durationMin: m.durationMin ?? null,
  genres: m.genres, language: m.language, certificate: m.certificate, director: m.director, cast: m.cast,
  featured: m.featured, published: m.published, minPlanRank: m.minPlanRank ?? 1,
  posterUrl: cleanUrl(m.poster?.url), backdropUrl: cleanUrl(m.backdrop?.url), trailerUrl: m.trailer?.url || null,
  posterPublicId: m.poster?.publicId || null, backdropPublicId: m.backdrop?.publicId || null, trailerPublicId: m.trailer?.publicId || null,
  vimeoId: m.vimeo?.videoId || null, vimeoLink: m.vimeo?.link || null, // admin only
  processing: m.processing, createdAt: m.createdAt,
});
const findMovie = async (id) => {
  const m = isId(id) ? await Movie.findById(id) : null;
  if (!m) throw new HttpError(404, 'Movie not found');
  return m;
};

router.get('/movies', asyncHandler(async (req, res) => {
  require('../services/processingPoller').runOnce().catch(() => {}); // serverless: refresh Vimeo status whenever the admin looks at the list
  res.json((await Movie.find().sort({ createdAt: -1 })).map(adminMovie));
}));
router.get('/movies/:id', asyncHandler(async (req, res) => res.json(adminMovie(await refreshVimeo(await findMovie(req.params.id))))));

router.post('/movies', validate(movieBody), asyncHandler(async (req, res) => {
  res.status(201).json(adminMovie(await Movie.create(req.body)));
}));
router.put('/movies/:id', validate(movieBody), asyncHandler(async (req, res) => {
  const m = await findMovie(req.params.id);
  Object.assign(m, req.body);
  await m.save();
  res.json(adminMovie(m));
}));

router.patch('/movies/:id/publish', validate(z.object({ published: z.boolean() })), asyncHandler(async (req, res) => {
  const m = await refreshVimeo(await findMovie(req.params.id));
  if (req.body.published && (m.processing.status !== 'completed' || !m.vimeo?.videoId)) throw new HttpError(400, 'The video is not ready yet. Wait until Vimeo shows Completed.');
  m.published = req.body.published;
  await m.save();
  res.json(adminMovie(m));
}));

router.delete('/movies/:id', asyncHandler(async (req, res) => {
  const m = await findMovie(req.params.id);
  if (m.vimeo?.videoId) await vimeo.deleteVideo(m.vimeo.videoId);
  await cloud.destroyFolder(m.id);
  await Promise.all([Movie.deleteOne({ _id: m._id }), WatchHistory.deleteMany({ movie: m._id }), Watchlist.deleteMany({ movie: m._id })]);
  res.json({ ok: true });
}));

/* ---- images + trailer -> Cloudinary (multipart through this server; the Cloudinary secret never reaches a browser) ---- */
const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(file.mimetype)),
});
const FIELD = { poster: 'poster', backdrop: 'backdrop', trailer: 'trailer' };
router.post('/movies/:id/media/:kind', upload.single('file'), asyncHandler(async (req, res) => {
  const kind = FIELD[req.params.kind];
  const fs = require('fs');
  const cleanup = () => req.file && fs.unlink(req.file.path, () => {});
  try {
    const m = await findMovie(req.params.id);
    if (!kind) throw new HttpError(400, 'Unknown media kind');
    if (!req.file) throw new HttpError(400, 'Choose a JPG, PNG or WebP image (or an MP4 for the trailer)');
    const isVideo = req.file.mimetype === 'video/mp4';
    if ((kind === 'trailer') !== isVideo) throw new HttpError(400, 'Use JPG/PNG/WebP for images and MP4 for trailers');
    if (!isVideo && req.file.size > 10 * 1024 * 1024) throw new HttpError(400, 'Images must be under 10 MB');
    // Copy the old id as a plain string BEFORE assigning: m[kind] is a live Mongoose reference, so keeping
    // `const old = m[kind]` would end up pointing at the NEW file and the server would delete what it just uploaded.
    const oldPublicId = m[kind]?.publicId || null;
    const uploaded = await cloud.upload(req.file.path, { movieId: m.id, kind });
    m[kind] = { publicId: uploaded.publicId, url: uploaded.url };
    await m.save();
    if (oldPublicId && oldPublicId !== uploaded.publicId) await cloud.destroy({ publicId: oldPublicId }, kind);
    res.json(adminMovie(m));
  } catch (err) { cleanup(); throw err; }
}));
router.delete('/movies/:id/media/:kind', asyncHandler(async (req, res) => {
  const kind = FIELD[req.params.kind];
  if (!kind) throw new HttpError(400, 'Unknown media kind');
  const m = await findMovie(req.params.id);
  const pid = m[kind]?.publicId || null;
  m[kind] = undefined;
  await m.save();
  if (pid) await cloud.destroy({ publicId: pid }, kind);
  res.json(adminMovie(m));
}));

/* ---- the movie itself -> Vimeo (browser uploads straight to Vimeo with a one-time tus link) ---- */
router.post('/movies/:id/video/init', validate(z.object({ size: z.number().int().min(1) })), asyncHandler(async (req, res) => {
  const m = await findMovie(req.params.id);
  if (m.processing.status === 'uploading' || m.processing.status === 'processing') throw new HttpError(409, 'A video is already being uploaded or processed for this movie');
  const old = m.vimeo?.videoId;
  const v = await vimeo.createUpload({ name: m.title, description: `Cinema movie ${m.id}`, size: req.body.size });
  m.vimeo = { videoId: v.videoId, hash: v.hash, uri: v.uri, link: v.link };
  m.processing = { status: 'uploading', percent: 0 };
  m.published = false;
  await m.save();
  if (old) await vimeo.deleteVideo(old); // replaced video
  res.json({ uploadLink: v.uploadLink, vimeoId: v.videoId, warning: v.warning });
}));

// Admin tells us the upload finished (or just asks for a refresh): we read the real state from Vimeo.
async function refreshVimeo(m) {
  if (!m.vimeo?.videoId || !['uploading', 'processing'].includes(m.processing.status)) return m;
  try {
    const st = await vimeo.getStatus(m.vimeo.videoId);
    if (st.status === 'uploading' && m.processing.status === 'uploading') return m; // still uploading
    m.processing = { status: st.status === 'uploading' ? 'processing' : st.status, percent: st.percent, error: st.error };
    if (st.hash) m.vimeo.hash = st.hash;
    if (st.link) m.vimeo.link = st.link;
    if (st.status === 'completed' && !m.durationMin && st.durationSec) m.durationMin = Math.max(1, Math.round(st.durationSec / 60));
    if (st.status === 'failed') m.published = false;
    await m.save();
  } catch (err) { console.error('Vimeo status check failed for', m._id, err.message); }
  return m;
}
router.post('/movies/:id/video/complete', asyncHandler(async (req, res) => {
  const m = await findMovie(req.params.id);
  if (!m.vimeo?.videoId) throw new HttpError(400, 'Start an upload first');
  m.processing = { status: 'processing', percent: 10 };
  await m.save();
  res.json(adminMovie(await refreshVimeo(m)));
}));
router.post('/movies/:id/video/abort', asyncHandler(async (req, res) => {
  const m = await findMovie(req.params.id);
  if (m.vimeo?.videoId) await vimeo.deleteVideo(m.vimeo.videoId);
  m.vimeo = undefined; m.processing = { status: 'none', percent: 0 }; m.published = false;
  await m.save();
  res.json(adminMovie(m));
}));
router.post('/movies/:id/video/refresh', asyncHandler(async (req, res) => res.json(adminMovie(await refreshVimeo(await findMovie(req.params.id))))));

/* ---- users ---- */
router.get('/users', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.q) { const rx = new RegExp(esc(String(req.query.q).slice(0, 60)), 'i'); filter.$or = [{ name: rx }, { email: rx }, { phone: rx }]; }
  const users = await User.find(filter).sort({ createdAt: -1 }).limit(200).select('-passwordHash');
  const ids = users.map((u) => u._id);
  const [act, planRows] = await Promise.all([
    Session.find({ user: { $in: ids }, active: true }),
    Subscription.find({ user: { $in: ids }, expiresAt: { $gt: new Date() } }).populate('plan'),
  ]);
  const devByUser = new Map(act.map((a) => [String(a.user), a]));
  const subByUser = new Map(planRows.map((x) => [String(x.user), x]));
  res.json(users.map((u) => {
    const d = devByUser.get(String(u._id)); const sub = subByUser.get(String(u._id));
    return {
      id: String(u._id), name: u.name, email: u.email, phone: u.phone, isActive: u.isActive, createdAt: u.createdAt,
      device: d ? `${d.deviceName} (seen ${d.lastSeenAt.toISOString()})` : null,
      plan: sub && sub.plan ? { key: sub.plan.key, name: sub.plan.name, maxQuality: sub.plan.maxQuality, status: sub.status, expiresAt: sub.expiresAt, source: sub.source } : null,
    };
  }));
}));
router.patch('/users/:id', validate(z.object({ isActive: z.boolean() })), asyncHandler(async (req, res) => {
  const u = isId(req.params.id) ? await User.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }) : null;
  if (!u) throw new HttpError(404, 'User not found');
  if (!req.body.isActive) await sessions.revokeAllForUser(u._id, 'blocked');
  res.json({ ok: true });
}));

// Device reset: signs the user out everywhere (e.g. lost phone, or you switched between emulator and real phone while testing).
router.post('/users/:id/reset-devices', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(404, 'User not found');
  await sessions.revokeAllForUser(req.params.id, 'admin');
  res.json({ ok: true });
}));

/* ---- plans ---- */
router.get('/plans', asyncHandler(async (req, res) => {
  const plans = await Plan.find().sort({ rank: 1 });
  res.json({ plans: plans.map(subs.planDto), movieLevels: MOVIE_LEVELS });
}));
router.put('/plans/:id', validate(z.object({
  name: z.string().trim().min(1).max(30),
  price: z.number().min(0).max(1000000),
  durationDays: z.number().int().min(1).max(3650),
  maxQuality: z.union([z.literal(360), z.literal(480), z.literal(720), z.literal(1080)]),
  qualityLabel: z.string().trim().max(40),
  features: z.array(z.string().trim().min(1).max(120)).max(8),
  active: z.boolean(),
}).partial()), asyncHandler(async (req, res) => {
  const p = isId(req.params.id) ? await Plan.findById(req.params.id) : null;
  if (!p) throw new HttpError(404, 'Plan not found');
  Object.assign(p, req.body);
  await p.save();
  res.json(subs.planDto(p));
}));

/* ---- payments + subscribers ---- */
router.get('/payments', asyncHandler(async (req, res) => {
  const filter = {};
  if (['succeeded', 'failed', 'created', 'processing'].includes(req.query.status)) filter.status = req.query.status;
  const rows = await Payment.find(filter).sort({ createdAt: -1 }).limit(200).populate('user', 'name email phone');
  res.json(rows.map((p) => ({
    id: String(p._id), user: p.user ? (p.user.name || p.user.email || p.user.phone) : '(deleted user)', planName: p.planName, amount: p.amount, currency: p.currency,
    status: p.status, method: p.method, card: p.last4 ? `${p.brand || 'Card'} ending ${p.last4}` : '', reference: p.reference || '', failure: p.failureReason || '', createdAt: p.createdAt,
  })));
}));
router.get('/subscriptions', asyncHandler(async (req, res) => {
  const rows = await Subscription.find({ expiresAt: { $gt: new Date() } }).sort({ expiresAt: 1 }).limit(300).populate('user', 'name email phone').populate('plan');
  res.json(rows.map((x) => ({ id: String(x._id), user: x.user ? (x.user.name || x.user.email || x.user.phone) : '(deleted user)', planName: x.plan?.name, maxQuality: x.plan?.maxQuality, status: x.status, source: x.source, startedAt: x.startedAt, expiresAt: x.expiresAt })));
}));

// Manual plan for a user (support / testing). Recorded as a zero-amount "admin_grant" payment so history stays complete.
router.post('/users/:id/plan', validate(z.object({ planKey: z.string().min(2).max(30), days: z.number().int().min(1).max(3650).optional() })), asyncHandler(async (req, res) => {
  const user = isId(req.params.id) ? await User.findById(req.params.id) : null;
  if (!user) throw new HttpError(404, 'User not found');
  const plan = await Plan.findOne({ key: req.body.planKey.toLowerCase() });
  if (!plan) throw new HttpError(404, 'Plan not found');
  const grant = req.body.days ? { ...plan.toObject(), durationDays: req.body.days } : plan;
  const pay = await Payment.create({ user: user._id, plan: plan._id, planKey: plan.key, planName: plan.name, amount: 0, currency: plan.currency, status: 'succeeded', method: 'admin_grant', paidAt: new Date(), reference: `admin_${req.admin._id}` });
  await subs.activate(user._id, { _id: plan._id, durationDays: grant.durationDays }, { paymentId: pay._id, source: 'admin' });
  res.json({ ok: true });
}));
router.delete('/users/:id/plan', asyncHandler(async (req, res) => {
  if (!isId(req.params.id)) throw new HttpError(404, 'User not found');
  await subs.end(req.params.id);
  res.json({ ok: true });
}));

module.exports = router;