const jwt = require('jsonwebtoken');
const users = require('../repositories/users');
const { AppError } = require('../models/errors');
const { jwt: jwtConfig } = require('../config/env');

// Sessions are backend-issued JWTs rather than Firebase ID tokens because the
// browser never authenticates with Firebase directly — it posts credentials to
// /login and the server verifies them. Before this existed the whole session
// was `localStorage.activeUser`, a bare uid, so anyone could paste another
// user's uid and become them without a password.
function signSession({ uid, account }) {
  return jwt.sign({ uid, account: account || 'USER' }, jwtConfig.secret(), {
    expiresIn: jwtConfig.ttl,
    subject: String(uid),
  });
}

function unauthorized(msg = 'Sign in to continue') {
  return new AppError('UNAUTHENTICATED', msg, 401);
}

function readToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (!/^Bearer$/i.test(scheme || '') || !token) return null;
  return token.trim();
}

function verify(req) {
  const token = readToken(req);
  if (!token) throw unauthorized();

  try {
    return jwt.verify(token, jwtConfig.secret());
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw unauthorized('Your session has expired. Please sign in again.');
    }
    throw unauthorized('Invalid session');
  }
}

// Attaches req.user when a valid token is present, but never rejects. Used on
// endpoints that are public yet behave differently for admins.
function optionalAuth(req, res, next) {
  try {
    req.user = verify(req);
  } catch {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  try {
    req.user = verify(req);
    next();
  } catch (err) {
    next(err);
  }
}

// The account claim is re-read from the database rather than trusted from the
// token, so revoking someone's admin rights takes effect immediately instead of
// when their week-long session happens to expire.
async function loadAccount(uid) {
  const user = await users.findByUid(String(uid));
  if (!user) throw unauthorized('Account no longer exists');
  return user.account;
}

function requireAdmin(req, res, next) {
  Promise.resolve()
    .then(async () => {
      req.user = verify(req);
      if ((await loadAccount(req.user.uid)) !== 'ADMIN') {
        throw new AppError('FORBIDDEN', 'Administrator access required', 403);
      }
      next();
    })
    .catch(next);
}

// Every route below /data, /airtime, /atc etc. reads `uid` from the body.
// Overwriting it here means a caller cannot spend someone else's balance by
// sending their uid, and no individual route can forget to check.
function bindUid(req, res, next) {
  if (req.body && typeof req.body === 'object') req.body.uid = req.user.uid;
  next();
}

// requireAuth followed by bindUid, since they are always used together.
const authed = [requireAuth, bindUid];

module.exports = {
  signSession,
  requireAuth,
  requireAdmin,
  optionalAuth,
  bindUid,
  authed,
};
