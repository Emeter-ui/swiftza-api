const express = require('express');
const router = express.Router();
const { authfunc } = require('../services/index');
const users = require('../repositories/users');
const { asyncHandler } = require('../middleware');
const { validationFailed, AppError } = require('../models/errors');

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { email, passwd, password, ...profile } = req.body;
    // The new contract sends `password`; samzeedatas sends `passwd`. Accepting
    // both keeps one handler. Neither is ever written to the user document.
    const secret = passwd ?? password;

    if (!email || !/.+@.+\..+/.test(email)) {
      throw validationFailed('Enter a valid email address');
    }
    if (!secret || String(secret).length < 6) {
      throw validationFailed('Password must be at least 6 characters');
    }

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
    });

    res.status(201).json({ status: 'success', msg: 'User account created' });
  })
);

module.exports = router;
