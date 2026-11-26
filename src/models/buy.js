const { execute } = require('./purchase');
const { getDataPlan, cablePlanFrom, getEpin, validateAirtimeAmount, validateElectricityAmount } = require('./catalog');
const { resolveNetwork, resolveCable, resolveDisco } = require('./resolve');
const catalogRepo = require('../repositories/catalog');
const { purchaseReference } = require('./reference');
const { validationFailed } = require('./errors');
const { SERVICES } = require('../providers/contract');
const { serviceIdFor, planIdFor } = require('../providers/ids');

// The five purchases, shared by the signed-in routes (routes/purchases.js)
// and guest orders (models/guest-orders.js), so both charge, settle, refund
// and hold in exactly the same way. Moved here unchanged from purchases.js.

const PHONE_PATTERN = /^0\d{10}$/;

function requirePhone(value) {
  if (!PHONE_PATTERN.test(String(value ?? ''))) {
    throw validationFailed('Enter a valid 11-digit phone number');
  }
  return String(value);
}

// resultchecker.vue declares pins as string[], renders each entry directly and
// copies it to the clipboard -- so objects would render as "[object Object]"
// after the wallet has already been debited. Serial is included because a
// result-checker PIN is unusable without it.
// CheapDataHub nests its pins under data.delivery and joins serial and pin
// into one "<=>"-separated string, which passes through as-is.
function toPinStrings(raw) {
  const wire = raw?.pins ?? raw?.data?.delivery?.pins;
  const list = Array.isArray(wire) ? wire : [];
  return list
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      const pin = String(entry?.pin ?? entry?.Pin ?? '').trim();
      const serial = String(entry?.serial ?? entry?.Serial ?? '').trim();
      if (!pin) return '';
      return serial ? `${serial} / ${pin}` : pin;
    })
    .filter(Boolean);
}

const tokenFrom = (raw) => raw?.token ?? raw?.Token ?? raw?.data?.token ?? null;

/**
 * Checks an order completely and prices it from the catalog, without moving
 * any money. Guest orders are priced with this before Paystack is opened, so
 * a bad plan or number is refused before the customer pays.
 */
async function price(service, body = {}) {
  switch (service) {
    case 'data': {
      const phone = requirePhone(body.phone);
      const { doc } = await resolveNetwork(body.network);
      const plan = await getDataPlan({ docid: body.planId });
      if (plan.raw.networkId && String(plan.raw.networkId) !== String(doc.docid)) {
        throw validationFailed('That plan belongs to a different network');
      }
      return { price: plan.price, label: `${doc.name} ${plan.raw.Size ?? ''} data`.replace(/\s+/g, ' ').trim(), recipient: phone };
    }
    case 'airtime': {
      const phone = requirePhone(body.phone);
      const { doc } = await resolveNetwork(body.network);
      return { price: validateAirtimeAmount(body.amount), label: `${doc.name} airtime`, recipient: phone };
    }
    case 'cable': {
      if (!body.smartcard) throw validationFailed('Smart card number is required');
      const { doc } = await resolveCable(body.provider);
      const planDoc = await catalogRepo.findById('CABLESPLAN', String(body.planId));
      if (!planDoc) throw validationFailed('Unknown cable plan', { planId: body.planId });
      const plan = cablePlanFrom(planDoc);
      return { price: plan.price, label: `${doc.CableName} · ${plan.label}`, recipient: String(body.smartcard) };
    }
    case 'electricity': {
      if (!body.meter) throw validationFailed('Meter number is required');
      requirePhone(body.phone);
      const { doc } = await resolveDisco(body.disco);
      return { price: validateElectricityAmount(body.amount), label: `${doc.Disconame} electricity`, recipient: String(body.meter) };
    }
    case 'exam': {
      const examDoc = await catalogRepo.findById('EPIN', String(body.examId));
      if (!examDoc) throw validationFailed('Unknown exam type', { examId: body.examId });
      const pin = await getEpin(examDoc.examName, body.quantity);
      return { price: pin.price, label: `${examDoc.examName} PIN × ${pin.quantity}`, recipient: null };
    }
    default:
      throw validationFailed('Choose what to buy');
  }
}

async function buyData(uid, { planId, network, phone }) {
  const mobile = requirePhone(phone);

  // Resolved before any money moves, so a bad name is a clean 422.
  const { doc: networkDoc } = await resolveNetwork(network);
  // Price and provider plan id come from the catalog, never the request body.
  const plan = await getDataPlan({ docid: planId });
  const transref = purchaseReference();

  return execute({
    uid,
    transref,
    channel: 'Data',
    createdAt: new Date().toISOString(),
    service: SERVICES.DATA,
    amount: plan.price,
    transType: 'Data',
    // Ids are picked against the provider instance that will actually be
    // invoked, before reserveFunds, so a catalog row missing that provider's
    // column throws before the customer is charged.
    prepare: (provider) => ({
      networkId: serviceIdFor(provider.name, 'data', networkDoc),
      planId: planIdFor(provider.name, 'data', plan.raw),
    }),
    invoke: (provider, ids) =>
      provider.buyData({ networkId: ids.networkId, phone: mobile, planId: ids.planId, transref }),
  });
}

async function buyAirtime(uid, { network, amount, phone }) {
  const mobile = requirePhone(phone);

  const { doc: networkDoc } = await resolveNetwork(network);
  const purchaseAmount = validateAirtimeAmount(amount);
  const transref = purchaseReference();

  return execute({
    uid,
    transref,
    channel: 'Airtime',
    createdAt: new Date().toISOString(),
    service: SERVICES.AIRTIME,
    amount: purchaseAmount,
    transType: 'Airtime',
    prepare: (provider) => ({
      networkId: serviceIdFor(provider.name, 'airtime', networkDoc),
    }),
    invoke: (provider, ids) =>
      provider.buyAirtime({
        networkId: ids.networkId,
        phone: mobile,
        amount: purchaseAmount,
        airtimeType: 'VTU',
        transref,
      }),
  });
}

async function buyCable(uid, { provider: providerName, planId, smartcard }) {
  if (!smartcard) throw validationFailed('Smart card number is required');

  const { doc: cableDoc } = await resolveCable(providerName);
  // Priced straight from the document, not re-fetched by a legacy numeric id,
  // so a plan carrying only one provider's id still sells.
  const planDoc = await catalogRepo.findById('CABLESPLAN', String(planId));
  if (!planDoc) throw validationFailed('Unknown cable plan', { planId });
  const plan = cablePlanFrom(planDoc);
  const transref = purchaseReference();

  return execute({
    uid,
    transref,
    channel: 'Cable',
    createdAt: new Date().toISOString(),
    service: SERVICES.CABLE,
    amount: plan.price,
    transType: 'Cable',
    prepare: (provider) => ({
      cableId: serviceIdFor(provider.name, 'cable', cableDoc),
      planId: planIdFor(provider.name, 'cable', plan.raw),
    }),
    invoke: (p, ids) =>
      p.buyCable({ cableId: ids.cableId, planId: ids.planId, smartCard: smartcard, transref }),
  });
}

async function buyElectricity(uid, { disco, meterType, meter, amount, phone }) {
  if (!meter) throw validationFailed('Meter number is required');
  const mobile = requirePhone(phone);

  const { doc: discoDoc } = await resolveDisco(disco);
  const purchaseAmount = validateElectricityAmount(amount);
  const transref = purchaseReference();

  const result = await execute({
    uid,
    transref,
    channel: 'Electricity',
    createdAt: new Date().toISOString(),
    service: SERVICES.ELECTRICITY,
    amount: purchaseAmount,
    transType: 'Electricity',
    prepare: (provider) => ({
      discoId: serviceIdFor(provider.name, 'electricity', discoDoc),
    }),
    invoke: (p, ids) =>
      p.buyElectricity({
        discoId: ids.discoId, meterNumber: meter, meterType,
        amount: purchaseAmount, phone: mobile, transref,
      }),
  });
  // The meter token is what the customer actually needs; it lives on the
  // provider's raw response.
  return { ...result, token: tokenFrom(result.raw) };
}

async function buyExam(uid, { examId, quantity }) {
  const examDoc = await catalogRepo.findById('EPIN', String(examId));
  if (!examDoc) throw validationFailed('Unknown exam type', { examId });
  const pin = await getEpin(examDoc.examName, quantity);
  const transref = purchaseReference();

  const result = await execute({
    uid,
    transref,
    channel: 'Epin',
    createdAt: new Date().toISOString(),
    service: SERVICES.EPIN,
    amount: pin.price,
    transType: 'Epin',
    prepare: (provider) => ({
      examId: serviceIdFor(provider.name, 'epin', examDoc),
    }),
    invoke: (p, ids) => p.buyEpin({ examName: ids.examId, quantity: pin.quantity, transref }),
  });
  return { ...result, pins: toPinStrings(result.raw) };
}

const BUYERS = { data: buyData, airtime: buyAirtime, cable: buyCable, electricity: buyElectricity, exam: buyExam };

module.exports = { BUYERS, price, requirePhone, toPinStrings, buyData, buyAirtime, buyCable, buyElectricity, buyExam };
