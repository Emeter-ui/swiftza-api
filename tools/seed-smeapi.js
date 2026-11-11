#!/usr/bin/env node
// Seeds SME API network IDs and data plans into the catalog.
// Dry run by default — prints what it would do and writes nothing.
//
//   node tools/seed-smeapi.js                   # dry run
//   node tools/seed-smeapi.js --apply            # write to MongoDB
//   node tools/seed-smeapi.js --apply --markup=5 # write with 5% markup
//
// What it does:
// - NETWORKS: sets smeapiNetworkId on existing rows matched by name, or
//   creates the row if none exists. Network IDs are fixed from the dashboard.
// - DATAPACKS: fetches live plans from GET /api/dataplans/ and inserts NEW
//   rows (inactive, priced at SME cost + --markup%). Plans already carrying
//   the same smeapiDataPlanId are skipped, so re-running is safe.
//
// Network IDs from the SME API dashboard (Vendor account):
//   MTN=1  Glo=2  9mobile=3  Airtel=4

require('dotenv/config');
const mongo = require('../src/services/mongo');
const { collection } = mongo;

const APPLY = process.argv.includes('--apply');
const markupArg = process.argv.find((a) => a.startsWith('--markup='));
const MARKUP = markupArg ? Number(markupArg.split('=')[1]) : 0;

const BASE_URL = process.env.PROVIDER_SMEAPI_BASE_URL || 'https://smeapi.com.ng';

// Fixed from the SME API dashboard — these never change per account.
const NETWORK_IDS = [
  { name: 'MTN',     smeapiNetworkId: 1 },
  { name: 'Glo',     smeapiNetworkId: 2 },
  { name: '9mobile', smeapiNetworkId: 3 },
  { name: 'Airtel',  smeapiNetworkId: 4 },
];

const key = (v) => String(v ?? '').trim().toLowerCase();

function round2(n) { return Math.round(n * 100) / 100; }

function priceWithMarkup(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return Math.ceil(cost * (1 + MARKUP / 100));
}

async function fetchPlans() {
  const res = await fetch(`${BASE_URL}/api/dataplans/`, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`SME API returned ${res.status}`);
  const body = await res.json();
  // Response: { status: 'success', data: [...] }
  const plans = body?.data ?? body;
  if (!Array.isArray(plans)) throw new Error(`Unexpected response shape: ${JSON.stringify(body).slice(0, 200)}`);
  return plans;
}

async function seedNetworks() {
  console.log('\n=== NETWORKS ===');
  const col = collection('NETWORKS');

  for (const entry of NETWORK_IDS) {
    const existing = await col.findOne({
      name: { $regex: new RegExp(`^${entry.name}$`, 'i') },
    });

    if (existing) {
      if (existing.smeapiNetworkId === entry.smeapiNetworkId) {
        console.log(`  [skip]   ${entry.name} — already has smeapiNetworkId=${entry.smeapiNetworkId}`);
        continue;
      }
      console.log(`  [update] ${entry.name} — set smeapiNetworkId=${entry.smeapiNetworkId}`);
      if (APPLY) {
        await col.updateOne(
          { _id: existing._id },
          { $set: { smeapiNetworkId: entry.smeapiNetworkId } }
        );
      }
    } else {
      console.log(`  [create] ${entry.name} — new row with smeapiNetworkId=${entry.smeapiNetworkId}`);
      if (APPLY) {
        await col.insertOne({
          name: entry.name,
          smeapiNetworkId: entry.smeapiNetworkId,
          active: true,
        });
      }
    }
  }
}

async function seedDataPlans(plans) {
  console.log('\n=== DATA PLANS ===');
  const col = collection('DATAPACKS');

  let skipped = 0, created = 0, noPrice = 0;

  for (const plan of plans) {
    const id = plan.id;
    if (!id) continue;

    const existing = await col.findOne({ smeapiDataPlanId: id });
    if (existing) {
      skipped++;
      continue;
    }

    const cost = Number(plan.price ?? 0);
    const price = priceWithMarkup(cost);

    if (!price) {
      console.log(`  [skip-no-price] plan ${id} ${plan.network} ${plan.name}`);
      noPrice++;
      continue;
    }

    const network = String(plan.network ?? '').trim();
    const name = String(plan.name ?? '').trim();
    const validity = String(plan.days ?? '').trim();
    const type = String(plan.type ?? '').trim();

    // Parse size from the plan name (e.g. "1GB", "500MB")
    const sizeMatch = name.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i);
    const size = sizeMatch ? `${sizeMatch[1]}${sizeMatch[2].toUpperCase()}` : name;

    console.log(`  [create] ${id.toString().padStart(4)} ${network.padEnd(8)} ${size.padEnd(10)} ${validity.padEnd(20)} ₦${cost} → ₦${price}`);
    created++;

    if (APPLY) {
      await col.insertOne({
        Network: network,
        Size: size,
        Validity: validity,
        planType: type || null,
        Amount: `₦${price}.0`,
        smeapiDataPlanId: id,
        active: false, // inactive until you review and enable
      });
    }
  }

  console.log(`\n  Done: ${created} to create, ${skipped} already imported, ${noPrice} skipped (no price)`);
}

async function main() {
  if (!APPLY) {
    console.log('DRY RUN — pass --apply to write changes\n');
  } else {
    console.log(`APPLYING changes (markup: ${MARKUP}%)\n`);
  }

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'sameazy';
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }

  try {
    await mongo.connect(uri, dbName);

    await seedNetworks();

    console.log('\nFetching data plans from SME API...');
    const plans = await fetchPlans();
    console.log(`  Got ${plans.length} plans`);
    await seedDataPlans(plans);

  } finally {
    await mongo.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
