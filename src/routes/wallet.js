const express = require('express');
const router = express.Router();
const { asyncHandler, authed } = require('../middleware');
const { finance } = require('../models/finance');
const { request, OK } = require('../models/http');
const { paystack } = require('../config/env');
const funding = require('../models/funding');
const fees = require('../models/fees');
const feeRepo = require('../repositories/fees');
const users = require('../repositories/users');
const { validationFailed, providerUnavailable, paymentNotSuccessful } = require('../models/errors');

// What the Add Money screen needs before the customer types anything: the
// limits, and whether a fee applies at all. The rules themselves stay
// server-side; the screen asks for a quote per amount.
router.get(
  '/fund-wallet/config',
  authed,
  asyncHandler(async (req, res) => {
    const { settings, rules } = await feeRepo.load();
    res.json({
      minDeposit: settings.minDeposit,
      maxDeposit: settings.maxDeposit,
      feesEnabled: settings.enabled && rules.some((r) => r.active !== false),
      methods: fees.METHODS.filter((m) => m !== 'any'),
    });
  })
);

router.post(
  '/fund-wallet/quote',
  authed,
  asyncHandler(async (req, res) => {
    const config = await feeRepo.load();
    res.json({ quote: fees.quote(config, { amount: req.body.amount, method: req.body.method || 'card' }) });
  })
);

// Creates the server-side reference the Paystack popup must use. The client
// is told the exact kobo amount to charge; it does not compute fees itself.
router.post(
  '/fund-wallet/initialize',
  authed,
  asyncHandler(async (req, res) => {
    const { uid } = req.body;
    const user = await users.findByUid(uid);
    const { reference, quote } = await funding.initialize({
      uid,
      email: user?.email ?? null,
      amount: req.body.amount,
      method: req.body.method || 'card',
    });
    res.json({ reference, quote, chargeKobo: quote.chargeKobo, email: user?.email ?? null });
  })
);

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
      throw paymentNotSuccessful();
    }

    const amount = Number(data.amount) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw validationFailed('Payment is missing required account details');
    }

    // The uid comes from the session; a funding intent created for another
    // account is refused. The credit amount comes from the fee engine, and
    // the transref is derived the same way by the webhook and the legacy
    // /fundwallet route so the idempotency guard sees across all three.
    const outcome = await funding.creditFromPaystack({ data, sessionUid: uid, source: 'verify-v2' });

    res.json({
      wallet: await finance.getBalance(uid),
      credited: outcome.credit,
      fee: outcome.breakdown.totalFee,
      message: outcome.changed
        ? 'Wallet funded successfully'
        : 'This payment has already been credited',
    });
  })
);

module.exports = router;
