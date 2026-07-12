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

import { auth, db, isConfigProblem, reportConfigProblem } from './firebase-config.js';
import { clearUserCache } from '../utils/storage.js';
import { hasPremiumAccess } from './premium-service.js';

const googleProvider = new GoogleAuthProvider();

// Shows the exact Firebase error code + message alongside the friendly
// copy. Previously this only activated on localhost, which is useless for
// a solo/small deployment being debugged directly on its real GitHub
// Pages URL — there's no "localhost" in that workflow, so the raw error
// was silently hidden exactly where it was needed. Toggle off later (set
// to `false`) once the app has real end users you don't want seeing raw
// error internals.
const IS_DEV = true;

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
  console.log('[Melody][auth] Sign-up (email) — starting');
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  console.log(`[Melody][auth] Sign-up (email) — Firebase account created uid=${cred.user.uid}`);
  await sendEmailVerification(cred.user);
  console.log('[Melody][auth] Sign-up (email) — verification email sent');
  await ensureUserProfile(cred.user, 'Email');
  return cred.user;
}

export async function signInWithEmail(email, password) {
  console.log('[Melody][auth] Sign-in (email) — starting');
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  console.log(`[Melody][auth] Sign-in (email) — success uid=${cred.user.uid}`);
  await ensureUserProfile(cred.user, 'Email');
  return cred.user;
}

export async function signInWithGoogle() {
  console.log('[Melody][auth] Sign-in (Google) — starting');
  const cred = await signInWithPopup(auth, googleProvider);
  console.log(`[Melody][auth] Sign-in (Google) — success uid=${cred.user.uid}`);
  await ensureUserProfile(cred.user, 'Google');
  return cred.user;
}

export async function signOutUser() {
  const uid = auth.currentUser?.uid;
  await signOut(auth);
  console.log('[Melody][auth] Signed out');
  // Wipe this account's cached onboarding state (nickname, hasSeenGreeting)
  // so a different account signing in on the same device — or this same
  // account signing back in after data changed server-side — never reads
  // stale local values. Non-fatal: sign-out itself already succeeded.
  if (uid) {
    await clearUserCache(uid).catch((err) => {
      console.warn('[Melody][auth] Could not clear local cache on sign-out (non-fatal).', err);
    });
  }
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

// Keyed by uid. Guards against duplicate profile-creation attempts when
// ensureUserProfile is called more than once in quick succession for the
// same account — e.g. a fast double sign-in click, or app.js's boot-time
// auth check and login-screen's post-auth call both firing close together.
// Without this, two concurrent getDoc() reads can both see "doesn't exist"
// and both fire a create — wasted writes at best, a lost lastLogin update
// at worst. Callers for the same uid share one in-flight promise instead.
const profileEnsureInFlight = new Map();

/**
 * Creates the user's Firestore profile document on their very first
 * sign-in. If the document already exists it is left alone (aside from
 * bumping lastLogin) — this never clobbers fields like premiumPlan or
 * totalSongs.
 */
export function ensureUserProfile(user, provider) {
  const uid = user.uid;
  if (profileEnsureInFlight.has(uid)) {
    console.log(`[Melody][auth] Profile ensure already in flight for uid=${uid} — reusing it.`);
    return profileEnsureInFlight.get(uid);
  }

  const task = ensureUserProfileImpl(user, provider).finally(() => {
    profileEnsureInFlight.delete(uid);
  });
  profileEnsureInFlight.set(uid, task);
  return task;
}

async function ensureUserProfileImpl(user, provider) {
  const uid = user.uid;
  const ref = doc(db, USERS_COLLECTION, uid);
  console.log(`[Melody][auth] Profile lookup — users/${uid}`);

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (err) {
    console.error(`[Melody][auth] Profile lookup failed for users/${uid}.`, err);
    throw err;
  }

  if (!snap.exists()) {
    console.log(`[Melody][auth] Profile does not exist — creating users/${uid} (provider=${provider})`);
    try {
      await setDoc(ref, {
        uid,
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
      console.log(`[Melody][auth] Profile created — users/${uid}`);
    } catch (err) {
      console.error(`[Melody][auth] Profile creation failed for users/${uid}.`, err);
      throw err;
    }
  } else {
    console.log(`[Melody][auth] Profile exists — skipping creation, bumping lastLogin for users/${uid}`);
    try {
      await updateDoc(ref, { lastLogin: serverTimestamp() });
    } catch (err) {
      // Non-fatal: the user already has a working profile document, so a
      // failed lastLogin bump shouldn't block sign-in or show an error.
      console.warn(`[Melody][auth] Could not update lastLogin for users/${uid} (non-fatal).`, err);
    }
  }
}

export async function getUserProfile(uid) {
  console.log(`[Melody][auth] Profile read — users/${uid}`);
  try {
    const snap = await getDoc(doc(db, USERS_COLLECTION, uid));
    if (!snap.exists()) {
      console.log(`[Melody][auth] Profile read — users/${uid} does not exist`);
      return null;
    }
    return snap.data();
  } catch (err) {
    console.error(`[Melody][auth] Profile read failed for users/${uid}.`, err);
    throw err;
  }
}

/** Sets the nickname in both Firestore and the Firebase Auth profile. */
export async function setUserNickname(uid, nickname) {
  const ref = doc(db, USERS_COLLECTION, uid);
  console.log(`[Melody][auth] Nickname save — starting for users/${uid}`);

  let snap;
  try {
    snap = await getDoc(ref);
  } catch (err) {
    console.error(`[Melody][auth] Nickname save — profile lookup failed for users/${uid}.`, err);
    throw err;
  }

  try {
    if (!snap.exists()) {
      // Profile document never got created (e.g. a dropped connection
      // during sign-up) — recreate it in full now instead of just writing
      // the nickname on top of nothing, so premiumPlan/role/etc. aren't
      // silently missing afterward.
      console.log(`[Melody][auth] Nickname save — users/${uid} has no profile yet, recreating it in full`);
      const user = auth.currentUser;
      await setDoc(ref, {
        uid,
        nickname,
        email: user?.email || null,
        profilePhoto: user?.photoURL || null,
        provider: user?.providerData.some((p) => p.providerId === 'google.com') ? 'Google' : 'Email',
        accountCreated: serverTimestamp(),
        premiumPlan: 'Free',
        premiumExpiry: null,
        role: 'User',
        totalSongs: 0,
        totalListeningTime: 0,
        lastLogin: serverTimestamp(),
      });
    } else {
      await setDoc(ref, { nickname }, { merge: true });
    }
    console.log(`[Melody][auth] Nickname save — saved "${nickname}" to users/${uid}`);
  } catch (err) {
    console.error(`[Melody][auth] Nickname save — Firestore write failed for users/${uid}.`, err);
    throw err;
  }

  if (auth.currentUser && auth.currentUser.uid === uid) {
    await updateProfile(auth.currentUser, { displayName: nickname }).catch((err) => {
      // Non-fatal — Firestore is the source of truth Melody actually reads from.
      console.warn('[Melody][auth] Could not mirror nickname onto the Firebase Auth profile (non-fatal).', err);
    });
  }
}

/* -------------------------------------------------------------------- */
/*  Nickname changes after onboarding (Basic+ only, capped 2/month)      */
/* -------------------------------------------------------------------- */
// Free accounts only ever set their nickname once, during onboarding.
// Basic and above unlock changing it later from Settings, capped at 2
// changes per rolling calendar month. No scheduled job resets the
// counter — the reset only happens lazily, the next time this function
// runs, by comparing today's "YYYY-MM" against the stored reset date.

const NICKNAME_CHANGES_PER_MONTH = 2;

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Returns { allowed, remaining, resetsNextMonth } WITHOUT writing
 * anything — used by Settings to render "1 of 2 changes left this month"
 * before the user commits to a change.
 */
export async function getNicknameChangeStatus(uid) {
  if (hasPremiumAccess('Plus')) {
    return { used: 0, remaining: Infinity, limit: Infinity };
  }
  const profile = await getUserProfile(uid);
  const monthKey = currentMonthKey();
  const storedMonth = profile?.nicknameResetDate || null;
  const used = storedMonth === monthKey ? (profile?.nicknameChanges || 0) : 0;
  return {
    used,
    remaining: Math.max(0, NICKNAME_CHANGES_PER_MONTH - used),
    limit: NICKNAME_CHANGES_PER_MONTH,
  };
}

/**
 * Changes the nickname for a Basic+ account, enforcing the 2/month cap.
 * Throws a plain Error (not a Firebase error) with a friendly message if
 * the cap has been hit — callers should show it directly, no need to run
 * it through friendlyAuthError().
 */
export async function changeNicknameWithLimit(uid, nickname) {
  const ref = doc(db, USERS_COLLECTION, uid);

  if (hasPremiumAccess('Plus')) {
    // Unlimited — still bump lastLogin-style bookkeeping fields for
    // consistency, but never touch the counter/cap at all.
    await setDoc(ref, { nickname }, { merge: true });
    if (auth.currentUser && auth.currentUser.uid === uid) {
      await updateProfile(auth.currentUser, { displayName: nickname }).catch(() => {});
    }
    return;
  }

  const snap = await getDoc(ref);
  const profile = snap.exists() ? snap.data() : {};

  const monthKey = currentMonthKey();
  const sameMonth = profile.nicknameResetDate === monthKey;
  const usedThisMonth = sameMonth ? (profile.nicknameChanges || 0) : 0;

  if (usedThisMonth >= NICKNAME_CHANGES_PER_MONTH) {
    throw new Error(`You\u2019ve used all ${NICKNAME_CHANGES_PER_MONTH} nickname changes for this month. Try again next month.`);
  }

  await setDoc(ref, {
    nickname,
    nicknameChanges: usedThisMonth + 1,
    nicknameResetDate: monthKey,
  }, { merge: true });

  if (auth.currentUser && auth.currentUser.uid === uid) {
    await updateProfile(auth.currentUser, { displayName: nickname }).catch(() => {});
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
  // These four indicate a project-configuration problem, not a real
  // connectivity issue — most often an API key Google has restricted or
  // auto-suspended (routine for keys visible in a public repo, which is
  // how this app is hosted), or a domain missing from Authorized domains.
  'auth/unauthorized-domain': 'This site isn\u2019t yet authorized for sign-in — add its domain in Firebase Authentication settings.',
  'auth/requests-from-referer-are-blocked': 'This site\u2019s API key is restricted — check the key\u2019s allowed domains in Google Cloud Console.',
  'auth/invalid-api-key': 'This app\u2019s Firebase API key is invalid or has been suspended/restricted by Google — check the Firebase Console and Google Cloud Console > Credentials.',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'This app\u2019s Firebase API key is invalid or has been suspended/restricted by Google — check the Firebase Console and Google Cloud Console > Credentials.',
  'permission-denied': 'Your account was created, but saving your profile was blocked by Firestore\u2019s security rules — check they\u2019re published correctly.',
  'unavailable': 'Couldn\u2019t reach the server — usually a brief connection drop. It should recover automatically; try again in a moment.',
  'failed-precondition': 'Firestore isn\u2019t set up correctly for this project — make sure a Firestore database (Native mode) has been created in the Firebase Console.',
  'not-found': 'Firestore database not found for this project — create one in the Firebase Console if you haven\u2019t already.',
};

export function friendlyAuthError(err) {
  const code = err?.code || '';
  if (isConfigProblem(err)) reportConfigProblem(err);

  const mapped = FRIENDLY_ERRORS[code];
  const base = mapped
    ? mapped
    // Unmapped code — still show something actionable instead of a dead end,
    // and surface the raw code so it can be looked up/reported.
    : (code ? `Something went wrong (${code}). Please try again.` : 'Something went wrong. Please try again.');

  // In development, always append the exact Firebase code + message so the
  // real cause (a misconfigured Firestore rule, a bad API key restriction,
  // etc.) is visible immediately instead of hiding behind friendly copy.
  if (IS_DEV && err) {
    const detail = [code, err.message].filter(Boolean).join(': ');
    if (detail) return `${base}\n[dev] ${detail}`;
  }
  return base;
}
