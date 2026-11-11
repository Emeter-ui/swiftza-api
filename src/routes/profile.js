const express = require('express');
const router = express.Router();
const users = require('../repositories/users');
const { authfunc } = require('../services/index');
const { auth } = require('../services/firebase');
const P = require('../presenters');
const { asyncHandler, authed, requireAuth } = require('../middleware');
const { validationFailed, AppError, userNotFound } = require('../models/errors');

// A profile update may only ever touch these. Anything else — balance, role,
// the Paystack keys — is ignored rather than rejected, matching the legacy
// endpoint's behaviour.
const EDITABLE = ['fullname', 'username', 'phone', 'bankName', 'accountName', 'accountNumber'];

// /atoc rejects these three with requireString(..., maxLength) (see
// routes/atoc.js and routes/orders.js). Without matching validation here, a
// caller could store an object or an oversized string in accountNumber via
// /account and then find /atoc unusable for their own account.
const BANK_FIELD_LIMITS = { bankName: 100, accountName: 100, accountNumber: 20 };
const BANK_FIELD_LABELS = { bankName: 'Bank name', accountName: 'Account name', accountNumber: 'Account number' };

function requireString(value, label, maxLength = 100) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw validationFailed(`${label} is required`);
  if (text.length > maxLength) throw validationFailed(`${label} is too long`);
  return text;
}

router.post(
  '/account',
  authed,
  asyncHandler(async (req, res) => {
    const patch = {};
    for (const field of EDITABLE) {
      if (req.body[field] === undefined) continue;
      if (field in BANK_FIELD_LIMITS) {
        patch[field] = requireString(req.body[field], BANK_FIELD_LABELS[field], BANK_FIELD_LIMITS[field]);
      } else {
        patch[field] = req.body[field];
      }
    }
    if (Object.keys(patch).length === 0) {
      throw validationFailed('No updatable fields supplied');
    }

    await users.update(req.user.uid, patch);
    const updated = await users.findByUid(req.user.uid);

    res.json({ user: P.user(updated), message: 'Account details updated' });
  })
);

router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword) throw validationFailed('Your current password is required');
    if (!newPassword || String(newPassword).length < 6) {
      throw validationFailed('New password must be at least 6 characters');
    }

    // The email comes from the session user's own document. Taking it from the
    // body would let a caller attempt reauthentication against another account.
    const account = await users.findByUid(req.user.uid);
    if (!account) throw userNotFound(req.user.uid);

    try {
      await authfunc.login(account.email, currentPassword);
    } catch {
      throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect', 401);
    }

    try {
      // HAZARD, inherited from routes/auth.js: authfunc signs in against the
      // process-wide Firebase client instance, so auth.currentUser is shared
      // across concurrent requests. Out of scope here — tracked for the phase
      // that migrates off the Firebase client SDK.
      await authfunc.changePassword(newPassword, auth.currentUser);
      res.json({ message: 'Password changed successfully' });
    } finally {
      await authfunc.signout().catch(() => {});
    }
  })
);

router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) throw validationFailed('Email is required');

    await authfunc.reset(email).catch(() => {});
    // Always the same response, so the endpoint cannot be used to discover
    // which email addresses have accounts.
    res.json({ message: 'If that email has an account, a reset link has been sent' });
  })
);

module.exports = router;
