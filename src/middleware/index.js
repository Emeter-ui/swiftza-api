const { AppError } = require('../models/errors');
const { nodeEnv } = require('../config/env');

// Forwards rejected promises to the error handler. Without this an async route
// that throws leaves the request hanging until the client times out.
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function notFound(req, res) {
  res.status(404).json({ status: 'error', msg: 'Endpoint not found' });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof AppError) {
    return res.status(err.httpStatus).json({
      status: 'error',
      code: err.code,
      msg: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // Previously routes returned the raw error object, leaking Firebase internals
  // and stack traces to the client.
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);

  res.status(500).json({
    status: 'error',
    code: 'INTERNAL_ERROR',
    msg: 'Something went wrong. Please try again.',
    ...(nodeEnv === 'development' ? { debug: err.message } : {}),
  });
}

const auth = require('./auth');

module.exports = { asyncHandler, notFound, errorHandler, ...auth };
