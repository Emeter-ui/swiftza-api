const firebase = require('firebase/app');
const authentication = require('firebase/auth');

const config = require('../config/env');

const firebaseConfig = {
  apiKey: config.firebase.apiKey(),
  authDomain: config.firebase.authDomain,
  projectId: config.firebase.projectId,
  storageBucket: config.firebase.storageBucket,
  messagingSenderId: config.firebase.messagingSenderId,
  appId: config.firebase.appId(),
};

const app = firebase.initializeApp(firebaseConfig);
const auth = authentication.getAuth(app);

module.exports = { app, auth };
