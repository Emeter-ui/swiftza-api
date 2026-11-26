const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const funding = require('../models/funding');
const guestOrders = require('../models/guest-orders');
const { paystack } = require('../config/env');

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

    const transref = event.data?.reference;
    const amount = Number(event.data?.amount) / 100;

    if (!transref || !Number.isFinite(amount) || amount <= 0) {
      console.error('[webhook] malformed charge event', { transref, amount });
      return;
    }

    // Guest quick-buy orders are paid for directly, not credited to a wallet.
    if (guestOrders.isGuestReference(transref)) {
      await guestOrders.fulfil(transref, event.data, 'webhook');
      return;
    }

    // The owner comes from the server-side funding intent when there is one
    // (the inline popup does not send metadata.id), falling back to metadata
    // for payments started by older clients. The credit amount comes from the
    // fee engine; the idempotency key is shared with both verify routes.
    const outcome = await funding.creditFromPaystack({ data: event.data, sessionUid: null, source: 'webhook' });

    if (!outcome.changed) {
      console.log(`[webhook] ${transref} already credited, ignoring replay`);
    }
  } catch (err) {
    console.error('[webhook] processing failed:', err);
  }
});

module.exports = router;
