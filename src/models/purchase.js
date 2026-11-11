const { finance } = require('./finance');
const { getProvider } = require('../providers');
const { validationFailed } = require('./errors');
const { SUCCESS, FAILED, PENDING } = require('../providers/contract');

const TRANSREF_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

// A reversal that itself fails would silently strand the user's money, so the
// failure is downgraded to a requery flag rather than being swallowed.
async function safeReverse({ uid, transref, reason }) {
  try {
    await finance.reverse({ uid, transref, reason });
    return true;
  } catch (err) {
    console.error(
      `[purchase] REVERSAL FAILED transref=${transref} uid=${uid}: ${err.message}`
    );
    try {
      await finance.holdForRequery({
        transref,
        reason: `reversal-failed: ${reason ?? 'unknown'}`,
      });
    } catch (flagErr) {
      console.error(
        `[purchase] could not flag failed reversal transref=${transref}: ${flagErr.message}`
      );
    }
    return false;
  }
}

async function safeRecord(entry) {
  try {
    await finance.recordTransaction(entry);
  } catch (err) {
    // The ledger write is secondary; the balance movement already happened and
    // is recorded in WALLETTRANSACTIONS.
    console.error(
      `[purchase] could not write transaction record transref=${entry.transref}: ${err.message}`
    );
  }
}

// The new contract's purchase endpoints return the post-purchase balance,
// because every samzeenuxt purchase page does authStore.updateWallet(res.wallet).
// Read back rather than computed, so a failed reversal cannot report a balance
// the user does not actually have.
async function currentBalance(uid) {
  try {
    return await finance.getBalance(uid);
  } catch {
    return null;
  }
}

/**
 * Runs a purchase end to end: validate, reserve funds atomically, call the
 * provider, then settle according to the canonical result.
 *
 * `amount` must already be resolved server-side from the catalog by the caller.
 * `invoke` receives the resolved provider and must return a canonical result
 * from providers/contract.
 */
async function execute({
  uid,
  transref,
  channel,
  createdAt,
  service,
  amount,
  transType,
  prepare,
  invoke,
}) {
  if (!uid || typeof uid !== 'string') {
    throw validationFailed('A valid user id is required');
  }
  if (!TRANSREF_PATTERN.test(String(transref ?? ''))) {
    throw validationFailed('Invalid transaction reference');
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw validationFailed('Invalid transaction amount');
  }

  // Resolved before any money moves so a provider misconfiguration cannot leave
  // a deduction stranded.
  const provider = await getProvider(service);

  // Optional: callers that need to pick provider-specific ids (e.g. via
  // providers/ids.js) do it here, against the actual provider instance that
  // will be invoked, but BEFORE reserveFunds — so a catalog row missing the
  // active provider's column throws before any money moves, instead of
  // surfacing as a debit/reversal pair inside invoke's try/catch below.
  const prepared = prepare ? await prepare(provider) : undefined;

  await finance.reserveFunds({ uid, amount, transref, channel, createdAt });

  let result;
  try {
    result = await invoke(provider, prepared);
  } catch (err) {
    // Includes the case the old code got wrong: response.json() throwing on an
    // HTML maintenance page, which used to skip reversal entirely.
    await safeReverse({ uid, transref, reason: err.message });
    await safeRecord({
      uid,
      transref,
      transType,
      amount,
      result: {
        status: FAILED,
        message: err.message,
        provider: provider.name,
        raw: null,
      },
    });
    throw err;
  }

  const enriched = { ...result, provider: provider.name };

  if (enriched.status === SUCCESS) {
    await finance.settle({ transref });
    await safeRecord({ uid, transref, transType, amount, result: enriched });
    return {
      status: 'success',
      msg: enriched.message,
      httpStatus: 200,
      wallet: await currentBalance(uid),
      reference: transref,
      raw: enriched.raw,
    };
  }

  if (enriched.status === FAILED) {
    await safeReverse({ uid, transref, reason: enriched.message });
    await safeRecord({
      uid,
      transref,
      transType: `${transType}-Reversed`,
      amount,
      result: enriched,
    });
    // 200 because the request was processed correctly and the provider declined;
    // the frontend keys off the 'error' status string.
    return {
      status: 'error',
      msg: `${enriched.message}. Your wallet has been refunded.`,
      httpStatus: 200,
      wallet: await currentBalance(uid),
      reference: transref,
      raw: enriched.raw,
    };
  }

  // PENDING: the provider may or may not have fulfilled the order. Refunding
  // here risks paying the provider AND crediting the user back, so the debit is
  // held and flagged for reconciliation instead.
  await finance.holdForRequery({
    transref,
    reason: enriched.reason ?? 'unknown-outcome',
    raw: enriched.raw,
    providerRequestId: enriched.providerRequestId ?? null,
  });
  await safeRecord({
    uid,
    transref,
    transType: `${transType}-Pending`,
    amount,
    result: enriched,
  });

  return {
    status: 'pending',
    msg: 'Your order is being confirmed. You will not be charged twice — if it does not complete it will be reversed.',
    httpStatus: 202,
    wallet: await currentBalance(uid),
    reference: transref,
    raw: enriched.raw,
  };
}

module.exports = { execute, TRANSREF_PATTERN };
