const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const guestOrders = require('../models/guest-orders');
const { getProvider } = require('../providers');
const { resolveCable, resolveDisco } = require('../models/resolve');
const { validateIdFor } = require('../providers/ids');
const { SERVICES } = require('../providers/contract');
const { validationFailed } = require('../models/errors');

// Guest quick buy, open to anyone. Every endpoint is limited per network
// address; the order rules and money handling live in models/guest-orders.js.

const limit = (windowMinutes, max) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit: max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { status: 'error', code: 'RATE_LIMITED', msg: 'Too many attempts. Please wait a few minutes and try again.' },
});
const quoteLimit = limit(10, 40);
const orderLimit = limit(60, 12);
const checkLimit = limit(10, 60);
const trackLimit = limit(10, 120);
const validateLimit = limit(10, 20);

router.post('/guest/quote', quoteLimit, asyncHandler(async (req, res) => {
  res.json(await guestOrders.quote({ service: req.body?.service, details: req.body?.details }));
}));

router.post('/guest/orders', orderLimit, asyncHandler(async (req, res) => {
  const order = await guestOrders.create({
    guest: req.body?.guest,
    service: req.body?.service,
    details: req.body?.details,
    ip: req.ip,
  });
  res.status(201).json(order);
}));

// The token is the order's private key: it is in the guest's link and
// required to see or confirm the order.
router.post('/guest/orders/:reference/verify', checkLimit, asyncHandler(async (req, res) => {
  res.json(await guestOrders.verify(req.params.reference, req.body?.token));
}));

router.get('/guest/orders/:reference', trackLimit, asyncHandler(async (req, res) => {
  res.json(await guestOrders.status(req.params.reference, String(req.query.t || '')));
}));

// Same checks as /cables/validate and /electricity/validate, which need a
// session. A guest must see the account name before paying.
router.get('/guest/validate/cable', validateLimit, asyncHandler(async (req, res) => {
  const { smartcard, provider: name } = req.query;
  if (!smartcard || !name) throw validationFailed('Smart card number and cable provider are required');
  const provider = await getProvider(SERVICES.CABLE);
  const { doc } = await resolveCable(name);
  const result = await provider.validateIuc({ smartCard: String(smartcard), cableId: validateIdFor(provider.name, 'cable', doc) });
  const customerName = result.data?.name ?? result.data?.customer_name ?? result.data?.Customer_Name ?? null;
  res.status(result.valid ? 200 : 422).json({ valid: Boolean(result.valid), customerName });
}));

router.get('/guest/validate/meter', validateLimit, asyncHandler(async (req, res) => {
  const { meter, disco, type } = req.query;
  if (!meter || !disco) throw validationFailed('Meter number and disco are required');
  const provider = await getProvider(SERVICES.ELECTRICITY);
  const { doc } = await resolveDisco(disco);
  const result = await provider.validateMeter({ meterNumber: String(meter), discoId: validateIdFor(provider.name, 'electricity', doc), meterType: type });
  const customerName = result.data?.name ?? result.data?.customer_name ?? result.data?.Customer_Name ?? null;
  res.status(result.valid ? 200 : 422).json({ valid: Boolean(result.valid), customerName });
}));

module.exports = router;
