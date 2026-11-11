class AppError extends Error {
  constructor(code, message, httpStatus = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

const insufficientBalance = () =>
  new AppError('INSUFFICIENT_BALANCE', 'Insufficient balance', 402);

const paymentNotSuccessful = (message = 'Payment was not successful') =>
  new AppError('PAYMENT_NOT_SUCCESSFUL', message, 402);

const duplicateTransaction = (transref) =>
  new AppError(
    'DUPLICATE_TRANSACTION',
    'This transaction has already been submitted',
    409,
    { transref }
  );

// A collision on an ATC order's wallet credit reference (atc_credit_...) --
// distinct from duplicateTransaction because the two are refused for
// different reasons: duplicateTransaction is a retry of the SAME request
// racing itself, this is a different reference landing on the credit's
// reserved id. Naming it separately is what lets an operator (or a future
// log search) tell the two apart instead of both reading as "duplicate
// transaction".
const atcCreditCollision = (orderId) =>
  new AppError(
    'ATC_CREDIT_COLLISION',
    'Could not approve this order: its credit reference is already in use. No money was moved.',
    409,
    { orderId }
  );

const userNotFound = (uid) =>
  new AppError('USER_NOT_FOUND', 'User account not found', 404, { uid });

const validationFailed = (message, details = null) =>
  new AppError('VALIDATION_FAILED', message, 422, details);

const providerUnavailable = (message = 'Service temporarily unavailable') =>
  new AppError('PROVIDER_UNAVAILABLE', message, 503);

module.exports = {
  AppError,
  insufficientBalance,
  paymentNotSuccessful,
  duplicateTransaction,
  atcCreditCollision,
  userNotFound,
  validationFailed,
  providerUnavailable,
};
