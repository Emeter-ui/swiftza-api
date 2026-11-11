const express = require('express');
const router = express.Router();
const { asyncHandler, authed } = require('../middleware');
const { execute } = require('../models/purchase');
const { getDataPlan, cablePlanFrom, getEpin, validateAirtimeAmount, validateElectricityAmount } = require('../models/catalog');
const { resolveNetwork, resolveCable, resolveDisco } = require('../models/resolve');
const catalogRepo = require('../repositories/catalog');
const { purchaseReference } = require('../models/reference');
const { validationFailed } = require('../models/errors');
const { SERVICES } = require('../providers/contract');
const { serviceIdFor, planIdFor } = require('../providers/ids');

const PHONE_PATTERN = /^0\d{10}$/;

function requirePhone(value) {
  if (!PHONE_PATTERN.test(String(value ?? ''))) {
    throw validationFailed('Enter a valid 11-digit phone number');
  }
  return String(value);
}

const reply = (res, result) =>
  res.status(result.httpStatus).json({
    wallet: result.wallet,
    message: result.msg,
    reference: result.reference,
    // Additive: buy-data.vue and its siblings currently show a green success
    // toast for a provider decline or the 202-pending case because reply()
    // dropped execute()'s status. Adding it here unblocks that page fix
    // without changing this route's behaviour.
    status: result.status,
  });

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

router.post(
  '/buy-data',
  authed,
  asyncHandler(async (req, res) => {
    const { uid, planId, network, phone } = req.body;
    const mobile = requirePhone(phone);

    // Resolved before any money moves, so a bad name is a clean 422.
    const { doc: networkDoc } = await resolveNetwork(network);
    // Price and provider plan id come from the catalog, never the request body.
    const plan = await getDataPlan({ docid: planId });
    const transref = purchaseReference();

    const result = await execute({
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

    reply(res, result);
  })
);

router.post(
  '/buy-airtime',
  authed,
  asyncHandler(async (req, res) => {
    const { uid, network, amount, phone } = req.body;
    const mobile = requirePhone(phone);

    const { doc: networkDoc } = await resolveNetwork(network);
    const purchaseAmount = validateAirtimeAmount(amount);
    const transref = purchaseReference();

    const result = await execute({
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

    reply(res, result);
  })
);

router.post(
  '/buy-cable',
  authed,
  asyncHandler(async (req, res) => {
    const { uid, provider: providerName, planId, smartcard } = req.body;
    if (!smartcard) throw validationFailed('Smart card number is required');

    const { doc: cableDoc } = await resolveCable(providerName);
    // Priced straight from the document, not re-fetched by a legacy numeric id,
    // so a plan carrying only one provider's id still sells.
    const planDoc = await catalogRepo.findById('CABLESPLAN', String(planId));
    if (!planDoc) throw validationFailed('Unknown cable plan', { planId });
    const plan = cablePlanFrom(planDoc);
    const transref = purchaseReference();

    const result = await execute({
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

    reply(res, result);
  })
);

router.post(
  '/buy-electricity',
  authed,
  asyncHandler(async (req, res) => {
    const { uid, disco, meterType, meter, amount, phone } = req.body;
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
    res.status(result.httpStatus).json({
      wallet: result.wallet,
      message: result.msg,
      reference: result.reference,
      status: result.status,
      token: result.raw?.token ?? result.raw?.Token ?? result.raw?.data?.token ?? null,
    });
  })
);

router.post(
  '/result-checker',
  authed,
  asyncHandler(async (req, res) => {
    const { uid, examId, quantity } = req.body;

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

    res.status(result.httpStatus).json({
      wallet: result.wallet,
      message: result.msg,
      reference: result.reference,
      status: result.status,
      pins: toPinStrings(result.raw),
    });
  })
);

module.exports = router;
