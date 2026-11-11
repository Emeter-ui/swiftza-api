const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const { execute } = require('../models/purchase');
const { validateElectricityAmount } = require('../models/catalog');
const { resolveDisco, resolveDiscoById } = require('../models/resolve');
const { getProvider } = require('../providers');
const { validationFailed } = require('../models/errors');
const { SERVICES } = require('../providers/contract');
const { serviceIdFor, validateIdFor } = require('../providers/ids');

router.get(
  '/validate',
  asyncHandler(async (req, res) => {
    // samzeenuxt sends meter/disco/type; samzeedatas sends
    // meterNumber/disconame/mtype.
    const meterNumber = req.query.meterNumber ?? req.query.meter;
    const disconame = req.query.disconame ?? req.query.disco;
    const mtype = req.query.mtype ?? req.query.type;
    if (!meterNumber || !disconame) {
      throw validationFailed('Meter number and disco are required');
    }

    const provider = await getProvider(SERVICES.ELECTRICITY);
    const { doc: discoDoc } = await resolveDisco(disconame);
    const result = await provider.validateMeter({
      meterNumber,
      discoId: validateIdFor(provider.name, 'electricity', discoDoc),
      meterType: mtype,
    });

    const customerName =
      result.data?.name ?? result.data?.customer_name ?? result.data?.Customer_Name ?? null;
    res.status(result.valid ? 200 : 422).json({ ...result, customerName });
  })
);

router.post(
  '/buy',
  asyncHandler(async (req, res) => {
    const {
      uid,
      transref,
      channel,
      createdAt,
      DiscoID,
      meterno,
      meterType,
      amount,
    } = req.body;

    if (!meterno) throw validationFailed('Meter number is required');
    if (DiscoID === undefined || DiscoID === null) {
      throw validationFailed('Select an electricity provider');
    }

    // Variable-amount service, so the client amount is bounded rather than
    // looked up from a catalog.
    const purchaseAmount = validateElectricityAmount(amount);
    // DiscoID is the internal numeric id sent by samzeedatas. The catalog
    // row it identifies is looked up here so serviceIdFor can read whichever
    // provider column the active provider needs.
    const { doc: discoDoc } = await resolveDiscoById(DiscoID);

    const result = await execute({
      uid,
      transref,
      channel,
      createdAt,
      service: SERVICES.ELECTRICITY,
      amount: purchaseAmount,
      transType: 'Electricity',
      prepare: (provider) => ({
        discoId: serviceIdFor(provider.name, 'electricity', discoDoc),
      }),
      invoke: (provider, ids) =>
        provider.buyElectricity({
          discoId: ids.discoId,
          meterNumber: meterno,
          meterType,
          amount: purchaseAmount,
          transref,
        }),
    });

    res.status(result.httpStatus).json({ status: result.status, msg: result.msg });
  })
);

module.exports = router;
