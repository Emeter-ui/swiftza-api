const express = require('express');
const router = express.Router();
const { collection, inTransaction, isDuplicateKey } = require('../services/mongo');
const { getAtcRate } = require('../models/catalog');
const { TRANSREF_PATTERN } = require('../models/purchase');
const { asyncHandler } = require('../middleware');
const { validationFailed, duplicateTransaction } = require('../models/errors');
const { optionalInt } = require('../config/env');

const ORDERS = 'ATCORDERS';

const MIN_AMOUNT = optionalInt('ATC_MIN_AMOUNT', 1000);
const MAX_AMOUNT = optionalInt('ATC_MAX_AMOUNT', 100000);

function requireString(value, label, maxLength = 100) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw validationFailed(`${label} is required`);
  if (text.length > maxLength) throw validationFailed(`${label} is too long`);
  return text;
}

router.post(
  '/place-order',
  asyncHandler(async (req, res) => {
    const { transref, network, amount, uid, channel } = req.body;

    if (!TRANSREF_PATTERN.test(String(transref ?? ''))) {
      throw validationFailed('Invalid transaction reference');
    }

    const value = Number(amount);
    if (!Number.isInteger(value) || value < MIN_AMOUNT || value > MAX_AMOUNT) {
      throw validationFailed(
        `Amount must be a whole number between ₦${MIN_AMOUNT} and ₦${MAX_AMOUNT}`
      );
    }

    const order = {
      accountName: requireString(req.body.accountName, 'Account name'),
      accountNumber: requireString(req.body.accountNumber, 'Account number', 20),
      bankName: requireString(req.body.bankName, 'Bank name'),
    };

    const rate = await getAtcRate(requireString(network, 'Network', 30));
    const receiveAmount = Math.round(value - (rate.percent / 100) * value);

    // Claiming the transref as the _id makes a double-tap a 409 rather than a
    // second payout request, and prevents a resubmit overwriting an order an
    // admin has already marked validated. inTransaction carries the same
    // explicit majority read/write concerns as every other money path (see
    // services/mongo.js) so durability here does not depend on MONGODB_URI.
    try {
      await inTransaction(async (session) => {
        const existing = await collection(ORDERS).findOne(
          { _id: String(transref) },
          { session }
        );
        if (existing) throw duplicateTransaction(String(transref));

        await collection(ORDERS).insertOne(
          {
            _id: String(transref),
            ...order,
            uid: uid ? String(uid) : null,
            transref: String(transref),
            channel: channel ? String(channel) : 'AirtimeToCash',
            network: rate.network,
            atcNumber: rate.number,
            percent: rate.percent,
            amount: value,
            reciveAmount: receiveAmount,
            status: 'pending',
            validate: false,
            CreatedAt: new Date(),
          },
          { session }
        );
      });
    } catch (err) {
      // Two requests can pass the findOne check simultaneously; the unique _id
      // index is the real guard and turns the loser into the same 409.
      if (isDuplicateKey(err)) throw duplicateTransaction(String(transref));
      throw err;
    }

    res.status(201).json({
      status: 'success',
      msg: 'Order Placed Succesfully',
      reciveAmount: receiveAmount,
    });
  })
);

module.exports = router;
