const express = require('express');
const router = express.Router();
const users = require('../repositories/users');
const { asyncHandler } = require('../middleware');
const { validationFailed, userNotFound } = require('../models/errors');

const SENSITIVE_FIELDS = ['passwd', 'password', 'paystacksecretkey'];

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { uid } = req.body;
    if (!uid || typeof uid !== 'string') {
      throw validationFailed('A user id is required');
    }

    const user = await users.findByUid(uid);
    if (!user) throw userNotFound();

    // The repository adds `docid`; this endpoint has always returned the id as
    // `id`, so the shape is preserved exactly rather than gaining a field.
    const { docid, ...rest } = user;
    const profile = { ...rest, id: docid };
    for (const field of SENSITIVE_FIELDS) delete profile[field];

    // New-contract aliases, additive. samzeedatas reads balance/account and
    // ignores these. Removed at cutover.
    profile.wallet = Number(profile.balance) || 0;
    profile.role = profile.account ?? 'USER';

    res.json(profile);
  })
);

module.exports = router;
