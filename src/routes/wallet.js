const express = require('express');
const router = express.Router();
const { asyncHandler, authed } = require('../middleware');
const { finance } = require('../models/finance');
const { request, OK } = require('../models/http');
const { paystack } = require('../config/env');
const { paystackReference } = require('../models/reference');
const { validationFailed, providerUnavailable, paymentNotSuccessful } = require('../models/errors');

router.post(
  '/fund-wallet/verify',
  authed,
  asyncHandler(async (req, res) => {
    const { uid, reference } = req.body;
    if (!reference || typeof reference !== 'string') {
      throw validationFailed('A payment reference is required');
    }

    const verification = await request(
      `${paystack.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${paystack.secretKey()}` } }
    );

    if (verification.outcome !== OK) {
      throw providerUnavailable('Could not verify payment. Please try again.');
    }

    const data = verification.body?.data;
    if (!data || data.status !== 'success') {
      // Routed through errorHandler like every other error path, instead of a
      // bare {message} that skips the {status, code, msg} envelope.
      throw paymentNotSuccessful();
    }

    const amount = Number(data.amount) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw validationFailed('Payment is missing required account details');
    }

    // The uid comes from the session, not the payment metadata, and the credit
    // key is namespaced so it cannot collide with a purchase reference. The
    // legacy /fundwallet route and the /wenbook webhook must derive the same
    // _id from the Paystack reference or the idempotency guard cannot see
    // across them.
    const outcome = await finance.creditWallet({
      uid,
      amount,
      transref: paystackReference(data.reference),
      meta: {
        email: data.metadata?.email ?? null,
        channel: 'Wallet',
        paychannel: data.channel ?? null,
        paidAt: data.paidAt ?? data.paid_at ?? null,
        source: 'verify-v2',
      },
    });

    res.json({
      wallet: await finance.getBalance(uid),
      message: outcome.changed
        ? 'Wallet funded successfully'
        : 'This payment has already been credited',
    });
  })
);

module.exports = router;
