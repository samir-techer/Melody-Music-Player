/**
 * firebase-config.js
 * Single place that initializes the Firebase app + exports the Auth and
 * Firestore instances every other auth/profile module imports from.
 * Loaded straight from the CDN (gstatic) — no build step, matches the
 * rest of Melody's "plain ES modules, no bundler" philosophy.
 */

import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  getFirestore,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAnwMLQRRji9t9utWBZrUKjQA1tGJaTRJU',
  authDomain: 'music-player-51973.firebaseapp.com',
  projectId: 'music-player-51973',
  storageBucket: 'music-player-51973.firebasestorage.app',
  messagingSenderId: '520500500029',
  appId: '1:520500500029:web:1b5e9d5ae785eda17f3c54',
  measurementId: 'G-C501Z4S39Z',
};

// ES modules are cached by the browser/bundler per URL, so importing this
// file twice normally just returns the same module instance — but a
// defensive check costs nothing and prevents the classic "Firebase App
// named '[DEFAULT]' already exists" crash if this module ever ends up
// duplicated (e.g. served from two different paths, or re-imported by a
// future dynamic-import refactor).
export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
console.log(`[Melody] Firebase app initialized (project: ${firebaseConfig.projectId})`);

export const auth = getAuth(app);

// Firestore with IndexedDB-backed offline persistence + multi-tab support,
// AND long-polling instead of the default WebChannel/gRPC-Web streaming
// transport.
//
// Evidence from this project's Firebase Console Usage tab: reads complete
// (they're billed, so they demonstrably reach Firestore), but writes have
// NEVER completed — not "sometimes fail," never once succeeded, on any
// network, since the project's creation. Rules were checked and match
// what the client sends, and reads use the exact same API key/project —
// so it isn't rules or a key restriction. What's different about writes
// (and realtime listeners) is that they require a long-lived streaming
// connection, while a plain read is a single short request. Mobile
// carrier NATs, some firewalls, and various proxies are well known to
// allow short requests through while silently dropping or blocking
// long-lived streaming connections — which reproduces exactly this
// "reads work, writes/streams don't" pattern. `experimentalAutoDetectLongPolling`
// makes the SDK detect this and fall back to plain HTTP long-polling,
// which behaves like normal short-lived requests and survives on
// networks that break streaming connections. This is Firebase's own
// documented fix for "requests to Firestore fail on some networks."
let firestoreDb;
try {
  firestoreDb = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    useFetchStreams: false,
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  console.log('[Melody] Firestore initialized with persistent offline cache.');
} catch (err) {
  console.warn('[Melody] Firestore persistent cache unavailable — falling back to in-memory cache.', err);
  firestoreDb = getFirestore(app);
}
export const db = firestoreDb;

/* -------------------------------------------------------------------- */
/*  Config-problem detection                                             */
/* -------------------------------------------------------------------- */
// A generic "Couldn't reach the server — check your connection" message is
// actively misleading for a specific class of failure: the API key being
// restricted or auto-suspended by Google. This happens routinely for keys
// committed in plain text to a *public* repo (which is exactly how this
// project is hosted, on GitHub Pages) — Google's abuse scanners pick the
// key up and lock it down, and every Auth/Firestore call then fails at
// the network layer, which looks identical to a real connectivity problem
// to both the SDK and the person using the app. Since restoring the key
// itself requires action in the Firebase/Google Cloud console (nothing a
// code fix here can repair), the most useful thing this module can do is
// detect the pattern and say so plainly instead of blaming the user's WiFi.
export let firebaseConfigProblem = null; // null | { code, message }

const CONFIG_PROBLEM_CODES = new Set([
  'auth/invalid-api-key',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.',
  'auth/api-key-not-valid',
  'auth/unauthorized-domain',
  'auth/requests-from-referer-are-blocked',
]);

export function isConfigProblem(err) {
  return !!err?.code && CONFIG_PROBLEM_CODES.has(err.code);
}

export function reportConfigProblem(err) {
  firebaseConfigProblem = { code: err.code, message: err.message };
  console.error(
    `[Melody] Firebase config problem detected (${err.code}). ` +
    'This is very likely an API key that Google has restricted/suspended ' +
    '(common for keys visible in a public GitHub Pages repo) or a domain ' +
    'missing from Firebase Auth > Settings > Authorized domains — not a ' +
    "user-side network issue. Check the Firebase Console and Google Cloud " +
    'Console > APIs & Services > Credentials for this project.',
    err,
  );
  showConfigProblemBanner(err.code);
}

function showConfigProblemBanner(code) {
  const el = document.getElementById('firebase-diagnostic-banner');
  if (!el) return;
  el.textContent = `App configuration problem (${code}) — sign-in/sync is unavailable until this is fixed in the Firebase Console. This is not a problem with your connection.`;
  el.hidden = false;
}

// Auth surfaces config problems (like a suspended/restricted API key)
// through the onAuthStateChanged error callback, not just from
// individual sign-in calls — catch it as early as boot so the banner can
// appear even before the person tries to interact with anything.
onAuthStateChanged(
  auth,
  () => {},
  (err) => {
    if (isConfigProblem(err)) reportConfigProblem(err);
  },
);

// Keep users signed in across launches/tabs (this is what makes "already
// logged in -> skip straight to Home" work). This is fire-and-forget: if
// it fails (e.g. some locked-down WebView), Firebase just falls back to
// its default in-memory persistence for that session — auth still works,
// it just won't survive a full app restart.
setPersistence(auth, browserLocalPersistence).catch((err) => {
  console.warn('[Melody] Could not set auth persistence — falling back to session-only.', err);
});

// Analytics is intentionally NOT initialized here. getAnalytics() throws in
// any context without a real browser measurement environment (many WebViews,
// privacy-hardened browsers, and ad-blockers strip the required network
// calls), and Melody has no use for it — pulling it in would only add a
// startup failure mode with no product benefit.
