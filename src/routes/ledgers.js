const express = require('express');
const router = express.Router();
const ledger = require('../repositories/ledger');
const P = require('../presenters');
const { asyncHandler, requireAuth } = require('../middleware');

// Owner filtering happens in the query, using the {uid, CreatedAt} and
// {userId, CreatedAt} indexes. WALLETTRANSACTIONS records the owner under
// either key depending on which code path wrote the row.
router.get(
  '/transactions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await ledger.listByOwner('TRANSACTIONS', req.user.uid, ['uid']);
    res.json(rows.map(P.transaction));
  })
);

router.get(
  '/wallet-summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await ledger.listByOwner('WALLETTRANSACTIONS', req.user.uid, ['uid', 'userId']);
    res.json(rows.map(P.walletEntry));
  })
);

module.exports = router;
