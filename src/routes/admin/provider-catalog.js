// Read-only SME API discovery, for an operator populating smeapiDataPlanId on
// DATAPACKS rows. Same separation the requery console uses: what an upstream
// says is EVIDENCE for an operator, never an automatic change to our own
// records. Nothing in this file writes a catalog document.
//
// SME API has a flat dataplans list rather than a tiered service/variation
// hierarchy, so discovery is a single GET against /api/dataplans/. There is no
// equivalent audit endpoint (no catalog of cable/electricity/epin IDs to
// compare against), so those are entered manually in the admin CRUD.
const express = require('express');
const router = express.Router();
const providers = require('../../providers');
const { asyncHandler } = require('../../middleware');
const { providerUnavailable } = require('../../models/errors');

const upstreamFailed = (message) =>
  providerUnavailable(message || 'Could not reach SME API');

// Returns the full flat list of data plans from SME API. Used by the import
// preview and by an operator browsing plan IDs to fill in manually.
// describe(), not getProvider(): an operator must be able to inspect SME API
// while it is serving nothing, which is exactly the state they are in when
// filling the ids that would let it serve something.
router.get(
  '/providers/smeapi/dataplans',
  asyncHandler(async (req, res) => {
    const smeapi = await providers.describe('smeapi');
    const out = await smeapi.listDataPlans();
    if (!out.ok) throw upstreamFailed(out.message);
    res.json({ items: out.items });
  })
);

module.exports = router;
