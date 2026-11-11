const express = require('express');
const router = express.Router();
const { collection } = require('../../services/mongo');
// CREDIT_MODES is shared with the presenters module rather than redeclared
// here, so the wallet-credit whitelist has one source of truth instead of two
// hand-synchronised copies drifting apart.
const { toIso, CREDIT_MODES } = require('../../presenters');
const { asyncHandler } = require('../../middleware');

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

// The page's tabs are a fixed set. Matching against a whitelist rather than
// building a regex from the query string means a caller cannot pass `.*` (or a
// catastrophically backtracking pattern) and have it run against the collection.
const PURCHASE_KINDS = ['airtime', 'data', 'cable', 'electricity', 'epin'];

// /buyepin (still mounted) writes transType 'Epins' while /purchases writes
// 'Epin', so without this the older rows land under a kind no tab renders.
const KIND_ALIASES = Object.assign(Object.create(null), { epins: 'epin' });

// Matches the customer contract's `transaction` presenter so the two cannot
// drift: 'Data-Reversed' and 'Data-Pending' both fold to 'data'.
function purchaseKind(transType) {
  const raw = String(transType ?? '').split('-')[0].trim().toLowerCase() || null;
  return raw ? KIND_ALIASES[raw] ?? raw : null;
}

// The admin feed spans two collections whose ids are unrelated, so the cursor
// cannot be an _id. It is the compound {CreatedAt, _id} of the last row, with
// _id breaking ties between rows written in the same millisecond.
function encodeCursor(row) {
  const at = row.CreatedAt instanceof Date ? row.CreatedAt : null;
  // A row with an unusable CreatedAt must not take down the whole feed. Returning
  // null ends pagination here rather than throwing out of the request.
  if (!at || Number.isNaN(at.getTime())) {
    console.warn('[admin/transactions] row %s has an unusable CreatedAt; feed truncated here', row._id);
    return null;
  }
  return Buffer.from(JSON.stringify({ t: at.toISOString(), i: row._id })).toString('base64url');
}

function decodeCursor(raw) {
  try {
    const { t, i } = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    return { at: new Date(t), id: i };
  } catch {
    return null;
  }
}

router.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const parsed = Number(req.query.limit);
    const size = Math.min(Math.max(Number.isFinite(parsed) ? parsed : DEFAULT_PAGE, 1), MAX_PAGE);

    const kind = req.query.kind ? String(req.query.kind).trim().toLowerCase() : null;
    const wantsWallet = kind === 'wallet';

    const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : null;
    const range = cursor
      ? {
          $or: [
            { CreatedAt: { $lt: cursor.at } },
            { CreatedAt: cursor.at, _id: { $lt: cursor.id } },
          ],
        }
      : {};

    const project = (source) => ({
      $project: {
        _id: 1, uid: 1, amount: 1, status: 1, CreatedAt: 1,
        transType: 1, transref: 1, message: 1, mode: 1, channel: 1,
        source: { $literal: source },
      },
    });

    // One pipeline: the database merges and sorts, so a page is correct without
    // reading both collections into memory.
    // An unknown kind matches nothing rather than silently returning everything.
    const purchaseMatch = wantsWallet
      // The wallet feed comes entirely from the $unionWith branch below. Matching
      // nothing here is what stops the pipeline scanning all of TRANSACTIONS only
      // to discard every row at the trailing $match.
      ? { _id: { $exists: false } }
      : kind
        ? PURCHASE_KINDS.includes(kind)
          ? { ...range, transType: { $regex: `^${kind}`, $options: 'i' } }
          : { _id: { $exists: false } }
        : range;

    const pipeline = [{ $match: purchaseMatch }, project('purchase')];

    if (!kind || wantsWallet) {
      pipeline.push({
        $unionWith: {
          coll: 'WALLETTRANSACTIONS',
          pipeline: [{ $match: range }, project('wallet')],
        },
      });
    }

    if (wantsWallet) {
      pipeline.push({ $match: { source: 'wallet' } });
    }

    pipeline.push({ $sort: { CreatedAt: -1, _id: -1 } }, { $limit: size + 1 });

    const rows = await collection('TRANSACTIONS').aggregate(pipeline).toArray();

    const hasMore = rows.length > size;
    const pageRows = hasMore ? rows.slice(0, size) : rows;

    // One USERS query for the whole page, never one per row.
    const uids = [...new Set(pageRows.map((r) => r.uid).filter(Boolean))];
    const owners = uids.length
      ? await collection('USERS')
          .find({ _id: { $in: uids } }, { projection: { username: 1, fullname: 1 } })
          .toArray()
      : [];
    const nameByUid = new Map(owners.map((u) => [u._id, u.username ?? u.fullname ?? null]));

    const transactions = pageRows.map((r) => ({
      id: String(r._id),
      userId: r.uid ?? null,
      username: nameByUid.get(r.uid) ?? null,
      kind: r.source === 'wallet' ? 'wallet' : purchaseKind(r.transType),
      label: r.source === 'wallet' ? r.channel ?? null : r.transType ?? null,
      type:
        r.source === 'wallet' && CREDIT_MODES.includes(r.mode) ? 'credit' : 'debit',
      amount: Number(r.amount) || 0,
      status: r.status ?? null,
      message: r.message ?? null,
      reference: r.transref ?? null,
      createdAt: toIso(r.CreatedAt),
    }));

    res.json({
      transactions,
      nextCursor: hasMore ? encodeCursor(pageRows[pageRows.length - 1]) : null,
    });
  })
);

// purchaseKind is also the service-name mapper admin/requery.js needs to turn a
// WALLETTRANSACTIONS row's `channel` into a provider service -- exported here so
// the two routes share one mapping instead of drifting apart by hand.
module.exports = router;
module.exports.purchaseKind = purchaseKind;
