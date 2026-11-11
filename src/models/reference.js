const crypto = require('crypto');

// References are namespaced by origin so the purchase key space and the
// Paystack credit key space cannot overlap. creditWallet's idempotency guard
// keys off `validate === true`, which settle() also sets on debit rows — so a
// Paystack reference equal to a settled purchase reference was previously
// treated as already-credited, silently dropping a real payment.
const PURCHASE_PREFIX = 'pur_';
const PAYSTACK_PREFIX = 'ps_';
const ADJUSTMENT_PREFIX = 'adj_';
const ATC_CREDIT_PREFIX = 'atc_credit_';

function purchaseReference() {
  return `${PURCHASE_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
}

function paystackReference(reference) {
  // Replace rather than strip: removing characters would map 'abc.def' and
  // 'abcdef' to the same key, and this value is the _id that makes wallet
  // credits idempotent — a collision silently drops a real payment.
  return `${PAYSTACK_PREFIX}${String(reference).replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function adjustmentReference() {
  return `${ADJUSTMENT_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
}

// Namespaced AND salted. The namespacing is the same reasoning as the other
// generators: the ATC order document's _id IS the bare transref, so the
// wallet credit's _id must be kept away from it (and from a Paystack/
// adjustment reference sharing the same WALLETTRANSACTIONS collection) or the
// two rows would collide. The salt is what the plain `atc_credit_<transref>`
// form used to be missing: for a legacy /place-order order, transref is
// client-chosen, so a deterministic reference built only from it is
// predictable by the customer and short enough to collide with a transref
// someone else claims through reserveFunds (whose TRANSREF_PATTERN spans the
// same character class) -- which throws a raw, uncaught E11000. Appending
// random hex, as purchaseReference/adjustmentReference already do, removes
// that predictability without giving up the `atc_credit_` prefix, whose
// disjointness from pur_/ps_/adj_ is load-bearing.
function atcCreditReference(transref) {
  return `${ATC_CREDIT_PREFIX}${transref}_${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  purchaseReference,
  paystackReference,
  adjustmentReference,
  atcCreditReference,
  PURCHASE_PREFIX,
  PAYSTACK_PREFIX,
  ADJUSTMENT_PREFIX,
  ATC_CREDIT_PREFIX,
};
