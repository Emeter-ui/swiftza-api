const express = require('express');
const router = express.Router();
const base = require('../../repositories/base');
const guestOrders = require('../../models/guest-orders');
const audit = require('../../models/audit');
const { asyncHandler } = require('../../middleware');

const STATUSES = Object.values(guestOrders.STATUS);

// GET /admin/guest-orders?status=refund_failed -- newest first.
router.get('/guest-orders', asyncHandler(async (req, res) => {
  const filter = STATUSES.includes(req.query.status) ? { status: req.query.status } : {};
  const { items, nextCursor } = await base.page(guestOrders.ORDERS, filter, { limit: req.query.limit, cursor: req.query.cursor });
  res.json({
    items: items.map((o) => ({
      ...guestOrders.publicView({ ...o, _id: o.docid }),
      guest: { name: o.guest?.name, email: o.guest?.email },
      paid: o.paidKobo ? o.paidKobo / 100 : null,
      purchaseRef: o.purchaseRef || null,
      refundReason: o.refundReason || null,
      refundError: o.refundError || null,
      ip: o.ip || null,
    })),
    nextCursor,
  });
}));

// POST /admin/guest-orders/:reference/refund -- retry a refund Paystack refused.
router.post('/guest-orders/:reference/refund', asyncHandler(async (req, res) => {
  const order = await guestOrders.retryRefund(req.params.reference);
  await audit.record({ action: 'guest-order.refund-retry', adminUid: req.user.uid, details: { reference: req.params.reference, status: order.status } });
  res.json(guestOrders.publicView(order));
}));

module.exports = router;
