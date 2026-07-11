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
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

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
export const db = getFirestore(app);

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
