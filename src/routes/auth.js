const express = require('express');
const router = express.Router();
const { authfunc } = require('../services/index');
const { getAdminAuth } = require('../services/firebase-admin');
const { asyncHandler, requireAuth, signSession } = require('../middleware');
const { validationFailed, AppError } = require('../models/errors');
const users = require('../repositories/users');
const { notify } = require('../models/notifications');
const P = require('../presenters');
const referrals = require('../models/referrals');

// The user object comes from this request's own sign-in, never from the shared
// `auth.currentUser`, which a concurrent request may have replaced. The account
// must also be the one that owns the session.
async function reauthenticate(email, password, uid) {
  if (!email || !password) {
    throw validationFailed('Email and current password are required');
  }
  let user = null;
  try {
    ({ user } = await authfunc.login(email, password));
  } catch { /* rejected below */ }
  if (!user || user.uid !== uid) {
    throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect', 401);
  }
  return user;
}

router.post(
  '/changemail',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { oldEmail, newEmail, passwd } = req.body;

    if (!newEmail || !/.+@.+\..+/.test(newEmail)) {
      throw validationFailed('Enter a valid new email address');
    }

    const user = await reauthenticate(oldEmail, passwd, req.user.uid);

    try {
      await authfunc.changeEmail(newEmail, user);
      res.json({ status: 'success', msg: 'Email changed successfully' });
    } finally {
      await authfunc.signout().catch(() => {});
    }
  })
);

router.post(
  '/changepass',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { email, oldpassword, newpassword } = req.body;

    if (!newpassword || String(newpassword).length < 6) {
      throw validationFailed('New password must be at least 6 characters');
    }

    const user = await reauthenticate(email, oldpassword, req.user.uid);

    try {
      // Firebase Auth is the credential store; the previous version also wrote
      // the new password to the USERS document in plaintext.
      await authfunc.changePassword(newpassword, user);
      await notify(req.user.uid, { title: 'Password changed', body: "Your password was changed. If this wasn't you, contact support." });
      res.json({ status: 'success', msg: 'Password changed successfully' });
    } finally {
      await authfunc.signout().catch(() => {});
    }
  })
);

router.post(
  '/resetmail',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) throw validationFailed('Email is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw validationFailed('Enter a valid email address');

    try {
      await authfunc.reset(email);
    } catch (err) {
      const code = String(err.code || '');
      if (code === 'auth/invalid-email') throw validationFailed('Enter a valid email address');
      if (code === 'auth/too-many-requests') {
        throw new AppError('TOO_MANY_REQUESTS', 'Too many reset requests. Please wait a few minutes and try again.', 429);
      }
      // user-not-found (older projects without enumeration protection) falls
      // through to the same success reply as a real account.
      if (code !== 'auth/user-not-found') throw err;
    }
    // Always the same response so the endpoint cannot be used to discover which
    // email addresses have accounts.
    res.json({
      status: 'success',
      msg: 'If that email has an account, a reset link has been sent',
    });
  })
);

router.post(
  '/verifycode',
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    if (!code) throw validationFailed('Reset code is required');

    try {
      await authfunc.verifycode(code);
    } catch {
      throw new AppError('INVALID_CODE', 'This reset code is invalid or expired', 400);
    }
    res.json({ status: 'success', msg: 'Code verified' });
  })
);

router.post(
  '/resetpassword',
  asyncHandler(async (req, res) => {
    const { code, newpassword } = req.body;

    if (!code) throw validationFailed('Reset code is required');
    if (!newpassword || String(newpassword).length < 6) {
      throw validationFailed('New password must be at least 6 characters');
    }

    try {
      await authfunc.confirmreset(code, newpassword);
    } catch {
      throw new AppError('INVALID_CODE', 'This reset code is invalid or expired', 400);
    }
    res.json({ status: 'success', msg: 'Password reset successful' });
  })
);

router.post(
  '/resend-verification',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) throw validationFailed('Email and password are required');
    let credential;
    try {
      credential = await authfunc.login(email, password);
    } catch {
      // Always return the same message so the endpoint cannot be used to discover accounts.
      res.json({ status: 'success', msg: 'If your credentials are correct, a verification email has been sent.' });
      return;
    }
    try {
      await authfunc.sendVerification(credential.user);
    } catch {
      // Best-effort — swallow send errors.
    } finally {
      await authfunc.signout().catch(() => {});
    }
    res.json({ status: 'success', msg: 'If your credentials are correct, a verification email has been sent.' });
  })
);

router.post(
  '/google',
  asyncHandler(async (req, res) => {
    const { idToken, referral } = req.body;
    if (!idToken) throw validationFailed('idToken is required');

    let decoded;
    try {
      decoded = await getAdminAuth().verifyIdToken(idToken);
    } catch (e) {
      console.error('[auth/google] verifyIdToken failed:', e.code, e.message);
      throw new AppError('INVALID_TOKEN', 'Google sign-in failed. Please try again.', 401);
    }

    const { uid, email, name } = decoded;
    let user = await users.findByUid(uid);
    if (!user) {
      // A bad code never blocks a Google sign-up; it is just not applied.
      const referrer = await referrals.resolveForSignup(referral, { quiet: true });
      await users.create(uid, {
        email,
        fullname: name || '',
        userId: uid,
        uniqueId: uid,
        account: 'USER',
        balance: 0,
        bonusBalance: 0,
        ...(referrer ? { referredBy: referrer.uid, referredWithCode: referrer.code } : {}),
      });
      await referrals.announceJoin(referrer, { fullname: name });
      user = await users.findByUid(uid);
    }

    res.json({
      status: 'success',
      msg: 'Signed in with Google',
      token: signSession({ uid, account: user.account }),
      user: P.user(user),
    });
  })
);

module.exports = router;
