const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { finance } = require('../models/finance');
const { paystack } = require('../config/env');
const { paystackReference } = require('../models/reference');

// Paystack signs the exact bytes it sent. The previous version hashed
// JSON.stringify(req.body), which re-serialises the parsed object and can
// differ from the original payload, so valid events could fail verification.
function isValidSignature(rawBody, signature) {
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha512', paystack.webhookSecret())
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/', async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');

  let valid;
  try {
    valid = isValidSignature(rawBody, req.headers['x-paystack-signature']);
  } catch (err) {
    console.error('[webhook] signature check failed:', err.message);
    return res.sendStatus(500);
  }

  if (!valid) {
    console.warn('[webhook] rejected event with invalid signature');
    return res.sendStatus(401);
  }

  // Acknowledge immediately so Paystack does not retry while we work.
  res.sendStatus(200);

  try {
    const event = JSON.parse(rawBody.toString('utf8'));
    if (event.event !== 'charge.success' && event.data?.status !== 'success') {
      return;
    }

    const uid = event.data?.metadata?.id;
    const transref = event.data?.reference;
    const amount = Number(event.data?.amount) / 100;

    if (!uid || !transref || !Number.isFinite(amount) || amount <= 0) {
      console.error('[webhook] malformed charge event', { uid, transref, amount });
      return;
    }

    // Idempotent on transref, and the new balance is derived from the current
    // stored balance inside a transaction rather than from the stale value
    // Paystack captured in metadata at checkout time. Namespaced so this
    // shares the idempotency key with the legacy /fundwallet and new
    // /fund-wallet/verify routes — all three credit writers must derive the
    // same _id from the Paystack reference or the idempotency guard cannot
    // see across them.
    const outcome = await finance.creditWallet({
      uid,
      amount,
      transref: paystackReference(transref),
      meta: {
        email: event.data?.metadata?.email ?? null,
        channel: 'Wallet',
        paychannel: event.data?.channel ?? null,
        paidAt: event.data?.paid_at ?? null,
        source: 'webhook',
      },
    });

    if (!outcome.changed) {
      console.log(`[webhook] ${transref} already credited, ignoring replay`);
    }
  } catch (err) {
    console.error('[webhook] processing failed:', err);
  }
});

module.exports = router;
