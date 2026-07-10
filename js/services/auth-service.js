/**
 * auth-service.js
 * Every Firebase Authentication + user-profile operation Melody needs,
 * in one place. Screens (login-screen, nickname-screen, settings-screen,
 * app.js) call these functions rather than touching the Firebase SDK
 * directly — that keeps the SDK imports, error-message mapping, and
 * Firestore document shape consistent no matter which screen triggers them.
 */

import {
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  onAuthStateChanged,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

import { auth, db } from './firebase-config.js';

const googleProvider = new GoogleAuthProvider();

/* -------------------------------------------------------------------- */
/*  Auth state                                                          */
/* -------------------------------------------------------------------- */

/**
 * Subscribe to auth state changes. Returns the unsubscribe function.
 * Fires once immediately with the current user (or null) and again on
 * every future sign-in/sign-out — this is what lets the app skip the
 * login screen automatically when a session is already active.
 */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/** Resolves once, with the current user (or null) — used at boot. */
export function waitForInitialUser() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      unsubscribe();
      resolve(user);
    });
  });
}

export function getCurrentUser() {
  return auth.currentUser;
}

/* -------------------------------------------------------------------- */
/*  Sign up / sign in                                                   */
/* -------------------------------------------------------------------- */

export async function signUpWithEmail(email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  await sendEmailVerification(cred.user);
  await ensureUserProfile(cred.user, 'Email');
  return cred.user;
}

export async function signInWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  await ensureUserProfile(cred.user, 'Email');
  return cred.user;
}

export async function signInWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  await ensureUserProfile(cred.user, 'Google');
  return cred.user;
}

export async function signOutUser() {
  await signOut(auth);
}

export async function resendVerificationEmail() {
  if (!auth.currentUser) throw new Error('No signed-in user.');
  await sendEmailVerification(auth.currentUser);
}

/** Re-fetches the user from Firebase so `emailVerified` reflects reality. */
export async function refreshCurrentUser() {
  if (!auth.currentUser) return null;
  await auth.currentUser.reload();
  return auth.currentUser;
}

export async function sendResetPasswordEmail(email) {
  await sendPasswordResetEmail(auth, email.trim());
}

/* -------------------------------------------------------------------- */
/*  Firestore user profile ("users/{uid}")                              */
/* -------------------------------------------------------------------- */

const USERS_COLLECTION = 'users';

/**
 * Creates the user's Firestore profile document on their very first
 * sign-in, using setDoc(..., { merge: true }) so calling this again on
 * every later login is always safe (it never clobbers fields like
 * premiumPlan or totalSongs — it only fills in anything missing and
 * bumps lastLogin).
 */
export async function ensureUserProfile(user, provider) {
  const ref = doc(db, USERS_COLLECTION, user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      nickname: user.displayName || null,
      email: user.email || null,
      profilePhoto: user.photoURL || null,
      provider,
      accountCreated: serverTimestamp(),
      premiumPlan: 'Free',
      premiumExpiry: null,
      role: 'User',
      totalSongs: 0,
      totalListeningTime: 0,
      lastLogin: serverTimestamp(),
    });
  } else {
    await updateDoc(ref, { lastLogin: serverTimestamp() });
  }
}

export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, USERS_COLLECTION, uid));
  return snap.exists() ? snap.data() : null;
}

/** Sets the nickname in both Firestore and the Firebase Auth profile. */
export async function setUserNickname(uid, nickname) {
  await updateDoc(doc(db, USERS_COLLECTION, uid), { nickname });
  if (auth.currentUser && auth.currentUser.uid === uid) {
    await updateProfile(auth.currentUser, { displayName: nickname }).catch(() => {
      // Non-fatal — Firestore is the source of truth Melody actually reads from.
    });
  }
}

export async function incrementListeningStats(uid, { songsDelta = 0, secondsDelta = 0 } = {}) {
  if (!uid) return;
  const ref = doc(db, USERS_COLLECTION, uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  await updateDoc(ref, {
    totalSongs: (data.totalSongs || 0) + songsDelta,
    totalListeningTime: (data.totalListeningTime || 0) + secondsDelta,
  });
}

/* -------------------------------------------------------------------- */
/*  Friendly error messages                                             */
/* -------------------------------------------------------------------- */

const FRIENDLY_ERRORS = {
  'auth/invalid-email': 'That email address doesn\u2019t look right.',
  'auth/missing-password': 'Please enter a password.',
  'auth/user-disabled': 'This account has been disabled. Contact support if that seems wrong.',
  'auth/user-not-found': 'We couldn\u2019t find an account with that email.',
  'auth/wrong-password': 'That password doesn\u2019t match this account.',
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/invalid-login-credentials': 'Email or password is incorrect.',
  'auth/email-already-in-use': 'An account already exists with that email — try logging in instead.',
  'auth/weak-password': 'Please choose a password with at least 6 characters.',
  'auth/password-does-not-meet-requirements': 'That password doesn\u2019t meet this project\u2019s password rules (check length/character requirements in Firebase).',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network error — check your connection and try again.',
  'auth/popup-closed-by-user': 'Google sign-in was closed before finishing.',
  'auth/cancelled-popup-request': 'Google sign-in was cancelled.',
  'auth/popup-blocked': 'Your browser blocked the Google sign-in popup. Please allow popups and try again.',
  'auth/account-exists-with-different-credential': 'An account already exists with this email using a different sign-in method.',
  'auth/unauthorized-domain': 'This site isn\u2019t yet authorized for sign-in — add its domain in Firebase Authentication settings.',
  'auth/requests-from-referer-are-blocked': 'This site\u2019s API key is restricted — check the key\u2019s allowed domains in Google Cloud Console.',
  'permission-denied': 'Your account was created, but saving your profile was blocked by Firestore\u2019s security rules — check they\u2019re published correctly.',
  'unavailable': 'Couldn\u2019t reach the server. Check your connection and try again.',
};

export function friendlyAuthError(err) {
  const code = err?.code || '';
  const mapped = FRIENDLY_ERRORS[code];
  if (mapped) return mapped;
  // Unmapped code — still show something actionable instead of a dead end,
  // and surface the raw code so it can be looked up/reported.
  return code ? `Something went wrong (${code}). Please try again.` : 'Something went wrong. Please try again.';
}
