const express = require('express');
const router = express.Router();
const catalogRepo = require('../repositories/catalog');
const P = require('../presenters');
const { asyncHandler } = require('../middleware');

// The catalog is what the login and home screens render before anyone signs in,
// so it stays public — same rule the legacy /store endpoint applies.
const listing = (collection, present) =>
  asyncHandler(async (req, res) => {
    const rows = await catalogRepo.list(collection);
    res.json(rows.map(present));
  });

router.get('/networks', listing('NETWORKS', P.network));
router.get('/data-plans', listing('DATAPACKS', P.dataPlan));
router.get('/cable-providers', listing('CABLES', P.cableProvider));
router.get('/disco-providers', listing('ELECTRICITY', P.disco));
router.get('/exam-types', listing('EPIN', P.examType));
router.get('/atc-networks', listing('ATC', P.atcNetwork));

const key = (value) => String(value ?? '').trim().toLowerCase();

// CABLESPLAN documents carry no provider id — they link to CABLES through a
// lowercase `category` string while CABLES stores CableName upper case. The
// join happens here because buy-cable.vue filters on p.providerId === provider.id.
router.get(
  '/cable-plans',
  asyncHandler(async (req, res) => {
    const [plans, providers] = await Promise.all([
      catalogRepo.list('CABLESPLAN'),
      catalogRepo.list('CABLES'),
    ]);

    // Repository reads carry `docid`; the presenter is what renames it to `id`.
    const providerIdByName = new Map(providers.map((p) => [key(p.CableName), p.docid]));

    res.json(
      plans.map((plan) => P.cablePlan(plan, providerIdByName.get(key(plan.category)) ?? null))
    );
  })
);

module.exports = router;
