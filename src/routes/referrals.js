const express = require('express');
const router = express.Router();
const { asyncHandler, requireAuth } = require('../middleware');
const referrals = require('../models/referrals');

// Invite friends: the customer's code, totals and the friends who joined.
const summary = asyncHandler(async (req, res) => {
  res.json(await referrals.summary(req.user.uid));
});
router.get('/referrals/me', requireAuth, summary);
// The name the app's home and invite screens were first written against.
router.get('/referrals/stats', requireAuth, summary);

module.exports = router;
