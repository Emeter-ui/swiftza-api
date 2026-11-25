const { collection } = require('../services/mongo');
const logger = require('../services/logger');

const WALLET = 'WALLETTRANSACTIONS';
const EVENTS = 'USERNOTIFICATIONS'; // account events; money comes from the ledger
const READS = 'NOTIFICATIONREADS';
const LIMIT = 50;

const naira = (n) => `₦${(Math.abs(Number(n)) || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

const LABELS = { epin: 'E-Pin', epins: 'E-Pin', cable: 'Cable TV' };
function service(row) {
  const raw = String(row.transType || row.channel || '').replace(/-(Reversed|Pending)$/i, '').trim();
  if (!raw || /^wallet$/i.test(raw)) return 'purchase';
  return LABELS[raw.toLowerCase()] || raw;
}

// One wallet row is one money event, so deriving from it cannot miss a path
// (webhook, admin, legacy routes) or disagree with the balance.
function fromWallet(row) {
  const amount = naira(row.amount);
  const what = service(row);
  const text = {
    credit: ['Wallet funded', `${amount} was added to your wallet.`, 'credit'],
    'admin-credit': ['Wallet credited', `${amount} was added to your wallet.`, 'credit'],
    'admin-debit': ['Wallet debited', `${amount} was removed from your wallet.`, 'debit'],
    'atc-credit': ['Airtime to cash paid', `${amount} was added to your wallet.`, 'credit'],
    'credit-reversal': ['Payment refunded', `Your ${amount} ${what} payment failed and was refunded.`, 'refund'],
  }[row.mode];
  let entry = text;
  if (row.mode === 'debit') {
    entry = row.status === 'success'
      ? ['Payment successful', `Your ${amount} ${what} payment was successful.`, 'success']
      : ['Payment pending', `Your ${amount} ${what} payment is being confirmed.`, 'pending'];
  } else if (entry && row.mode === 'credit' && row.status !== 'success') {
    return null; // a deposit that has not landed
  }
  if (!entry) return null;
  return { id: `w_${row._id}`, title: entry[0], body: entry[1], type: entry[2], createdAt: row.eventAt };
}

async function load(uid) {
  const owner = String(uid ?? '');
  if (!owner) throw new Error('notifications require an owner');

  const [rows, events, read] = await Promise.all([
    collection(WALLET).aggregate([
      { $match: { $or: [{ uid: owner }, { userId: owner }] } },
      // A pending order that is later settled or refunded is news again.
      { $addFields: { eventAt: { $ifNull: ['$reversedAt', { $ifNull: ['$settledAt', '$CreatedAt'] }] } } },
      { $match: { eventAt: { $type: 'date' } } },
      { $sort: { eventAt: -1 } },
      { $limit: LIMIT },
      { $lookup: { from: 'TRANSACTIONS', localField: '_id', foreignField: '_id', as: 'tx' } },
      { $project: { amount: 1, mode: 1, status: 1, channel: 1, eventAt: 1, transType: { $first: '$tx.transType' } } },
    ]).toArray(),
    collection(EVENTS).find({ uid: owner }).sort({ CreatedAt: -1 }).limit(LIMIT).toArray(),
    collection(READS).findOne({ _id: owner }),
  ]);

  const readAt = read?.readAt?.getTime() ?? 0;
  return [
    ...rows.map(fromWallet).filter(Boolean),
    ...events.map((e) => ({ id: `e_${e._id}`, title: e.title, body: e.body, type: e.type, createdAt: e.CreatedAt })),
  ]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, LIMIT)
    .map((n) => ({ ...n, unread: n.createdAt.getTime() > readAt, createdAt: n.createdAt.toISOString() }));
}

async function markRead(uid, upTo) {
  const at = new Date(typeof upTo === 'string' ? upTo : NaN);
  // Never past "now", so a bad clock cannot hide future notifications.
  const readAt = Number.isNaN(at.getTime()) ? new Date() : new Date(Math.min(at.getTime(), Date.now()));
  await collection(READS).updateOne({ _id: String(uid) }, { $max: { readAt } }, { upsert: true });
}

// Best-effort: a notification must never fail the action it describes.
async function notify(uid, { title, body, type = 'security' }) {
  try {
    await collection(EVENTS).insertOne({ uid: String(uid), title, body, type, CreatedAt: new Date() });
  } catch (err) {
    logger.error({ err: err.message }, 'could not write notification');
  }
}

module.exports = { load, markRead, notify };
