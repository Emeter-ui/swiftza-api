const rateLimit = require('express-rate-limit');

// In-memory store resets per Vercel instance. For strict cross-instance
// enforcement on Vercel, swap to an Upstash Redis store.

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', code: 'RATE_LIMITED', msg: 'Too many login attempts. Try again in 15 minutes.' },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', code: 'RATE_LIMITED', msg: 'Too many signup attempts. Try again in an hour.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', code: 'RATE_LIMITED', msg: 'Too many requests. Try again in 15 minutes.' },
});

module.exports = { loginLimiter, signupLimiter, authLimiter };
