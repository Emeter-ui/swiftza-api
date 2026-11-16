const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { finance } = require('../models/finance');
const { asyncHandler } = require('../middleware');

function checkCronSecret(req, res, next) {
  const secret   = process.env.CRON_SECRET || '';
  const provided = req.headers['x-cron-secret'] || '';
  if (!secret) return res.status(500).json({ status: 'error', msg: 'CRON_SECRET not set' });
  try {
    const a = Buffer.from(secret);
    const b = Buffer.from(provided);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ status: 'error', msg: 'Unauthorized' });
    }
  } catch {
    return res.status(401).json({ status: 'error', msg: 'Unauthorized' });
  }
  next();
}

router.get('/sweep-pending', checkCronSecret, asyncHandler(async (req, res) => {
  const { swept, found } = await finance.sweepStalePending({});
  res.json({ status: 'success', swept, found });
}));

module.exports = router;
