require('dotenv/config');
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI not set'); process.exit(1); }

const networks = [
  { name: 'MTN',     img: null, active: true },
  { name: 'Airtel',  img: null, active: true },
  { name: 'Glo',     img: null, active: true },
  { name: '9mobile', img: null, active: true },
];

async function run() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db('swiftza');

  const existing = await db.collection('NETWORKS').countDocuments();
  if (existing > 0) {
    console.log(`NETWORKS already has ${existing} documents — skipping.`);
    await client.close();
    return;
  }

  await db.collection('NETWORKS').insertMany(
    networks.map(n => ({ ...n, CreatedAt: new Date() }))
  );
  console.log(`Inserted ${networks.length} networks into swiftza.NETWORKS`);
  await client.close();
  console.log('Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
