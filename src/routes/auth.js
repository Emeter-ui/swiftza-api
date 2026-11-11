const express = require('express');
const router = express.Router();
const { auth } = require('../services/firebase');
const { authfunc } = require('../services/index');
const { asyncHandler, requireAuth } = require('../middleware');
const { validationFailed, AppError } = require('../models/errors');

// HAZARD: these handlers sign in against the process-wide Firebase client auth
// instance, so `auth.currentUser` is shared across concurrent requests and two
// simultaneous changes can be applied to the wrong account. Migrating to
// firebase-admin removes the shared-state problem entirely.
async function reauthenticate(email, password) {
  if (!email || !password) {
    throw validationFailed('Email and current password are required');
  }
  try {
    return await authfunc.login(email, password);
  } catch {
    throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect', 401);
  }
}

router.post(
  '/changemail',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { oldEmail, newEmail, passwd } = req.body;

    if (!newEmail || !/.+@.+\..+/.test(newEmail)) {
      throw validationFailed('Enter a valid new email address');
    }

    await reauthenticate(oldEmail, passwd);
    const user = auth.currentUser;

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

    await reauthenticate(email, oldpassword);
    const user = auth.currentUser;

    try {
      // Firebase Auth is the credential store; the previous version also wrote
      // the new password to the USERS document in plaintext.
      await authfunc.changePassword(newpassword, user);
      res.json({ status: 'success', msg: 'Password changed successfully' });
    } finally {
      await authfunc.signout().catch(() => {});
    }
  })
);

router.post(
  '/resetmail',
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) throw validationFailed('Email is required');

    await authfunc.reset(email);
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

module.exports = router;
