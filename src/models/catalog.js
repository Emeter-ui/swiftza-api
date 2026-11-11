const catalogRepo = require('../repositories/catalog');
const { validationFailed } = require('./errors');
const { optionalInt } = require('../config/env');

const DATAPACKS = 'DATAPACKS';
const CABLESPLAN = 'CABLESPLAN';
const EPIN = 'EPIN';
const ATC = 'ATC';

// Prices are stored inconsistently: DATAPACKS uses a display string like
// "₦4200.0" while CABLESPLAN and EPIN use plain numbers.
function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value !== 'string') return NaN;
  const parsed = parseFloat(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed) : NaN;
}

async function queryOne(collectionName, field, value, label) {
  if (value === undefined || value === null || value === '') {
    throw validationFailed(`${label} is required`);
  }
  // MongoDB interprets a plain object as query operators (e.g. { $ne: null }
  // matches almost anything), where Firestore's where(field, '==', value) took
  // only scalars and matched nothing for a non-scalar. Rejecting anything that
  // is not a string or a finite number keeps a crafted request from resolving
  // an arbitrary catalog row instead of a clean 422.
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
    throw validationFailed(`${label} is invalid`);
  }
  const doc = await catalogRepo.findOne(collectionName, field, value);
  if (!doc) throw validationFailed(`Unknown ${label}`, { [field]: value });
  return doc;
}

function assertAvailable(item, label) {
  if (item.active === false) {
    throw validationFailed(`This ${label} is currently unavailable`);
  }
  return item;
}

// The authoritative price always comes from here, never from the request body.
// Previously the client sent both the plan id and the amount to deduct, so a
// crafted request could buy a 5GB plan for ₦1.
async function getDataPlan({ docid, dataId }) {
  let plan = null;

  if (docid) {
    // findById returns null for a malformed docid rather than throwing, so a
    // bad value falls through to the dataId lookup below.
    plan = await catalogRepo.findById(DATAPACKS, String(docid));
  }
  // Falls back to the provider plan id for clients that do not send the
  // Firestore document id.
  if (!plan && dataId !== undefined && dataId !== null) {
    plan = await queryOne(DATAPACKS, 'dataId', dataId, 'data plan');
  }
  if (!plan) throw validationFailed('Unknown data plan', { docid, dataId });

  assertAvailable(plan, 'data plan');

  const price = parsePrice(plan.Amount);
  if (!Number.isFinite(price) || price <= 0) {
    throw validationFailed('Data plan is misconfigured (invalid price)');
  }
  // No provider-id check here: a plan may carry only one provider's id.
  // prepare() (models/purchase.js, via providers/ids.js) refuses a plan
  // missing the routed provider's column, before any funds are reserved.

  return {
    price,
    providerPlanId: plan.dataId,
    label: `${plan.Network ?? ''} ${plan.Size ?? ''}`.trim(),
    raw: plan,
  };
}

async function getCablePlan(cablePlanId) {
  return cablePlanFrom(await queryOne(CABLESPLAN, 'CableplanID', cablePlanId, 'cable plan'));
}

// For callers that already hold the row (looked up by document id), so a plan
// with no CableplanID — e.g. a smeapi-only plan — is still priceable.
function cablePlanFrom(doc) {
  const plan = assertAvailable(doc, 'cable plan');

  const price = parsePrice(plan.amount);
  if (!Number.isFinite(price) || price <= 0) {
    throw validationFailed('Cable plan is misconfigured (invalid price)');
  }

  return {
    price,
    providerPlanId: plan.CableplanID,
    label: plan.CableplanName ?? 'Cable plan',
    raw: plan,
  };
}

async function getEpin(examName, quantity) {
  const pin = assertAvailable(
    await queryOne(EPIN, 'examName', examName, 'exam pin'),
    'exam pin'
  );

  const unitPrice = parsePrice(pin.amount);
  const qty = Number(quantity);

  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    throw validationFailed('Exam pin is misconfigured (invalid price)');
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
    throw validationFailed('Quantity must be a whole number between 1 and 20');
  }

  return {
    price: unitPrice * qty,
    unitPrice,
    quantity: qty,
    examName: pin.examName,
    label: `${pin.examName} x${qty}`,
    raw: pin,
  };
}

// Airtime-to-cash is settled by hand, so the commission is what decides how
// much the user is owed. The client sent both `percent` and `reciveAmount`,
// which meant an order could be placed at a 0% commission.
async function getAtcRate(network) {
  const entry = assertAvailable(
    await queryOne(ATC, 'network', network, 'airtime-to-cash network'),
    'airtime-to-cash network'
  );

  const percent = Number(entry.percent);
  if (!Number.isFinite(percent) || percent < 0 || percent >= 100) {
    throw validationFailed('Airtime-to-cash rate is misconfigured');
  }
  if (!entry.number) {
    throw validationFailed('Airtime-to-cash number is not configured');
  }

  return { percent, number: String(entry.number), network: entry.network };
}

// Airtime and electricity are variable-amount, so there is no catalog price to
// look up — they get bounds-checked instead.
const AIRTIME_MIN = optionalInt('AIRTIME_MIN_AMOUNT', 50);
const AIRTIME_MAX = optionalInt('AIRTIME_MAX_AMOUNT', 50000);
const ELECTRICITY_MIN = optionalInt('ELECTRICITY_MIN_AMOUNT', 500);
const ELECTRICITY_MAX = optionalInt('ELECTRICITY_MAX_AMOUNT', 100000);

function validateAmount(value, min, max, label) {
  const amount = Number(value);
  if (!Number.isInteger(amount)) {
    throw validationFailed(`${label} amount must be a whole number`);
  }
  if (amount < min || amount > max) {
    throw validationFailed(`${label} amount must be between ₦${min} and ₦${max}`);
  }
  return amount;
}

const validateAirtimeAmount = (value) =>
  validateAmount(value, AIRTIME_MIN, AIRTIME_MAX, 'Airtime');

const validateElectricityAmount = (value) =>
  validateAmount(value, ELECTRICITY_MIN, ELECTRICITY_MAX, 'Electricity');

module.exports = {
  parsePrice,
  getDataPlan,
  getCablePlan,
  cablePlanFrom,
  getEpin,
  getAtcRate,
  validateAirtimeAmount,
  validateElectricityAmount,
};
