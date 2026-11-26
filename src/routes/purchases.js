const express = require('express');
const router = express.Router();
const { asyncHandler, authed } = require('../middleware');
const { requirePin } = require('../middleware/pin');
const { buyData, buyAirtime, buyCable, buyElectricity, buyExam } = require('../models/buy');

// The purchase logic itself lives in models/buy.js, shared with guest orders.

const reply = (res, result, extra = {}) =>
  res.status(result.httpStatus).json({
    wallet: result.wallet,
    message: result.msg,
    reference: result.reference,
    // Additive: buy-data.vue and its siblings currently show a green success
    // toast for a provider decline or the 202-pending case because reply()
    // dropped execute()'s status. Adding it here unblocks that page fix
    // without changing this route's behaviour.
    status: result.status,
    ...extra,
  });

router.post(
  '/buy-data',
  authed,
  requirePin,
  asyncHandler(async (req, res) => {
    reply(res, await buyData(req.body.uid, req.body));
  })
);

router.post(
  '/buy-airtime',
  authed,
  requirePin,
  asyncHandler(async (req, res) => {
    reply(res, await buyAirtime(req.body.uid, req.body));
  })
);

router.post(
  '/buy-cable',
  authed,
  requirePin,
  asyncHandler(async (req, res) => {
    reply(res, await buyCable(req.body.uid, req.body));
  })
);

router.post(
  '/buy-electricity',
  authed,
  requirePin,
  asyncHandler(async (req, res) => {
    const result = await buyElectricity(req.body.uid, req.body);
    reply(res, result, { token: result.token });
  })
);

router.post(
  '/result-checker',
  authed,
  requirePin,
  asyncHandler(async (req, res) => {
    const result = await buyExam(req.body.uid, req.body);
    reply(res, result, { pins: result.pins });
  })
);

module.exports = router;
