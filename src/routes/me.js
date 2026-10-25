const router = require('express').Router();
const { z } = require('zod');
const { Movie, WatchHistory, Watchlist } = require('../models');
const { resolveAccess } = require('../services/access');
const { requireUser } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { asyncHandler, HttpError } = require('../utils/errors');
const { movieCard } = require('../services/serializers');

router.use(requireUser);
const isId = (id) => /^[a-f\d]{24}$/i.test(id);
const live = { published: true, 'processing.status': 'completed', 'vimeo.videoId': { $exists: true } };

router.get('/watchlist', asyncHandler(async (req, res) => {
  const rows = await Watchlist.find({ user: req.user._id }).sort({ createdAt: -1 }).populate({ path: 'movie', match: live });
  res.json(rows.filter((r) => r.movie).map((r) => movieCard(r.movie)));
}));

router.put('/watchlist/:movieId', asyncHandler(async (req, res) => {
  if (!isId(req.params.movieId) || !(await Movie.exists({ _id: req.params.movieId, ...live }))) throw new HttpError(404, 'Movie not found');
  await Watchlist.updateOne({ user: req.user._id, movie: req.params.movieId }, { $setOnInsert: {} }, { upsert: true });
  res.json({ inWatchlist: true });
}));

router.delete('/watchlist/:movieId', asyncHandler(async (req, res) => {
  if (isId(req.params.movieId)) await Watchlist.deleteOne({ user: req.user._id, movie: req.params.movieId });
  res.json({ inWatchlist: false });
}));

router.get('/continue-watching', asyncHandler(async (req, res) => {
  const rows = await WatchHistory.find({ user: req.user._id, completed: false, positionSec: { $gt: 10 } })
    .sort({ updatedAt: -1 }).limit(12).populate({ path: 'movie', match: live });
  res.json(rows.filter((r) => r.movie).map((r) => ({
    ...movieCard(r.movie),
    progress: r.durationSec ? Math.min(1, r.positionSec / r.durationSec) : 0,
    resumeSec: Math.floor(r.positionSec),
  })));
}));

router.post('/progress', validate(z.object({
  movieId: z.string().regex(/^[a-f\d]{24}$/i),
  positionSec: z.number().min(0).max(86400),
  durationSec: z.number().min(0).max(86400),
})), asyncHandler(async (req, res) => {
  const { movieId, positionSec, durationSec } = req.body;
  const movie = await Movie.findOne({ _id: movieId, ...live });
  if (!movie || !(await resolveAccess(req.user._id, movie)).allowed) throw new HttpError(403, 'Not allowed', 'FORBIDDEN');
  const completed = durationSec > 0 && positionSec / durationSec > 0.95;
  await WatchHistory.updateOne({ user: req.user._id, movie: movieId },
    { positionSec: completed ? 0 : positionSec, durationSec, completed }, { upsert: true });
  res.json({ ok: true });
}));

module.exports = router;
