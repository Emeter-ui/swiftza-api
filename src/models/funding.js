const crypto = require('crypto');
const fees = require('./fees');
const feeRepo = require('../repositories/fees');
const { finance } = require('./finance');
const { paystackReference } = require('./reference');
const { AppError } = require('./errors');
const logger = require('../services/logger');

// How long a quoted reference stays payable. After this the intent is still
// honoured if Paystack later reports it paid -- money already taken is never
// refused -- but the client is told to start over rather than reuse it.
const INTENT_TTL_MS = 60 * 60 * 1000;

function methodFromPaystackChannel(channel) {
  const c = String(channel || '').toLowerCase();
  if (c === 'ussd') return 'ussd';
  if (c === 'bank_transfer' || c === 'dedicated_nuban' || c === 'bank') return 'transfer';
  return 'card';
}

function newReference() {
  return `SWZ-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
}

// Quote, then persist what was quoted under a server-chosen reference. The
// client pays exactly `charge` with that reference, and whichever credit
// writer sees the payment first credits exactly `credit`.
async function initialize({ uid, email, amount, method }) {
  const config = await feeRepo.load();
  const q = fees.quote(config, { amount, method });
  const reference = newReference();
  await feeRepo.createIntent({
    _id: reference,
    uid: String(uid),
    email: email || null,
    method,
    amount: q.amount,
    quote: q,
    configVersion: config.version,
    expiresAt: new Date(Date.now() + INTENT_TTL_MS),
  });
  return { reference, quote: q };
}

// Decides what a successful Paystack charge is worth in wallet credit.
// `sessionUid` is set by the authenticated verify route; the webhook passes
// null and relies on the intent (or legacy metadata) for the owner.
async function resolveCredit({ data, sessionUid = null }) {
  const reference = String(data.reference || '');
  const paidKobo = Math.round(Number(data.amount));
  // A guest order's payment pays for that order only (models/guest-orders.js).
  // Without this, a signed-in user could quote a guest's reference to the
  // verify routes and have it credited to their own wallet.
  if (reference.startsWith('SWZG-')) {
    throw new AppError('GUEST_ORDER_PAYMENT', 'This payment belongs to a guest order, not a wallet top-up.', 409);
  }
  if (!reference || !Number.isFinite(paidKobo) || paidKobo <= 0) {
    throw new AppError('VALIDATION_FAILED', 'Payment is missing required account details', 422);
  }

  const intent = await feeRepo.findIntent(reference);
  const method = intent?.method || methodFromPaystackChannel(data.channel);

  if (intent) {
    if (sessionUid && intent.uid !== String(sessionUid)) {
      throw new AppError('FORBIDDEN', 'This payment belongs to a different account', 403);
    }
    const q = intent.quote;
    if (paidKobo >= q.chargeKobo) {
      // Overpayment (rare: a processor rounding up) goes to the customer.
      const creditKobo = q.creditKobo + (paidKobo - q.chargeKobo);
      return {
        uid: intent.uid,
        creditKobo,
        breakdown: {
          grossPaid: paidKobo / 100, fee: q.fee, tax: q.tax, totalFee: q.totalFee,
          feeMode: q.mode, feeRuleId: q.ruleId, feeRuleName: q.ruleName,
          requestedAmount: q.amount, method, inferred: false,
        },
        intent,
      };
    }
    // Underpaid against the quote: credit what the money actually covers
    // under today's rules, never the quoted figure.
    logger.warn({ reference, paidKobo, expected: q.chargeKobo }, 'funding intent underpaid');
    const config = await feeRepo.load();
    const r = fees.creditForPaid(config, { paidKobo, method });
    return {
      uid: intent.uid,
      creditKobo: r.creditKobo,
      breakdown: {
        grossPaid: paidKobo / 100, fee: r.feeKobo / 100, tax: r.taxKobo / 100, totalFee: (paidKobo - r.creditKobo) / 100,
        feeMode: r.mode, feeRuleId: r.ruleId, requestedAmount: q.amount, method, inferred: true, underpaid: true,
      },
      intent,
    };
  }

  // No intent: a payment started by an older client or outside the app.
  const uid = sessionUid || data.metadata?.id || null;
  if (!uid) throw new AppError('VALIDATION_FAILED', 'Payment is missing required account details', 422);
  const config = await feeRepo.load();
  const r = fees.creditForPaid(config, { paidKobo, method });
  return {
    uid: String(uid),
    creditKobo: r.creditKobo,
    breakdown: {
      grossPaid: paidKobo / 100, fee: r.feeKobo / 100, tax: r.taxKobo / 100, totalFee: (paidKobo - r.creditKobo) / 100,
      feeMode: r.mode, feeRuleId: r.ruleId, method, inferred: true,
    },
    intent: null,
  };
}

// The one path every Paystack credit writer goes through.
async function creditFromPaystack({ data, sessionUid = null, source }) {
  const resolved = await resolveCredit({ data, sessionUid });
  if (resolved.creditKobo <= 0) {
    if (resolved.intent) await feeRepo.markIntent(data.reference, { status: 'underpaid', paidKobo: Number(data.amount) });
    throw new AppError('FEE_EXCEEDS_AMOUNT', 'The amount paid does not cover the funding fee. Contact support with your reference.', 422, { reference: data.reference });
  }

  const outcome = await finance.creditWallet({
    uid: resolved.uid,
    amount: resolved.creditKobo / 100,
    transref: paystackReference(data.reference),
    meta: {
      email: data.metadata?.email ?? resolved.intent?.email ?? null,
      channel: 'Wallet',
      paychannel: data.channel ?? null,
      paidAt: data.paidAt ?? data.paid_at ?? null,
      source,
      paystackReference: String(data.reference),
      ...resolved.breakdown,
    },
  });

  if (resolved.intent && outcome.changed) {
    await feeRepo.markIntent(data.reference, {
      status: resolved.breakdown.underpaid ? 'underpaid' : 'credited',
      paidKobo: Number(data.amount),
      creditedKobo: resolved.creditKobo,
      creditedBy: source,
    }).catch((err) => logger.error({ err: err.message }, 'could not mark funding intent'));
  }

  return { ...outcome, uid: resolved.uid, credit: resolved.creditKobo / 100, breakdown: resolved.breakdown };
}

module.exports = { initialize, resolveCredit, creditFromPaystack, methodFromPaystackChannel, newReference, INTENT_TTL_MS };
