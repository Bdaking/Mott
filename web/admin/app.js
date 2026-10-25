(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '-');
    let token = localStorage.getItem('admin_token');
  let timer = null;
  const app = $('#app');

  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), Math.min(15000, Math.max(3200, String(msg).length * 70)));
  }
  function logout() { localStorage.removeItem('admin_token'); token = null; location.hash = ''; render(); }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api/admin' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) { logout(); throw new Error('Session expired. Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }
  const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  /* ---------- layout ---------- */
  function shell(active, html) {
    const link = (h, t) => `<a href="#/${h}" class="${active === h ? 'on' : ''}">${t}</a>`;
    app.innerHTML = `<div class="shell"><nav><div class="brand">Cinema <span>Admin</span></div>
      ${link('', 'Dashboard')}${link('movies', 'Movies')}${link('users', 'Users')}${link('plans', 'Plans')}${link('payments', 'Payments')}
      <button id="logout">Sign out</button></nav><main>${html}</main></div>`;
    $('#logout').onclick = logout;
  }

  function loginView() {
    app.innerHTML = `<div class="login"><h1>Cinema Admin</h1><div class="card">
      <div><label for="em">Email</label><input id="em" type="email" autocomplete="username"></div>
      <div><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password"></div>
      <button class="primary" id="go" style="width:100%">Sign in</button><div class="err" id="le"></div></div></div>`;
    const go = async () => {
      try {
        const r = await api('/auth/login', { method: 'POST', body: { email: $('#em').value, password: $('#pw').value } });
        token = r.token; localStorage.setItem('admin_token', token); render();
      } catch (e) { $('#le').textContent = e.message; }
    };
    $('#go').onclick = go; $('#pw').onkeydown = (e) => e.key === 'Enter' && go();
  }

  const statusBadge = (m) => {
    const p = m.processing || { status: 'none' };
    const label = { none: 'No video', uploading: 'Uploading', processing: `Processing ${p.percent || 0}%`, completed: 'Completed', failed: 'Failed' }[p.status];
    return `<span class="badge b-${p.status}" title="${esc(p.error || '')}">${label}</span>`;
  };

  /* ---------- movies list ---------- */
  async function moviesView() {
    const movies = await api('/movies');
    shell('movies', `<div class="row" style="justify-content:space-between"><div><h1>Movies</h1><p class="sub">Videos are stored on Vimeo, images on Cloudinary.</p></div><a class="btn primary" href="#/movies/new">Add movie</a></div>
      <div class="card scroll"><table><thead><tr><th></th><th>Title</th><th>Video</th><th>Status</th><th></th></tr></thead><tbody>
      ${movies.map((m) => `<tr><td>${m.posterUrl ? `<img class="thumb" src="${esc(m.posterUrl)}" alt="">` : '<div class="thumb"></div>'}</td>
        <td><a href="#/movies/${m.id}">${esc(m.title)}</a><div class="muted">${esc(m.year || '')} ${esc(m.genres.join(', '))} &middot; ${['Free', 'Basic+', 'Standard+', 'Premium'][m.minPlanRank ?? 1]}</div></td>
        <td>${statusBadge(m)}</td>
        <td><span class="badge ${m.published ? 'b-live' : 'b-none'}">${m.published ? 'Published' : 'Hidden'}</span></td>
        <td class="row"><button class="sm" data-pub="${m.id}" data-to="${!m.published}">${m.published ? 'Unpublish' : 'Publish'}</button>
        <a class="btn sm" href="#/movies/${m.id}">Edit</a><button class="sm danger" data-del="${m.id}" data-title="${esc(m.title)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No movies yet. Add your first one.</td></tr>'}
      </tbody></table></div>`);
    app.querySelectorAll('[data-pub]').forEach((b) => (b.onclick = safe(async () => {
      await api(`/movies/${b.dataset.pub}/publish`, { method: 'PATCH', body: { published: b.dataset.to === 'true' } });
      toast(b.dataset.to === 'true' ? 'Published' : 'Unpublished'); moviesView();
    })));
    app.querySelectorAll('[data-del]').forEach((b) => (b.onclick = safe(async () => {
      if (!confirm(`Delete "${b.dataset.title}" and all its files? This cannot be undone.`)) return;
      await api(`/movies/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted'); moviesView();
    })));
    if (movies.some((m) => ['uploading', 'processing'].includes(m.processing.status))) timer = setTimeout(safe(moviesView), 8000);
  }

  /* ---------- movie form ---------- */
  async function movieView(id) {
    const m = id === 'new' ? { title: '', description: '', genres: [], cast: [], featured: false, minPlanRank: 1, processing: { status: 'none' }, published: false } : await api('/movies/' + id);
    const isNew = id === 'new';
    shell('movies', `<p><a href="#/movies">&larr; All movies</a></p><h1>${isNew ? 'Add movie' : esc(m.title)}</h1><p class="sub">${isNew ? 'Fill in the details first. You can upload the poster and video right after saving.' : 'Edit details and manage files.'}</p>
      <div class="card"><h2>Details</h2><div class="grid">
        <div class="full"><label for="f-title">Title</label><input id="f-title" value="${esc(m.title)}"></div>
        <div class="full"><label for="f-desc">Description</label><textarea id="f-desc">${esc(m.description)}</textarea></div>
        <div><label for="f-year">Year</label><input id="f-year" type="number" value="${esc(m.year ?? '')}"></div>
        <div><label for="f-dur">Duration (minutes)</label><input id="f-dur" type="number" value="${esc(m.durationMin ?? '')}"></div>
        <div><label for="f-lang">Language</label><input id="f-lang" value="${esc(m.language)}"></div>
        <div><label for="f-cert">Certificate (U, UA, A)</label><input id="f-cert" value="${esc(m.certificate)}"></div>
        <div><label for="f-genres">Genres (comma separated)</label><input id="f-genres" value="${esc(m.genres.join(', '))}"></div>
        <div><label for="f-dir">Director</label><input id="f-dir" value="${esc(m.director)}"></div>
        <div class="full"><label for="f-cast">Cast (comma separated)</label><input id="f-cast" value="${esc(m.cast.join(', '))}"></div>
        <div><label for="f-level">Included in plan</label><select id="f-level">${[[1, 'Basic and above (all plans)'], [2, 'Standard and above'], [3, 'Premium only'], [0, 'Free (any signed-in user, 360p)']].map(([v, t]) => `<option value="${v}" ${(m.minPlanRank ?? 1) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div style="align-self:end"><label class="row" style="color:var(--text)"><input id="f-feat" type="checkbox" ${m.featured ? 'checked' : ''}> Show on the home screen banner</label></div>
      </div><div class="row" style="margin-top:16px"><button class="primary" id="save">${isNew ? 'Save and continue' : 'Save changes'}</button></div></div>
      ${isNew ? '' : `<div class="card"><h2>Artwork and trailer <span class="muted">(stored on Cloudinary)</span></h2><div class="grid">
        ${['poster', 'backdrop', 'trailer'].map((k) => `<div><label>${k === 'poster' ? 'Poster (portrait JPG/PNG/WebP)' : k === 'backdrop' ? 'Backdrop (wide JPG/PNG/WebP)' : 'Trailer (MP4)'}</label>
          <input type="file" data-asset="${k}" accept="${k === 'trailer' ? 'video/mp4' : 'image/jpeg,image/png,image/webp'}">
          ${k === 'trailer' ? (m.trailerUrl ? `<video class="preview" src="${esc(m.trailerUrl)}" controls></video>` : '') : (m[k + 'Url'] ? `<img class="preview" src="${esc(m[k + 'Url'])}" alt="Image failed to load"><div class="muted" style="margin-top:6px;word-break:break-all"><a href="${esc(m[k + 'Url'])}" target="_blank" rel="noopener">Open image URL</a></div>` : '')}
          <div class="bar" hidden><i></i></div></div>`).join('')}</div></div>
      <div class="card"><h2>Movie video <span class="muted">(stored on Vimeo)</span></h2><div class="row">${statusBadge(m)}${m.processing.error ? `<span class="err">${esc(m.processing.error)}</span>` : ''}${m.vimeoId ? `<span class="muted">Vimeo ID ${esc(m.vimeoId)}</span>` : ''}</div>
        ${m.processing.status === 'processing' ? `<div class="bar"><i style="width:${m.processing.percent || 0}%"></i></div>` : ''}
        <div style="margin-top:14px"><input type="file" id="video-file" accept="video/*"></div><div class="bar" id="video-bar" hidden><i></i></div><div class="muted" id="video-msg" style="margin-top:6px"></div>
        <div class="row" style="margin-top:14px"><button class="primary" id="video-go">${m.vimeoId ? 'Replace movie' : 'Upload movie'}</button><button id="video-refresh">Check Vimeo status</button></div></div>
      <div class="card row"><button id="pubtoggle" class="${m.published ? '' : 'primary'}">${m.published ? 'Unpublish' : 'Publish movie'}</button><span class="muted">${m.published ? 'Visible to everyone in the app.' : 'Hidden until the video shows Completed.'}</span></div>`}`);

    const val = (s) => $(s).value.trim();
    const list = (s) => val(s).split(',').map((x) => x.trim()).filter(Boolean);
    const num = (s) => (val(s) === '' ? null : Number(val(s)));
    $('#save').onclick = safe(async () => {
      const body = { title: val('#f-title'), description: $('#f-desc').value, year: num('#f-year'), durationMin: num('#f-dur'), language: val('#f-lang'), certificate: val('#f-cert'),
        genres: list('#f-genres'), director: val('#f-dir'), cast: list('#f-cast'), featured: $('#f-feat').checked, minPlanRank: Number($('#f-level').value) };
      const r = await api(isNew ? '/movies' : '/movies/' + id, { method: isNew ? 'POST' : 'PUT', body });
      toast('Saved');
      if (isNew) location.hash = '#/movies/' + r.id; else movieView(id);
    });
    if (isNew) return;

    app.querySelectorAll('[data-asset]').forEach((inp) => (inp.onchange = safe(async () => {
      const f = inp.files[0]; if (!f) return;
      const kind = inp.dataset.asset; const bar = inp.parentElement.querySelector('.bar');
      bar.hidden = false; bar.firstChild.style.width = '30%';
      const fd = new FormData(); fd.append('file', f);
      const res = await fetch(`/api/admin/movies/${id}/media/${kind}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { logout(); throw new Error('Session expired. Please sign in again.'); }
      if (!res.ok) { bar.hidden = true; throw new Error(data.error || 'Upload failed'); }
      toast('Uploaded to Cloudinary'); movieView(id);
    })));

    $('#video-go').onclick = safe(async () => {
      const f = $('#video-file').files[0];
      if (!f) return toast('Choose a video file first', true);
      if (m.vimeoId && !confirm('This replaces the current video on Vimeo. Continue?')) return;
      $('#video-go').disabled = true;
      const bar = $('#video-bar'), msg = $('#video-msg'); bar.hidden = false;
      try {
        const init = await api(`/movies/${id}/video/init`, { method: 'POST', body: { size: f.size } });
        if (init.warning) toast(init.warning, true);
        await tusUpload(init.uploadLink, f, (p) => { bar.firstChild.style.width = p + '%'; msg.textContent = `Uploading to Vimeo… ${p}%. Keep this tab open.`; });
      } catch (e) { await api(`/movies/${id}/video/abort`, { method: 'POST' }).catch(() => {}); $('#video-go').disabled = false; throw new Error('Upload failed: ' + e.message); }
      await api(`/movies/${id}/video/complete`, { method: 'POST' });
      toast('Upload finished. Vimeo is processing the video.'); movieView(id);
    });
    $('#video-refresh').onclick = safe(async () => { await api(`/movies/${id}/video/refresh`, { method: 'POST' }); movieView(id); });
    $('#pubtoggle').onclick = safe(async () => { await api(`/movies/${id}/publish`, { method: 'PATCH', body: { published: !m.published } }); toast(m.published ? 'Unpublished' : 'Published'); movieView(id); });
    if (m.processing.status === 'processing') timer = setTimeout(safe(() => movieView(id)), 8000);
  }

  // Resumable upload straight to Vimeo (tus protocol). The Vimeo access token never reaches the browser; the link is single-use.
  async function tusUpload(link, file, onProgress) {
    const CH = 16 * 1024 * 1024; let offset = 0;
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(offset + CH, file.size));
      let ok = false;
      for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
        try {
          const res = await fetch(link, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream' }, body: chunk });
          if (!res.ok) throw new Error('Vimeo returned ' + res.status);
          offset = Number(res.headers.get('Upload-Offset')) || offset + chunk.size; ok = true;
        } catch (e) {
          if (attempt === 4) throw e;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          const head = await fetch(link, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } }).catch(() => null);
          const off = head && head.ok ? Number(head.headers.get('Upload-Offset')) : NaN;
          if (Number.isFinite(off) && off !== offset) { offset = off; break; } // server is ahead/behind: re-slice
        }
      }
      onProgress(Math.min(100, Math.round((offset / file.size) * 100)));
    }
  }

  /* ---------- users ---------- */
  const planBadge = (p) => (p ? `<span class="badge pl-${esc(p.key)}">${esc(p.name)} &middot; ${p.maxQuality}p</span><div class="muted">${p.status === 'cancelled' ? 'Ends' : 'Renews'} ${fmtDate(p.expiresAt)}${p.source === 'admin' ? ' (granted by admin)' : ''}</div>` : '<span class="muted">No plan</span>');
  async function usersView(q = '') {
    const [users, pl] = await Promise.all([api('/users?q=' + encodeURIComponent(q)), api('/plans')]);
    shell('users', `<h1>Users</h1><p class="sub">Give or remove a plan, block accounts, or reset a user's device (signs them out everywhere).</p>
      <div class="row" style="margin-bottom:14px"><input id="uq" placeholder="Search name, email or phone" value="${esc(q)}" style="max-width:320px"><button id="usearch">Search</button></div>
      <div class="card scroll"><table><thead><tr><th>User</th><th>Plan</th><th>Joined</th><th>Device</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name || '')}<div class="muted">${esc(u.email || u.phone || '')}</div></td><td>${planBadge(u.plan)}</td><td>${fmtDate(u.createdAt)}</td>
        <td><div class="muted">${u.device ? 'Device: ' + esc(u.device) : 'No active device'}</div></td>
        <td><div class="row"><select data-plansel="${u.id}" style="width:130px"><option value="">Give plan…</option>${pl.plans.map((p) => `<option value="${esc(p.key)}">${esc(p.name)}</option>`).join('')}</select>
        ${u.plan ? `<button class="sm danger" data-endplan="${u.id}">End plan</button>` : ''}
        <button class="sm" data-reset="${u.id}">Reset devices</button><button class="sm ${u.isActive ? 'danger' : ''}" data-block="${u.id}" data-to="${!u.isActive}">${u.isActive ? 'Block' : 'Unblock'}</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No users yet. Sign in from the app to create one.</td></tr>'}
      </tbody></table></div>`);
    $('#usearch').onclick = () => usersView($('#uq').value); $('#uq').onkeydown = (e) => e.key === 'Enter' && usersView($('#uq').value);
    app.querySelectorAll('[data-block]').forEach((b) => (b.onclick = safe(async () => { await api('/users/' + b.dataset.block, { method: 'PATCH', body: { isActive: b.dataset.to === 'true' } }); usersView(q); })));
    app.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = safe(async () => {
      if (!confirm('Sign this user out of every device?')) return;
      await api('/users/' + b.dataset.reset + '/reset-devices', { method: 'POST' }); toast('Devices reset'); usersView(q);
    })));
    app.querySelectorAll('[data-plansel]').forEach((sel) => (sel.onchange = safe(async () => {
      if (!sel.value) return;
      if (!confirm(`Give this user the ${sel.options[sel.selectedIndex].text} plan now (free, recorded as an admin grant)?`)) { sel.value = ''; return; }
      await api('/users/' + sel.dataset.plansel + '/plan', { method: 'POST', body: { planKey: sel.value } }); toast('Plan activated'); usersView(q);
    })));
    app.querySelectorAll('[data-endplan]').forEach((b) => (b.onclick = safe(async () => {
      if (!confirm('End this user\'s plan immediately? Anything they are watching stops within about 20 seconds.')) return;
      await api('/users/' + b.dataset.endplan + '/plan', { method: 'DELETE' }); toast('Plan ended'); usersView(q);
    })));
  }

  /* ---------- plans ---------- */
  const QS = [[360, '360p'], [480, '480p'], [720, '720p HD'], [1080, '1080p Full HD']];
  async function plansView() {
    const { plans } = await api('/plans');
    shell('plans', `<h1>Plans</h1><p class="sub">The three plans users can buy. Changes apply immediately: a new quality limit reaches people who are already watching within about 20 seconds.</p>
      ${plans.map((p) => `<div class="card" data-plan="${p.id}"><div class="row" style="justify-content:space-between"><h2 style="margin:0"><span class="badge pl-${esc(p.key)}">${esc(p.name)}</span></h2>
        <label class="row" style="color:var(--text);margin:0"><input type="checkbox" data-f="active" ${p.active ? 'checked' : ''}> On sale</label></div>
        <div class="grid" style="margin-top:14px">
          <div><label>Name</label><input data-f="name" value="${esc(p.name)}"></div>
          <div><label>Price (${esc(p.currency)})</label><input data-f="price" type="number" min="0" value="${p.price}"></div>
          <div><label>Length (days)</label><input data-f="durationDays" type="number" min="1" value="${p.durationDays}"></div>
          <div><label>Highest quality allowed</label><select data-f="maxQuality">${QS.map(([v, t]) => `<option value="${v}" ${p.maxQuality === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div><label>Quality label shown in the app</label><input data-f="qualityLabel" value="${esc(p.qualityLabel)}"></div>
          <div class="full"><label>Features (one per line)</label><textarea data-f="features" style="min-height:80px">${esc((p.features || []).join('\n'))}</textarea></div>
        </div><div class="row" style="margin-top:14px"><button class="primary" data-save="${p.id}">Save ${esc(p.name)}</button></div></div>`).join('')}
      <p class="muted">Which movies each plan includes is set per movie (Movies > edit > "Included in plan"). Rank order is fixed: Basic &lt; Standard &lt; Premium.</p>`);
    app.querySelectorAll('[data-save]').forEach((b) => (b.onclick = safe(async () => {
      const box = b.closest('[data-plan]'); const f = (n) => box.querySelector(`[data-f="${n}"]`);
      const body = { name: f('name').value.trim(), price: Number(f('price').value), durationDays: Number(f('durationDays').value), maxQuality: Number(f('maxQuality').value),
        qualityLabel: f('qualityLabel').value.trim(), features: f('features').value.split('\n').map((x) => x.trim()).filter(Boolean), active: f('active').checked };
      await api('/plans/' + b.dataset.save, { method: 'PUT', body }); toast('Plan saved'); plansView();
    })));
  }

  /* ---------- payments + subscribers ---------- */
  const money = (n, c) => (c === 'INR' || !c ? '\u20B9' : esc(c) + ' ') + Number(n).toLocaleString('en-IN');
  async function paymentsView(status = '') {
    const [rows, subsList] = await Promise.all([api('/payments' + (status ? '?status=' + status : '')), api('/subscriptions')]);
    shell('payments', `<h1>Payments</h1><p class="sub">Test payments from the built-in dummy gateway (no real money). Card numbers are never stored, only the last 4 digits.</p>
      <h2>Active subscribers (${subsList.length})</h2>
      <div class="card scroll"><table><thead><tr><th>User</th><th>Plan</th><th>Quality</th><th>Status</th><th>Since</th><th>Valid until</th></tr></thead><tbody>
      ${subsList.map((x) => `<tr><td>${esc(x.user)}</td><td>${esc(x.planName)}</td><td>${x.maxQuality}p</td><td>${x.status === 'cancelled' ? 'Ends (no renewal)' : 'Active'}${x.source === 'admin' ? ' <span class="muted">(admin)</span>' : ''}</td><td>${fmtDate(x.startedAt)}</td><td>${fmtDate(x.expiresAt)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No active subscribers yet.</td></tr>'}</tbody></table></div>
      <div class="row" style="justify-content:space-between;margin-top:22px"><h2 style="margin:0">Payment history</h2>
      <select id="pstatus" style="width:180px">${[['', 'All'], ['succeeded', 'Succeeded'], ['failed', 'Failed'], ['created', 'Not completed']].map(([v, t]) => `<option value="${v}" ${v === status ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="card scroll" style="margin-top:12px"><table><thead><tr><th>Date</th><th>User</th><th>Plan</th><th>Amount</th><th>Status</th><th>Card / method</th><th>Reference</th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td>${fmtDate(p.createdAt)}</td><td>${esc(p.user)}</td><td>${esc(p.planName)}</td><td>${p.method === 'admin_grant' ? 'Free' : money(p.amount, p.currency)}</td>
        <td><span class="badge ${p.status === 'succeeded' ? 'b-completed' : p.status === 'failed' ? 'b-failed' : 'b-none'}" title="${esc(p.failure)}">${esc(p.status)}</span>${p.failure ? `<div class="muted">${esc(p.failure)}</div>` : ''}</td>
        <td>${p.method === 'admin_grant' ? 'Admin grant' : esc(p.card || 'Dummy card')}</td><td class="muted">${esc(p.reference)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No payments yet.</td></tr>'}</tbody></table></div>`);
    $('#pstatus').onchange = () => paymentsView($('#pstatus').value);
  }

  /* ---------- router ---------- */
  const views = {};
  const check = (label, ok, detail) => `<div class="stat"><b class="${ok ? '' : 'err'}">${ok ? 'OK' : 'Problem'}</b><span>${esc(label)}</span><span class="muted" style="display:block;margin-top:4px;font-size:12px">${esc(detail || '')}</span></div>`;
  views.dashboard = async () => {
    shell('', '<h1>Dashboard</h1><p class="sub">Loading…</p>');
    const [s, d] = await Promise.all([api('/stats'), api('/diagnostics').catch((e) => ({ error: e.message }))]);
    const sys = d.error ? `<p class="err">System check failed: ${esc(d.error)}</p>` : `<h2 style="margin-top:28px">System check</h2><p class="sub">Confirms the keys in backend/.env really work before you upload.</p><div class="stats">
      ${check('Database (MongoDB)', d.database.ok, d.database.ok ? 'Connected' : 'Not connected')}
      ${check('Vimeo (movies)', d.vimeo.ok, d.vimeo.ok ? `${d.vimeo.account || ''} (${d.vimeo.plan || 'plan unknown'})` : (d.vimeo.error || (d.vimeo.configured ? 'Token rejected' : 'VIMEO_ACCESS_TOKEN missing')))}
      ${check('Cloudinary (images)', d.cloudinary.ok, d.cloudinary.ok ? 'Connected' : (d.cloudinary.error || 'Keys missing'))}
      ${check('Login by email', d.login.devMode || d.login.email.ok, d.login.devMode ? 'Test mode: codes are shown in the app, no email is sent' : d.login.email.ok ? 'Gmail/SMTP login works' : (d.login.email.error || (d.login.email.configured ? 'SMTP login failed' : 'SMTP_* missing in .env')))}
      ${check('Login by SMS', d.login.devMode || d.login.sms.configured, d.login.devMode ? 'Test mode' : d.login.sms.configured ? 'Twilio keys present (trial accounts only text verified numbers)' : 'TWILIO_* missing in .env')}
      ${check('Payments', d.payments.enabled, d.payments.enabled ? 'Dummy gateway: test cards only, no real money' : 'Switched off')}
      ${check('Video delivery', true, ({ files: 'Own player with plan-filtered MP4 files (strict, iOS + Android)', auto: 'Auto: iPhone/iPad use plan-filtered MP4 files, others use the Vimeo player', embed: 'Vimeo player, quality capped per plan (iOS may ignore the cap)' })[d.player.delivery] + (d.player.strict ? ' - strict' : ''))}</div>
      <p class="muted" style="margin-top:10px">Server address: ${esc(d.server.publicUrl)}</p>`;
    const mix = s.byPlan.map((p) => `<div class="stat"><b>${p.subscribers}</b><span><span class="badge pl-${esc(p.key)}">${esc(p.name)}</span> up to ${p.maxQuality}p</span></div>`).join('');
    shell('', `<h1>Dashboard</h1><p class="sub">Users, plans and money at a glance.</p><div class="stats">
      <div class="stat"><b>${s.users}</b><span>Registered users</span></div><div class="stat"><b>${s.activeSubs}</b><span>Active subscribers</span></div>
      <div class="stat"><b>${money(s.revenueMonth)}</b><span>Revenue this month</span></div><div class="stat"><b>${money(s.revenue)}</b><span>Revenue all time</span></div>
      <div class="stat"><b>${s.published}/${s.movies}</b><span>Movies published</span></div>
      <div class="stat"><b>${s.processing}</b><span>Uploading / processing</span></div><div class="stat"><b class="${s.failed ? 'err' : ''}">${s.failed}</b><span>Failed videos</span></div></div>
      <h2>Subscribers by plan</h2><div class="stats">${mix}</div>
      <div style="margin-top:18px"><a class="btn primary" href="#/movies/new">Add a movie</a> <a class="btn" href="#/plans">Edit plans</a></div>${sys}`);
  };

  function render() {
    clearTimeout(timer);
    if (!token) return loginView();
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const run = safe(async () => {
      if (parts[0] === 'movies' && parts[1]) return movieView(parts[1]);
      if (parts[0] === 'movies') return moviesView();
      if (parts[0] === 'users') return usersView();
      if (parts[0] === 'plans') return plansView();
      if (parts[0] === 'payments') return paymentsView();
      return views.dashboard();
    });
    run();
  }
  window.addEventListener('hashchange', render);
  render();
})();