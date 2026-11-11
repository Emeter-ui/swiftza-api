const authentication = require('firebase/auth');
const { auth } = require('./firebase');

const {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateEmail,
  updatePassword,
  verifyPasswordResetCode,
  confirmPasswordReset,
} = authentication;

// Firebase Auth remains the credential store. Only persistence moved to
// MongoDB; nothing in this file changed behaviour.
function AuthFunc() {
  this.signup = (email, password) => createUserWithEmailAndPassword(auth, email, password);
  this.login = (email, password) => signInWithEmailAndPassword(auth, email, password);
  this.signout = () => signOut(auth);
  this.reset = (email) => sendPasswordResetEmail(auth, email);
  this.verifycode = (code) => verifyPasswordResetCode(auth, code);
  this.confirmreset = (code, newpassword) => confirmPasswordReset(auth, code, newpassword);
  this.changeEmail = (email, curruser) => updateEmail(curruser, email);
  this.changePassword = (password, curruser) => updatePassword(curruser, password);
}

const authfunc = new AuthFunc();

module.exports = { authfunc, auth };
