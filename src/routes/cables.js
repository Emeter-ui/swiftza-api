const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const { execute } = require('../models/purchase');
const { getCablePlan } = require('../models/catalog');
const { resolveCable, resolveCableById } = require('../models/resolve');
const { getProvider } = require('../providers');
const { validationFailed } = require('../models/errors');
const { SERVICES } = require('../providers/contract');
const { serviceIdFor, planIdFor, validateIdFor } = require('../providers/ids');

router.get(
  '/validate',
  asyncHandler(async (req, res) => {
    // samzeenuxt sends smartcard/provider; samzeedatas sends iucNumber/cableName.
    const iucNumber = req.query.iucNumber ?? req.query.smartcard;
    const cableName = req.query.cableName ?? req.query.provider;
    if (!iucNumber || !cableName) {
      throw validationFailed('Smart card number and cable provider are required');
    }

    const provider = await getProvider(SERVICES.CABLE);
    const { doc: cableDoc } = await resolveCable(cableName);
    const result = await provider.validateIuc({
      smartCard: iucNumber,
      cableId: validateIdFor(provider.name, 'cable', cableDoc),
    });

    const customerName =
      result.data?.name ?? result.data?.customer_name ?? result.data?.Customer_Name ?? null;
    res.status(result.valid ? 200 : 422).json({ ...result, customerName });
  })
);

router.post(
  '/buy',
  asyncHandler(async (req, res) => {
    const { uid, transref, channel, createdAt, cableID, cablePlanId, iuc } =
      req.body;

    if (!iuc) throw validationFailed('Smart card number is required');
    if (cableID === undefined || cableID === null) {
      throw validationFailed('Select a cable provider');
    }

    const plan = await getCablePlan(cablePlanId);
    // cableID is the internal numeric id sent by samzeedatas. The catalog
    // row it identifies is looked up here so serviceIdFor/planIdFor can read
    // whichever provider column the active provider needs.
    const { doc: cableDoc } = await resolveCableById(cableID);

    const result = await execute({
      uid,
      transref,
      channel,
      createdAt,
      service: SERVICES.CABLE,
      amount: plan.price,
      transType: 'Cable',
      prepare: (provider) => ({
        cableId: serviceIdFor(provider.name, 'cable', cableDoc),
        planId: planIdFor(provider.name, 'cable', plan.raw),
      }),
      invoke: (provider, ids) =>
        provider.buyCable({
          cableId: ids.cableId,
          planId: ids.planId,
          smartCard: iuc,
          transref,
        }),
    });

    res.status(result.httpStatus).json({ status: result.status, msg: result.msg });
  })
);

module.exports = router;
