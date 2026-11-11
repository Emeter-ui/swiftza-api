// smazeeapis/tools/capture-vtpass.js
//
// Captures VTpass's real response bodies into tests/fixtures/vtpass/ so tests
// assert against what the provider actually sends rather than a shape someone
// assumed. Run it, commit what it writes, and never hand-edit the output.
//
//   node tools/capture-vtpass.js               # discovery only, no credentials
//   node tools/capture-vtpass.js --buy         # also spends 100 naira of sandbox
//
// The three discovery calls need NO headers at all -- verified against the
// sandbox. --buy needs PROVIDER_VTPASS_API_KEY / _SECRET_KEY in .env.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BASE = process.env.PROVIDER_VTPASS_BASE_URL || 'https://vtpass.com';
const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'vtpass');

async function save(name, url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${name}: ${url} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`captured ${name}.json  (HTTP ${res.status})`);
  return body;
}

async function main() {
  await save('service-categories', `${BASE}/api/service-categories`);
  await save('services-airtime', `${BASE}/api/services?identifier=airtime`);
  await save('service-variations-mtn-data', `${BASE}/api/service-variations?serviceID=mtn-data`);

  if (!process.argv.includes('--buy')) {
    console.log('skipped airtime-success.json (pass --buy to spend 100 sandbox naira)');
    return;
  }

  // A real purchase, because the commission block only exists on a real one.
  // request_id must carry the current minute in Africa/Lagos or VTpass rejects
  // it -- same rule buildRequestId() follows in src/providers/vtpass.js.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  const requestId = `${g('year')}${g('month')}${g('day')}${g('hour')}${g('minute')}capture${Date.now()
    .toString(36)}`;

  const body = await save('airtime-success', `${BASE}/api/pay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': process.env.PROVIDER_VTPASS_API_KEY,
      'secret-key': process.env.PROVIDER_VTPASS_SECRET_KEY,
    },
    body: JSON.stringify({
      request_id: requestId,
      serviceID: 'mtn',
      amount: 100,
      phone: '08011111111',
    }),
  });
  console.log('request_id:', requestId);
  console.log('status:', body?.content?.transactions?.status);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
