#!/usr/bin/env node
// Seeds an admin account: creates the Firebase Auth user, writes the profile
// to MongoDB with account=ADMIN and setUpProcess=true, and prints the
// credentials to stdout. Run once locally after setting up .env.
//
//   node tools/seed-admin.js
//
// Optional overrides via CLI flags:
//   --email=x@y.com   (default: superadmin@samzee.local)
//   --username=foo    (default: superadmin)
//   --password=…      (default: freshly generated)

require('dotenv/config');
const crypto = require('crypto');
const { authfunc } = require('../src/services');
const users = require('../src/repositories/users');
const mongo = require('../src/services/mongo');

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function randomPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, 'x') + 'A1!';
}

async function main() {
  const args = parseArgs();
  const email = args.email || 'superadmin@samzee.local';
  const username = args.username || 'superadmin';
  const password = args.password || randomPassword();

  await mongo.connect(process.env.MONGODB_URI, process.env.MONGODB_DB || 'samzee');

  let uid;
  try {
    const cred = await authfunc.signup(email, password);
    uid = cred.user.uid;
    console.log(`[seed] Firebase Auth user created: ${uid}`);
  } catch (err) {
    if (err.code === 'auth/email-already-in-use') {
      console.error(
        `[seed] ${email} is already registered in Firebase Auth.\n` +
          `       This script cannot reset a Firebase password without the Admin SDK.\n` +
          `       Either re-run with a different --email=… or delete the Auth user from the Firebase console and retry.`
      );
      process.exit(1);
    }
    throw err;
  }

  const existing = await users.findByUid(uid);
  if (existing) {
    await users.update(uid, { account: 'ADMIN', setUpProcess: true, username, fullname: 'Super Admin' });
  } else {
    await users.create(uid, {
      email,
      username,
      fullname: 'Super Admin',
      account: 'ADMIN',
      setUpProcess: true,
      balance: 0,
      bonusBalance: 0,
      userId: uid,
      uniqueId: uid,
    });
  }

  console.log('\n=== ADMIN CREDENTIALS (save these — the password is not stored) ===');
  console.log(`email:    ${email}`);
  console.log(`username: ${username}`);
  console.log(`password: ${password}`);
  console.log(`uid:      ${uid}`);
  console.log('====================================================================\n');

  // Firebase client keeps the process alive with its network handles; force
  // exit so the script doesn't hang after logging.
  process.exit(0);
}

main().catch((err) => {
  console.error('[seed] failed:', err.message || err);
  process.exit(1);
});
