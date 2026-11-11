const { collection, inTransaction, isDuplicateKey } = require('../services/mongo');
const {
  insufficientBalance,
  duplicateTransaction,
  atcCreditCollision,
  userNotFound,
  validationFailed,
} = require('./errors');
const audit = require('./audit');
const { adjustmentReference, atcCreditReference } = require('./reference');
const { optionalInt } = require('../config/env');

const USERS = 'USERS';
const WALLET = 'WALLETTRANSACTIONS';
const TRANSACTIONS = 'TRANSACTIONS';
const ATCORDERS = 'ATCORDERS';

const ADJUSTMENT_MAX = optionalInt('ADJUSTMENT_MAX_AMOUNT', 1000000);
const ATC_APPROVE_MAX = optionalInt('ATC_APPROVE_MAX_AMOUNT', 1000000);
// Comfortably beyond the 30-second provider timeout a purchase's invoke()
// call is bounded by, so a row this old was never going to hear back from
// the provider on its own -- something (a deploy, an OOM kill, a container
// recycle) interrupted the request before it could settle/reverse/hold.
const STALE_PENDING_MS = optionalInt('STALE_PENDING_SWEEP_MS', 60 * 60 * 1000);

const STATUS = Object.freeze({
  PENDING: 'pending',
  SUCCESS: 'success',
  REVERSED: 'reversed',
  // Provider outcome unknown. Money stays deducted and a human or a requery job
  // must reconcile against the provider before it is released either way.
  REQUERY: 'requery',
});

function FinanceClient() {
  // Claims the transref, verifies the balance and deducts, all in one atomic
  // transaction. Replaces the old CheckBalance -> DeductBalance -> WalletUpdate
  // sequence, which had a read-modify-write race (two concurrent requests could
  // both pass the check and overdraw) and no idempotency (a retry re-purchased).
  this.reserveFunds = async ({ uid, amount, transref, channel, createdAt }) => {
    // Coerced once up front so a numeric transref (e.g. 123456) and its string
    // form ("123456") always resolve to the same _id -- otherwise a retry sent
    // as a different JS type would miss the duplicate guard and double-spend.
    transref = String(transref);
    try {
      return await inTransaction(async (session) => {
        const user = await collection(USERS).findOne({ _id: uid }, { session });
        const existing = await collection(WALLET).findOne({ _id: transref }, { session });

        if (!user) throw userNotFound(uid);
        if (existing) throw duplicateTransaction(transref);

        const prevBal = Number(user.balance) || 0;
        if (prevBal < amount) throw insufficientBalance();

        const newBal = prevBal - amount;

        await collection(USERS).updateOne(
          { _id: uid },
          { $set: { balance: newBal } },
          { session }
        );
        await collection(WALLET).insertOne(
          {
            _id: transref,
            prevBal,
            newBal,
            uid,
            email: user.email ?? null,
            channel,
            amount,
            transref,
            createdAt: createdAt ?? null,
            status: STATUS.PENDING,
            validate: false,
            mode: 'debit',
            CreatedAt: new Date(),
          },
          { session }
        );

        return { prevBal, newBal, email: user.email ?? null };
      });
    } catch (err) {
      // Two requests can pass the findOne check simultaneously; the unique _id
      // index is the real guard and turns the loser into the same 409.
      if (isDuplicateKey(err)) throw duplicateTransaction(transref);
      throw err;
    }
  };

  // Marks a reserved debit as settled. Idempotent: re-running on an already
  // settled transaction is a no-op rather than a second write.
  this.settle = async ({ transref }) => {
    transref = String(transref);
    return inTransaction(async (session) => {
      const row = await collection(WALLET).findOne({ _id: transref }, { session });
      if (!row) return { changed: false, reason: 'not-found' };
      if (row.status !== STATUS.PENDING) {
        return { changed: false, reason: 'already-settled' };
      }

      await collection(WALLET).updateOne(
        { _id: transref },
        { $set: { status: STATUS.SUCCESS, validate: true, settledAt: new Date() } },
        { session }
      );
      return { changed: true };
    });
  };

  // Atomically refunds and marks the wallet entry reversed. Guarded by the
  // PENDING check so a double-call cannot double-refund.
  this.reverse = async ({ uid, transref, reason = null }) => {
    transref = String(transref);
    return inTransaction(async (session) => {
      const user = await collection(USERS).findOne({ _id: uid }, { session });
      const row = await collection(WALLET).findOne({ _id: transref }, { session });

      if (!row) return { changed: false, reason: 'not-found' };
      if (row.status !== STATUS.PENDING) {
        return { changed: false, reason: 'not-reversible' };
      }
      if (!user) throw userNotFound(uid);

      const amount = Number(row.amount) || 0;
      const currentBal = Number(user.balance) || 0;
      const restored = currentBal + amount;

      await collection(USERS).updateOne(
        { _id: uid },
        { $set: { balance: restored } },
        { session }
      );
      await collection(WALLET).updateOne(
        { _id: transref },
        {
          $set: {
            status: STATUS.REVERSED,
            validate: true,
            mode: 'credit-reversal',
            reversalReason: reason,
            prevBal: currentBal,
            newBal: restored,
            reversedAt: new Date(),
          },
        },
        { session }
      );

      return { changed: true, restored };
    });
  };

  // Unknown upstream outcome: hold the funds and flag for reconciliation.
  // Deliberately does NOT refund — the provider may have fulfilled the order.
  this.holdForRequery = async ({ transref, reason = null, raw = null, providerRequestId = null }) => {
    transref = String(transref);
    return inTransaction(async (session) => {
      const row = await collection(WALLET).findOne({ _id: transref }, { session });
      if (!row) return { changed: false, reason: 'not-found' };
      if (row.status !== STATUS.PENDING) {
        return { changed: false, reason: 'already-settled' };
      }

      await collection(WALLET).updateOne(
        { _id: transref },
        {
          $set: {
            status: STATUS.REQUERY,
            validate: false,
            requeryReason: reason,
            // The id the provider knows this purchase by, captured at call
            // time because it cannot be recomputed: buildRequestId stamps the
            // current minute into it. Without it a requery has nothing to
            // match on and the held debit can only be resolved by hand.
            // Null for a swept stale-pending row, whose request died before
            // anything could record what it sent.
            providerRequestId: providerRequestId || null,
            providerResponse: raw ? JSON.stringify(raw).slice(0, 1500) : null,
            flaggedAt: new Date(),
          },
        },
        { session }
      );
      return { changed: true };
    });
  };

  // PENDING is written once, inside the same request that reserved the funds
  // (purchase.js), and that request is the only thing that ever moves a row
  // off it -- to SUCCESS, REVERSED or REQUERY. Nothing else watches PENDING
  // rows, so one interrupted mid-flight (a deploy, an OOM kill, a container
  // recycle during the provider call) is stuck there forever: debited,
  // invisible to the requery queue (which only lists REQUERY), and reachable
  // by no admin route, since resolveRequery deliberately accepts only REQUERY.
  //
  // This ages such a row into REQUERY -- the same state a genuinely unknown
  // provider outcome already lands in -- rather than widening resolveRequery
  // or settle/reverse's guard to also accept PENDING, which would let this
  // recovery path (or a bug in it) act on a row still legitimately in flight
  // inside its own request. Reuses holdForRequery per row instead of
  // duplicating its update, so the two ways a row reaches REQUERY can never
  // diverge. `requeryReason: 'stale-pending'` distinguishes a swept row from
  // one a provider actually answered ambiguously.
  //
  // Sequential, not Promise.all: each row's move runs inside its own
  // MongoDB transaction (inTransaction, inside holdForRequery), and running
  // multiple transactions concurrently over the driver's session pool is
  // documented undefined behaviour in the MongoDB v6 driver.
  this.sweepStalePending = async ({ olderThanMs = STALE_PENDING_MS } = {}) => {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await collection(WALLET)
      .find(
        { status: STATUS.PENDING, CreatedAt: { $lt: cutoff } },
        { projection: { _id: 1 } }
      )
      .toArray();

    let swept = 0;
    for (const { _id } of stale) {
      // eslint-disable-next-line no-await-in-loop -- deliberate; see comment above.
      const out = await this.holdForRequery({ transref: _id, reason: 'stale-pending' });
      if (out.changed) swept += 1;
    }
    return { swept, found: stale.length };
  };

  // A NEW method rather than widening settle/reverse. Those two guard on PENDING,
  // and that guard is what stops an already-resolved transaction being acted on
  // twice on the normal purchase path; widening them would widen every caller.
  // This one accepts only a held row, so neither path can act on the other's.
  this.resolveRequery = async ({ transref, decision, adminUid, reason }) => {
    transref = String(transref);
    if (decision !== 'settle' && decision !== 'reverse') {
      throw validationFailed('Decision must be settle or reverse', { decision });
    }
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (!note) throw validationFailed('A reason is required to resolve a held transaction');
    const actor = typeof adminUid === 'string' ? adminUid.trim() : '';
    if (!actor) throw validationFailed('A held transaction must record the admin who resolved it');

    return inTransaction(async (session) => {
      const row = await collection(WALLET).findOne({ _id: transref }, { session });
      if (!row) return { changed: false, reason: 'not-found' };
      if (row.status !== STATUS.REQUERY) {
        return { changed: false, reason: 'not-held' };
      }

      let restored;
      if (decision === 'settle') {
        await collection(WALLET).updateOne(
          { _id: transref },
          { $set: { status: STATUS.SUCCESS, validate: true, settledAt: new Date(), resolvedReason: note } },
          { session }
        );
      } else {
        const user = await collection(USERS).findOne({ _id: row.uid }, { session });
        if (!user) throw userNotFound(row.uid);
        const amount = Number(row.amount) || 0;
        const currentBal = Number(user.balance) || 0;
        restored = currentBal + amount;

        await collection(USERS).updateOne(
          { _id: row.uid }, { $set: { balance: restored } }, { session }
        );
        await collection(WALLET).updateOne(
          { _id: transref },
          {
            $set: {
              status: STATUS.REVERSED, validate: true, mode: 'credit-reversal',
              reversalReason: note, prevBal: currentBal, newBal: restored,
              reversedAt: new Date(),
            },
          },
          { session }
        );
      }

      await audit.record(
        {
          action: 'requery.resolve', adminUid: actor, targetUid: row.uid,
          details: { transref, decision, reason: note, amount: Number(row.amount) || 0 },
        },
        session
      );

      return { changed: true, status: decision === 'settle' ? STATUS.SUCCESS : STATUS.REVERSED, restored };
    });
  };

  this.recordTransaction = async ({ uid, transref, transType, amount, result }) => {
    transref = String(transref);
    // Extracted by the adapter, not here: provider-specific response shapes
    // stay behind the adapter contract. Absent stays null -- 0 is a real
    // earning rate and must remain distinguishable from "not reported".
    const earning = result.earning || {};
    const numOrNull = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    await collection(TRANSACTIONS).replaceOne(
      { _id: transref },
      {
        uid,
        transref,
        transType,
        amount,
        status: result.status,
        message: result.message ?? null,
        providerReference: result.reference ?? null,
        provider: result.provider ?? null,
        // Stored as their own fields rather than left inside `raw`, which is
        // truncated to 1500 characters: a long provider response would
        // silently drop the commission, and a string inside raw is neither
        // queryable nor aggregatable.
        providerEarning: numOrNull(earning.earning),
        providerEarningRate: numOrNull(earning.rate),
        providerAmountCharged: numOrNull(earning.amountCharged),
        // The figure the provider CLAIMED, kept apart from providerEarning
        // because the two demonstrably disagree. Never summed for reporting;
        // only compared. See providers/vtpass.js extractEarning.
        providerReportedEarning: numOrNull(earning.reportedEarning),
        raw: result.raw ? JSON.stringify(result.raw).slice(0, 1500) : null,
        CreatedAt: new Date(),
      },
      { upsert: true }
    );
  };

  this.getBalance = async (uid) => {
    const user = await collection(USERS).findOne({ _id: uid });
    if (!user) throw userNotFound(uid);
    return Number(user.balance) || 0;
  };

  // Atomic credit, used by the Paystack webhook and verification callback.
  // Idempotent on transref so a webhook replay cannot credit twice.
  this.creditWallet = async ({ uid, amount, transref, meta = {} }) => {
    transref = String(transref);
    return inTransaction(async (session) => {
      const user = await collection(USERS).findOne({ _id: uid }, { session });
      const row = await collection(WALLET).findOne({ _id: transref }, { session });

      if (!user) throw userNotFound(uid);
      if (row && row.validate === true) {
        return { changed: false, reason: 'already-credited' };
      }

      const prevBal = Number(user.balance) || 0;
      const newBal = prevBal + Number(amount);

      await collection(USERS).updateOne(
        { _id: uid },
        { $set: { balance: newBal } },
        { session }
      );
      // replaceOne with upsert, because a PENDING row for this transref may
      // already exist. The _id comes from the filter, so it is not repeated
      // in the replacement document.
      await collection(WALLET).replaceOne(
        { _id: transref },
        {
          ...meta,
          uid,
          amount: Number(amount),
          transref,
          prevBal,
          newBal,
          status: STATUS.SUCCESS,
          validate: true,
          mode: 'credit',
          CreatedAt: new Date(),
        },
        { upsert: true, session }
      );

      return { changed: true, prevBal, newBal };
    });
  };

  // An admin correction. Deliberately NOT a variant of creditWallet: that is
  // idempotent on a Paystack reference and writes mode 'credit', which would put
  // an operator action and a payment-processor callback on one code path.
  //
  // The balance is read inside the session and the delta applied there, so two
  // concurrent adjustments cannot both read the same stale value.
  this.adjustBalance = async ({ uid, amount, reason, adminUid }) => {
    const delta = Number(amount);
    // isInteger is true for any integer-valued double, so 1e20 would pass and
    // prevBal + delta would silently discard the existing balance to float
    // rounding. isSafeInteger plus a business cap is what actually bounds this.
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw validationFailed('Adjustment must be a non-zero whole number');
    }
    if (Math.abs(delta) > ADJUSTMENT_MAX) {
      throw validationFailed(
        `An adjustment cannot exceed ${ADJUSTMENT_MAX}`,
        { max: ADJUSTMENT_MAX }
      );
    }
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (!note) throw validationFailed('A reason is required for a balance adjustment');
    if (note.length > 500) throw validationFailed('Reason must be 500 characters or fewer');

    const actor = typeof adminUid === 'string' ? adminUid.trim() : '';
    if (!actor) throw validationFailed('An adjustment must record the admin who made it');

    const transref = adjustmentReference();

    return inTransaction(async (session) => {
      const user = await collection(USERS).findOne({ _id: String(uid) }, { session });
      if (!user) throw userNotFound(uid);

      const prevBal = Number(user.balance) || 0;
      const newBal = prevBal + delta;

      // A debit larger than the balance is a mistake, not an overdraft.
      if (newBal < 0) {
        throw validationFailed('That adjustment would take the balance negative', {
          prevBal,
          delta,
        });
      }

      await collection(USERS).updateOne(
        { _id: String(uid) },
        { $set: { balance: newBal } },
        { session }
      );

      await collection(WALLET).insertOne(
        {
          _id: transref,
          uid: String(uid),
          email: user.email ?? null,
          channel: 'Adjustment',
          amount: Math.abs(delta),
          transref,
          prevBal,
          newBal,
          status: STATUS.SUCCESS,
          validate: true,
          mode: delta > 0 ? 'admin-credit' : 'admin-debit',
          reason: note,
          adminUid: actor,
          CreatedAt: new Date(),
        },
        { session }
      );

      await audit.record(
        {
          action: 'balance.adjust',
          adminUid: actor,
          targetUid: uid,
          details: { amount: delta, reason: note, prevBal, newBal, transref },
        },
        session
      );

      return { prevBal, newBal, transref };
    });
  };

  // Approves a pending Airtime-To-Cash order. Credits from `receivedAmount` —
  // what the operator confirms actually landed on the payout line — never
  // from the order's stored `amount`, which is only the customer's claim.
  // Paying on the claim would overpay whenever less airtime arrives than was
  // sent. The original claim is preserved on the row; `receivedAmount` is
  // recorded alongside it, not written over it.
  //
  // Deliberately not built on creditWallet: that hardcodes mode 'credit' and
  // uses replaceOne/upsert for Paystack idempotency, whereas this needs its
  // own wallet mode and must update the order row in the same transaction as
  // the credit, which creditWallet has no way to do.
  this.approveAtcOrder = async ({ orderId, receivedAmount, adminUid, reason }) => {
    const received = Number(receivedAmount);
    // isInteger is true for any integer-valued double (Number.isInteger(1e20)
    // is true), which would let an absurd received amount silently corrupt
    // the balance it's added to through float rounding. isSafeInteger bounds it.
    if (!Number.isSafeInteger(received) || received <= 0) {
      throw validationFailed('Received amount must be a positive whole number');
    }
    // Same business cap adjustBalance enforces alongside isSafeInteger: without
    // it an operator's extra zero credits an arbitrary amount, atomically and
    // audited, and the pending-guard makes this path one-shot so it can't be
    // walked back through the same route.
    if (received > ATC_APPROVE_MAX) {
      throw validationFailed(
        `Received amount cannot exceed ${ATC_APPROVE_MAX}`,
        { max: ATC_APPROVE_MAX }
      );
    }
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (!note) throw validationFailed('A reason is required to approve an ATC order');
    const actor = typeof adminUid === 'string' ? adminUid.trim() : '';
    if (!actor) throw validationFailed('An ATC approval must record the admin who made it');

    try {
      return await inTransaction(async (session) => {
        const order = await collection(ATCORDERS).findOne({ _id: String(orderId) }, { session });
        if (!order) return { changed: false, reason: 'not-found' };
        // Guards against a double-submit paying twice: once the order leaves
        // 'pending' a second approve (or a reject) is a no-op, not a second credit.
        if (order.status !== 'pending') return { changed: false, reason: 'not-pending' };

        // percent is the COMMISSION WITHHELD, not the payout share. Mirrors the
        // exact expression the order's own quote was computed with
        // (routes/atoc.js, routes/orders.js) rather than a paraphrase that
        // could algebraically drift from it. A missing/corrupt percent must
        // not silently become NaN and corrupt the balance it's added to.
        //
        // The comment this replaced said percent was "validated in [0, 100) by
        // getAtcRate" -- true, but that check runs at a different time against
        // a different collection (the ATC catalog, not this order row), so it
        // does not hold here. It especially does not hold for Firestore-
        // migrated ATCORDERS rows, which this codebase inherits and never
        // validated. With percent > 100, credited goes negative and this
        // "approval" would silently DEBIT the customer -- unlike adjustBalance,
        // which refuses to go negative, this path had no floor. Validation on
        // the write path (getAtcRate, order creation) is not validation here;
        // this read path re-checks its own input.
        const percent = Number(order.percent);
        if (!Number.isFinite(percent) || percent < 0 || percent >= 100) {
          throw validationFailed(
            'Order does not have a valid commission percent in [0, 100)',
            { orderId: order._id, percent: order.percent }
          );
        }
        const credited = Math.round(received - (percent / 100) * received);

        const user = await collection(USERS).findOne({ _id: order.uid }, { session });
        if (!user) throw userNotFound(order.uid);

        const prevBal = Number(user.balance) || 0;
        const newBal = prevBal + credited;

        // Belt-and-braces alongside the percent bound above: with percent
        // constrained to [0, 100), credited cannot itself be negative, but this
        // still refuses to compound a balance already corrupted by some other
        // path (e.g. a bad legacy adjustment) rather than silently accepting it.
        if (newBal < 0) {
          throw validationFailed('That approval would take the balance negative', {
            orderId: order._id,
            prevBal,
            credited,
          });
        }

        await collection(USERS).updateOne(
          { _id: order.uid },
          { $set: { balance: newBal } },
          { session }
        );

        // Prefixed off the order's own transref so it cannot collide with the
        // order document (whose _id IS that bare transref) or with any other
        // reference sharing WALLETTRANSACTIONS. atcCreditReference() also
        // appends random hex (see reference.js) so this insert's _id cannot be
        // predicted by the customer from a client-chosen legacy transref -- but
        // an insert races other writers of this collection regardless, so a
        // collision is still caught below rather than left to throw a raw,
        // uncaught E11000 that would abort the transaction with no clue why.
        const walletRef = atcCreditReference(order.transref);
        await collection(WALLET).insertOne(
          {
            _id: walletRef,
            uid: order.uid,
            email: user.email ?? null,
            channel: 'AirtimeToCash',
            amount: credited,
            transref: walletRef,
            prevBal,
            newBal,
            status: STATUS.SUCCESS,
            validate: true,
            mode: 'atc-credit',
            CreatedAt: new Date(),
          },
          { session }
        );

        await collection(ATCORDERS).updateOne(
          { _id: order._id },
          {
            $set: {
              status: 'success',
              receivedAmount: received,
              approvedBy: actor,
              approvalReason: note,
              approvedAt: new Date(),
            },
          },
          { session }
        );

        await audit.record(
          {
            action: 'atc.approve',
            adminUid: actor,
            targetUid: order.uid,
            details: {
              orderId: order._id,
              transref: order.transref,
              amountClaimed: Number(order.amount) || 0,
              receivedAmount: received,
              credited,
              prevBal,
              newBal,
              reason: note,
            },
          },
          session
        );

        return { changed: true, credited, newBal };
      });
    } catch (err) {
      // Mirrors reserveFunds's catch (finance.js:78-83): the unique _id index
      // is the real guard against a walletRef collision, and without this the
      // insert's raw E11000 aborts the transaction uncaught, 500s the route,
      // and leaves the operator with no clue why the order can never be
      // approved.
      if (isDuplicateKey(err)) throw atcCreditCollision(orderId);
      throw err;
    }
  };

  // Rejects a pending Airtime-To-Cash order. Touches no balance and writes no
  // wallet row — the customer's airtime never arrived (or wasn't verifiable),
  // so nothing was owed.
  this.rejectAtcOrder = async ({ orderId, adminUid, reason }) => {
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (!note) throw validationFailed('A reason is required to reject an ATC order');
    const actor = typeof adminUid === 'string' ? adminUid.trim() : '';
    if (!actor) throw validationFailed('An ATC rejection must record the admin who made it');

    return inTransaction(async (session) => {
      const order = await collection(ATCORDERS).findOne({ _id: String(orderId) }, { session });
      if (!order) return { changed: false, reason: 'not-found' };
      // Same pending-only guard as approve: stops a double-submit from acting
      // on an order the other decision (or this one) already resolved.
      if (order.status !== 'pending') return { changed: false, reason: 'not-pending' };

      await collection(ATCORDERS).updateOne(
        { _id: order._id },
        {
          $set: {
            status: 'rejected',
            rejectionReason: note,
            rejectedBy: actor,
            rejectedAt: new Date(),
          },
        },
        { session }
      );

      await audit.record(
        {
          action: 'atc.reject',
          adminUid: actor,
          targetUid: order.uid,
          details: { orderId: order._id, transref: order.transref, reason: note },
        },
        session
      );

      return { changed: true };
    });
  };
}

const finance = new FinanceClient();

module.exports = { finance, STATUS };
