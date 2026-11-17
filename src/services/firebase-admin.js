const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { cert } = require('firebase-admin/app');

let adminApp;

function getAdminApp() {
  if (!adminApp) {
    adminApp = initializeApp(
      {
        credential: cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey:  (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      },
      'admin'
    );
  }
  return adminApp;
}

function getAdminAuth() {
  return getAuth(getAdminApp());
}

module.exports = { getAdminAuth };
