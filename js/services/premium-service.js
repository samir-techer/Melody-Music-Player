/**
 * premium-service.js
 * The single reusable helper every premium feature check goes through:
 * hasPremiumAccess(requiredPlan).
 *
 * Design:
 *  - Never trust local/cached values for the FIRST read — initPremium(uid)
 *    opens a live Firestore listener (onSnapshot) on users/{uid} so the
 *    in-memory plan state is always driven by the server document, not a
 *    value some other tab/session could have gone stale.
 *  - Once the listener is live, hasPremiumAccess() is a cheap synchronous
 *    check against that server-driven cache — every screen can call it
 *    directly without awaiting a network round trip on every render.
 *  - Plans are hierarchical: Free < Basic < Plus < Elite. Higher plans
 *    automatically satisfy a lower requirement (hasPremiumAccess('Basic')
 *    is true for a Plus or Elite account).
 *  - Expiry is enforced here, once, for everyone: if premiumExpiry has
 *    passed, the effective plan is Free — Firestore itself is NOT written
 *    to (no auto-downgrade write); the account simply behaves as Free
 *    until it renews or an admin/back-end updates the document.
 */

import { doc, onSnapshot } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { db } from './firebase-config.js';

export const PLAN_ORDER = ['Free', 'Basic', 'Plus', 'Elite'];

function rank(plan) {
  const i = PLAN_ORDER.indexOf(plan);
  return i === -1 ? 0 : i;
}

// Server-driven cache. `raw` is exactly what's in Firestore (or null before
// the first snapshot arrives / when signed out); `effectivePlan` already
// has expiry applied.
let raw = { premiumPlan: 'Free', premiumExpiry: null, role: 'User' };
let effectivePlan = 'Free';
let unsubscribeSnapshot = null;
let currentUid = null;
let readySince = false;

const listeners = new Set();

function computeEffectivePlan(profileLike) {
  const plan = profileLike?.premiumPlan || 'Free';
  if (plan === 'Free') return 'Free';

  const expiry = profileLike?.premiumExpiry;
  if (!expiry) return plan; // no expiry set (e.g. admin-granted) — treat as active

  // Firestore Timestamp, millis, or ISO string — normalize all three.
  const expiryMs = typeof expiry?.toMillis === 'function'
    ? expiry.toMillis()
    : (expiry instanceof Date ? expiry.getTime() : new Date(expiry).getTime());

  if (!Number.isFinite(expiryMs)) return plan;
  return expiryMs > Date.now() ? plan : 'Free';
}

function notify() {
  listeners.forEach((fn) => {
    try { fn(getPremiumState()); } catch (err) { console.error('[Melody] Premium subscriber threw:', err); }
  });
}

/**
 * Start (or restart, for a new uid) the live premium listener. Call this
 * once auth resolves a signed-in user, and again on sign-out (with null)
 * to reset back to Free instead of leaking the previous account's plan.
 */
export function initPremium(uid) {
  if (uid === currentUid) return; // already watching this account (or already reset)
  currentUid = uid;
  readySince = false;

  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }

  if (!uid) {
    raw = { premiumPlan: 'Free', premiumExpiry: null, role: 'User' };
    effectivePlan = 'Free';
    notify();
    return;
  }

  unsubscribeSnapshot = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const data = snap.exists() ? snap.data() : {};
      raw = {
        premiumPlan: data.premiumPlan || 'Free',
        premiumExpiry: data.premiumExpiry || null,
        role: data.role || 'User',
      };
      effectivePlan = computeEffectivePlan(raw);
      readySince = true;
      notify();
    },
    (err) => {
      console.error('[Melody] Premium listener failed — defaulting to Free until it recovers.', err);
      readySince = true;
      notify();
    },
  );
}

/** True once the first live Firestore snapshot has been seen for this uid. */
export function isPremiumReady() {
  return readySince;
}

/**
 * Resolves once the first live Firestore snapshot has arrived (or
 * immediately if it already has). Used by anything that must never apply
 * a premium-gated effect (like the Premium Theme) before verification is
 * actually in — never "apply and correct later".
 */
export function waitForPremiumReady() {
  if (readySince) return Promise.resolve(getPremiumState());
  return new Promise((resolve) => {
    const unsub = subscribePremium((state) => {
      if (state.ready) {
        unsub();
        resolve(state);
      }
    });
  });
}

/**
 * THE reusable helper. Every premium feature in the app should gate
 * through this rather than reading premiumPlan directly.
 * hasPremiumAccess('Basic') -> true for Basic, Plus, or Elite (unexpired).
 */
export function hasPremiumAccess(requiredPlan) {
  if (!requiredPlan || requiredPlan === 'Free') return true;
  return rank(effectivePlan) >= rank(requiredPlan);
}

/** The account's real, expiry-adjusted plan right now ("Free" | "Basic" | "Plus" | "Elite"). */
export function getEffectivePlan() {
  return effectivePlan;
}

/** The raw Firestore plan, ignoring expiry — mainly for display ("your plan says Basic, but it's expired"). */
export function getRawPlan() {
  return raw.premiumPlan;
}

export function getPremiumExpiry() {
  return raw.premiumExpiry;
}

export function isAdmin() {
  return raw.role === 'admin';
}

export function getPremiumState() {
  return {
    rawPlan: raw.premiumPlan,
    effectivePlan,
    expiry: raw.premiumExpiry,
    isExpired: raw.premiumPlan !== 'Free' && effectivePlan === 'Free',
    ready: readySince,
  };
}

/** Subscribe to plan changes (expiry ticking over, an admin grant arriving, sign-out, etc). */
export function subscribePremium(listener) {
  listeners.add(listener);
  listener(getPremiumState());
  return () => listeners.delete(listener);
}

/** Human label used by badges/lock-dialog copy: "Basic", "Plus", "Elite". */
export function planLabel(plan) {
  return plan;
}
