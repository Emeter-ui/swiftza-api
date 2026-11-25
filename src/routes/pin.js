const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const pins = require('../models/pin');
const { notify } = require('../models/notifications');
const users = require('../repositories/users');
const { authfunc } = require('../services/index');
const { getAdminAuth } = require('../services/firebase-admin');
const { asyncHandler, requireAuth } = require('../middleware');
const { validationFailed, AppError, userNotFound } = require('../models/errors');

const RECENT_SIGN_IN_SECONDS = 5 * 60;

// Resetting proves identity with a password, so it must not become a place to
// guess one.
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user.uid,
  message: { status: 'error', code: 'RATE_LIMITED', msg: 'Too many attempts. Try again in 15 minutes.' },
});

router.get('/pin/status', requireAuth, asyncHandler(async (req, res) => {
  res.json({ hasPin: await pins.hasPin(req.user.uid) });
}));

router.post('/pin/set', requireAuth, asyncHandler(async (req, res) => {
  await pins.create(req.user.uid, req.body.pin);
  await notify(req.user.uid, { title: 'PIN created', body: 'Your transaction PIN is ready to use.' });
  res.status(201).json({ status: 'success', message: 'PIN created' });
}));

router.post('/pin/change', requireAuth, asyncHandler(async (req, res) => {
  pins.assertFormat(req.body.newPin);
  await pins.verify(req.user.uid, req.body.currentPin);
  await pins.replace(req.user.uid, req.body.newPin);
  await notify(req.user.uid, { title: 'PIN changed', body: "Your transaction PIN was changed. If this wasn't you, contact support." });
  res.json({ status: 'success', message: 'PIN changed' });
}));

// A session alone is not enough to reset: the caller re-enters the account
// password, or signs in with Google again just now.
router.post('/pin/reset', requireAuth, resetLimiter, asyncHandler(async (req, res) => {
  const { password, idToken, newPin } = req.body;
  pins.assertFormat(newPin);
  const { uid } = req.user;
  let provenUid = null;

  if (typeof idToken === 'string' && idToken) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(idToken);
      const fresh = Date.now() / 1000 - decoded.auth_time <= RECENT_SIGN_IN_SECONDS;
      if (fresh && decoded.firebase?.sign_in_provider === 'google.com') provenUid = decoded.uid;
    } catch { /* rejected below */ }
  } else if (typeof password === 'string' && password) {
    const account = await users.findByUid(uid);
    if (!account) throw userNotFound(uid);
    try {
      provenUid = (await authfunc.login(account.email, password)).user.uid;
    } catch { /* rejected below */ }
  } else {
    throw validationFailed('Enter your password to reset your PIN');
  }

  if (provenUid !== uid) throw new AppError('INVALID_CREDENTIALS', 'We could not confirm it is you. Please try again.', 403);
  await pins.replace(uid, newPin);
  await notify(uid, { title: 'PIN reset', body: "Your transaction PIN was reset. If this wasn't you, contact support." });
  res.json({ status: 'success', message: 'PIN reset' });
}));

module.exports = router;
