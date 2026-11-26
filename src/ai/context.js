const { collection } = require('../services/mongo');
const catalogRepo = require('../repositories/catalog');
const feeRepo = require('../repositories/fees');
const fees = require('../models/fees');
const P = require('../presenters');
const { parsePrice } = require('../models/catalog');
const referrals = require('../models/referrals');

// Everything the assistant knows about this user and this system, gathered
// fresh per message. Figures the model might get wrong (sums, counts, date
// windows) are computed here, so it reads totals instead of adding them up.

const TZ = 'Africa/Lagos';
const LAGOS_OFFSET_MS = 60 * 60 * 1000; // WAT is UTC+1 all year, no DST.

const naira = (n) => `₦${(Math.round(Number(n || 0) * 100) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
const stamp = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '?');

function lagosMonthStart(now, monthsBack = 0) {
  const local = new Date(now.getTime() + LAGOS_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - monthsBack, 1) - LAGOS_OFFSET_MS);
}
function lagosDayStart(now, daysBack = 0) {
  const local = new Date(now.getTime() + LAGOS_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysBack) - LAGOS_OFFSET_MS);
}

// Plain-language meaning of each stored state, so the model explains states
// the way the system actually behaves rather than guessing.
const STATUS_MEANING = {
  success: 'completed',
  pending: 'in progress: the provider has not answered yet',
  requery: 'on hold: the provider never confirmed, so the money is held while staff check with the provider. It will be completed or refunded',
  reversed: 'failed and refunded to the wallet',
  failed: 'failed',
  error: 'failed and refunded',
};

const REF_PATTERN = /\b(pur_[a-f0-9]{8,}|ps_[A-Za-z0-9_-]{4,}|adj_[a-f0-9]{8,}|atc_credit_[A-Za-z0-9_-]+|SWZ-[0-9]{6,}(?:-[a-f0-9]+)?)\b/g;

function walletLine(w) {
  const kind = {
    credit: 'Wallet top-up', 'credit-reversal': 'Refund', 'admin-credit': 'Credit by Swiftza staff',
    'admin-debit': 'Debit by Swiftza staff', 'atc-credit': 'Airtime-to-cash payout', 'referral-credit': 'Referral reward', debit: 'Purchase payment',
  }[w.mode] || w.mode || 'Wallet entry';
  const sign = P.CREDIT_MODES.includes(w.mode) ? '+' : '-';
  const fee = w.totalFee ? ` | paid ${naira(w.grossPaid)} incl. fee ${naira(w.totalFee)}` : '';
  return `${stamp(w.CreatedAt)} | ${kind} | ${sign}${naira(w.amount)} | ${w.status || '?'} | balance ${naira(w.prevBal)} → ${naira(w.newBal)} | ref ${w.transref || w._id}${fee}`;
}

function purchaseLine(t) {
  const p = P.transaction({ ...t, docid: String(t._id) });
  const status = p.status || '?';
  const msg = p.message ? ` | "${String(p.message).slice(0, 120)}"` : '';
  return `${stamp(t.CreatedAt)} | ${p.kind || '?'} | ${naira(p.amount)} | ${status} | ref ${p.reference} | id ${p.id}${msg}`;
}

async function userTimeline(uid, { limit, now }) {
  const owner = String(uid);
  const [purchases, wallet] = await Promise.all([
    collection('TRANSACTIONS').find({ uid: owner }).sort({ CreatedAt: -1 }).limit(limit).toArray(),
    collection('WALLETTRANSACTIONS').find({ $or: [{ uid: owner }, { userId: owner }] }).sort({ CreatedAt: -1 }).limit(limit).toArray(),
  ]);

  // Totals over a wider window than the listed rows, so "this month" is
  // right even for a heavy user whose month does not fit in `limit` rows.
  const since = lagosMonthStart(now, 2);
  const agg = await collection('WALLETTRANSACTIONS').aggregate([
    { $match: { $or: [{ uid: owner }, { userId: owner }], CreatedAt: { $gte: since } } },
    { $project: { amount: 1, mode: 1, status: 1, CreatedAt: 1, totalFee: 1 } },
  ]).toArray();
  const purchasesAgg = await collection('TRANSACTIONS').find(
    { uid: owner, CreatedAt: { $gte: since } },
    { projection: { amount: 1, transType: 1, status: 1, CreatedAt: 1 } }
  ).toArray();

  const windows = {
    today: lagosDayStart(now, 0),
    last7Days: lagosDayStart(now, 6),
    thisMonth: lagosMonthStart(now, 0),
    lastMonth: [lagosMonthStart(now, 1), lagosMonthStart(now, 0)],
  };
  const inWindow = (d, w) => (Array.isArray(w) ? d >= w[0] && d < w[1] : d >= w);

  const summary = {};
  for (const [name, w] of Object.entries(windows)) {
    const rows = agg.filter((r) => r.CreatedAt && inWindow(r.CreatedAt, w));
    const spent = rows.filter((r) => r.mode === 'debit' && r.status !== 'reversed').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const funded = rows.filter((r) => r.mode === 'credit').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const feesPaid = rows.filter((r) => r.mode === 'credit').reduce((s, r) => s + (Number(r.totalFee) || 0), 0);
    const refunded = rows.filter((r) => r.status === 'reversed' || r.mode === 'credit-reversal').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const byKind = {};
    purchasesAgg.filter((t) => t.CreatedAt && inWindow(t.CreatedAt, w) && t.status === 'success').forEach((t) => {
      const k = P.transaction({ ...t, docid: '' }).kind || 'other';
      byKind[k] = (byKind[k] || 0) + (Number(t.amount) || 0);
    });
    summary[name] = { spent, funded, feesPaid, refunded, byKind, count: rows.filter((r) => r.mode === 'debit').length };
  }

  const held = wallet.filter((w) => w.status === 'requery' || w.status === 'pending');
  return { purchases, wallet, summary, held };
}

async function lookupReferences(uid, text) {
  const refs = [...new Set(String(text || '').match(REF_PATTERN) || [])].slice(0, 3);
  if (!refs.length) return [];
  const owner = String(uid);
  const out = [];
  for (const ref of refs) {
    const variants = [ref, `ps_${ref.replace(/[^A-Za-z0-9_-]/g, '-')}`];
    // Owner is part of the filter: a user can never pull someone else's row
    // by quoting its reference.
    const [p, w] = await Promise.all([
      collection('TRANSACTIONS').findOne({ uid: owner, transref: { $in: variants } }),
      collection('WALLETTRANSACTIONS').findOne({ $or: [{ uid: owner }, { userId: owner }], $and: [{ $or: [{ _id: { $in: variants } }, { transref: { $in: variants } }, { paystackReference: ref }] }] }),
    ]);
    if (!p && !w) { out.push(`${ref}: not found on this account`); continue; }
    if (p) out.push(`${ref} (purchase): ${purchaseLine(p)}${p.providerReference ? ` | provider ref ${p.providerReference}` : ''}`);
    if (w) {
      const extra = [
        w.requeryReason ? `held because: ${w.requeryReason}` : '',
        w.reversalReason ? `refund reason: ${w.reversalReason}` : '',
        w.reversedAt ? `refunded at ${stamp(w.reversedAt)}` : '',
        w.settledAt ? `completed at ${stamp(w.settledAt)}` : '',
        w.feeRuleName ? `fee rule: ${w.feeRuleName}` : '',
      ].filter(Boolean).join(' | ');
      out.push(`${ref} (wallet): ${walletLine(w)}${extra ? ` | ${extra}` : ''}`);
    }
  }
  return out;
}

// Raw rows, loaded once per message: the prompt's CATALOG block and the
// widget validator (ai/widgets.js) must see the same data.
async function loadCatalog() {
  const safe = (p) => p.catch(() => []);
  const [networks, plans, cables, cablePlans, discos, exams] = await Promise.all([
    safe(catalogRepo.list('NETWORKS')), safe(catalogRepo.list('DATAPACKS')), safe(catalogRepo.list('CABLES')),
    safe(catalogRepo.list('CABLESPLAN')), safe(catalogRepo.list('ELECTRICITY')), safe(catalogRepo.list('EPIN')),
  ]);
  return { networks, plans, cables, cablePlans, discos, exams };
}

function catalogBlock({ networks, plans, cables, cablePlans, discos, exams }) {
  const active = (d) => d.active !== false;
  const netName = new Map(networks.map((n) => [String(n.docid), n.name]));
  const lines = [];
  lines.push(`Networks: ${networks.filter(active).map((n) => n.name).join(', ') || 'none'}`);
  const dp = plans.filter(active).slice(0, 80).map((d) => `${netName.get(String(d.networkId)) || d.networkId} ${d.planType || ''} ${d.Size || ''} ${d.Validity || ''} ${naira(parsePrice(d.Amount))} [planId ${d.docid}]`);
  if (dp.length) lines.push(`Data plans:\n  ${dp.join('\n  ')}`);
  lines.push(`Cable providers: ${cables.filter(active).map((c) => c.CableName).join(', ') || 'none'}`);
  const cp = cablePlans.filter(active).slice(0, 40).map((c) => `${c.category || ''} ${c.CableplanName || ''} ${naira(parsePrice(c.amount))} [planId ${c.docid}]`);
  if (cp.length) lines.push(`Cable plans:\n  ${cp.join('\n  ')}`);
  lines.push(`Electricity discos: ${discos.filter(active).map((d) => d.Disconame).join(', ') || 'none'}`);
  lines.push(`Exam pins: ${exams.filter(active).map((e) => `${e.examName} ${naira(parsePrice(e.amount))} each`).join(', ') || 'none'}`);
  return lines.join('\n');
}

async function feesBlock() {
  const config = await feeRepo.load().catch(() => null);
  if (!config) return 'Funding fees: unavailable.';
  const s = config.settings;
  const lines = [`Wallet top-up limits: ${naira(s.minDeposit)} to ${naira(s.maxDeposit)} per top-up, whole naira only. Only card payment via Paystack is live; bank transfer and USSD are coming soon.`];
  const active = config.rules.filter((r) => r.active !== false);
  if (!s.enabled || !active.length) {
    lines.push('Funding fees: none. The wallet receives exactly what is paid.');
  } else {
    lines.push('Funding fee rules (use the worked examples or the fee calculator; never invent a fee):');
    active.forEach((r) => lines.push(`  - ${r.name}: ${r.method === 'any' ? 'any method' : r.method}, ${naira(r.minAmount)}–${r.maxAmount == null ? 'no limit' : naira(r.maxAmount)}, ${r.mode === 'on_top' ? 'added on top (customer pays more, wallet gets the full amount)' : 'deducted (wallet gets the amount minus the fee)'}`));
    const examples = [1000, 2000, 5000, 10000, 50000].filter((a) => a >= s.minDeposit && a <= s.maxDeposit);
    examples.forEach((amount) => {
      try {
        const q = fees.quote(config, { amount, method: 'card' });
        lines.push(`  e.g. add ${naira(amount)} by card → pays ${naira(q.charge)}, fee ${naira(q.totalFee)}${q.tax ? ` (incl. ${naira(q.tax)} tax)` : ''}, wallet gets ${naira(q.credit)}`);
      } catch (err) {
        lines.push(`  e.g. add ${naira(amount)} → not allowed: ${err.message}`);
      }
    });
  }
  return lines.join('\n');
}

// Quotes amounts the user actually mentioned, so "fee for 7,350?" gets an
// exact figure instead of an interpolation between the examples.
async function quotesForMessage(text) {
  const nums = [...String(text || '').matchAll(/₦?\s?(\d{1,3}(?:,\d{3})+|\d{3,7})(?:\.\d+)?\s*(k)?/gi)]
    .map((m) => Number(m[1].replace(/,/g, '')) * (m[2] ? 1000 : 1))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 3);
  if (!nums.length || !/fee|charge|cost|fund|add|top.?up|deposit|pay/i.test(text)) return [];
  const config = await feeRepo.load().catch(() => null);
  if (!config) return [];
  return nums.map((amount) => {
    try {
      const q = fees.quote(config, { amount, method: 'card' });
      return `Adding ${naira(amount)} by card: pays ${naira(q.charge)}, fee ${naira(q.totalFee)}${q.tax ? ` (incl. ${naira(q.tax)} tax)` : ''}, wallet gets ${naira(q.credit)}`;
    } catch (err) {
      return `Adding ${naira(amount)}: ${err.message}`;
    }
  });
}

async function build({ uid, message, settings, now = new Date() }) {
  const user = await collection('USERS').findOne({ _id: String(uid) });
  const timeline = await userTimeline(uid, { limit: settings.transactionsInContext, now });
  const [refs, catalogRows, feeText, quotes] = await Promise.all([
    lookupReferences(uid, message), loadCatalog(), feesBlock(), quotesForMessage(message),
  ]);
  const catalog = catalogBlock(catalogRows);
  const refSettings = await referrals.loadSettings();
  const referredCount = refSettings.enabled ? await collection('USERS').countDocuments({ referredBy: String(uid) }) : 0;

  const name = user?.fullname || user?.username || 'Customer';
  const s = timeline.summary;
  const kindLine = (k) => Object.entries(k).map(([kind, amt]) => `${kind} ${naira(amt)}`).join(', ') || 'none';

  const sections = [
    `NOW: ${stamp(now)} (Lagos time)`,
    `CUSTOMER: ${name}${user?.username ? ` (@${user.username})` : ''} | wallet balance ${naira(user?.balance)} | email ${user?.email || '?'} | phone ${user?.phone || '?'}`,
    [
      'SPENDING SUMMARY (pre-computed, trust these over adding rows yourself):',
      `  Today: spent ${naira(s.today.spent)} on ${s.today.count} purchase(s), funded ${naira(s.today.funded)}`,
      `  Last 7 days: spent ${naira(s.last7Days.spent)}, funded ${naira(s.last7Days.funded)}`,
      `  This month: spent ${naira(s.thisMonth.spent)} (${kindLine(s.thisMonth.byKind)}), funded ${naira(s.thisMonth.funded)}, funding fees ${naira(s.thisMonth.feesPaid)}, refunded ${naira(s.thisMonth.refunded)}`,
      `  Last month: spent ${naira(s.lastMonth.spent)} (${kindLine(s.lastMonth.byKind)}), funded ${naira(s.lastMonth.funded)}`,
      timeline.held.length ? `  On hold / in progress right now: ${timeline.held.map((w) => `${naira(w.amount)} ref ${w.transref || w._id} (${w.status})`).join('; ')}` : '  Nothing on hold.',
    ].join('\n'),
    `PURCHASES (newest first, id = receipt route id):\n${timeline.purchases.map(purchaseLine).join('\n') || 'none yet'}`,
    `WALLET LEDGER (newest first):\n${timeline.wallet.map(walletLine).join('\n') || 'none yet'}`,
    refs.length ? `REFERENCES THE CUSTOMER MENTIONED:\n${refs.join('\n')}` : '',
    refSettings.enabled
      ? `REFERRALS: invite friends from Profile → Invite friends (/dashboard/profile/invite). The customer earns ${naira(refSettings.referrerReward)} per friend who signs up with their code and makes a first purchase of ${naira(refSettings.minQualifyingAmount)} or more${refSettings.refereeReward ? `; the friend gets ${naira(refSettings.refereeReward)} too` : ''}. Rewards go straight to the wallet. This customer has referred ${referredCount} friend(s).`
      : 'REFERRALS: not available right now.',
    `STATUS MEANINGS:\n${Object.entries(STATUS_MEANING).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`,
    `FUNDING:\n${feeText}`,
    quotes.length ? `EXACT QUOTES FOR AMOUNTS IN THIS MESSAGE:\n  ${quotes.join('\n  ')}` : '',
    `CATALOG (current prices):\n${catalog}`,
  ].filter(Boolean);

  return {
    text: sections.join('\n\n'),
    firstName: String(name).split(/\s+/)[0],
    balance: Number(user?.balance) || 0,
    phone: user?.phone || null,
    catalog: catalogRows,
    transactionIds: new Set(timeline.purchases.map((t) => String(t._id))),
  };
}

// A signed-out visitor: public information only. No account is looked up, so
// nothing personal can reach the model however the visitor phrases things.
async function buildPublic({ message, now = new Date() }) {
  const [catalogRows, feeText, quotes] = await Promise.all([loadCatalog(), feesBlock(), quotesForMessage(message)]);
  const sections = [
    `NOW: ${stamp(now)} (Lagos time)`,
    'VISITOR: not signed in. You cannot see any account, balance or transaction.',
    `STATUS MEANINGS:\n${Object.entries(STATUS_MEANING).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`,
    `FUNDING:\n${feeText}`,
    quotes.length ? `EXACT QUOTES FOR AMOUNTS IN THIS MESSAGE:\n  ${quotes.join('\n  ')}` : '',
    `CATALOG (current prices):\n${catalogBlock(catalogRows)}`,
  ].filter(Boolean);
  return { text: sections.join('\n\n'), firstName: null, balance: null, phone: null, catalog: catalogRows, transactionIds: new Set() };
}

module.exports = { build, buildPublic, loadCatalog, lookupReferences, quotesForMessage, userTimeline, lagosMonthStart, REF_PATTERN, STATUS_MEANING };
