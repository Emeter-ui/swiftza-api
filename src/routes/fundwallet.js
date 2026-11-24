const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const funding = require('../models/funding');
const { request, OK } = require('../models/http');
const { paystack } = require('../config/env');
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

    const amount = Number(data.amount) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw validationFailed('Payment is missing required account details');
    }

    // Same fee engine and idempotency key as the webhook and
    // /fund-wallet/verify. The session uid wins over payment metadata.
    const outcome = await funding.creditFromPaystack({ data, sessionUid: req.body.uid, source: 'verify' });

    res.json({
      status: 'success',
      msg: outcome.changed
        ? 'Wallet funded successfully'
        : 'This payment has already been credited',
    });
  })
);

module.exports = router;
