const { Movie } = require('../models');
const vimeo = require('./vimeo');

// Every 20 s, asks Vimeo about videos that are still uploading/transcoding and updates MongoDB.
async function tick() {
  if (!vimeo.configured()) return;
  if (require('mongoose').connection.readyState !== 1) return; // skip quietly while the DB is down
  const movies = await Movie.find({ 'processing.status': { $in: ['uploading', 'processing'] }, 'vimeo.videoId': { $exists: true } });
  for (const m of movies) {
    try {
      const st = await vimeo.getStatus(m.vimeo.videoId);
      if (st.status === 'uploading') {
        // Abandoned uploads (browser closed) are marked failed after 24 h.
        if (Date.now() - m.updatedAt.getTime() > 24 * 3600 * 1000) { m.processing = { status: 'failed', percent: 0, error: 'Upload was not finished. Please upload again.' }; await m.save(); }
        continue;
      }
      m.processing = { status: st.status, percent: st.percent, error: st.error };
      if (st.hash) m.vimeo.hash = st.hash;
      if (st.link) m.vimeo.link = st.link;
      if (st.status === 'completed' && !m.durationMin && st.durationSec) m.durationMin = Math.max(1, Math.round(st.durationSec / 60));
      if (st.status === 'failed') m.published = false;
      await m.save();
    } catch (err) { console.error('Vimeo poll failed for', m._id, err.message); }
  }
}
let timer;
let last = 0;
// Long-running server: poll every 20 s.
const start = () => { if (!timer) timer = setInterval(() => tick().catch((e) => console.error('poller', e.message)), 20000); };
// Serverless (Vercel): no timers. Called from the admin movie list and from /api/cron/poll, at most once per 15 s.
const runOnce = async () => { if (Date.now() - last < 15000) return; last = Date.now(); await tick(); };
module.exports = start;
module.exports.start = start;
module.exports.runOnce = runOnce;
