// Protected playback.
//   POST /api/playback/:movieId   user -> plan (and which movies it includes) -> movie -> ACTIVE device session -> short-lived player link
//   GET  /api/player/:token       server-rendered page that embeds the Vimeo player (opened in the app's WebView)
//   POST /api/player/:token/beat  heartbeat: re-checks session + access every ~20s, saves progress, or tells the page to stop
const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Movie, Session, User, WatchHistory } = require('../models');
const { requireUser } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../utils/errors');
const { resolveAccess, denyMessage, qualityText } = require('../services/access');
const { loadActiveSession, sha, newJti } = require('../services/sessions');
const vimeo = require('../services/vimeo');

const live = { published: true, 'processing.status': 'completed', 'vimeo.videoId': { $exists: true } };
const isId = (id) => /^[a-f\d]{24}$/i.test(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Public base URL as the phone sees it. In development the address the phone just used is always right
// (your computer's Wi-Fi IP can change; PUBLIC_API_URL in .env would then be stale and the player would not open).
const baseUrl = (req) => (!config.isProd || /localhost|127\.0\.0\.1/.test(config.publicUrl) ? `${req.protocol}://${req.get('host')}` : config.publicUrl);

// Colour of the plan, used by the player's quality badge (the app uses the same colours).
const PLAN_COLORS = { basic: '#4FA3E0', standard: '#9B7BFF', premium: '#FF5C8A' };
const planColor = (key) => PLAN_COLORS[key] || '#F5B83D';
const denyStatus = (a) => (a.reason === 'UPGRADE_REQUIRED' ? 403 : 402);

// Explicit stop (e.g. user closes the player) so the lease is released immediately.
router.post('/playback/stop', requireUser, asyncHandler(async (req, res) => {
  await Session.updateOne({ _id: req.session._id }, { $unset: { playing: 1 } });
  res.json({ ok: true });
}));

router.post('/playback/:movieId', requireUser, asyncHandler(async (req, res) => {
  const movie = isId(req.params.movieId) ? await Movie.findOne({ _id: req.params.movieId, ...live }) : null;
  if (!movie) throw new HttpError(404, 'Movie not found', 'NOT_FOUND');

  // user (requireUser) -> plan (does it include this movie?) -> movie -> active device session -> authorisation
  const access = await resolveAccess(req.user._id, movie);
  if (!access.allowed) throw new HttpError(denyStatus(access), await denyMessage(access), access.reason);

  const session = await loadActiveSession({ sid: req.session._id, sub: req.user._id }); // fresh re-check
  const p = session.playing;
  if (p?.movie && p.lastBeatAt && Date.now() - p.lastBeatAt.getTime() < config.session.playerStaleSeconds * 1000 && p.claimedBy && String(p.movie) !== String(movie._id)) {
    // Same device only (one active session), but never run two different movies at once.
    throw new HttpError(409, 'Another movie is already playing on this account. Close it first.', 'ALREADY_PLAYING');
  }

  const jti = newJti();
  await Session.updateOne({ _id: session._id, active: true }, { playing: { movie: movie._id, jti, startedAt: new Date(), lastBeatAt: new Date() } });
  const ttl = 6 * 3600;
  const token = jwt.sign({ type: 'player', sid: String(session._id), uid: String(req.user._id), mid: String(movie._id), jti }, config.jwtSecret, { expiresIn: ttl });
  const hist = await WatchHistory.findOne({ user: req.user._id, movie: movie._id });
  res.json({
    playerUrl: `${baseUrl(req)}/api/player/${token}`,
    resumeAt: hist && !hist.completed ? Math.floor(hist.positionSec) : 0,
    title: movie.title,
    quality: { max: access.maxQuality, label: qualityText(access.maxQuality), planKey: access.planKey, planName: access.planName || 'Free' },
  });
}));

/* ---- player token handling (shared by page + beat) ---- */
// UA only (not IP): a phone moving from Wi-Fi to mobile data must not lose its video.
const fingerprint = (req) => sha(req.headers['user-agent'] || '');

async function authorizePlayer(req, { claim }) {
  let p;
  try { p = jwt.verify(req.params.token, config.jwtSecret); if (p.type !== 'player') throw new Error(); }
  catch { throw new HttpError(401, 'This playback link has expired. Go back and press Watch again.', 'PLAYER_EXPIRED'); }
  const [user, session, movie] = await Promise.all([User.findById(p.uid), loadActiveSession({ sid: p.sid, sub: p.uid }), Movie.findOne({ _id: p.mid, ...live })]);
  if (!user || !user.isActive) throw new HttpError(403, 'Account unavailable', 'BLOCKED');
  if (!movie) throw new HttpError(404, 'Movie not found', 'NOT_FOUND');
  if (!session.playing || session.playing.jti !== p.jti) throw new HttpError(409, 'Playback was started somewhere else. Press Watch again.', 'PLAYER_REPLACED');
  const access = await resolveAccess(user._id, movie); // re-checked on every heartbeat: an expired / cancelled / downgraded plan stops the movie within ~20 s
  if (!access.allowed) throw new HttpError(denyStatus(access), await denyMessage(access), access.reason);
  const fp = fingerprint(req);
  if (claim) {
    // The link can be opened only by the device that requested it (first opener wins; reloads from the same client are fine).
    if (session.playing.claimedBy && session.playing.claimedBy !== fp) throw new HttpError(403, 'This playback link is already in use on another device.', 'PLAYER_IN_USE');
    if (!session.playing.claimedBy) await Session.updateOne({ _id: session._id, 'playing.jti': p.jti }, { 'playing.claimedBy': fp });
  } else if (session.playing.claimedBy !== fp) throw new HttpError(403, 'This playback link is already in use on another device.', 'PLAYER_IN_USE');
  return { p, user, session, movie, access };
}

const page = (inner, nonce, script = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Player</title><style>html,body{margin:0;height:100%;background:#000;color:#f1eee8;font-family:system-ui,sans-serif}iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
#msg{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:28px;background:#000;font-size:17px;line-height:1.5;z-index:5}#msg.on{display:flex}
#q{position:absolute;top:14px;right:16px;z-index:4;display:flex;gap:8px;align-items:center;pointer-events:none;font-size:12px;font-weight:700;letter-spacing:.3px}
#q span,#q select{background:rgba(0,0,0,.62);border:1px solid var(--c,#F5B83D);color:var(--c,#F5B83D);border-radius:99px;padding:5px 11px;pointer-events:auto}
#q select{font:inherit;appearance:none;-webkit-appearance:none;cursor:pointer;color:#fff}video{position:absolute;inset:0;width:100%;height:100%;background:#000}</style></head>
<body>${inner}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;

function setPlayerCsp(res, nonce) {
  res.set('Content-Security-Policy', [
    "default-src 'none'", `script-src 'nonce-${nonce}' https://player.vimeo.com`, 'frame-src https://player.vimeo.com',
    "connect-src 'self'", "media-src https:", "style-src 'unsafe-inline'", "frame-ancestors 'none'", "base-uri 'none'",
  ].join('; '));
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'origin' });
}

router.get('/player/:token', asyncHandler(async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  setPlayerCsp(res, nonce);
  let ctx;
  try { ctx = await authorizePlayer(req, { claim: true }); }
  catch (err) {
    if (!(err instanceof HttpError)) throw err;
    const msg = `<div id="msg" class="on">${esc(err.message)}</div>`;
    const post = `try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'blocked',code:${JSON.stringify(err.code || '')},message:${JSON.stringify(err.message)}}))}catch(e){}`;
    return res.status(err.status === 401 ? 401 : 403).type('html').send(page(msg, nonce, post));
  }
  const { p, movie, access, session } = ctx;
  const mode = config.playerDelivery === 'auto' ? (session.platform === 'ios' ? 'files' : 'embed') : config.playerDelivery;
  const hist = await WatchHistory.findOne({ user: p.uid, movie: movie._id });
  const resume = hist && !hist.completed ? Math.floor(hist.positionSec) : 0;
  const cfg = {
    beatMs: config.session.playerBeatSeconds * 1000, resume, duration: movie.durationMin ? movie.durationMin * 60 : 0,
    max: access.maxQuality, plan: access.planName || 'Free', color: planColor(access.planKey),
  };

  // Shared by both delivery modes: heartbeat (re-checks login, device, plan every ~20 s) + stop screen.
  const common = `
  var CFG=${JSON.stringify(cfg)};var token=${JSON.stringify(req.params.token)};var blocked=false;var pos=0,dur=CFG.duration;
  document.getElementById('q').style.setProperty('--c',CFG.color);
  function notify(o){try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(o))}catch(e){}}
  function badge(actual){document.getElementById('qb').textContent=(actual&&actual!=='auto'?actual+' \u00b7 ':'')+CFG.plan+' (up to '+CFG.max+'p)'}
  function stop(m,code){if(blocked)return;blocked=true;try{pause()}catch(e){}var el=document.getElementById('msg');el.textContent=m;el.className='on';notify({type:'blocked',code:code,message:m});}
  function beat(){if(blocked)return;fetch('/api/player/'+token+'/beat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({positionSec:pos,durationSec:dur})})
    .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})}).then(function(x){if(!x.ok)return stop(x.d.error||'Playback stopped.',x.d.code);
      if(x.d.maxQuality&&x.d.maxQuality!==CFG.max){CFG.max=x.d.maxQuality;CFG.plan=x.d.planName||CFG.plan;onPlanChanged()}}).catch(function(){});}
  setInterval(beat,CFG.beatMs);
  document.addEventListener('visibilitychange',function(){if(document.hidden)beat()});
  badge();`;

  // ---- Mode "files": our own <video>, fed ONLY the MP4 renditions this plan allows (strict, works on iOS too). Falls back to the embed.
  if (mode === 'files') {
    const files = await vimeo.getFiles(movie.vimeo.videoId);
    const allowed = files.filter((f) => f.height <= access.maxQuality);
    const usable = allowed.length ? allowed : files.slice(0, 1); // nothing at/below the cap: lowest available rather than a black screen
    if (usable.length) {
      const list = usable.map((f) => ({ h: f.height, url: f.link }));
      const inner = `<div id="q"><span id="qb"></span><select id="qs" aria-label="Video quality">${list.map((f, i) => `<option value="${i}"${i === list.length - 1 ? ' selected' : ''}>${f.h}p</option>`).join('')}</select></div>
<video id="v" controls playsinline autoplay preload="auto" controlsList="nodownload" disablePictureInPicture></video><div id="msg"></div>`;
      const script = `${common}
  var L=${JSON.stringify(list)};var v=document.getElementById('v'),sel=document.getElementById('qs'),cur=-1,startAt=CFG.resume;
  function pause(){v.pause()}
  function load(i,at){cur=i;startAt=at||0;v.src=L[i].url;badge(L[i].h+'p')}
  function onPlanChanged(){badge(L[cur]&&L[cur].h+'p')}
  v.addEventListener('loadedmetadata',function(){dur=v.duration||dur;if(startAt>5&&startAt<(v.duration||1e9)-5)v.currentTime=startAt;startAt=0;v.play().catch(function(){})});
  v.addEventListener('timeupdate',function(){pos=v.currentTime;dur=v.duration||dur});
  v.addEventListener('ended',function(){pos=dur;beat();notify({type:'ended'})});v.addEventListener('pause',beat);
  v.addEventListener('error',function(){stop('This video link has expired or could not load. Go back and press Watch again.','PLAYER_EXPIRED')});
  sel.addEventListener('change',function(){load(Number(sel.value),v.currentTime)});
  load(L.length-1,CFG.resume);`;
      return res.type('html').send(page(inner, nonce, script));
    }
    console.warn('Strict quality wanted, but Vimeo returned no MP4 renditions (needs Vimeo Pro/Business + video_files scope).' + (config.playerStrict ? ' PLAYER_STRICT is on: playback refused.' : ' Using the embedded player (quality cap may be ignored on iOS).'));
    if (config.playerStrict) {
      const m = 'This video cannot be played at your plan quality on this device right now. Please contact support.';
      const post = `try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify({type:'blocked',code:'QUALITY_UNAVAILABLE',message:${JSON.stringify(m)}}))}catch(e){}`;
      return res.status(403).type('html').send(page(`<div id="msg" class="on">${esc(m)}</div>`, nonce, post));
    }
  }

  // ---- Mode "embed": Vimeo's player; the quality is capped through its JavaScript API.
  const script = `${common}
  var player=new Vimeo.Player(document.getElementById('v'));
  function pause(){player.pause().catch(function(){})}
  var num=function(id){return parseInt(id,10)};
  // Pick the best quality the plan allows (never "auto", because auto can climb above the cap). If the video has nothing at/below the cap, use its lowest.
  function enforce(){if(blocked)return Promise.resolve();
    return player.getQualities().then(function(list){
      var all=list.filter(function(q){return !isNaN(num(q.id))}).sort(function(a,b){return num(a.id)-num(b.id)});
      var ok=all.filter(function(q){return num(q.id)<=CFG.max});var pick=ok.length?ok[ok.length-1]:all[0];if(!pick)return;
      return player.getQuality().then(function(c){return c===pick.id?null:player.setQuality(pick.id)}).then(function(){badge(pick.id)});
    }).catch(function(){/* the platform cannot control quality (e.g. iOS native HLS): use PLAYER_DELIVERY=files for strict limits */});}
  function onPlanChanged(){enforce()}
  player.on('timeupdate',function(e){pos=e.seconds;dur=e.duration||dur});
  player.on('qualitychange',function(e){var n=num(e.quality);if(e.quality==='auto'||n>CFG.max)enforce();else badge(e.quality)});
  player.on('ended',function(){pos=dur;beat();notify({type:'ended'})});
  player.on('pause',beat);
  player.on('play',enforce);
  player.on('loaded',function(){enforce().then(function(){if(CFG.resume>10){return player.setCurrentTime(CFG.resume).then(function(){return player.play()})}return player.play()}).catch(function(){})});
  setInterval(enforce,30000);`;
  const html = `<div id="q"><span id="qb"></span></div><iframe id="v" src="${esc(vimeo.embedUrl(movie.vimeo, access.maxQuality))}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe><div id="msg"></div><script nonce="${nonce}" src="https://player.vimeo.com/api/player.js"></script>`;
  res.type('html').send(page(html, nonce, script));
}));

router.post('/player/:token/beat', asyncHandler(async (req, res) => {
  const { p, user, session, movie, access } = await authorizePlayer(req, { claim: false });
  const pos = Math.max(0, Math.min(86400, Number(req.body?.positionSec) || 0));
  const dur = Math.max(0, Math.min(86400, Number(req.body?.durationSec) || 0));
  await Session.updateOne({ _id: session._id, 'playing.jti': p.jti }, { 'playing.lastBeatAt': new Date() });
  if (dur > 0 && pos > 5) {
    const completed = pos / dur > 0.95;
    await WatchHistory.updateOne({ user: user._id, movie: movie._id }, { positionSec: completed ? 0 : pos, durationSec: dur, completed }, { upsert: true });
  }
  res.json({ ok: true, maxQuality: access.maxQuality, planName: access.planName || 'Free' });
}));

module.exports = router;
