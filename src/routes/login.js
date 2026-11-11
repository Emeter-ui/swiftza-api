const express = require('express');
const router = express.Router();
const { authfunc } = require('../services/index');
const users = require('../repositories/users');
const { asyncHandler, signSession } = require('../middleware');
const { validationFailed, AppError } = require('../models/errors');
const P = require('../presenters');

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { identifier, email, passwd, password } = req.body;
    // samzeenuxt posts `password`; samzeedatas posts `passwd`. Accepting both
    // keeps one handler. Additive — the legacy app is unaffected.
    const secret = passwd ?? password;
    // `identifier` may be either an email or a username. Legacy clients still
    // send `email`, which we treat as the identifier for backwards compat.
    const rawIdentifier = String(identifier ?? email ?? '').trim();

    if (!rawIdentifier || !secret) {
      throw validationFailed('Email/username and password are required');
    }

    // Only lookups happen for a non-email identifier — the eventual Firebase
    // call still uses the resolved email so the credential store contract is
    // unchanged.
    let resolvedEmail = rawIdentifier;
    if (!rawIdentifier.includes('@')) {
      const byUsername = await users.findByUsername(rawIdentifier);
      // Return the same INVALID_CREDENTIALS shape as a bad password so the
      // endpoint doesn't leak whether a username exists.
      if (!byUsername || !byUsername.email) {
        throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password', 401);
      }
      resolvedEmail = byUsername.email;
    }

    let credential;
    try {
      credential = await authfunc.login(resolvedEmail, secret);
    } catch (err) {
      // Every auth failure returns the same message so the endpoint cannot be
      // used to tell registered emails apart from unregistered ones.
      if (String(err.code || '').startsWith('auth/')) {
        throw new AppError(
          'INVALID_CREDENTIALS',
          'Incorrect email or password',
          401
        );
      }
      throw err;
    }

    const { uid } = credential.user;
    const user = await users.findByUid(uid);

    // The credential is real but no USERS document exists — signup's Firebase
    // write succeeded and its Mongo write did not, since the two are not
    // transactional. Previously this fell through to a 200 with `user: null`,
    // which the Nuxt store reads as a normal login (isLoggedIn stays false but
    // nothing throws), so the account was silently locked out forever.
    if (!user) {
      throw new AppError(
        'ACCOUNT_INCOMPLETE',
        'Your account could not be found. Please contact support.',
        500
      );
    }

    const account = user.account;

    // Only the uid and a session token — the previous version returned the
    // whole Firebase user object, including its refresh token, to the client.
    res.json({
      status: 'success',
      msg: 'Logged in successfully',
      token: signSession({ uid, account }),
      data: { uid, account },
      // New contract: samzeenuxt reads res.user. Additive — samzeedatas reads
      // res.data and ignores this. Removed at cutover.
      user: P.user(user),
    });
  })
);

module.exports = router;
