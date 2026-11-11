const express = require('express');
const router = express.Router();
const users = require('../repositories/users');
const catalogRepo = require('../repositories/catalog');
const ledger = require('../repositories/ledger');
const {
  asyncHandler,
  requireAuth,
  requireAdmin,
  optionalAuth,
} = require('../middleware');
const { validationFailed, AppError } = require('../models/errors');

// Catalog collections the admin panel manages.
const CATALOG = [
  'NETWORKS',
  'DATAPACKS',
  'CABLES',
  'CABLESPLAN',
  'ELECTRICITY',
  'EPIN',
  'ATC',
];

const READABLE = [...CATALOG, 'USERS', 'TRANSACTIONS', 'WALLETTRANSACTIONS'];
const WRITABLE = [...CATALOG, 'USERS'];

// The catalog is what the login and home screens render before anyone signs
// in, so it stays public. Everything else needs a session.
const PUBLIC_READ = CATALOG;

// Ledgers a signed-in user may read, but only their own rows.
const OWNED_READ = { TRANSACTIONS: ['uid'], WALLETTRANSACTIONS: ['uid', 'userId'] };

// Ledger collections are only ever written by the finance layer inside a
// transaction; letting them through this generic endpoint would allow balances
// and transaction history to be forged.
const NEVER_WRITABLE = ['TRANSACTIONS', 'WALLETTRANSACTIONS'];

// Fields on a USERS document that a profile update must never touch.
const PROTECTED_USER_FIELDS = [
  'balance',
  'bonusBalance',
  'account',
  'setUpProcess',
  'uniqueId',
  'userId',
  'passwd',
  'password',
  'paystacksecretkey',
  'paystackpublickey',
  'apiurl',
];

const SENSITIVE_OUTPUT_FIELDS = ['passwd', 'password', 'paystacksecretkey'];

// `forWrite` matters: the ledgers are readable (that is what the transaction
// and wallet pages render) but must never be written through this endpoint.
function assertCollection(name, allowed, forWrite = true) {
  if (!name || typeof name !== 'string') {
    throw validationFailed('A collection name is required');
  }
  if (forWrite && NEVER_WRITABLE.includes(name)) {
    throw new AppError(
      'FORBIDDEN_COLLECTION',
      'This collection cannot be modified directly',
      403
    );
  }
  if (!allowed.includes(name)) {
    throw new AppError('FORBIDDEN_COLLECTION', 'Unknown collection', 403);
  }
  return name;
}

function stripSensitive(doc) {
  const clean = { ...doc };
  for (const field of SENSITIVE_OUTPUT_FIELDS) delete clean[field];
  return clean;
}

function stripProtected(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw validationFailed('Update payload must be an object');
  }
  const clean = { ...data };
  for (const field of PROTECTED_USER_FIELDS) delete clean[field];
  if (Object.keys(clean).length === 0) {
    throw validationFailed('No updatable fields supplied');
  }
  return clean;
}

async function isAdmin(user) {
  if (!user) return false;
  const record = await users.findByUid(String(user.uid));
  return Boolean(record) && record.account === 'ADMIN';
}

router.post(
  '/',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const collection = assertCollection(req.body.collection, READABLE, false);
    const sort = ['asc', 'desc'].includes(req.body.sort) ? req.body.sort : '';
    const admin = await isAdmin(req.user);

    if (!PUBLIC_READ.includes(collection) && !req.user) {
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue', 401);
    }
    // Only an admin has any reason to list every account.
    if (collection === 'USERS' && !admin) {
      throw new AppError('FORBIDDEN', 'Administrator access required', 403);
    }

    if (collection === 'USERS') {
      return res.json((await users.listAll(sort)).map(stripSensitive));
    }

    // The ledger pages used to download every transaction in the system and
    // filter client-side, so any user could read everyone else's history.
    // Filtering in the query keeps those pages working and stops the leak.
    // Every owner field is indexed (uid and, for WALLETTRANSACTIONS, userId
    // too) so the $or below can use an index-OR plan rather than scanning.
    const ownerFields = OWNED_READ[collection];
    if (ownerFields) {
      return res.json(
        admin
          ? await ledger.listAll(collection, sort)
          : await ledger.listByOwner(collection, req.user.uid, ownerFields)
      );
    }

    res.json(await catalogRepo.list(collection, sort));
  })
);

router.post(
  '/update',
  requireAuth,
  asyncHandler(async (req, res) => {
    const collection = assertCollection(req.body.collection, WRITABLE);
    const { uid } = req.body;

    if (!uid) throw validationFailed('A document id is required');

    const admin = await isAdmin(req.user);
    // A user may edit their own profile; everything else is the admin panel.
    const editingOwnProfile =
      collection === 'USERS' && String(uid) === req.user.uid;
    if (!admin && !editingOwnProfile) {
      throw new AppError('FORBIDDEN', 'Administrator access required', 403);
    }

    // Without this a profile update could set its own balance, since the old
    // handler passed req.body.data straight through.
    const data =
      collection === 'USERS' ? stripProtected(req.body.data) : req.body.data;

    if (!data || typeof data !== 'object') {
      throw validationFailed('Update payload must be an object');
    }

    if (collection === 'USERS') {
      await users.update(String(uid), data);
    } else {
      await catalogRepo.update(collection, String(uid), data);
    }
    res.json({ status: 'success', msg: 'Updated successfully' });
  })
);

router.post(
  '/add',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const collection = assertCollection(req.body.collection, CATALOG);

    if (!req.body.data || typeof req.body.data !== 'object') {
      throw validationFailed('Document payload must be an object');
    }

    await catalogRepo.insert(collection, req.body.data);
    res.json({ status: 'success', msg: 'Added successfully' });
  })
);

router.get(
  '/keystore',
  asyncHandler(async (req, res) => {
    const admin = await users.findInstalledAdmin();

    // Previously this threw a TypeError when no admin existed.
    if (!admin) {
      throw new AppError('NOT_INSTALLED', 'Application is not set up yet', 404);
    }

    res.json({
      paystack: admin.paystackpublickey ?? null,
      apiurl: admin.apiurl ?? null,
      supportmail: admin.supportmail ?? null,
      appname: admin.appname ?? null,
    });
  })
);

module.exports = router;
