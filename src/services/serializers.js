// Older uploads were saved with a transformation in the URL (c_limit,w_1280,f_auto,q_auto) that Cloudinary may reject.
// Strip it so those movies work without re-uploading.
const cleanUrl = (u) => (u ? u.replace(/\/upload\/c_limit,w_1280,f_auto,q_auto\//, '/upload/') : null);

const movieCard = (m) => ({
  id: String(m._id),
  title: m.title,
  year: m.year || null,
  genres: m.genres || [],
  posterUrl: cleanUrl(m.poster?.url),
  backdropUrl: cleanUrl(m.backdrop?.url),
  minPlanRank: m.minPlanRank ?? 1, // 0 free, 1 Basic+, 2 Standard+, 3 Premium
});

// Never includes Vimeo ids or any storage secrets.
const movieDetail = (m) => ({
  ...movieCard(m),
  description: m.description,
  durationMin: m.durationMin || null,
  language: m.language,
  certificate: m.certificate,
  director: m.director,
  cast: m.cast || [],
  trailerUrl: m.trailer?.url || null,
  playable: m.processing?.status === 'completed' && Boolean(m.vimeo?.videoId),
});

module.exports = { movieCard, movieDetail, cleanUrl };
