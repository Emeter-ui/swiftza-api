require('dotenv/config');
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI not set'); process.exit(1); }

// Plans per network: [planType, Size, Validity, Amount]
const PLANS = [
  // SME plans
  ['SME', '500MB', '30 days',  150],
  ['SME', '1GB',   '30 days',  250],
  ['SME', '2GB',   '30 days',  450],
  ['SME', '5GB',   '30 days', 1000],
  ['SME', '10GB',  '30 days', 2000],
  // Direct plans
  ['DIRECT', '500MB', '30 days',  200],
  ['DIRECT', '1GB',   '30 days',  300],
  ['DIRECT', '2GB',   '30 days',  500],
  ['DIRECT', '5GB',   '30 days', 1200],
  ['DIRECT', '10GB',  '30 days', 2500],
];

async function run() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db('swiftza');

  const networks = await db.collection('NETWORKS').find({}).toArray();
  if (!networks.length) {
    console.error('No networks found in swiftza.NETWORKS — run seed-networks.js first.');
    await client.close();
    process.exit(1);
  }
  console.log(`Found ${networks.length} networks`);

  const existing = await db.collection('DATAPACKS').countDocuments();
  if (existing > 0) {
    console.log(`DATAPACKS already has ${existing} documents — skipping.`);
    await client.close();
    return;
  }

  const docs = [];
  for (const net of networks) {
    const networkId = net._id.toString();
    for (const [planType, Size, Validity, Amount] of PLANS) {
      docs.push({
        networkId,
        Network: net.name,
        planType,
        Size,
        Validity,
        Amount,
        active: true,
        CreatedAt: new Date(),
      });
    }
  }

  await db.collection('DATAPACKS').insertMany(docs);
  console.log(`Inserted ${docs.length} data plans into swiftza.DATAPACKS`);
  await client.close();
  console.log('Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
