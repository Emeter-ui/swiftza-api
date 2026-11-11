const base = require('./base');

const list = (name, sort = '') => base.all(name, sort);
const findOne = (name, field, value) => base.findBy(name, field, value);
const findById = (name, docid) => base.byId(name, docid);
const insert = (name, doc) => base.insert(name, doc);
const insertMany = (name, docs) => base.insertMany(name, docs);
const update = (name, docid, patch) => base.update(name, docid, patch);

module.exports = { list, findOne, findById, insert, insertMany, update };
