// What each service actually earns, against a rate the operator maintains.
//
// Two things about this report are deliberate and load-bearing:
//
// 1. Earnings are summed from `providerEarning` -- derived at capture time as
//    amount - total_amount, the provider's own ledger movement -- and NEVER
//    from `providerReportedEarning`, the figure the provider claimed. On an
//    earlier, separate 100 naira purchase VTpass claimed 4 while charging
//    96.5, so it actually paid 3.5. (The fixture captured for this branch
//    happens to show the claim and the derived figure agreeing to within a
//    sub-ULP float error -- that is a property of that one transaction, not
//    a guarantee: the two are inconsistent BETWEEN transactions, which is
//    exactly why the derived value is authoritative and the claim is stored
//    only for comparison.) Summing the claim across a month would report
//    earnings the wallet never received. The claim is reported alongside,
//    as `totalReported`, so the gap is visible; it is never folded into the
//    total.
//
// 2. The expected rate is NOT discovered. It lives on a VTpass dashboard page
//    that their REST API does not expose, and a sandbox transaction is not a
//    substitute (sandbox reports 3.50% where the live card says 3.00%). It is
//    seeded and maintained by hand in PROVIDERRATES, so a stale number
//    produces a false alarm rather than silence -- the right direction to fail,
//    but only if it stays visible, which is why every row carries the
//    expectedRate it was compared against.
const express = require('express');
const router = express.Router();
const { collection } = require('../../services/mongo');
const { asyncHandler } = require('../../middleware');
const { validationFailed } = require('../../models/errors');
const { purchaseKind } = require('./transactions');

const TRANSACTIONS = 'TRANSACTIONS';
const RATES = 'PROVIDERRATES';

// Half a kobo. Float arithmetic on naira sums lands a hair either side of the
// exact figure, and a shortfall of 0.0000001 is not a shortfall.
const EPSILON = 0.005;

const round2 = (n) => Math.round(n * 100) / 100;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value, label, fallback) {
  if (value === undefined || value === '') return fallback;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) {
    throw validationFailed(`${label} is not a date`, { [label]: value });
  }
  // The console's <input type="date"> submits a bare "2026-09-30", which
  // parses to that day's midnight. To an operator picking a date, "to"
  // means the whole day -- but $lte against midnight would silently drop
  // every transaction from the rest of it. So a date-only `to` is pushed to
  // the last instant of that day; a value that already carries a time is
  // trusted exactly as given. (`from` needs no such push: its midnight
  // already is the start of the day the operator meant.)
  if (label === 'to' && DATE_ONLY.test(String(value))) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}

router.get(
  '/earnings',
  asyncHandler(async (req, res) => {
    const to = parseDate(req.query.to, 'to', new Date());
    const from = parseDate(
      req.query.from,
      'from',
      new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
    );

    // What the report can see at all, independent of the window asked for.
    // The structured fields did not exist before this feature shipped, so an
    // unqualified total would silently exclude every earlier transaction. The
    // console states this date rather than presenting a total as if it covered
    // all of history.
    const [oldest] = await collection(TRANSACTIONS)
      .find(
        { providerEarning: { $ne: null } },
        { projection: { CreatedAt: 1 }, sort: { CreatedAt: 1 }, limit: 1 }
      )
      .toArray();
    const covered = await collection(TRANSACTIONS).countDocuments({ providerEarning: { $ne: null } });

    // Bucketed by amount AND by the earning itself, not just by service. Both
    // are needed and neither is incidental: a per-transaction cap can only be
    // applied to a known per-transaction amount, and counting how many
    // transactions individually fell short needs the actual earning of each
    // bucket. Bucket count is bounded by the distinct (price, payout) pairs in
    // the window, which for a fixed provider rate is essentially the number of
    // distinct prices sold.
    const buckets = await collection(TRANSACTIONS)
      .aggregate([
        {
          $match: {
            status: 'success',
            providerEarning: { $ne: null },
            CreatedAt: { $gte: from, $lte: to },
          },
        },
        {
          $group: {
            _id: {
              provider: '$provider',
              transType: '$transType',
              amount: '$amount',
              earning: '$providerEarning',
            },
            count: { $sum: 1 },
            // Summed rather than derived from the bucket key: the reported
            // figure varies independently of the earned one, and a null on
            // some rows must not be read as a zero on all of them.
            reported: { $sum: { $ifNull: ['$providerReportedEarning', 0] } },
          },
        },
      ])
      .toArray();

    const rates = await collection(RATES).find({ active: { $ne: false } }).toArray();
    // Matched on the folded kind so an operator may type either 'Airtime' or
    // 'airtime' -- and so 'Epins' and 'Epin', both written by live routes,
    // resolve to the same rate.
    const rateFor = (provider, kind) =>
      rates.find(
        (r) => r.provider === provider && purchaseKind(r.matchesTransType) === kind
      ) ?? null;

    const groups = new Map();
    for (const b of buckets) {
      const provider = b._id.provider ?? null;
      const kind = purchaseKind(b._id.transType);
      const key = `${provider}::${kind}`;

      if (!groups.has(key)) {
        groups.set(key, {
          provider, kind, count: 0, totalCharged: 0, totalEarned: 0,
          totalReported: 0, expectedEarned: 0, belowExpectedCount: 0,
        });
      }
      const g = groups.get(key);
      const rate = rateFor(provider, kind);

      const amount = Number(b._id.amount) || 0;
      const earning = Number(b._id.earning) || 0;

      g.count += b.count;
      g.totalCharged += amount * b.count;
      g.totalEarned += earning * b.count;
      g.totalReported += Number(b.reported) || 0;

      // A rate row is hand-seeded (VTpass exposes no rate-card API, so this is
      // the one field in the whole pipeline never validated by a presenter),
      // and a garbage expectedRate must not silently masquerade as "rated" --
      // Number(...) on a non-numeric value yields NaN, which is neither
      // undefined nor excluded by `if (rate)`, and would otherwise flow
      // through into expectedEarned/JSON as a `null` indistinguishable from
      // a genuinely unrated service, dropping the operator's one signal to
      // go fix it. Guarding with Number.isFinite here keeps such a row out
      // of `rated` entirely, so it falls through to the unrated list below.
      const expectedRateNum = rate ? Number(rate.expectedRate) : NaN;
      if (rate && Number.isFinite(expectedRateNum)) {
        // Per transaction, because the cap is per transaction: several VTpass
        // rates are "N% capped at X naira", and applying the cap to a group
        // total instead would let a month of small sales absorb a cap that
        // should have bound each one.
        const rawCap = Number(rate.cappedAt);
        // A non-finite cap (missing, null, or malformed) is treated as "no
        // cap" -- the documented default -- rather than poisoning the
        // arithmetic with NaN. Absent a cap the report still fails toward a
        // visible shortfall rather than hiding one.
        const cap =
          rate.cappedAt === null || rate.cappedAt === undefined || !Number.isFinite(rawCap)
            ? null
            : rawCap;
        const uncapped = (amount * expectedRateNum) / 100;
        const expectedPer = cap === null ? uncapped : Math.min(uncapped, cap);

        g.expectedRate = expectedRateNum;
        g.cappedAt = cap;
        g.serviceLabel = rate.serviceLabel ?? null;
        g.expectedEarned += expectedPer * b.count;
        if (earning < expectedPer - EPSILON) g.belowExpectedCount += b.count;
      }
    }

    const unrated = [];
    const rows = [...groups.values()].map((g) => {
      const rated = g.expectedRate !== undefined;
      if (!rated) unrated.push({ provider: g.provider, kind: g.kind });

      return {
        provider: g.provider,
        kind: g.kind,
        serviceLabel: g.serviceLabel ?? null,
        count: g.count,
        totalCharged: round2(g.totalCharged),
        totalEarned: round2(g.totalEarned),
        effectiveRate: g.totalCharged > 0 ? round2((g.totalEarned / g.totalCharged) * 100) : null,
        expectedRate: rated ? g.expectedRate : null,
        cappedAt: rated ? g.cappedAt : null,
        expectedEarned: rated ? round2(g.expectedEarned) : null,
        variance: rated ? round2(g.totalEarned - g.expectedEarned) : null,
        // A service with no seeded rate is never flagged -- there is nothing to
        // compare it against, and a false "below expected" on an unrated
        // service would drown the real ones.
        belowExpected: rated ? g.totalEarned < g.expectedEarned - EPSILON : false,
        belowExpectedCount: rated ? g.belowExpectedCount : 0,
        // The provider's own claim, reported for comparison only. Never added
        // to totalEarned, and never used in place of it.
        totalReported: round2(g.totalReported),
        reportedGap: round2(g.totalReported - g.totalEarned),
      };
    });

    rows.sort((a, b) => b.totalEarned - a.totalEarned);

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      coverage: {
        since: oldest?.CreatedAt ? oldest.CreatedAt.toISOString() : null,
        transactions: covered,
      },
      rows,
      unrated,
    });
  })
);

module.exports = router;
