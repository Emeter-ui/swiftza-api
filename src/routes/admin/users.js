const express = require('express');
const router = express.Router();
const base = require('../../repositories/base');
const users = require('../../repositories/users');
const audit = require('../../models/audit');
const { finance } = require('../../models/finance');
const P = require('../../presenters');
const { asyncHandler } = require('../../middleware');
const { validationFailed, AppError } = require('../../models/errors');

const ROLES = ['USER', 'ADMIN'];

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { items, nextCursor } = await base.page('USERS', {}, {
      limit: req.query.limit,
      cursor: req.query.cursor,
    });

    res.json({ users: items.map(P.user), nextCursor });
  })
);

router.put(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const target = await users.findByUid(req.params.id);
    if (!target) throw new AppError('NOT_FOUND', 'User not found', 404, { id: req.params.id });

    const { role, adjustment } = req.body;

    if (role !== undefined) {
      // An admin changing their own role is the one edit with no way back:
      // setup.js refuses /setup/createadmin permanently once an admin exists, so
      // a sole admin who demotes themselves locks every human out for good. This
      // one rule also guarantees the admin set can never empty, since every
      // demotion is then made by someone who stays an admin.
      if (req.params.id === req.user.uid) {
        throw validationFailed('You cannot change your own role');
      }
      if (!ROLES.includes(role)) {
        throw validationFailed(`Role must be one of: ${ROLES.join(', ')}`, { role });
      }
      if (role !== target.account) {
        await users.update(req.params.id, { account: role });
        await audit.record({
          action: 'role.change',
          adminUid: req.user.uid,
          targetUid: req.params.id,
          details: { from: target.account, to: role },
        });
      }
    }

    // `balance` and `wallet` in the body are ignored on purpose. A balance only
    // ever moves through finance.adjustBalance, which is atomic and audited.
    // `amount` is deliberately NOT validated here. finance.adjustBalance owns
    // every money invariant — the whole-number and magnitude bounds, the reason,
    // and the refusal to go negative — so this route is a thin pass-through and
    // has no defence in depth of its own by design.
    if (adjustment !== undefined) {
      if (!adjustment || typeof adjustment !== 'object') {
        throw validationFailed('Adjustment must be an object with amount and reason');
      }
      await finance.adjustBalance({
        uid: req.params.id,
        amount: adjustment.amount,
        reason: adjustment.reason,
        adminUid: req.user.uid,
      });
    }

    const updated = await users.findByUid(req.params.id);
    res.json({ item: P.user(updated) });
  })
);

module.exports = router;
