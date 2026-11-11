const express = require('express');
const router = express.Router();
const { authfunc } = require('../services/index');
const users = require('../repositories/users');
const catalogRepo = require('../repositories/catalog');
const { asyncHandler, requireAdmin } = require('../middleware');
const { validationFailed, AppError } = require('../models/errors');

const MIGRATABLE = ['NETWORKS', 'DATAPACKS', 'CABLES', 'CABLESPLAN', 'ELECTRICITY', 'EPIN', 'ATC'];

// Backed by the {account, setUpProcess} index. The previous version downloaded
// every user document to find this one.
const findInstalledAdmin = () => users.findInstalledAdmin();

// The installer runs before any account exists, so it cannot require a session.
// Once setup has completed these become admin-only, otherwise anyone could keep
// seeding the catalog or flip setUpProcess back off.
function installerOnly(req, res, next) {
  findInstalledAdmin()
    .then((admin) => (admin ? requireAdmin(req, res, next) : next()))
    .catch(next);
}

router.post(
  '/createadmin',
  asyncHandler(async (req, res) => {
    const { email, passwd, ...profile } = req.body;

    if (!email || !/.+@.+\..+/.test(email)) {
      throw validationFailed('Enter a valid email address');
    }
    if (!passwd || String(passwd).length < 6) {
      throw validationFailed('Password must be at least 6 characters');
    }
    // Without this the installer endpoint stays open forever and anyone can
    // mint themselves an admin account.
    if (await findInstalledAdmin()) {
      throw new AppError('ALREADY_INSTALLED', 'Setup has already been completed', 409);
    }

    let credential;
    try {
      credential = await authfunc.signup(email, passwd);
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        throw new AppError('EMAIL_IN_USE', 'That email is already registered', 409);
      }
      throw err;
    }

    await users.create(credential.user.uid, {
      ...profile,
      email,
      uniqueId: credential.user.uid,
      userId: credential.user.uid,
      account: 'ADMIN',
      balance: 0,
      bonusBalance: 0,
    });

    res.status(201).json({
      status: 'success',
      msg: 'Admin account created',
      uniqueId: credential.user.uid,
    });
  })
);

router.post(
  '/migrate',
  installerOnly,
  asyncHandler(async (req, res) => {
    const { collection, data } = req.body;

    if (!MIGRATABLE.includes(collection)) {
      throw validationFailed(
        `Collection must be one of: ${MIGRATABLE.join(', ')}`
      );
    }
    if (!Array.isArray(data) || data.length === 0) {
      throw validationFailed('Migration data must be a non-empty array');
    }
    if (data.length > 1000) {
      throw validationFailed('Cannot migrate more than 1000 documents at once');
    }

    // The previous version used forEach with an async callback, so it responded
    // "Migrated Successfully" before any write completed and swallowed errors.
    await catalogRepo.insertMany(collection, data.map((entry) => ({ ...entry })));

    res.json({
      status: 'success',
      msg: `${collection} migrated successfully`,
      count: data.length,
    });
  })
);

router.post(
  '/finalsetup',
  installerOnly,
  asyncHandler(async (req, res) => {
    const { id, setUpProcess } = req.body;
    if (!id) throw validationFailed('Admin id is required');

    await users.update(id, { setUpProcess: Boolean(setUpProcess) });
    res.json({ status: 'success', msg: 'Installation successful' });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const admin = await findInstalledAdmin();

    // Only the fields the installer reads (SetUp.vue checks docid and
    // setUpProcess). The previous version returned the whole admin document,
    // exposing the stored password and Paystack keys to any caller.
    res.json(
      admin
        ? {
            docid: admin.docid,
            setUpProcess: admin.setUpProcess ?? false,
            account: admin.account,
            appname: admin.appname ?? null,
            supportmail: admin.supportmail ?? null,
          }
        : {}
    );
  })
);

module.exports = router;
