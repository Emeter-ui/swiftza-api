require('dotenv/config');
const { MongoClient } = require('mongodb');

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI not set'); process.exit(1); }

// Strip the database name from the URI so we can connect to both DBs
const baseUri = URI.replace(/\/[^/?]+(\?|$)/, '/$1');

async function run() {
  const client = new MongoClient(URI);
  await client.connect();

  const samzee  = client.db('samzee');
  const swiftza = client.db('swiftza');

  const networks = await samzee.collection('NETWORKS').find({}).toArray();
  console.log(`Found ${networks.length} networks in samzee`);

  if (!networks.length) {
    console.log('Nothing to migrate.');
    await client.close();
    return;
  }

  // Drop existing and re-insert so this script is safe to re-run
  await swiftza.collection('NETWORKS').deleteMany({});
  await swiftza.collection('NETWORKS').insertMany(networks);
  console.log(`Copied ${networks.length} networks to swiftza.NETWORKS`);

  await client.close();
  console.log('Done.');
}

run().catch(err => { console.error(err); process.exit(1); });
