const admin = require('firebase-admin');

let adminApp;

function getAdminApp() {
  if (!adminApp) {
    adminApp = admin.initializeApp(
      {
        credential: admin.credential.cert({
          projectId:   process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          // Vercel stores multi-line values with literal \n — replace them.
          privateKey:  (process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
      },
      'admin'
    );
  }
  return adminApp;
}

function getAdminAuth() {
  return admin.auth(getAdminApp());
}

module.exports = { getAdminAuth };
