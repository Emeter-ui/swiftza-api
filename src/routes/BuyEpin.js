const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const { execute } = require('../models/purchase');
const { getEpin } = require('../models/catalog');
const { SERVICES } = require('../providers/contract');
const { serviceIdFor } = require('../providers/ids');

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { uid, transref, channel, createdAt, exam_name, quantity } = req.body;

    // Unit price and total come from the catalog; the client-sent amount and
    // exam_price are ignored.
    const pin = await getEpin(exam_name, quantity);

    const result = await execute({
      uid,
      transref,
      channel,
      createdAt,
      service: SERVICES.EPIN,
      amount: pin.price,
      transType: 'Epins',
      prepare: (provider) => ({ examId: serviceIdFor(provider.name, 'epin', pin.raw) }),
      invoke: (provider, ids) =>
        provider.buyEpin({
          examName: ids.examId,
          quantity: pin.quantity,
          transref,
        }),
    });

    res.status(result.httpStatus).json({ status: result.status, msg: result.msg });
  })
);

module.exports = router;
