// Canonical result shape every provider adapter must return. Routes read only
// these values, never a provider's own field names, so swapping providers
// cannot change control flow.

const SUCCESS = 'success';
const FAILED = 'failed';
// Upstream state is genuinely unknown (timeout, 5xx, unparseable body). The
// purchase may or may not have been fulfilled, so the balance must NOT be
// reversed. These are held for reconciliation instead.
const PENDING = 'pending';

const SERVICES = Object.freeze({
  DATA: 'data',
  AIRTIME: 'airtime',
  CABLE: 'cable',
  ELECTRICITY: 'electricity',
  EPIN: 'epin',
});

// `earning` is what the provider paid us for this transaction, as a structured
// block rather than buried in `raw` -- see providers/vtpass.js extractEarning.
// Optional: an adapter that reports nothing leaves it null, and the finance
// layer stores null rather than zero, because "not reported" and "earned
// nothing" are different facts.
function success(message, { reference = null, raw = null, earning = null, extra = {} } = {}) {
  return { status: SUCCESS, message, reference, raw, earning, ...extra };
}

function failed(message, { reference = null, raw = null, extra = {} } = {}) {
  return { status: FAILED, message, reference, raw, ...extra };
}

function pending(message, { reason = null, raw = null, extra = {} } = {}) {
  return { status: PENDING, message, reason, reference: null, raw, ...extra };
}

// Providers report errors in wildly different shapes: a string, an array of
// strings, an object of field errors. The old code did `data.error[0]`, which
// silently produced a single character when the error was a string.
function extractMessage(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const first = value.find(Boolean);
    return first ? extractMessage(first, fallback) : fallback;
  }
  if (typeof value === 'object') {
    for (const key of ['message', 'msg', 'detail', 'error', 'response_description']) {
      if (value[key]) return extractMessage(value[key], fallback);
    }
    const first = Object.values(value).find(Boolean);
    return first ? extractMessage(first, fallback) : fallback;
  }
  return String(value);
}

module.exports = {
  SUCCESS,
  FAILED,
  PENDING,
  SERVICES,
  success,
  failed,
  pending,
  extractMessage,
};
