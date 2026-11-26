const express = require('express');
const router = express.Router();
const { authfunc } = require('../services/index');
const users = require('../repositories/users');
const { asyncHandler } = require('../middleware');
const { validationFailed, AppError } = require('../models/errors');
const referrals = require('../models/referrals');

// Set by the server only. Signup spreads the rest of the body into the new
// USERS document, so these are removed first.
const SERVER_OWNED = ['referredBy', 'referredWithCode', 'referralCode', 'referralRewardedAt', 'referralSkipped', 'balance', 'bonusBalance', 'account', 'setUpProcess', 'uniqueId', 'userId'];

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { email, passwd, password, referral, ...profile } = req.body;
    for (const k of SERVER_OWNED) delete profile[k];
    // The new contract sends `password`; samzeedatas sends `passwd`. Accepting
    // both keeps one handler. Neither is ever written to the user document.
    const secret = passwd ?? password;

    if (!email || !/.+@.+\..+/.test(email)) {
      throw validationFailed('Enter a valid email address');
    }
    if (!secret || String(secret).length < 6) {
      throw validationFailed('Password must be at least 6 characters');
    }

    // Checked before the account exists, so a mistyped code can be fixed
    // instead of leaving an account that was created but reported as failed.
    const referrer = await referrals.resolveForSignup(referral, { phone: profile.phone });

    let credential;
    try {
      credential = await authfunc.signup(email, secret);
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        throw new AppError('EMAIL_IN_USE', 'That email is already registered', 409);
      }
      throw err;
    }

    // `passwd` and `password` are deliberately excluded — Firebase Auth is the
    // credential store and the previous version wrote the secret into the
    // user document in plaintext.
    await users.create(credential.user.uid, {
      ...profile,
      email,
      userId: credential.user.uid,
      uniqueId: credential.user.uid,
      account: 'USER',
      balance: 0,
      bonusBalance: 0,
      ...(referrer ? { referredBy: referrer.uid, referredWithCode: referrer.code } : {}),
    });
    await referrals.announceJoin(referrer, profile);

    // Best-effort — never fails the signup if the email cannot be sent.
    authfunc.sendVerification(credential.user).catch(() => {});

    res.status(201).json({
      status: 'success',
      msg: 'Account created. You can now log in.',
    });
  })
);

module.exports = router;
