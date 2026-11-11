const express = require('express');
const router = express.Router();
const base = require('../../repositories/base');
const { collection } = require('../../services/mongo');
const { finance } = require('../../models/finance');
const { asyncHandler } = require('../../middleware');
const { validationFailed } = require('../../models/errors');
const { toIso } = require('../../presenters');

const ATCORDERS = 'ATCORDERS';

// Fixed whitelist the requested status is matched against before it ever
// reaches the query -- the same discipline admin/transactions.js applies to
// its `kind` filter, so a caller-supplied value cannot become a query operator.
const STATUSES = ['pending', 'success', 'rejected'];

// GET /admin/atc-orders -- the queue an operator works from. Defaults to the
// pending tab, since that is the only one anything can still be done about.
router.get(
  '/atc-orders',
  asyncHandler(async (req, res) => {
    const requested = req.query.status ? String(req.query.status).trim().toLowerCase() : 'pending';
    // An unknown status matches nothing rather than silently returning every
    // order -- mirrors the transactions feed's unknown-kind behaviour.
    const filter = STATUSES.includes(requested) ? { status: requested } : { _id: { $exists: false } };

    const { items, nextCursor } = await base.page(
      ATCORDERS,
      filter,
      { limit: req.query.limit, cursor: req.query.cursor }
    );

    // One USERS query for the whole page, never one per row, and only the
    // fields needed to label a row -- no raw user document is read.
    const uids = [...new Set(items.map((r) => r.uid).filter(Boolean))];
    const owners = uids.length
      ? await collection('USERS')
          .find({ _id: { $in: uids } }, { projection: { username: 1, fullname: 1 } })
          .toArray()
      : [];
    const nameByUid = new Map(owners.map((u) => [u._id, u.username ?? u.fullname ?? null]));

    res.json({
      items: items.map((r) => ({
        id: r.docid,
        reference: r.transref ?? null,
        userId: r.uid ?? null,
        username: nameByUid.get(r.uid) ?? null,
        network: r.network ?? null,
        atcNumber: r.atcNumber ?? null,
        percent: r.percent ?? null,
        // Historical misspelling in the stored document (`reciveAmount`) --
        // read as stored, presented under a clean name.
        claimedAmount: Number(r.amount) || 0,
        expectedAmount: Number(r.reciveAmount) || 0,
        status: r.status ?? null,
        createdAt: toIso(r.CreatedAt),
      })),
      nextCursor,
    });
  })
);

// PUT /admin/atc-orders/:id -- the operator's ruling, acted on by
// finance.approveAtcOrder / finance.rejectAtcOrder. Neither the payout
// arithmetic nor the pending check is repeated here: both live in the model,
// and a second copy is how the two would drift apart. The acting admin is
// always req.user.uid (populated by requireAdmin from a verified token),
// never the request body.
router.put(
  '/atc-orders/:id',
  asyncHandler(async (req, res) => {
    const { decision, reason, receivedAmount } = req.body || {};
    const orderId = req.params.id;

    let result;
    if (decision === 'approve') {
      result = await finance.approveAtcOrder({
        orderId,
        receivedAmount,
        adminUid: req.user.uid,
        reason,
      });
    } else if (decision === 'reject') {
      result = await finance.rejectAtcOrder({
        orderId,
        adminUid: req.user.uid,
        reason,
      });
    } else {
      throw validationFailed('Decision must be approve or reject', { decision });
    }

    // Both model methods return { changed: false } rather than throwing when
    // the order is not pending -- that is what tells an operator someone else
    // already handled it, so it becomes a 422 naming why.
    if (!result.changed) {
      throw validationFailed(`Cannot decide ATC order: ${result.reason}`, {
        orderId,
        reason: result.reason,
      });
    }

    res.json({
      id: orderId,
      status: decision === 'approve' ? 'success' : 'rejected',
      ...(decision === 'approve' ? { credited: result.credited } : {}),
    });
  })
);

module.exports = router;
