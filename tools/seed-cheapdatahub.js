#!/usr/bin/env node
// Loads CheapDataHub's published Plan IDs into the catalog. Dry run by
// default -- prints what it would do and writes nothing.
//
//   node tools/seed-cheapdatahub.js                 # dry run
//   node tools/seed-cheapdatahub.js --apply         # write
//   node tools/seed-cheapdatahub.js --apply --markup=50
//
// What it does:
// - Links existing NETWORKS / ELECTRICITY / CABLES rows to CheapDataHub ids,
//   matched by name. Rows it cannot match are listed, never guessed.
// - Inserts CheapDataHub data bundles and cable plans as NEW rows, INACTIVE,
//   priced at CheapDataHub's cost + --markup naira (default 0). Inactive
//   because a price is a business decision: review them in the admin panel
//   and activate. A plan already carrying the same CheapDataHub id is skipped,
//   so re-running is safe.
//
// Ids and costs copied from cheapdatahub.ng's Plan IDs page on 2026-10-14.
// They change; re-check that page before relying on this table.

require('dotenv/config');
const mongo = require('../src/services/mongo');
const { collection } = mongo;

const NETWORKS = { mtn: 1, glo: 2, airtel: 3, '9mobile': 4 };

// Matched against ELECTRICITY.Disconame as whole words: plain substrings
// mis-link "KAEDCO" (Kaduna) to AEDC and "ABEDC" (Aba) to BEDC.
const DISCOS = [
  [/\babuja\b|\baedc\b/i, 1],
  [/\beko\b|\bekedc\b/i, 2],
  [/\bibadan\b|\bibedc\b/i, 3],
  [/\bikeja\b|\bikedc\b/i, 4],
  [/\bkaduna\b|\bkaedco\b/i, 5],
  [/\bport harcourt\b|\bphed\b/i, 6],
  [/\bjos\b|\bjed\b/i, 7],
  [/\benugu\b|\beedc\b/i, 8],
  [/\byola\b|\byedc\b/i, 9],
  [/\bbenin\b|\bbedc\b/i, 10],
];

// [network, bundle_id, name, cost]. "(UNAVAILABLE)" plans are left out.
const BUNDLES = [
  ['Airtel', 70, '1GB (Social Bundle) Gifting (3 Days)', 295],
  ['Airtel', 13, '500MB Gifting (7 days)', 490],
  ['Airtel', 69, '1.5GB Gifting (1 Day)', 500],
  ['Airtel', 66, '1.5GB Gifting (2 Days)', 599],
  ['Airtel', 15, '1GB Gifting (7 Days)', 800],
  ['Airtel', 17, '2GB Gifting (30 Days)', 1490],
  ['Airtel', 52, '5GB Gifting (7 Days)', 1570],
  ['Airtel', 18, '3GB Gifting (30 Days)', 1960],
  ['Airtel', 22, '6GB SME (7 Days)', 2455],
  ['Airtel', 19, '4GB Gifting (30 Days)', 2570],
  ['Airtel', 20, '8GB Gifting (30 Days)', 2999],
  ['Airtel', 21, '10GB Gifting (30 Days)', 4070],
  ['GLO', 42, '200MB Corporate Gifting (1 Day)', 92],
  ['GLO', 35, '500MB Corporate Gifting (30 Days)', 225],
  ['GLO', 84, '1GB Awoof (1 Day)', 250],
  ['GLO', 68, '1GB Corporate Gifting (3 Days)', 300],
  ['GLO', 36, '1GB Corporate Gifting (30 Days)', 425],
  ['GLO', 41, '1GB Gifting (14 Days)', 485],
  ['GLO', 40, '2GB Corporate Gifting (30 Days)', 850],
  ['GLO', 37, '3GB Corporate Gifting (30 Days)', 1300],
  ['GLO', 54, '5GB Corporate Gifting (7 Days)', 1699],
  ['GLO', 38, '5GB Corporate Gifting (30 Days)', 2250],
  ['GLO', 39, '10GB Corporate Gifting (30 Days)', 4390],
  ['GLO', 59, '20.5GB Gifting (30 Days)', 5300],
  ['GLO', 58, '107GB Gifting (30 Days)', 19300],
  ['MTN', 43, '110MB Gifting (1 Day)', 99],
  ['MTN', 74, '230MB Gifting (1 Day)', 200],
  ['MTN', 76, '500MB SME (2 Days)', 250],
  ['MTN', 44, '500MB Data Share (30 Days)', 300],
  ['MTN', 77, '1GB SME (2 Days)', 399],
  ['MTN', 78, '1GB Awoof (30 Days)', 430],
  ['MTN', 45, '1GB SME (7 Days)', 450],
  ['MTN', 46, '1GB SME (30 Days)', 570],
  ['MTN', 71, '2GB Gifting (7 Days)', 900],
  ['MTN', 27, '2.5GB Gifting (2 Days)', 900],
  ['MTN', 47, '2GB SME (7 Days)', 930],
  ['MTN', 60, '3.5GB Gifting (1 Day)', 1050],
  ['MTN', 48, '2GB SME (30 Days)', 1150],
  ['MTN', 61, '4GB Gifting (2 Days)', 1175],
  ['MTN', 49, '3GB SME (30 Days)', 1370],
  ['MTN', 50, '5GB SME (30 Days)', 2050],
  ['MTN', 53, '6GB Gifting (7 Days)', 2495],
  ['MTN', 55, '11GB Gifting (7 Days)', 3550],
  ['MTN', 33, '7GB Gifting (30 Days)', 3600],
  ['MTN', 67, '10GB Gifting (30 Days)', 4800],
  ['MTN', 57, '36GB Gifting (30 Days)', 10900],
  ['MTN', 51, '75GB SME (30 Days)', 17990],
];

// [provider keyword, plan_id, name, cost]. The first plan per provider is
// also the one used for smart-card validation (CABLES row).
const CABLE_PLANS = [
  ['dstv', 3, 'DStv Padi', 4400],
  ['dstv', 6, 'DStv Yanga', 6000],
  ['dstv', 7, 'DStv Confam', 11000],
  ['dstv', 8, 'DStv Compact', 19000],
  ['dstv', 9, 'DStv Compact Plus', 30000],
  ['dstv', 10, 'DStv Premium', 44500],
  ['gotv', 4, 'GOtv Smallie - Monthly', 1900],
  ['gotv', 11, 'GOtv Jinja', 3900],
  ['gotv', 12, 'GOtv Jolli', 5800],
  ['gotv', 13, 'GOtv Max', 8500],
  ['gotv', 14, 'GOtv Supa', 11400],
  ['gotv', 15, 'GOtv Supa Plus', 16800],
  ['startimes', 5, 'Nova (Antenna) - 1 Week', 700],
  ['startimes', 16, 'Nova (Dish) - 1 Week', 700],
  ['startimes', 17, 'Nova (Antenna) - 1 Month', 2100],
  ['startimes', 18, 'Basic (Antenna) - 1 Week', 1400],
  ['startimes', 19, 'Basic (Dish) - 1 Week', 1700],
  ['startimes', 20, 'Basic (Antenna) - 1 Month', 4000],
  ['startimes', 21, 'Basic (Dish) - 1 Month', 5100],
  ['startimes', 22, 'Classic (Dish) - 1 Week', 2500],
  ['startimes', 23, 'Classic (Dish) - 1 Month', 7400],
  ['startimes', 25, 'Super (Antenna) - 1 Week', 3200],
  ['startimes', 24, 'Super (Dish) - 1 Week', 3300],
  ['startimes', 26, 'Super (Antenna) - 1 Month', 9500],
];

const key = (v) => String(v ?? '').trim().toLowerCase();

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

// "1GB SME (30 Days)" -> { size: '1GB', type: 'SME', validity: '30 Days' }
function parseBundle(name) {
  const validity = name.match(/\(([^)]*day[^)]*)\)/i)?.[1] ?? null;
  const size = name.match(/^[\d.]+\s*[MG]B/i)?.[0].replace(/\s+/g, '').toUpperCase() ?? name;
  const n = key(name);
  const type = n.includes('sme') ? 'SME' : n.includes('corporate') ? 'CORPORATE' : 'GIFTING';
  return { size, type, validity };
}

async function main() {
  const args = parseArgs();
  const apply = Boolean(args.apply);
  const markup = Number(args.markup ?? 0);
  if (!Number.isFinite(markup) || markup < 0) throw new Error('--markup must be a non-negative number');

  await mongo.connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'samzee');
  console.log(`${apply ? 'APPLYING to' : 'DRY RUN against'} db "${process.env.MONGODB_DB || 'samzee'}", markup N${markup}\n`);

  const set = async (name, _id, fields, label) => {
    console.log(`  link   ${label} -> ${JSON.stringify(fields)}`);
    if (apply) await collection(name).updateOne({ _id }, { $set: fields });
  };

  console.log('NETWORKS');
  for (const row of await collection('NETWORKS').find({}).toArray()) {
    const id = NETWORKS[key(row.name)];
    if (id) await set('NETWORKS', row._id, { cheapdatahubNetworkId: id }, row.name);
    else console.log(`  SKIP   ${row.name} (no CheapDataHub network)`);
  }

  console.log('ELECTRICITY');
  for (const row of await collection('ELECTRICITY').find({}).toArray()) {
    const hit = DISCOS.find(([pattern]) => pattern.test(String(row.Disconame ?? '')));
    if (hit) await set('ELECTRICITY', row._id, { cheapdatahubDiscoId: hit[1] }, row.Disconame);
    else console.log(`  SKIP   ${row.Disconame} (CheapDataHub does not list it)`);
  }

  console.log('CABLES');
  const cableRows = await collection('CABLES').find({}).toArray();
  const cableByKeyword = {};
  for (const row of cableRows) {
    const n = key(row.CableName);
    const word = ['dstv', 'gotv', 'startimes'].find((w) => n.includes(w));
    if (!word) {
      console.log(`  SKIP   ${row.CableName} (CheapDataHub does not list it)`);
      continue;
    }
    cableByKeyword[word] = row;
    const validatePlan = CABLE_PLANS.find(([w]) => w === word)[1];
    await set('CABLES', row._id, { cheapdatahubValidatePlanId: validatePlan }, row.CableName);
  }

  console.log('DATAPACKS (new, inactive)');
  const haveBundles = new Set(
    (await collection('DATAPACKS').find({ cheapdatahubBundleId: { $ne: null } }).toArray())
      .map((r) => r.cheapdatahubBundleId)
  );
  const newBundles = [];
  for (const [network, bundleId, name, cost] of BUNDLES) {
    if (haveBundles.has(bundleId)) {
      console.log(`  exists ${network} ${name} (#${bundleId})`);
      continue;
    }
    const { size, type, validity } = parseBundle(name);
    const price = cost + markup;
    console.log(`  add    ${network} ${name} #${bundleId}  cost N${cost} -> sell N${price}`);
    newBundles.push({
      Network: network, planType: type, Size: size, Validity: validity,
      Amount: `₦${price}.0`, dataId: null, vtpassCode: null,
      cheapdatahubBundleId: bundleId, active: false, CreatedAt: new Date(),
    });
  }
  if (apply && newBundles.length) await collection('DATAPACKS').insertMany(newBundles);

  console.log('CABLESPLAN (new, inactive)');
  const havePlans = new Set(
    (await collection('CABLESPLAN').find({ cheapdatahubPlanId: { $ne: null } }).toArray())
      .map((r) => r.cheapdatahubPlanId)
  );
  const newPlans = [];
  for (const [word, planId, name, cost] of CABLE_PLANS) {
    const provider = cableByKeyword[word];
    if (!provider) {
      console.log(`  SKIP   ${name} (no ${word} row in CABLES)`);
      continue;
    }
    if (havePlans.has(planId)) {
      console.log(`  exists ${name} (#${planId})`);
      continue;
    }
    const price = cost + markup;
    console.log(`  add    ${name} #${planId}  cost N${cost} -> sell N${price}`);
    newPlans.push({
      CableplanName: name, amount: price, CableplanID: null,
      // CABLESPLAN links to CABLES by lowercased provider name.
      category: key(provider.CableName), vtpassCode: null,
      cheapdatahubPlanId: planId, active: false, CreatedAt: new Date(),
    });
  }
  if (apply && newPlans.length) await collection('CABLESPLAN').insertMany(newPlans);

  console.log(apply ? '\nDone.' : '\nDry run only. Re-run with --apply to write.');
  await mongo.getClient().close();
}

main().catch(async (err) => {
  console.error(err);
  await mongo.getClient()?.close();
  process.exit(1);
});
