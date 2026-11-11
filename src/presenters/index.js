const { parsePrice } = require('../models/catalog');

// The repository serialiser emits the legacy wire shape: `docid`, and dates as
// Firestore-style {seconds, nanoseconds}. The new contract wants `id` and ISO
// strings. Every new route maps through here; the old routes do not. This whole
// module is deleted at cutover, together with the serialiser's timestamp branch.

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value.seconds === 'number') {
    return new Date(value.seconds * 1000 + (value.nanoseconds || 0) / 1e6).toISOString();
  }
  return null;
}

const isActive = (doc) => doc.active !== false;

// Key names below are dictated by the consuming pages, not chosen. Changing one
// renders a blank screen or a zero price rather than raising an error.

// buy-airtime.vue and buy-data.vue post `name` back as `network`, which
// resolveNetwork matches against NETWORKS.name. Provider routing ids (`id`,
// vtpass*ServiceId) stay server-side.
const network = (d) => ({
  id: d.docid,
  name: d.name ?? null,
  image: d.img ?? null,
  active: isActive(d),
});

const dataPlan = (d) => ({
  id: d.docid,
  networkId: d.networkId ?? null,
  type: d.planType ?? null,
  size: d.Size ?? null,
  validity: d.Validity ?? null,
  price: parsePrice(d.Amount),
  active: isActive(d),
});

const cableProvider = (d) => ({
  id: d.docid,
  name: d.CableName ?? null,
  image: d.img ?? null,
  active: isActive(d),
});

// providerId is injected by the route, which joins CABLESPLAN.category to
// CABLES.CableName case-insensitively — the documents carry no id link.
const cablePlan = (d, providerId = null) => ({
  id: d.docid,
  providerId,
  name: d.CableplanName ?? null,
  // buy-cable.vue reads `plan.price` (four sites, including its wallet-balance
  // guard), while buy-data.vue reads `plan.amount`. The pages disagree; the
  // presenters follow their consumers rather than imposing consistency.
  price: parsePrice(d.amount),
  active: isActive(d),
});

const disco = (d) => ({
  id: d.docid,
  name: d.Disconame ?? null,
  image: d.img ?? null,
  active: isActive(d),
});

// resultchecker.vue computes its total from `unitPrice`, not `amount`.
const examType = (d) => ({
  id: d.docid,
  name: d.examName ?? null,
  unitPrice: parsePrice(d.amount),
  image: d.img ?? null,
  active: isActive(d),
});

// airtime-to-cash.vue computes `1 - commissionRate`, so a stored 10 percent
// must arrive as the fraction 0.1.
const atcNetwork = (d) => ({
  id: d.docid,
  network: d.network ?? null,
  payoutNumber: d.number != null ? String(d.number) : null,
  commissionRate: Number(d.percent) / 100,
  active: isActive(d),
});

// transactions.vue filters tabs on `tx.kind` against 'airtime' | 'data' |
// 'cable' | 'electricity' | 'epin' | 'wallet', picks its row icon from
// `tx.kind`, and renders the row title as `tx.label || tx.description ||
// tx.kind`. models/purchase.js writes transType as 'Data', 'Airtime', etc,
// and also 'Data-Reversed' / 'Data-Pending' for the failure and pending
// cases, so a raw passthrough would never match a tab.
const KIND_SUFFIX_PATTERN = /-(Reversed|Pending)$/i;

function transactionKind(transType) {
  if (!transType) return null;
  return String(transType).replace(KIND_SUFFIX_PATTERN, '').toLowerCase();
}

const transaction = (d) => ({
  id: d.docid,
  type: d.transType ?? null,
  kind: transactionKind(d.transType),
  label: d.transType ?? null,
  amount: Number(d.amount) || 0,
  status: d.status ?? null,
  message: d.message ?? null,
  reference: d.transref ?? null,
  createdAt: toIso(d.CreatedAt),
});

// Every mode that moves money INTO the wallet. `type` below is derived from this
// one list rather than passing `mode` through raw, because the consumer decides
// colour and sign from `type` alone: a mode the consumer's own whitelist did not
// know about used to render a credit as a red negative amount while the balance
// went up. Adding a mode here is now the single edit that keeps consumers correct.
const CREDIT_MODES = ['credit', 'credit-reversal', 'admin-credit', 'atc-credit'];

const walletEntry = (d) => ({
  id: d.docid,
  mode: d.mode ?? null,
  // wallet-summary.vue computes isCredit from `entry.type`, not `mode`. `type`
  // is derived from CREDIT_MODES rather than passed through raw, so a mode not
  // yet on that list falls safely to 'debit' instead of silently mismatching
  // the frontend's own hardcoded credit list (which is how an admin-credit
  // once rendered as a red debit while the balance went up).
  type: CREDIT_MODES.includes(d.mode) ? 'credit' : 'debit',
  // Reversal entries carry status 'reversed' (finance.reverse updates the
  // same wallet row in place); wallet-summary.vue filters these out via
  // `!entry.reversed`.
  reversed: d.status === 'reversed',
  amount: Number(d.amount) || 0,
  prevBal: Number(d.prevBal) || 0,
  newBal: Number(d.newBal) || 0,
  status: d.status ?? null,
  channel: d.channel ?? null,
  createdAt: toIso(d.CreatedAt),
});

// Built by explicit field selection, not by deleting secrets from a spread, so
// a new sensitive field on USERS cannot leak by default.
const user = (d) => ({
  id: d.docid ?? d.id ?? null,
  username: d.username ?? null,
  fullname: d.fullname ?? null,
  email: d.email ?? null,
  phone: d.phone ?? null,
  wallet: Number(d.balance) || 0,
  role: d.account ?? 'USER',
  bankName: d.bankName ?? null,
  accountName: d.accountName ?? null,
  accountNumber: d.accountNumber ?? null,
});

module.exports = {
  toIso, network, dataPlan, cableProvider, cablePlan, disco,
  examType, atcNetwork, transaction, walletEntry, user,
  CREDIT_MODES,
};
