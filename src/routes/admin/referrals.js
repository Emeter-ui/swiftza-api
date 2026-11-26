const express = require('express');
const router = express.Router();
const referrals = require('../../models/referrals');
const audit = require('../../models/audit');
const { asyncHandler } = require('../../middleware');

router.get('/referrals/settings', asyncHandler(async (req, res) => {
  res.json({ settings: await referrals.loadSettings(), defaults: referrals.DEFAULTS });
}));

router.put('/referrals/settings', asyncHandler(async (req, res) => {
  const patch = req.body?.settings || req.body || {};
  const settings = await referrals.saveSettings(patch);
  await audit.record({ action: 'referrals.settings.update', adminUid: req.user.uid, details: { keys: Object.keys(patch) } });
  res.json({ settings });
}));

module.exports = router;
