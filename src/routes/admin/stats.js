const express = require('express');
const router = express.Router();
const base = require('../../repositories/base');
const { asyncHandler } = require('../../middleware');

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const [userCount, txCount, walletTxCount, waitlistCount] = await Promise.all([
      base.count('USERS'),
      base.count('TRANSACTIONS'),
      base.count('WALLETTRANSACTIONS'),
      base.count('waitlist'),
    ]);

    res.json({ userCount, txCount, walletTxCount, waitlistCount });
  })
);

module.exports = router;
