const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { getAtcRate } = require('../models/catalog');
const { asyncHandler, authed } = require('../middleware');
const { validationFailed, duplicateTransaction } = require('../models/errors');
const { collection, inTransaction, isDuplicateKey } = require('../services/mongo');
const { optionalInt } = require('../config/env');

const ORDERS = 'ATCORDERS';
const MIN_AMOUNT = optionalInt('ATC_MIN_AMOUNT', 1000);
const MAX_AMOUNT = optionalInt('ATC_MAX_AMOUNT', 100000);
const DUPLICATE_WINDOW_MS = 120000;

function requireString(value, label, maxLength = 100) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw validationFailed(`${label} is required`);
  if (text.length > maxLength) throw validationFailed(`${label} is too long`);
  return text;
}

// MongoDB transactions give snapshot isolation, not serializability: two
// concurrent requests each read a snapshot without the other's uncommitted
// row, then would insert different _ids, so both commit. A findOne-then-insert
// dedup guard only stops a sequential double-tap, not a concurrent one.
// Deriving a deterministic _id from the natural key plus a time bucket lets
// the existing unique-_id constraint enforce dedup atomically instead — the
// same mechanism the legacy /place-order route's comment (atoc.js:47)
// describes, just computed rather than client-supplied.
function atcOrderKey({ uid, network, amount, accountNumber }) {
  const bucket = Math.floor(Date.now() / DUPLICATE_WINDOW_MS);
  const hash = crypto
    .createHash('sha256')
    .update(`${uid}|${network}|${amount}|${accountNumber}|${bucket}`)
    .digest('hex');
  return `atc_${hash}`;
}

router.post(
  '/atoc',
  authed,
  asyncHandler(async (req, res) => {
    const { uid, network, amount } = req.body;

    const value = Number(amount);
    if (!Number.isInteger(value) || value < MIN_AMOUNT || value > MAX_AMOUNT) {
      throw validationFailed(`Amount must be a whole number between ₦${MIN_AMOUNT} and ₦${MAX_AMOUNT}`);
    }

    const order = {
      accountName: requireString(req.body.accountName, 'Account name'),
      accountNumber: requireString(req.body.accountNumber, 'Account number', 20),
      bankName: requireString(req.body.bankName, 'Bank name'),
      mobileNumber: requireString(req.body.mobileNumber, 'Mobile number', 20),
    };

    // Commission comes from the ATC catalog, never the request body.
    const rate = await getAtcRate(requireString(network, 'Network', 30));
    const receiveAmount = Math.round(value - (rate.percent / 100) * value);
    const transref = atcOrderKey({
      uid: String(uid), network: rate.network, amount: value, accountNumber: order.accountNumber,
    });

    try {
      await inTransaction(async (session) => {
        // The unique _id (derived above from the natural key plus a 120s time
        // bucket) is the real dedup guard — two concurrent requests for the
        // same intent collide on insertOne and the loser gets isDuplicateKey
        // below. This findOne only produces a friendlier duplicateTransaction
        // error for the common sequential-double-tap case.
        const existing = await collection(ORDERS).findOne({ _id: transref }, { session });
        if (existing) throw duplicateTransaction(transref);

        await collection(ORDERS).insertOne(
          {
            _id: transref,
            ...order,
            uid: String(uid),
            transref,
            channel: 'AirtimeToCash',
            network: rate.network,
            atcNumber: rate.number,
            percent: rate.percent,
            amount: value,
            // Historical misspelling, kept until the legacy route is deleted.
            reciveAmount: receiveAmount,
            status: 'pending',
            validate: false,
            CreatedAt: new Date(),
          },
          { session }
        );
      });
    } catch (err) {
      // Two requests can pass the findOne check simultaneously; the unique
      // _id index is the real guard and turns the loser into the same 409.
      if (isDuplicateKey(err)) throw duplicateTransaction(transref);
      throw err;
    }

    res.status(201).json({
      message: 'Airtime-to-cash order placed',
      receiveAmount,
      reference: transref,
    });
  })
);

module.exports = router;
