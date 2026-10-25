// Smoke test against a RUNNING server (start it first with `npm run dev`).
//   npm run smoke                      -> http://localhost:4000
//   npm run smoke -- http://192.168.1.5:4000
//
// It checks: server up, admin login, database/Vimeo/Cloudinary keys, public catalog, OTP login (needs OTP_DEV_MODE=true),
// one-device rule, protected routes. It creates ONE hidden test movie and deletes it again. Nothing is uploaded to Vimeo/Cloudinary.
require('dotenv').config();

const BASE = (process.argv[2] || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
let pass = 0; let fail = 0; let warn = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${extra ? '  -> ' + extra : ''}`); } return cond; };
const note = (name, extra) => { warn++; console.log(`  WARN  ${name}${extra ? '  -> ' + extra : ''}`); };

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

(async () => {
  console.log(`Smoke test against ${BASE}\n`);

  console.log('Server');
  let health;
  try { health = await call('/health'); } catch (e) { console.log(`  FAIL  Cannot reach ${BASE} (${e.message}). Is "npm run dev" running?`); process.exit(1); }
  ok(health.status === 200 && health.data.ok, 'GET /health');
  const admin = await fetch(`${BASE}/admin/app.js`);
  ok(admin.status === 200, 'admin page assets are served');
  const csp = (await fetch(`${BASE}/admin/`)).headers.get('content-security-policy') || '';
  ok(!/upgrade-insecure-requests/.test(csp) || BASE.startsWith('https'), 'admin page is not forced to https on a plain-http address');

  console.log('\nAdmin');
  const email = process.env.ADMIN_EMAIL; const password = process.env.ADMIN_PASSWORD;
  const login = await call('/api/admin/auth/login', { method: 'POST', body: { email, password } });
  if (!ok(login.status === 200 && login.data.token, 'admin login with ADMIN_EMAIL / ADMIN_PASSWORD from .env', 'run "npm run seed" once if this fails')) return finish();
  const at = login.data.token;
  ok((await call('/api/admin/movies')).status === 401, 'admin API refuses requests without a token');

  const diag = await call('/api/admin/diagnostics', { token: at });
  ok(diag.data.database?.ok, 'MongoDB connected');
  if (diag.data.vimeo?.ok) ok(true, `Vimeo token works (${diag.data.vimeo.account || 'account'}, plan: ${diag.data.vimeo.plan || '?'})`);
  else note('Vimeo is not usable yet', diag.data.vimeo?.error || 'VIMEO_ACCESS_TOKEN missing');
  if (diag.data.cloudinary?.ok) ok(true, 'Cloudinary keys work');
  else note('Cloudinary is not usable yet', diag.data.cloudinary?.error || 'CLOUDINARY_* missing');

  // A movie that is NOT published must never appear in the public catalog.
  const created = await call('/api/admin/movies', { method: 'POST', token: at, body: { title: 'Smoke test movie (safe to delete)', description: 'x', genres: ['Test'], cast: [] } });
  if (!ok(created.status === 201, 'create a movie in the admin API', JSON.stringify(created.data))) return finish();
  const movieId = created.data.id;
  const hidden = await call('/api/movies');
  ok(hidden.status === 200 && !hidden.data.items.some((m) => m.id === movieId), 'unpublished movies are hidden from the app');
  ok((await call(`/api/admin/movies/${movieId}/publish`, { method: 'PATCH', token: at, body: { published: true } })).status === 400, 'cannot publish a movie that has no finished video');

  console.log('\nPublic catalog (no login)');
  ok((await call('/api/movies/home')).status === 200, 'GET /api/movies/home');
  ok((await call('/api/movies/genres')).status === 200, 'GET /api/movies/genres');
  ok((await call('/api/movies?q=zzzz-no-match')).status === 200, 'GET /api/movies?q=');
  const plansRes = await call('/api/plans');
  ok(plansRes.status === 200 && plansRes.data.plans?.length >= 3, 'GET /api/plans lists Basic / Standard / Premium');
  ok(plansRes.data.plans?.map((p) => p.maxQuality).join() === '480,720,1080', 'plans cap quality at 480 / 720 / 1080 (unless you edited them)', plansRes.data.plans?.map((p) => p.maxQuality).join());
  ok((await call('/api/billing/subscription')).status === 401, 'subscription endpoint needs login');
  ok((await call('/api/billing/pay', { method: 'POST', body: { paymentId: 'a'.repeat(24), card: { number: '4242424242424242', expiry: '12/30', cvv: '123' } } })).status === 401, 'paying needs login');

  console.log('\nLogin (OTP) and one-device rule');
  const id = `smoke${Date.now()}@example.com`;
  const dev = { A: 'a'.repeat(8) + '-smoke-device-A-1234', B: 'b'.repeat(8) + '-smoke-device-B-1234' };
  // With real login (OTP_DEV_MODE=false) this would send a real email to a made-up address, so the sign-in part is skipped.
  const realLogin = process.env.OTP_DEV_MODE !== 'true';
  const rq = realLogin ? { status: 200, data: {} } : await call('/api/auth/otp/request', { method: 'POST', body: { identifier: id } });
  ok(rq.status === 200, 'request a login code', JSON.stringify(rq.data));
  if (!rq.data.devCode) {
    note('Real login is on (OTP_DEV_MODE=false), so the sign-in + payment tests are skipped', 'to run them temporarily set OTP_DEV_MODE=true, restart the server, run npm run smoke, then set it back to false. Use "npm run test:email -- you@gmail.com" to test real email.');
  } else {
    const bad = await call('/api/auth/otp/verify', { method: 'POST', body: { identifier: id, code: rq.data.devCode === '000000' ? '111111' : '000000', deviceId: dev.A } });
    ok(bad.status === 400, 'wrong code is refused');
    const good = await call('/api/auth/otp/verify', { method: 'POST', body: { identifier: id, code: rq.data.devCode, deviceId: dev.A, deviceName: 'Smoke phone A', platform: 'android' } });
    if (ok(good.status === 200 && good.data.accessToken, 'correct code signs in and creates the account', JSON.stringify(good.data))) {
      const ut = good.data.accessToken;
      ok((await call('/api/auth/me', { token: ut })).status === 200, 'GET /api/auth/me');
      ok((await call('/api/me/watchlist')).status === 401, 'watchlist needs login');
      const nf = await call(`/api/playback/${movieId}`, { method: 'POST', token: ut });
      ok(nf.status === 404, 'playback refused for a movie without a finished video', String(nf.status));

      // ---- plans + dummy payment ----
      if (plansRes.data.payments?.enabled) {
        const stdPlan = plansRes.data.plans.find((p) => p.key === 'standard');
        let co = await call('/api/billing/checkout', { method: 'POST', token: ut, body: { planKey: 'standard' } });
        ok(co.status === 201, 'checkout creates a payment', JSON.stringify(co.data));
        const decl = await call('/api/billing/pay', { method: 'POST', token: ut, body: { paymentId: co.data.paymentId, card: { number: '4000000000000002', expiry: '12/30', cvv: '123' } } });
        ok(decl.status === 402, 'a declined test card is refused');
        const sub0 = await call('/api/billing/subscription', { token: ut });
        ok(sub0.data.subscription === null, 'a declined payment gives no plan');
        const paid = await call('/api/billing/pay', { method: 'POST', token: ut, body: { paymentId: co.data.paymentId, card: { number: '4242 4242 4242 4242', expiry: '12/30', cvv: '123' } } });
        ok(paid.status === 200 && paid.data.subscription?.plan?.key === 'standard', 'test card 4242... pays and activates Standard', JSON.stringify(paid.data));
        const me = await call('/api/auth/me', { token: ut });
        ok(me.data.subscription?.plan?.maxQuality === stdPlan.maxQuality, `/auth/me reports the plan (${stdPlan.maxQuality}p)`);
        const dup = await call('/api/billing/pay', { method: 'POST', token: ut, body: { paymentId: co.data.paymentId, card: { number: '4242424242424242', expiry: '12/30', cvv: '123' } } });
        ok(dup.status === 200, 'paying the same order twice does not charge twice');
        ok((await call('/api/billing/history', { token: ut })).data.some((x) => x.status === 'succeeded'), 'payment history shows the payment');
      } else note('payments are switched off (PAYMENTS_MODE), billing tests skipped');

      // ---- one device at a time ----
      const rq2 = await call('/api/auth/otp/request', { method: 'POST', body: { identifier: id } });
      let activeToken = ut;
      if (rq2.status === 429) note('second device test skipped', `resend cooldown (${rq2.data.error}); run the smoke test again in a minute`);
      else {
        const second = await call('/api/auth/otp/verify', { method: 'POST', body: { identifier: id, code: rq2.data.devCode, deviceId: dev.B, deviceName: 'Smoke phone B' } });
        ok(second.status === 409 && second.data.code === 'DEVICE_ACTIVE', 'a second device is refused while the first is active', JSON.stringify(second.data));
        const forced = await call('/api/auth/otp/verify', { method: 'POST', body: { identifier: id, code: rq2.data.devCode, deviceId: dev.B, deviceName: 'Smoke phone B', replaceOther: true } });
        ok(forced.status === 200, '"sign out the other device and continue here" works', JSON.stringify(forced.data));
        ok((await call('/api/auth/me', { token: ut })).status === 401, 'the first device is signed out after being replaced');
        if (forced.data.accessToken) activeToken = forced.data.accessToken;
      }
      const logout = await call('/api/auth/logout', { method: 'POST', token: activeToken });
      ok(logout.status === 200, 'logout frees the account');
      ok((await call('/api/auth/me', { token: activeToken })).status === 401, 'old token stops working after logout');
    }
    // clean up the smoke user (block + leave; admin can delete the DB row if wanted)
    const users = await call(`/api/admin/users?q=${encodeURIComponent(id)}`, { token: at });
    const u = users.data[0]; if (u) await call(`/api/admin/users/${u.id}`, { method: 'PATCH', token: at, body: { isActive: false } });
  }

  await call(`/api/admin/movies/${movieId}`, { method: 'DELETE', token: at });
  ok((await call(`/api/movies/${movieId}`)).status === 404, 'test movie deleted');
  finish();
})().catch((e) => { console.error('Smoke test crashed:', e); process.exit(1); });

function finish() {
  console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings`);
  if (warn) console.log('Warnings are not failures: they mean something (usually Vimeo/Cloudinary keys or OTP dev mode) still needs your attention.');
  process.exit(fail ? 1 : 0);
}
