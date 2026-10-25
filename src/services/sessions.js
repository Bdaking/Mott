// Session + device tracking. This is the server-side source of truth for "which device may watch".
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Session } = require('../models');
const { HttpError } = require('../utils/errors');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const DAY = 86400000;

const signAccess = (userId, sid) => jwt.sign({ sub: String(userId), sid: String(sid), type: 'user' }, config.jwtSecret, { expiresIn: config.session.accessTtl });
const signRefresh = (userId, sid, jti) => jwt.sign({ sub: String(userId), sid: String(sid), jti, type: 'refresh' }, config.jwtRefreshSecret, { expiresIn: `${config.session.refreshDays}d` });
const newJti = () => crypto.randomBytes(24).toString('hex');

const tokens = (userId, sid, jti) => ({ accessToken: signAccess(userId, sid), refreshToken: signRefresh(userId, sid, jti) });

const idleCutoff = () => new Date(Date.now() - config.session.idleMinutes * 60000);

// Called after the user proved ownership of the account (OTP). Enforces ONE active device.
async function startSession(user, { deviceId, deviceName, platform, ip, replaceOther = false }) {
  const now = new Date();
  // Housekeeping: expired sessions never block a login.
  await Session.updateMany({ user: user._id, active: true, expiresAt: { $lte: now } }, { active: false, revokedReason: 'expired' });
  const current = await Session.findOne({ user: user._id, active: true });
  if (current) {
    const sameDevice = current.deviceId === deviceId;
    const idle = current.lastSeenAt < idleCutoff();
    if (!sameDevice && !idle && !replaceOther) { // replaceOther: the user just proved ownership (OTP) and chose to sign the other device out
      const freeInMin = Math.max(1, Math.ceil((current.lastSeenAt.getTime() + config.session.idleMinutes * 60000 - Date.now()) / 60000));
      throw new HttpError(409,
        `This account is already active on another device (${current.deviceName}). Sign out there first, or try again in about ${freeInMin} min if that device is no longer in use.`,
        'DEVICE_ACTIVE');
    }
    await Session.updateOne({ _id: current._id, active: true }, { active: false, revokedReason: 'replaced' });
  }
  const jti = newJti();
  try {
    const s = await Session.create({
      user: user._id, deviceId, deviceName: (deviceName || 'Unknown device').slice(0, 60), platform: (platform || '').slice(0, 20), ip,
      refreshHash: sha(jti), expiresAt: new Date(Date.now() + config.session.refreshDays * DAY),
    });
    return { session: s, ...tokens(user._id, s._id, jti), expiresIn: config.session.accessTtl };
  } catch (err) {
    // Two logins raced: the unique partial index guarantees only one wins.
    if (err.code === 11000) throw new HttpError(409, 'This account is already active on another device.', 'DEVICE_ACTIVE');
    throw err;
  }
}

// Rotating refresh tokens. Re-using an old refresh token means it leaked, so the session is killed.
async function refreshSession(refreshToken, deviceId) {
  let p;
  try { p = jwt.verify(refreshToken, config.jwtRefreshSecret); } catch { throw new HttpError(401, 'Please sign in again', 'SESSION_EXPIRED'); }
  if (p.type !== 'refresh') throw new HttpError(401, 'Please sign in again', 'SESSION_EXPIRED');
  const s = await Session.findOne({ _id: p.sid, user: p.sub });
  if (!s || !s.active || s.expiresAt <= new Date()) throw sessionGone(s);
  if (s.deviceId !== deviceId) throw new HttpError(401, 'This session belongs to a different device. Please sign in again.', 'SESSION_REVOKED');
  const jti = newJti();
  const r = await Session.updateOne({ _id: s._id, active: true, refreshHash: sha(p.jti) }, { refreshHash: sha(jti), lastSeenAt: new Date() });
  if (!r.modifiedCount) {
    await revoke(s._id, 'refresh_reuse');
    throw new HttpError(401, 'Your session was ended for security reasons. Please sign in again.', 'SESSION_REVOKED');
  }
  return { userId: s.user, ...tokens(s.user, s._id, jti), expiresIn: config.session.accessTtl };
}

const REASONS = {
  replaced: 'You were signed out because this account was opened on another device.',
  admin: 'You were signed out by the administrator.',
  blocked: 'This account has been blocked. Please contact support.',
  refresh_reuse: 'Your session was ended for security reasons. Please sign in again.',
};
function sessionGone(s) {
  return new HttpError(401, REASONS[s?.revokedReason] || 'Your session has ended. Please sign in again.', 'SESSION_REVOKED');
}

const revoke = (sid, reason) => Session.updateOne({ _id: sid, active: true }, { active: false, revokedReason: reason, $unset: { playing: 1 } });
const revokeAllForUser = (userId, reason) => Session.updateMany({ user: userId, active: true }, { active: false, revokedReason: reason, $unset: { playing: 1 } });

// Validates an access-token payload against the database on EVERY protected request.
async function loadActiveSession(payload) {
  const s = await Session.findOne({ _id: payload.sid, user: payload.sub });
  if (!s || !s.active || s.expiresAt <= new Date()) throw sessionGone(s);
  if (Date.now() - s.lastSeenAt.getTime() > 60000) Session.updateOne({ _id: s._id }, { lastSeenAt: new Date() }).catch(() => {});
  return s;
}

module.exports = { startSession, refreshSession, revoke, revokeAllForUser, loadActiveSession, sha, newJti };
