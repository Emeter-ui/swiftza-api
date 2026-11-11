require('dotenv/config');

// API_KEY and APP_ID keep their original names because the deployed
// environment already sets them; renaming would break the live deploy.
// FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_STORAGE_BUCKET and
// FIREBASE_MESSAGING_SENDER_ID are listed here only to produce the startup
// warning below if a deploy forgets them -- they stay optional() (not
// requireSecret()) below because they are not needed for email/password auth
// and hard-requiring them would break the test suite.
const SECRETS = [
  'API_KEY',
  'APP_ID',
  'PAYSTACK_SECRET_KEY',
  'PAYSTACK_WEBHOOK_SECRET',
  'PROVIDER_SMEAPI_TOKEN',
  'PROVIDER_CHEAPDATAHUB_API_KEY',
  'JWT_SECRET',
  'MONGODB_URI',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
];

const missing = SECRETS.filter((name) => !process.env[name]);
if (missing.length) {
  console.warn(
    `[config] missing env vars: ${missing.join(', ')}. ` +
      `Routes depending on them will fail until they are set.`
  );
}

// Throws at call time rather than boot so the process still starts and
// reports which specific secret is missing on the route that needs it.
function requireSecret(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function optionalInt(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  requireSecret,
  optional,
  optionalInt,
  port: optionalInt('PORT', 3000),
  nodeEnv: optional('NODE_ENV', 'development'),
  corsOrigins: optional('CORS_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  firebase: {
    apiKey: () => requireSecret('API_KEY'),
    appId: () => requireSecret('APP_ID'),
    authDomain: optional('FIREBASE_AUTH_DOMAIN', ''),
    projectId: optional('FIREBASE_PROJECT_ID', ''),
    storageBucket: optional('FIREBASE_STORAGE_BUCKET', ''),
    messagingSenderId: optional('FIREBASE_MESSAGING_SENDER_ID', ''),
  },
  paystack: {
    secretKey: () => requireSecret('PAYSTACK_SECRET_KEY'),
    webhookSecret: () => requireSecret('PAYSTACK_WEBHOOK_SECRET'),
    baseUrl: optional('PAYSTACK_BASE_URL', 'https://api.paystack.co'),
  },
  http: {
    timeoutMs: optionalInt('UPSTREAM_TIMEOUT_MS', 30000),
  },
  jwt: {
    secret: () => requireSecret('JWT_SECRET'),
    // Sessions are long-lived because the app has no refresh-token flow yet;
    // shortening this logs users out mid-session.
    ttl: optional('JWT_TTL', '7d'),
  },
  mongo: {
    uri: () => requireSecret('MONGODB_URI'),
    dbName: optional('MONGODB_DB', 'samzee'),
  },
};
