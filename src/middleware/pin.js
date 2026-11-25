const { asyncHandler } = require('./index');
const pins = require('../models/pin');

// Runs after `authed` on every route that spends from a wallet. An account with
// a PIN must supply it on all of them, including the legacy routes; otherwise a
// stolen session could simply use the older endpoint. Accounts that never set
// one keep working for the older apps, which have no PIN screen. A client that
// does send a PIN is never let through without it being checked.
const requirePin = asyncHandler(async (req, res, next) => {
  const pin = req.body?.pin;
  if (pin !== undefined || (await pins.hasPin(req.user.uid))) await pins.verify(req.user.uid, pin);
  if (req.body) delete req.body.pin;
  next();
});

module.exports = { requirePin };
