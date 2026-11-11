const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const { execute } = require('../models/purchase');
const { validateAirtimeAmount } = require('../models/catalog');
const { resolveNetworkById } = require('../models/resolve');
const { validationFailed } = require('../models/errors');
const { SERVICES } = require('../providers/contract');
const { serviceIdFor } = require('../providers/ids');

const PHONE_PATTERN = /^0\d{10}$/;

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const {
      uid,
      transref,
      channel,
      createdAt,
      mobile_number,
      network,
      airtime_type,
      amount,
    } = req.body;

    if (!PHONE_PATTERN.test(String(mobile_number ?? ''))) {
      throw validationFailed('Enter a valid 11-digit phone number');
    }
    if (network === undefined || network === null) {
      throw validationFailed('Select a network');
    }

    // Airtime has no catalog price, so the client-supplied amount is bounded
    // rather than looked up.
    const purchaseAmount = validateAirtimeAmount(amount);
    // network is the internal numeric id sent by samzeedatas. The catalog
    // row it identifies is looked up here so serviceIdFor can read whichever
    // provider column the active provider needs.
    const { doc: networkDoc } = await resolveNetworkById(network);

    const result = await execute({
      uid,
      transref,
      channel,
      createdAt,
      service: SERVICES.AIRTIME,
      amount: purchaseAmount,
      transType: 'Airtime',
      prepare: (provider) => ({
        networkId: serviceIdFor(provider.name, 'airtime', networkDoc),
      }),
      invoke: (provider, ids) =>
        provider.buyAirtime({
          networkId: ids.networkId,
          phone: mobile_number,
          amount: purchaseAmount,
          airtimeType: airtime_type,
          transref,
        }),
    });

    res.status(result.httpStatus).json({ status: result.status, msg: result.msg });
  })
);

module.exports = router;
