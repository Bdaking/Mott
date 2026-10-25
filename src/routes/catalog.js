const router = require('express').Router();
const { Movie, WatchHistory, Watchlist } = require('../models');
const { optionalUser } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/errors');
const { movieCard, movieDetail } = require('../services/serializers');
const { resolveAccess } = require('../services/access');
const { Plan } = require('../models');

const live = { published: true, 'processing.status': 'completed', 'vimeo.videoId': { $exists: true } };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/movies/genres', asyncHandler(async (req, res) => {
  res.json((await Movie.distinct('genres', live)).sort());
}));

router.get('/movies/home', asyncHandler(async (req, res) => {
  const [featuredDocs, latest, genres] = await Promise.all([
    Movie.find({ ...live, featured: true }).sort({ updatedAt: -1 }).limit(5),
    Movie.find(live).sort({ createdAt: -1 }).limit(12),
    Movie.distinct('genres', live),
  ]);
  const rows = [];
  if (latest.length) rows.push({ title: 'New releases', movies: latest.map(movieCard) });
  for (const g of genres.filter((x) => x.trim().toLowerCase() !== 'new releases').slice(0, 6)) { // a genre literally called "New releases" would duplicate the first row
    const ms = await Movie.find({ ...live, genres: g }).sort({ createdAt: -1 }).limit(12);
    if (ms.length) rows.push({ title: g, movies: ms.map(movieCard) });
  }
  const featured = (featuredDocs.length ? featuredDocs : latest.slice(0, 1)).map((m) => ({ ...movieCard(m), description: m.description }));
  res.json({ featured, rows });
}));

router.get('/movies', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(30, parseInt(req.query.limit, 10) || 18);
  const filter = { ...live };
  if (req.query.genre) filter.genres = String(req.query.genre);
  if (req.query.q) {
    const rx = new RegExp(esc(String(req.query.q).slice(0, 60)), 'i');
    filter.$or = [{ title: rx }, { cast: rx }, { director: rx }, { genres: rx }];
  }
  const [items, total] = await Promise.all([
    Movie.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Movie.countDocuments(filter),
  ]);
  res.json({ items: items.map(movieCard), page, hasMore: page * limit < total });
}));

router.get('/movies/:id', optionalUser, asyncHandler(async (req, res) => {
  const m = /^[a-f\d]{24}$/i.test(req.params.id) ? await Movie.findOne({ _id: req.params.id, ...live }) : null;
  if (!m) throw new HttpError(404, 'Movie not found', 'NOT_FOUND');
  const out = movieDetail(m);
  out.inWatchlist = false;
  out.resumeSec = 0;
  out.canWatch = false;
  out.access = null;
  // Which plan includes this movie (shown on the details screen so the user knows what to buy).
  const need = (m.minPlanRank ?? 1) > 0 ? await Plan.findOne({ rank: { $gte: m.minPlanRank ?? 1 }, active: true }).sort({ rank: 1 }) : null;
  out.requiredPlan = need ? { key: need.key, name: need.name, rank: need.rank } : null;
  if (req.user) {
    const [wl, hist, access] = await Promise.all([
      Watchlist.exists({ user: req.user._id, movie: m._id }),
      WatchHistory.findOne({ user: req.user._id, movie: m._id }),
      resolveAccess(req.user._id, m),
    ]);
    out.inWatchlist = Boolean(wl);
    out.resumeSec = hist && !hist.completed ? Math.floor(hist.positionSec) : 0;
    out.canWatch = Boolean(access.allowed && out.playable); // display hint only; /playback re-checks everything
    out.access = { allowed: access.allowed, reason: access.reason || null, maxQuality: access.maxQuality, planKey: access.planKey, planName: access.planName };
  }
  res.json(out);
}));

module.exports = router;
