const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware');
const { validationFailed, AppError } = require('../models/errors');
const config = require('../config/env');

const TERMII_BASE = 'https://api.ng.termii.com/api';

function termiiKey() {
  const key = config.optional('TERMII_API_KEY', '');
  if (!key) throw new AppError('SERVICE_UNAVAILABLE', 'OTP service is not configured', 503);
  return key;
}

// POST /otp/send  — sends OTP to a phone number via Termii
router.post('/send', asyncHandler(async (req, res) => {
  const { phone } = req.body;

  if (!phone || !/^\+234\d{10}$/.test(String(phone))) {
    throw validationFailed('Enter a valid Nigerian phone number (+234XXXXXXXXXX)');
  }

  const payload = {
    api_key:          termiiKey(),
    message_type:     'NUMERIC',
    to:               phone,
    from:             config.optional('TERMII_SENDER_ID', 'Swiftza'),
    channel:          'generic',
    pin_attempts:     3,
    pin_time_to_live: 10,
    pin_length:       6,
    pin_placeholder:  '< 1234 >',
    message_text:     'Your Swiftza verification code is < 1234 >. Valid for 10 minutes. Do not share this code.',
    pin_type:         'NUMERIC',
  };

  const termiiRes = await fetch(`${TERMII_BASE}/sms/otp/send`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  const data = await termiiRes.json();

  if (!termiiRes.ok || !data.pinId) {
    throw new AppError('OTP_SEND_FAILED', data.message || 'Failed to send OTP. Try again.', 502);
  }

  res.json({ pinId: data.pinId });
}));

// POST /otp/verify  — verifies the OTP entered by the user
router.post('/verify', asyncHandler(async (req, res) => {
  const { pinId, pin } = req.body;

  if (!pinId || !pin) throw validationFailed('pinId and pin are required');
  if (!/^\d{6}$/.test(String(pin))) throw validationFailed('Enter the 6-digit code');

  const payload = {
    api_key: termiiKey(),
    pin_id:  pinId,
    pin:     String(pin),
  };

  const termiiRes = await fetch(`${TERMII_BASE}/sms/otp/verify`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  const data = await termiiRes.json();

  if (!termiiRes.ok || data.verified !== true) {
    throw new AppError('OTP_INVALID', 'Incorrect code. Please try again.', 400);
  }

  res.json({ verified: true });
}));

module.exports = router;
