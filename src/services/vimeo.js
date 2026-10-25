// Vimeo API (server side only: the access token never leaves this process).
const config = require('../config');
const { HttpError } = require('../utils/errors');

const API = 'https://api.vimeo.com';
const HEADERS = () => ({
  Authorization: `bearer ${config.vimeo.accessToken}`,
  'Content-Type': 'application/json',
  Accept: 'application/vnd.vimeo.*+json;version=3.4',
});
const configured = () => Boolean(config.vimeo.accessToken);

async function call(path, { method = 'GET', body, okStatus } = {}) {
  if (!configured()) throw new HttpError(503, 'Vimeo is not configured. Set VIMEO_ACCESS_TOKEN in backend/.env', 'VIMEO_NOT_CONFIGURED');
  let res;
  try {
    res = await fetch(API + path, { method, headers: HEADERS(), body: body ? JSON.stringify(body) : undefined });
  } catch (err) { throw new HttpError(502, `Could not reach Vimeo: ${err.message}`, 'VIMEO_UNREACHABLE'); }
  if (res.status === 204 || (okStatus && okStatus.includes(res.status))) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `Vimeo: ${data.developer_message || data.error || res.statusText}`, 'VIMEO_ERROR');
  return data;
}

const idFromUri = (uri) => String(uri || '').split('/').pop();
const hashFromLink = (link) => { const m = /vimeo\.com\/\d+\/([0-9a-f]+)/i.exec(link || ''); return m ? m[1] : null; };
const embedDomain = () => {
  if (config.vimeo.embedDomain) return config.vimeo.embedDomain;
  try { return new URL(config.publicUrl).hostname; } catch { return ''; }
};
const isLocalHost = (h) => !h || h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.endsWith('.local');

// Cheap credentials check for the admin "System check" panel.
async function ping() {
  const me = await call('/me?fields=name,account');
  return { account: me.name || '', plan: me.account || '' };
}

// Creates the video record and returns a resumable (tus) upload link the admin's browser uploads to directly.
async function createUpload({ name, description, size }) {
  const domain = embedDomain();
  const local = isLocalHost(domain);
  const rich = {
    embed: { buttons: { like: false, watchlater: false, share: false, embed: false }, logos: { vimeo: false }, title: { name: 'hide', owner: 'hide', portrait: 'hide' } },
  };
  const bodyFor = (view, withEmbedTweaks) => ({
    upload: { approach: 'tus', size },
    name, description: description || '',
    // 'whitelist' = only the listed domains may embed. On a local/LAN address there is no domain to list, and a whitelist
    // with no domains blocks the embed completely ("privacy settings prevent playback"), so local testing uses 'public'.
    privacy: { view, embed: local ? 'public' : 'whitelist', download: false, add: false, comments: 'nobody' },
    ...(withEmbedTweaks ? rich : {}),
  });

  // Some Vimeo plans reject "unlisted" privacy or the player customisations. Try the configured settings first, then simpler ones,
  // so an upload on a basic/free test account still works (with a warning telling you what was relaxed).
  const attempts = [
    { view: config.vimeo.privacyView, tweaks: true, note: null },
    { view: config.vimeo.privacyView, tweaks: false, note: 'Your Vimeo plan does not allow the custom player settings, so the default Vimeo player look is used.' },
  ];
  if (config.vimeo.privacyView !== 'anybody') attempts.push({ view: 'anybody', tweaks: false, note: `Your Vimeo plan does not allow "${config.vimeo.privacyView}" videos, so this one was created as PUBLIC on Vimeo. Fine for testing; upgrade Vimeo before going live.` });
  let data; let warning = null; let lastErr;
  for (const at of attempts) {
    try { data = await call('/me/videos', { method: 'POST', body: bodyFor(at.view, at.tweaks) }); warning = at.note; break; }
    catch (err) {
      lastErr = err;
      if (err.code !== 'VIMEO_ERROR') throw err; // not configured / unreachable: retrying with other settings will not help
    }
  }
  if (!data) throw lastErr;

  const videoId = idFromUri(data.uri);
  if (local) {
    warning = [warning, 'PUBLIC_API_URL is a local address, so the video is not restricted to your domain on Vimeo (needed for testing on Wi-Fi). Set PUBLIC_API_URL / VIMEO_EMBED_DOMAIN to your real domain before going live.'].filter(Boolean).join(' ');
  } else {
    try { await call(`/videos/${videoId}/privacy/domains/${encodeURIComponent(domain)}`, { method: 'PUT' }); }
    catch (err) { warning = [warning, `Could not restrict the video to ${domain}: ${err.message}`].filter(Boolean).join(' '); }
  }
  let hash = hashFromLink(data.link);
  if (!hash) { try { hash = new URL(data.player_embed_url || 'https://x/').searchParams.get('h'); } catch { hash = null; } }
  return { videoId, uri: data.uri, link: data.link, hash: hash || null, uploadLink: data.upload.upload_link, warning };
}

// Maps Vimeo's upload/transcode state to our processing status.
async function getStatus(videoId) {
  const v = await call(`/videos/${videoId}?fields=uri,link,duration,upload.status,transcode.status,status,player_embed_url`);
  const up = v.upload?.status; const tc = v.transcode?.status;
  let status = 'processing'; let percent = 50; let error;
  if (up === 'error' || tc === 'error') { status = 'failed'; percent = 0; error = 'Vimeo could not process this video. Try uploading again.'; }
  else if (up === 'in_progress') { status = 'uploading'; percent = 0; }
  else if (tc === 'complete' && (v.status === 'available' || !v.status)) { status = 'completed'; percent = 100; }
  return { status, percent, error, durationSec: v.duration || 0, hash: hashFromLink(v.link), link: v.link };
}

const deleteVideo = (videoId) => call(`/videos/${videoId}`, { method: 'DELETE', okStatus: [404] }).catch((e) => console.error('Vimeo delete failed:', e.message));

const embedUrl = ({ videoId, hash }, maxQuality) => {
  const q = new URLSearchParams({ title: '0', byline: '0', portrait: '0', dnt: '1', playsinline: '1', autopause: '0' });
  // Starting quality hint. The real limit is enforced by the player page through Vimeo's JavaScript API (see routes/playback.js).
  if (maxQuality) q.set('quality', `${maxQuality === 480 ? 360 : maxQuality}p`);
  if (hash) q.set('h', hash);
  return `https://player.vimeo.com/video/${videoId}?${q}`;
};

// MP4 renditions straight from Vimeo (needs Vimeo Pro/Business and the "video_files" token scope). Returns [] when Vimeo does not hand them out,
// and the player then falls back to the normal embed.
async function getFiles(videoId) {
  try {
    const v = await call(`/videos/${videoId}?fields=files.quality,files.type,files.height,files.width,files.link,files.size`);
    return (v.files || [])
      .filter((f) => f.link && f.type === 'video/mp4' && f.quality !== 'hls' && f.height)
      .map((f) => ({ height: Number(f.height), width: Number(f.width) || 0, link: f.link }))
      .sort((a, b) => a.height - b.height);
  } catch (err) { console.error('Vimeo files lookup failed:', err.message); return []; }
}

module.exports = { configured, ping, createUpload, getStatus, deleteVideo, embedUrl, getFiles };
