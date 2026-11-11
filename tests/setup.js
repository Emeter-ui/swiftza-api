// Dummy credentials so modules that read secrets at import time can load.
// Nothing in the test suite makes a real Firebase, Paystack or provider call.
process.env.NODE_ENV = 'test';
process.env.API_KEY ||= 'test-api-key';
process.env.APP_ID ||= 'test-app-id';
process.env.JWT_SECRET ||= 'test-jwt-secret-not-used-in-production';
process.env.PAYSTACK_SECRET_KEY ||= 'sk_test_dummy';
process.env.PAYSTACK_WEBHOOK_SECRET ||= 'whsec_test_dummy';
process.env.PROVIDER_HUSMODATA_TOKEN ||= 'test-provider-token';
process.env.PROVIDER_VTPASS_API_KEY ||= 'test-vtpass-api-key';
process.env.PROVIDER_VTPASS_SECRET_KEY ||= 'test-vtpass-secret-key';
process.env.PROVIDER_CHEAPDATAHUB_API_KEY ||= 'test-cheapdatahub-api-key';
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017';
process.env.MONGODB_DB ||= 'samzee_test';

// Pinned so no test can reach a real Firebase project. env.js now defaults
// these to empty strings (a misconfigured environment should fail loudly
// rather than silently pointing at a real project), so tests must supply
// their own values or Firebase Auth calls would fail to initialise.
process.env.FIREBASE_AUTH_DOMAIN ||= 'test-project.firebaseapp.com';
process.env.FIREBASE_PROJECT_ID ||= 'test-project';
process.env.FIREBASE_STORAGE_BUCKET ||= 'test-project.appspot.com';
process.env.FIREBASE_MESSAGING_SENDER_ID ||= '000000000000';
