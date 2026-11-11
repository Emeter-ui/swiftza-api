const { collection } = require('../services/mongo');

const AUDITLOG = 'AUDITLOG';

// Always written inside the caller's transaction, so a committed action always
// has its audit row and neither can exist without the other. Nothing reads this
// collection yet — a viewer belongs with the money-operations sub-project — but
// the record is worthless if it starts later than the actions it describes.
async function record({ action, adminUid, targetUid, details = {} }, session) {
  await collection(AUDITLOG).insertOne(
    {
      ...details,
      action,
      adminUid: adminUid ? String(adminUid) : null,
      targetUid: targetUid ? String(targetUid) : null,
      CreatedAt: new Date(),
    },
    session ? { session } : {}
  );
}

module.exports = { record, AUDITLOG };
