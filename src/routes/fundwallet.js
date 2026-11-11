const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const { finance } = require('../models/finance');
const { request, OK } = require('../models/http');
const { paystack } = require('../config/env');
const { paystackReference } = require('../models/reference');
const { validationFailed, providerUnavailable } = require('../models/errors');

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { reference } = req.body;

    if (!reference || typeof reference !== 'string') {
      throw validationFailed('A payment reference is required');
    }

    const verification = await request(
      `${paystack.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${paystack.secretKey()}` },
      }
    );

    if (verification.outcome !== OK) {
      throw providerUnavailable('Could not verify payment. Please try again.');
    }

    const data = verification.body?.data;

    if (!data || data.status !== 'success') {
      // The old version sent no response at all on this path, leaving the
      // client hanging until it timed out.
      return res
        .status(402)
        .json({ status: 'error', msg: 'Payment was not successful' });
    }

    const uid = data.metadata?.id;
    const amount = Number(data.amount) / 100;

    if (!uid || !Number.isFinite(amount) || amount <= 0) {
      throw validationFailed('Payment is missing required account details');
    }

    // Shares the idempotency key with the webhook and the new /fund-wallet/verify
    // route, so whichever arrives second is a no-op instead of a double credit.
    // All three credit writers must derive the same _id from the Paystack
    // reference or the idempotency guard cannot see across them.
    const outcome = await finance.creditWallet({
      uid,
      amount,
      transref: paystackReference(data.reference),
      meta: {
        email: data.metadata?.email ?? null,
        channel: 'Wallet',
        paychannel: data.channel ?? null,
        paidAt: data.paidAt ?? data.paid_at ?? null,
        source: 'verify',
      },
    });

    res.json({
      status: 'success',
      msg: outcome.changed
        ? 'Wallet funded successfully'
        : 'This payment has already been credited',
    });
  })
);

module.exports = router;
