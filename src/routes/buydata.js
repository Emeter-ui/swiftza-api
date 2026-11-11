const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const { execute } = require('../models/purchase');
const { getDataPlan } = require('../models/catalog');
const { resolveNetworkById } = require('../models/resolve');
const { validationFailed } = require('../models/errors');
const { SERVICES } = require('../providers/contract');
const { serviceIdFor, planIdFor } = require('../providers/ids');

const PHONE_PATTERN = /^0\d{10}$/;

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { uid, transref, channel, createdAt, mobile, network_id, docid, dataId } =
      req.body;

    if (!PHONE_PATTERN.test(String(mobile ?? ''))) {
      throw validationFailed('Enter a valid 11-digit phone number');
    }
    if (network_id === undefined || network_id === null) {
      throw validationFailed('Select a network');
    }

    // Price and provider plan id come from the catalog, never the request body.
    const plan = await getDataPlan({ docid, dataId });
    // network_id is the internal numeric id sent by samzeedatas. The catalog
    // row it identifies is looked up here so serviceIdFor/planIdFor can read
    // whichever provider column the active provider needs.
    const { doc: networkDoc } = await resolveNetworkById(network_id);

    const result = await execute({
      uid,
      transref,
      channel,
      createdAt,
      service: SERVICES.DATA,
      amount: plan.price,
      transType: 'Data',
      prepare: (provider) => ({
        networkId: serviceIdFor(provider.name, 'data', networkDoc),
        planId: planIdFor(provider.name, 'data', plan.raw),
      }),
      invoke: (provider, ids) =>
        provider.buyData({
          networkId: ids.networkId,
          phone: mobile,
          planId: ids.planId,
          transref,
        }),
    });

    res.status(result.httpStatus).json({ status: result.status, msg: result.msg });
  })
);

module.exports = router;
