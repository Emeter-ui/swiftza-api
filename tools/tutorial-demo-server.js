/* eslint-disable no-console */
// Throwaway API for recording the admin tutorial. Runs the real app against an
// in-memory MongoDB replica set filled with invented demo data, so the video
// never shows (or touches) a real customer. Nothing here reads MONGODB_URI.
//
//   node tools/tutorial-demo-server.js --port 3905
//
// Prints one JSON line {"ready":true,"port":..,"token":..,"user":..} on stdout
// once seeded, then keeps serving until killed.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'tutorial-demo-secret-not-for-production-use';
for (const k of ['API_KEY', 'APP_ID', 'PAYSTACK_SECRET_KEY', 'PAYSTACK_WEBHOOK_SECRET', 'PROVIDER_SMEAPI_TOKEN', 'PROVIDER_CHEAPDATAHUB_API_KEY']) {
  process.env[k] ||= `demo-${k.toLowerCase()}`;
}
process.env.MONGODB_URI = 'mongodb://unused-demo';
delete process.env.CORS_ORIGINS;

const port = Number((process.argv.find((a, i) => process.argv[i - 1] === '--port')) || 3905);

const { MongoMemoryReplSet } = require('mongodb-memory-server');
const mongo = require('../src/services/mongo');
const { signSession } = require('../src/middleware/auth');
const { PRESETS, normalizeRule } = require('../src/models/fees');

// Without an AI key the assistant test console would only show an error, so
// in this demo (and only here) answer OpenRouter calls with a scripted reply.
if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY) {
  process.env.OPENROUTER_API_KEY = 'demo';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('openrouter.ai/api/v1/chat')) {
      const reply = {
        reply: 'Your MTN 2GB data on 18 Nov failed at the provider, so the ₦1,000 was refunded to your wallet the same minute. Your balance is now ₦12,450. Want to try the purchase again?',
        in_scope: true,
        actions: [{ label: 'Buy MTN data again', route: '/dashboard/buy/data', params: { network: 'MTN' } }],
        suggestions: ['What did I spend this month?', 'How much is the fee to add ₦5,000?'],
      };
      return { status: 200, text: async () => JSON.stringify({ model: 'demo/scripted', choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 2140, completion_tokens: 96 } }) };
    }
    return realFetch(url, init);
  };
}

const FIRST = ['Adaeze', 'Tunde', 'Chiamaka', 'Ibrahim', 'Funmilayo', 'Emeka', 'Zainab', 'Segun', 'Ngozi', 'Musa', 'Kemi', 'Obinna'];
const LAST = ['Okafor', 'Adeyemi', 'Nwosu', 'Bello', 'Ogunleye', 'Eze', 'Abubakar', 'Balogun', 'Uche', 'Danjuma', 'Afolabi', 'Igwe'];
const DAY = 24 * 60 * 60 * 1000;
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');

async function api(path, method, body, token) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) console.error(`[demo-seed] ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function seedRaw(db) {
  const now = Date.now();
  await db.collection('USERS').insertOne({ _id: 'demo-admin', username: 'ops.lead', fullname: 'Ops Lead', email: 'ops@swiftza.demo', phone: '08000000000', account: 'ADMIN', balance: 0, setUpProcess: true, CreatedAt: new Date(now - 90 * DAY) });

  const customers = FIRST.map((f, i) => ({
    _id: `demo-user-${i + 1}`, username: `${f.toLowerCase()}${LAST[i].slice(0, 3).toLowerCase()}`, fullname: `${f} ${LAST[i]}`,
    email: `${f.toLowerCase()}.${LAST[i].toLowerCase()}@example.com`, phone: `080${String(31000000 + i * 7919).padStart(8, '0')}`,
    account: 'USER', balance: Math.round(rand() * 40000) + 500, setUpProcess: true, CreatedAt: new Date(now - (60 - i * 4) * DAY),
  }));
  await db.collection('USERS').insertMany(customers);

  const kinds = [['Data', [500, 1000, 1500, 3000]], ['Airtime', [200, 500, 1000, 2000]], ['Cable', [4150, 6000, 11400]], ['Electricity', [3000, 5000, 10000]], ['Epin', [3500]]];
  const purchases = [];
  const wallet = [];
  for (let i = 0; i < 64; i += 1) {
    const u = pick(customers);
    const [kind, amounts] = pick(kinds);
    const amount = pick(amounts);
    const at = new Date(now - Math.floor(rand() * 21 * DAY) - Math.floor(rand() * DAY));
    const ref = `pur_${hex(24)}`;
    const roll = rand();
    const outcome = roll < 0.82 ? 'success' : roll < 0.95 ? 'reversed' : 'requery';
    purchases.push({
      _id: ref, uid: u._id, transref: ref, amount, CreatedAt: at, provider: 'smeapi',
      transType: outcome === 'success' ? kind : outcome === 'reversed' ? `${kind}-Reversed` : `${kind}-Pending`,
      status: outcome === 'success' ? 'success' : outcome === 'reversed' ? 'error' : 'pending',
      message: outcome === 'reversed' ? 'Provider rejected the request: plan temporarily unavailable' : outcome === 'success' ? 'Transaction successful' : 'Awaiting provider confirmation',
      providerEarning: outcome === 'success' ? Math.round(amount * 0.02 * 100) / 100 : null,
      providerEarningRate: outcome === 'success' ? 2 : null,
      providerAmountCharged: outcome === 'success' ? amount * 0.98 : null,
    });
    wallet.push({
      _id: ref, uid: u._id, email: u.email, transref: ref, channel: 'Wallet', amount, prevBal: u.balance + amount, newBal: u.balance,
      mode: outcome === 'reversed' ? 'credit-reversal' : 'debit', validate: outcome !== 'requery',
      status: outcome === 'success' ? 'success' : outcome === 'reversed' ? 'reversed' : 'requery',
      ...(outcome === 'requery' ? { requeryReason: 'timeout', providerRequestId: `SWZ${hex(10)}`, flaggedAt: at } : {}),
      ...(outcome === 'reversed' ? { reversalReason: 'provider rejected', reversedAt: at } : {}),
      CreatedAt: at,
    });
  }
  // Two held purchases from today, so the Requery tab has something fresh.
  for (const u of customers.slice(0, 2)) {
    const ref = `pur_${hex(24)}`;
    const at = new Date(now - Math.floor(rand() * 3) * 60 * 60 * 1000 - 20 * 60 * 1000);
    purchases.push({ _id: ref, uid: u._id, transref: ref, amount: 1000, transType: 'Data-Pending', status: 'pending', message: 'Awaiting provider confirmation', provider: 'smeapi', CreatedAt: at });
    wallet.push({ _id: ref, uid: u._id, email: u.email, transref: ref, channel: 'Wallet', amount: 1000, prevBal: u.balance + 1000, newBal: u.balance, mode: 'debit', validate: false, status: 'requery', requeryReason: 'timeout', providerRequestId: `SWZ${hex(10)}`, flaggedAt: at, CreatedAt: at });
  }
  // Paystack top-ups, priced by the preset fee rules.
  for (let i = 0; i < 26; i += 1) {
    const u = pick(customers);
    const credit = pick([1000, 2000, 3000, 5000, 10000, 20000]);
    const fee = credit < 2500 ? Math.round(credit * 0.015 / 0.985 * 100) / 100 : Math.min(Math.round((credit + 100) / 0.985 * 0.015 * 100) / 100 + 100, 2000);
    const ref = `ps_SWZ-${now - i * 3600000}-${hex(10)}`;
    const at = new Date(now - Math.floor(rand() * 21 * DAY));
    wallet.push({ _id: ref, uid: u._id, email: u.email, transref: ref, channel: 'Wallet', paychannel: 'card', amount: credit, prevBal: u.balance, newBal: u.balance + credit, mode: 'credit', validate: true, status: 'success', source: 'webhook', grossPaid: credit + fee, fee, tax: 0, totalFee: fee, feeMode: 'on_top', feeRuleName: credit < 2500 ? 'Paystack local · under ₦2,500' : 'Paystack local · ₦2,500 and above', CreatedAt: at });
  }
  await db.collection('TRANSACTIONS').insertMany(purchases);
  await db.collection('WALLETTRANSACTIONS').insertMany(wallet);

  await db.collection('ATCORDERS').insertMany(customers.slice(3, 6).map((u, i) => ({
    _id: `atc_demo_${i}_${hex(8)}`, uid: u._id, transref: `atc_demo_${i}`, channel: 'AirtimeToCash', network: ['MTN', 'Airtel', 'Glo'][i],
    atcNumber: '08031234567', percent: 20, amount: [5000, 2000, 10000][i], reciveAmount: [4000, 1600, 8000][i], status: 'pending', validate: false,
    CreatedAt: new Date(now - (i + 1) * 5 * 60 * 60 * 1000),
  })));

  await db.collection('waitlist').insertMany(['amaka.j', 'dayo.f', 'halima.s', 'chidi.o', 'bisi.k', 'yusuf.a', 'tola.m', 'efe.n'].map((n, i) => ({
    email: `${n}@example.com`, joinedAt: new Date(now - i * 2 * DAY), source: i % 2 ? 'landing' : 'referral',
  })));

  await db.collection('AILOGS').insertMany([
    { uid: customers[0]._id, message: 'Why was my data reversed?', reply: 'The provider rejected the plan, so ₦1,000 went back to your wallet.', inScope: true, actions: ['/dashboard/buy/data?network=MTN'], provider: 'openrouter', model: 'google/gemini-2.5-flash', latencyMs: 1840, tokensIn: 2210, tokensOut: 88, failures: [] },
    { uid: customers[1]._id, message: 'How much to add 5000?', reply: 'Adding ₦5,000 by card costs ₦5,177.66; your wallet gets the full ₦5,000.', inScope: true, actions: ['/dashboard/wallet/fund?amount=5000'], provider: 'openrouter', model: 'google/gemini-2.5-flash', latencyMs: 1320, tokensIn: 2105, tokensOut: 61, failures: [] },
    { uid: customers[2]._id, message: 'Who won the match yesterday?', reply: 'I can only help with your Swiftza account: payments, bills, top-ups, transactions and how the app works.', inScope: false, actions: [], provider: 'gemini', model: 'gemini-2.5-flash', latencyMs: 2410, tokensIn: 1980, tokensOut: 40, failures: [{ provider: 'openrouter', reason: 'timeout' }] },
  ].map((r, i) => ({ ...r, CreatedAt: new Date(now - i * 47 * 60 * 1000) })));

  return customers;
}

async function seedViaApi(token) {
  const post = (p, b) => api(p, 'POST', b, token);
  const nets = {};
  for (const [name, id] of [['MTN', 1], ['Airtel', 4], ['Glo', 2], ['9mobile', 3]]) {
    const r = await post('/admin/networks', { name, smeapiNetworkId: id, active: true });
    nets[name] = r?.item?.id || r?.id;
  }
  const plans = [['MTN', 'SME', '1GB', 280, '30 days', 1], ['MTN', 'SME', '2GB', 560, '30 days', 2], ['MTN', 'SME', '5GB', 1400, '30 days', 3], ['MTN', 'GIFTING', '1.5GB', 1000, '30 days', 4],
    ['Airtel', 'CORPORATE', '1GB', 300, '30 days', 5], ['Airtel', 'CORPORATE', '2GB', 600, '30 days', 6], ['Glo', 'GIFTING', '2.9GB', 1000, '30 days', 7], ['9mobile', 'SME', '1GB', 250, '30 days', 8]];
  for (const [network, type, size, amount, validity, pid] of plans) {
    await post('/admin/data-plans', { network, type, size, amount, validity, smeapiDataPlanId: pid, active: true });
  }
  const cableIds = {};
  for (const [name, cid, sid] of [['GOtv', 1, 1], ['DStv', 2, 2], ['StarTimes', 3, 3]]) {
    const r = await post('/admin/cables', { name, cableId: cid, smeapiCableProviderId: sid, active: true });
    cableIds[name] = r?.item?.id || r?.id;
  }
  for (const [prov, name, price, code] of [['GOtv', 'GOtv Max', 7200, 1], ['GOtv', 'GOtv Jolli', 4850, 2], ['DStv', 'DStv Compact', 15700, 3], ['DStv', 'DStv Padi', 4400, 4], ['StarTimes', 'Nova', 1900, 5]]) {
    if (cableIds[prov]) await post('/admin/cable-plans', { name, price, providerId: cableIds[prov], planCode: code, smeapiCablePlanId: code, active: true });
  }
  for (const [name, d] of [['Ikeja Electric', 1], ['Eko Electric', 2], ['Abuja Electric', 3], ['Ibadan Electric', 4]]) {
    await post('/admin/electricity', { name, discoId: d, smeapiDiscoId: d, active: true });
  }
  for (const [name, price, id] of [['WAEC', 3500, 1], ['NECO', 1300, 2], ['NABTEB', 1000, 3]]) {
    await post('/admin/epins', { name, unitPrice: price, smeapiExamProviderId: id, active: true });
  }
  for (const [network, rate] of [['MTN', 0.2], ['Airtel', 0.22], ['Glo', 0.25]]) {
    await post('/admin/atc', { network, commissionRate: rate, payoutNumber: '08031234567', active: true });
  }
  for (const [label, kind, rate] of [['MTN Airtime VTU', 'airtime', 3], ['Data bundles', 'data', 2], ['Cable TV', 'cable', 1.5], ['Electricity', 'electricity', 1]]) {
    await post('/admin/provider-rates', { provider: 'smeapi', serviceLabel: label, matchesTransType: kind, expectedRate: rate, active: true });
  }
  await api('/admin/fees/rules', 'PUT', { rules: PRESETS.paystack_local.map((r) => normalizeRule(r).rule) }, token);
  await api('/admin/fees/settings', 'PUT', { settings: { minDeposit: 100, maxDeposit: 500000 } }, token);
}

(async () => {
  const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongo.connect(replset.getUri(), 'swiftza_tutorial_demo');
  await mongo.ensureIndexes();
  const db = mongo.getDb();

  const app = require('../src/app');
  const server = app.listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));

  await seedRaw(db);
  const token = signSession({ uid: 'demo-admin', account: 'ADMIN' });
  await seedViaApi(token);

  const user = { id: 'demo-admin', username: 'ops.lead', fullname: 'Ops Lead', email: 'ops@swiftza.demo', phone: '08000000000', wallet: 0, role: 'ADMIN' };
  process.stdout.write(`${JSON.stringify({ ready: true, port, token, user })}\n`);

  const stop = async () => { server.close(); await mongo.close(); await replset.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((err) => { console.error(err); process.exit(1); });
