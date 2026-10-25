const jwt = require('jsonwebtoken');
const config = require('../config');
const { User, Admin } = require('../models');
const { HttpError, asyncHandler } = require('../utils/errors');
const { loadActiveSession } = require('../services/sessions');

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};
const decode = (token, secret, type) => {
  try {
    const p = jwt.verify(token, secret);
    return p.type === type ? p : null;
  } catch (err) { return err.name === 'TokenExpiredError' ? 'expired' : null; }
};

// Valid access token + user still allowed + the session is still THE active device session (checked in MongoDB).
async function authenticate(req) {
  const t = bearer(req);
  const p = t && decode(t, config.jwtSecret, 'user');
  if (p === 'expired') throw new HttpError(401, 'Session refresh needed', 'TOKEN_EXPIRED');
  if (!p) throw new HttpError(401, 'Please sign in', 'UNAUTHENTICATED');
  const [user, session] = await Promise.all([User.findById(p.sub), loadActiveSession(p)]);
  if (!user || !user.isActive) throw new HttpError(401, 'Account unavailable', 'UNAUTHENTICATED');
  req.user = user; req.session = session;
}

const requireUser = asyncHandler(async (req, res, next) => { await authenticate(req); next(); });

// For public endpoints that personalise when the caller happens to be signed in. A bad token just means "guest".
const optionalUser = asyncHandler(async (req, res, next) => {
  if (bearer(req)) { try { await authenticate(req); } catch { /* guest */ } }
  next();
});

const requireAdmin = asyncHandler(async (req, res, next) => {
  const t = bearer(req);
  const p = t && decode(t, config.adminJwtSecret, 'admin');
  if (!p || p === 'expired') throw new HttpError(401, 'Admin sign-in required', 'UNAUTHENTICATED');
  const admin = await Admin.findById(p.sub);
  if (!admin) throw new HttpError(401, 'Admin sign-in required', 'UNAUTHENTICATED');
  req.admin = admin;
  next();
});

const signAdminToken = (admin) => jwt.sign({ sub: String(admin._id), type: 'admin' }, config.adminJwtSecret, { expiresIn: '12h' });

module.exports = { requireUser, optionalUser, requireAdmin, signAdminToken, authenticate };
