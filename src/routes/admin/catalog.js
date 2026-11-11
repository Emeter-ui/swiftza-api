const express = require('express');
const router = express.Router();
const catalogRepo = require('../../repositories/catalog');
const base = require('../../repositories/base');
const { ADMIN_COLLECTIONS, assertRequired } = require('../../presenters/admin');
const { asyncHandler } = require('../../middleware');
const { validationFailed, AppError } = require('../../models/errors');

const CABLES = 'CABLES';
const key = (v) => String(v ?? '').trim().toLowerCase();

// CABLESPLAN stores a lowercase `category` rather than a provider id, so a
// submitted providerId has to be resolved to its provider document both on
// write (to derive the category) and on read (to give the page back an id it
// can filter on).
async function cableContextForWrite(body) {
  const provider = await catalogRepo.findById(CABLES, String(body.providerId));
  if (!provider) throw validationFailed('Unknown cable provider', { providerId: body.providerId });
  return { providerName: provider.CableName };
}

async function cableProviderIndex() {
  const providers = await catalogRepo.list(CABLES);
  return new Map(providers.map((p) => [key(p.CableName), p.docid]));
}

// The presented view of an existing cable-plan row needs a providerId to
// merge against on PUT, same as the listing does — derived from the same
// category->id map rather than a per-row lookup.
async function existingCableProviderId(existing) {
  const index = await cableProviderIndex();
  return index.get(key(existing.category)) ?? null;
}

function mount(segment, config) {
  const isCablePlans = segment === 'cable-plans';

  router.get(
    `/${segment}`,
    asyncHandler(async (req, res) => {
      const rows = await catalogRepo.list(config.collection);
      if (!isCablePlans) return res.json(rows.map((r) => config.present(r)));

      const index = await cableProviderIndex();
      res.json(rows.map((r) => config.present(r, { providerId: index.get(key(r.category)) ?? null })));
    })
  );

  router.post(
    `/${segment}`,
    asyncHandler(async (req, res) => {
      assertRequired(config, req.body);
      const ctx = isCablePlans ? await cableContextForWrite(req.body) : {};
      const id = await catalogRepo.insert(config.collection, config.toStored(req.body, ctx));
      const saved = await catalogRepo.findById(config.collection, id);
      res.status(201).json({
        item: config.present(saved, isCablePlans ? { providerId: req.body.providerId } : {}),
      });
    })
  );

  router.put(
    `/${segment}/:id`,
    asyncHandler(async (req, res) => {
      const existing = await catalogRepo.findById(config.collection, req.params.id);
      if (!existing) throw new AppError('NOT_FOUND', 'Record not found', 404, { id: req.params.id });

      // useCrud sends the whole form on an edit but only { active } when the
      // row's active toggle is flipped. Merging the submitted body over the
      // presented existing row makes both work: a full edit overwrites
      // everything, a partial one inherits the rest from storage.
      // assertRequired then runs on the merged object, so a create still
      // cannot omit a provider-side id and an edit cannot blank one out.
      const existingProviderId = isCablePlans ? await existingCableProviderId(existing) : null;
      const current = config.present(existing, isCablePlans ? { providerId: existingProviderId } : {});
      const merged = { ...current, ...req.body };

      assertRequired(config, merged);
      const ctx = isCablePlans ? await cableContextForWrite(merged) : {};
      await catalogRepo.update(config.collection, req.params.id, config.toStored(merged, ctx));

      const saved = await catalogRepo.findById(config.collection, req.params.id);
      res.json({
        item: config.present(saved, isCablePlans ? { providerId: merged.providerId } : {}),
      });
    })
  );

  router.delete(
    `/${segment}/:id`,
    asyncHandler(async (req, res) => {
      // A deliberate speed bump against a mis-click, not a security control —
      // requireAdmin is the boundary. Nothing references catalog documents, so
      // there is no referential check to make here.
      if (req.query.confirm !== 'true') {
        throw new AppError(
          'CONFIRMATION_REQUIRED',
          'Deletion is permanent. Re-send with confirm=true, or deactivate the record instead.',
          400
        );
      }

      const removed = await base.remove(config.collection, req.params.id);
      if (!removed) throw new AppError('NOT_FOUND', 'Record not found', 404, { id: req.params.id });

      res.json({ ok: true });
    })
  );
}

for (const [segment, config] of Object.entries(ADMIN_COLLECTIONS)) {
  mount(segment, config);
}

module.exports = router;
// import.js needs this to derive the same CABLESPLAN->CABLES category link
// for an imported plan that ordinary CRUD writes here -- reused, not copied,
// so the two paths cannot compute that link differently.
module.exports.cableContextForWrite = cableContextForWrite;
