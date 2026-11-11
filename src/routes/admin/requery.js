const express = require('express');
const router = express.Router();
const base = require('../../repositories/base');
const { collection } = require('../../services/mongo');
const { finance } = require('../../models/finance');
const providers = require('../../providers');
const { PENDING, SERVICES } = require('../../providers/contract');
const { asyncHandler } = require('../../middleware');
const { validationFailed, AppError } = require('../../models/errors');
const { toIso } = require('../../presenters');
// WALLETTRANSACTIONS carries no `transType` -- that field lives on the
// separate TRANSACTIONS collection, written by finance.recordTransaction. The
// service-bearing field on a wallet row is `channel` (reserveFunds writes
// 'Data'/'Airtime'/'Cable'/'Electricity'/'Epin'), and admin/transactions.js's
// purchaseKind() already does exactly the lowercasing/aliasing this needs for
// its own `channel` field, so it is imported rather than re-implemented here.
const { purchaseKind } = require('./transactions');

const WALLET = 'WALLETTRANSACTIONS';

const KNOWN_SERVICES = new Set(Object.values(SERVICES));

function serviceFor(channel) {
  const kind = purchaseKind(channel);
  return kind && KNOWN_SERVICES.has(kind) ? kind : null;
}

// GET /admin/requery -- everything currently held for a human to reconcile.
router.get(
  '/requery',
  asyncHandler(async (req, res) => {
    const { items, nextCursor } = await base.page(
      WALLET,
      { status: 'requery' },
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
        reference: r.transref ?? r.docid,
        userId: r.uid ?? null,
        username: nameByUid.get(r.uid) ?? null,
        amount: Number(r.amount) || 0,
        reason: r.requeryReason ?? null,
        providerResponse: r.providerResponse ?? null,
        channel: r.channel ?? null,
        // holdForRequery writes this (finance.js) but the listing never
        // emitted it, so an operator triaging held money could not tell a
        // row held ten minutes ago from one held last week.
        flaggedAt: toIso(r.flaggedAt),
        // Whether /ask can reach the provider at all. The id itself stays on
        // the server -- the console needs to know the question is answerable,
        // not what it would ask. Rows held before this was persisted, swept
        // stale-pending rows, and every husmodata row report false.
        canAsk: Boolean(r.providerRequestId),
      })),
      nextCursor,
    });
  })
);

// POST /admin/requery/:transref/ask -- asks the provider what actually
// happened. This is evidence for the operator, never a money movement: it
// must not touch WALLETTRANSACTIONS, USERS or AUDITLOG. Whatever the provider
// answers (including `pending`, which covers every non-OK transport outcome)
// is passed through as-is, never upgraded to something more definite.
router.post(
  '/requery/:transref/ask',
  asyncHandler(async (req, res) => {
    const transref = String(req.params.transref);
    const row = await collection(WALLET).findOne({ _id: transref });
    if (!row) throw new AppError('NOT_FOUND', 'Held transaction not found', 404, { transref });

    const service = serviceFor(row.channel);
    if (!service) {
      return res.json({
        status: PENDING,
        message: `Could not determine a provider service from channel "${row.channel}"`,
      });
    }

    // Asked with the id the PROVIDER knows, not our own transref -- the two
    // are different strings and vtpass matches only on the former. Rows held
    // before that id was persisted, and rows swept from stale-pending, have
    // none. Asking anyway would return "could not confirm", which is
    // indistinguishable from the provider genuinely not knowing; saying so
    // plainly is the difference between "no answer" and "we never asked".
    if (!row.providerRequestId) {
      return res.json({
        status: PENDING,
        message:
          'No provider request id was recorded for this purchase, so it cannot '
          + 'be queried automatically. Check the provider dashboard for '
          + `reference ${row.providerReference || transref}.`,
      });
    }

    const provider = await providers.getProvider(service);
    const result = await provider.requery(row.providerRequestId);
    res.json({ status: result.status, message: result.message });
  })
);

// PUT /admin/requery/:transref -- the operator's ruling, acted on by
// finance.resolveRequery. The acting admin is always req.user.uid (populated
// by requireAdmin from a verified token), never the request body.
router.put(
  '/requery/:transref',
  asyncHandler(async (req, res) => {
    const { decision, reason } = req.body || {};
    const result = await finance.resolveRequery({
      transref: req.params.transref,
      decision,
      reason,
      adminUid: req.user.uid,
    });

    if (!result.changed) {
      throw validationFailed(`Cannot resolve requery: ${result.reason}`, {
        transref: req.params.transref,
        reason: result.reason,
      });
    }

    res.json({ status: result.status });
  })
);

module.exports = router;
