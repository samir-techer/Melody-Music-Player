/**
 * rewards-service.js
 * 🎁 Melody Points Rewards Store — spend MP (earned via
 * achievements-service.js) on Premium Themes or auto-generated discount
 * coupons for a future Premium purchase.
 *
 * Storage: users/{uid}, same document as everything else:
 *   mpUnlockedThemes  string[]   — theme keys unlocked via MP, independent
 *                                  of premiumPlan. settings-screen.js
 *                                  treats a theme as usable if EITHER
 *                                  hasPremiumAccess(requiredPlan) OR its
 *                                  key is in this array.
 *   discountCoupons   array of { code, discountPercent, mpCost, createdAt,
 *                                expiresAt, redeemed } — expires 30 days
 *                                after creation. Melody's Premium screen
 *                                is a "Get Started" CTA -> "coming soon"
 *                                mock (see premium-screen.js — there's no
 *                                live billing wired up yet), so a coupon
 *                                is issued and displayed for the person to
 *                                use once checkout exists; it isn't
 *                                auto-applied anywhere today.
 *   rewardHistory     array of { type, label, mp, redeemedAt }, capped to
 *                                the most recent 50 entries.
 *
 * Independent onSnapshot listener on the same users/{uid} document —
 * consistent with how premium-service / achievements-service / auth-
 * service each already read and write that document on their own.
 */

import { doc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { spendMelodyPoints } from './achievements-service.js';
import { PREMIUM_THEMES } from './theme-service.js';

const HISTORY_LIMIT = 50;
const COUPON_VALID_DAYS = 30;

export const THEME_PRICES = { basic: 500, plus: 700, elite: 1200 };

export const DISCOUNT_TIERS = [
  { percent: 10, mp: 300 },
  { percent: 20, mp: 600 },
  { percent: 30, mp: 1000 },
];

function defaultState() {
  return { mpUnlockedThemes: [], discountCoupons: [], rewardHistory: [] };
}

let state = defaultState();
let currentUid = null;
let unsubscribeSnapshot = null;
const listeners = new Set();

function notify() {
  const snap = getRewardsSnapshot();
  listeners.forEach((fn) => {
    try { fn(snap); } catch (err) { console.error('[Melody] Rewards subscriber threw:', err); }
  });
}

async function persist() {
  if (!currentUid) return;
  try {
    await setDoc(doc(db, 'users', currentUid), {
      mpUnlockedThemes: state.mpUnlockedThemes,
      discountCoupons: state.discountCoupons,
      rewardHistory: state.rewardHistory.slice(-HISTORY_LIMIT),
    }, { merge: true });
  } catch (err) {
    console.error('[Melody] Rewards: save failed.', err);
  }
}

function generateCouponCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let code = 'MELODY-';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function initRewards(uid) {
  if (uid === currentUid) return;
  currentUid = uid;

  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }

  if (!uid) {
    state = defaultState();
    notify();
    return;
  }

  unsubscribeSnapshot = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const data = snap.data() || {};
      state.mpUnlockedThemes = Array.isArray(data.mpUnlockedThemes) ? data.mpUnlockedThemes : [];
      state.discountCoupons = Array.isArray(data.discountCoupons) ? data.discountCoupons : [];
      state.rewardHistory = Array.isArray(data.rewardHistory) ? data.rewardHistory : [];
      notify();
    },
    (err) => console.error('[Melody] Rewards: live listener failed.', err),
  );
}

export function subscribeRewards(listener) {
  listeners.add(listener);
  listener(getRewardsSnapshot());
  return () => listeners.delete(listener);
}

/** True if this theme is usable regardless of premiumPlan — settings-screen.js checks this too. */
export function isThemeUnlockedViaMP(themeKey) {
  return state.mpUnlockedThemes.includes(themeKey);
}

function activeCoupons() {
  const now = Date.now();
  return state.discountCoupons.filter((c) => !c.redeemed && c.expiresAt > now);
}

export function getRewardsSnapshot() {
  return {
    themes: Object.values(PREMIUM_THEMES).map((t) => ({
      key: t.key,
      label: t.label,
      price: THEME_PRICES[t.key] || 999,
      unlocked: state.mpUnlockedThemes.includes(t.key),
    })),
    discountTiers: DISCOUNT_TIERS,
    activeCoupons: activeCoupons(),
    expiredOrUsedCoupons: state.discountCoupons.filter((c) => c.redeemed || c.expiresAt <= Date.now()),
    history: [...state.rewardHistory].reverse(),
  };
}

/** Spend MP to permanently unlock a Premium Theme for this account (independent of plan). */
export function redeemTheme(themeKey) {
  const theme = PREMIUM_THEMES[themeKey];
  const price = THEME_PRICES[themeKey];
  if (!theme || !price) return { success: false, reason: 'unknown-theme' };
  if (state.mpUnlockedThemes.includes(themeKey)) return { success: false, reason: 'already-unlocked' };

  if (!spendMelodyPoints(price)) return { success: false, reason: 'insufficient-mp' };

  state.mpUnlockedThemes.push(themeKey);
  state.rewardHistory.push({ type: 'theme', label: theme.label, mp: price, redeemedAt: Date.now() });
  notify();
  persist();
  return { success: true };
}

/** Spend MP to generate a discount coupon (expires in 30 days). */
export function redeemDiscountCoupon(percent) {
  const tier = DISCOUNT_TIERS.find((t) => t.percent === percent);
  if (!tier) return { success: false, reason: 'unknown-tier' };

  if (!spendMelodyPoints(tier.mp)) return { success: false, reason: 'insufficient-mp' };

  const coupon = {
    code: generateCouponCode(),
    discountPercent: tier.percent,
    mpCost: tier.mp,
    createdAt: Date.now(),
    expiresAt: Date.now() + COUPON_VALID_DAYS * 24 * 60 * 60 * 1000,
    redeemed: false,
  };
  state.discountCoupons.push(coupon);
  state.rewardHistory.push({ type: 'coupon', label: `${tier.percent}% off coupon`, mp: tier.mp, redeemedAt: Date.now() });
  notify();
  persist();
  return { success: true, coupon };
}
