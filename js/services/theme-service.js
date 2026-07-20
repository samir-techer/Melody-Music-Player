/**
 * theme-service.js
 * Handles Melody's Light / Dark / System appearance setting.
 *
 * Storage key: "theme" -> "light" | "dark" | "system"  (default: "system")
 *
 * Applied via a data-theme="light|dark" attribute on <html>, which the
 * dark-theme block in css/tokens.css keys off of. "system" resolves to
 * whichever the OS prefers and stays in sync if the OS setting changes
 * while the app is open.
 */

import { getItem, setItem } from '../utils/storage.js';
import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { hasPremiumAccess, waitForPremiumReady } from './premium-service.js';

const STORAGE_KEY = 'theme';
const VALID_MODES = ['light', 'dark', 'system'];

/* -------------------------------------------------------------------- */
/*  Premium Themes                                                       */
/* -------------------------------------------------------------------- */
// Stored in Firestore as `selectedTheme` on the user's profile document
// ("basic" | null) so it follows the account across devices. The
// selection is NEVER erased when premium expires — only its *application*
// stops — so it comes right back the moment the plan is renewed.

export const PREMIUM_THEMES = {
  basic: {
    key: 'basic',
    label: 'Crimson Velvet',
    requiredPlan: 'Basic',
    colors: {
      primary: '#6A1024',
      secondary: '#A61D3B',
      accent: '#E8A0B7',
      highlight: '#F2C6D4',
      background: '#0F0A0A',
      card: '#1A0F12',
      text: '#FFFFFF',
      mutedText: '#C9A9B2', // soft rose-tinted gray, warmer than neutral
    },
  },
  plus: {
    key: 'plus',
    label: 'Royal Navy',
    requiredPlan: 'Plus',
    colors: {
      primary: '#002147',
      secondary: '#08182F',
      accent: '#D2B48C',
      highlight: '#F8F0E5',
      background: '#091321',
      card: 'rgba(210, 180, 140, 0.08)', // subtle blue/tan glassmorphism, not a flat fill
      text: '#FFFFFF',
      mutedText: '#B7C2D6',
    },
  },
  elite: {
    key: 'elite',
    label: 'Gold Elite',
    requiredPlan: 'Elite',
    colors: {
      primary: '#C9A227',
      secondary: '#D4AF37',
      accent: '#C9A227',
      highlight: '#F6E7B0', // champagne gold
      background: '#090909',
      card: '#151515', // matte black, near-flat — gold is a border/accent only, never a fill
      text: '#FFFFFF',
      mutedText: '#B8B8B8', // light gray
    },
  },

  // ---- Gradient Collection — sold in the MP Store, not tied to a plan  ----
  // (except Midnight Nebula, which ships free with Elite and is
  // deliberately NOT for sale — see rewards-service.js's THEME_PRICES,
  // which has no entry for it). `mpOnly: true` means the plan system
  // grants nothing for these — see isPremiumThemeUnlocked() below, which
  // is the ONLY thing settings-screen.js / rewards-screen.js should ever
  // call to decide whether one of these is usable.
  'pink-blossom': {
    key: 'pink-blossom',
    label: 'Pink Blossom',
    collection: 'gradient',
    mpOnly: true,
    colors: {
      primary: '#F042FF',
      secondary: '#FF7AD9',
      accent: '#F042FF',
      highlight: '#FFE5F1',
      background: '#12060F',
      card: '#1C0C17',
      text: '#FFFFFF',
      mutedText: '#D8AFC7',
    },
    gradient: { start: '#FFE5F1', mid: '#FF8FE0', end: '#F042FF' },
  },
  'neon-orchid': {
    key: 'neon-orchid',
    label: 'Neon Orchid',
    collection: 'gradient',
    mpOnly: true,
    animated: true, // gets the slow animated-gradient treatment in tokens.css
    colors: {
      primary: '#F042FF',
      secondary: '#7226FF',
      accent: '#C36BFF',
      highlight: '#FFE5F1',
      background: '#0D0716',
      card: '#180F26',
      text: '#FFFFFF',
      mutedText: '#C9B6E8',
    },
    gradient: { start: '#FFE5F1', mid: '#F042FF', end: '#7226FF' },
  },
  'aurora-mint': {
    key: 'aurora-mint',
    label: 'Aurora Mint',
    collection: 'gradient',
    mpOnly: true,
    colors: {
      primary: '#87F5F5',
      secondary: '#F042FF',
      accent: '#87F5F5',
      highlight: '#FFE5F1',
      background: '#06131A',
      card: '#0E1E24',
      text: '#FFFFFF',
      mutedText: '#AFDDE0',
    },
    gradient: { start: '#87F5F5', mid: '#FFE5F1', end: '#F042FF' },
  },
  'midnight-nebula': {
    key: 'midnight-nebula',
    label: 'Midnight Nebula',
    collection: 'gradient',
    requiredPlan: 'Elite', // free with Elite, deliberately never MP-purchasable
    colors: {
      primary: '#7226FF',
      secondary: '#160078',
      accent: '#B89CFF',
      highlight: '#B89CFF',
      background: '#010030',
      card: 'rgba(114, 38, 255, 0.08)', // dark glass, not a flat fill
      text: '#FFFFFF',
      mutedText: '#B7ADDC',
    },
    gradient: { start: '#7226FF', mid: '#160078', end: '#010030' },
  },
};

/** Every theme in the MP Store's Gradient Collection, in display order. */
export const GRADIENT_COLLECTION_KEYS = ['pink-blossom', 'neon-orchid', 'aurora-mint', 'midnight-nebula'];

// Themes unlocked via Melody Points, mirrored in from rewards-service.js
// every time its Firestore snapshot updates (see setMpUnlockedThemeKeys
// below). Kept here — rather than importing rewards-service.js, which
// itself imports PREMIUM_THEMES from this file — purely to avoid a
// circular import between the two services.
let mpUnlockedThemeKeys = new Set();

/** Called by rewards-service.js whenever the account's MP-unlocked theme list changes. */
export function setMpUnlockedThemeKeys(keys) {
  mpUnlockedThemeKeys = new Set(keys || []);
}

/**
 * The single source of truth for "can this account actually use this
 * theme right now" — combines plan access (Basic/Plus/Elite themes,
 * Midnight Nebula) with Melody Points unlocks (the three mpOnly gradient
 * themes). Always use this instead of calling hasPremiumAccess() directly
 * on a theme's requiredPlan, since hasPremiumAccess(undefined) resolves
 * to true and would otherwise make every mpOnly theme look "free".
 */
export function isPremiumThemeUnlocked(themeKey) {
  const theme = PREMIUM_THEMES[themeKey];
  if (!theme) return false;
  if (theme.mpOnly) return mpUnlockedThemeKeys.has(theme.key);
  return hasPremiumAccess(theme.requiredPlan) || mpUnlockedThemeKeys.has(theme.key);
}

function applyPremiumThemeColors(themeKey) {
  const theme = PREMIUM_THEMES[themeKey];
  const root = document.documentElement;
  if (!theme) {
    root.removeAttribute('data-premium-theme');
    ['primary', 'secondary', 'accent', 'highlight', 'background', 'card', 'text', 'muted-text'].forEach((prop) => {
      root.style.removeProperty(`--premium-${prop}`);
    });
    ['start', 'mid', 'end'].forEach((stop) => root.style.removeProperty(`--premium-gradient-${stop}`));
    return;
  }
  root.setAttribute('data-premium-theme', theme.key);
  root.style.setProperty('--premium-primary', theme.colors.primary);
  root.style.setProperty('--premium-secondary', theme.colors.secondary);
  root.style.setProperty('--premium-accent', theme.colors.accent);
  root.style.setProperty('--premium-highlight', theme.colors.highlight || theme.colors.accent);
  root.style.setProperty('--premium-background', theme.colors.background);
  root.style.setProperty('--premium-card', theme.colors.card || theme.colors.background);
  root.style.setProperty('--premium-muted-text', theme.colors.mutedText || theme.colors.text);
  root.style.setProperty('--premium-text', theme.colors.text);
  if (theme.gradient) {
    root.style.setProperty('--premium-gradient-start', theme.gradient.start);
    root.style.setProperty('--premium-gradient-mid', theme.gradient.mid);
    root.style.setProperty('--premium-gradient-end', theme.gradient.end);
  } else {
    ['start', 'mid', 'end'].forEach((stop) => root.style.removeProperty(`--premium-gradient-${stop}`));
  }
}

/** Reads the saved selection straight from Firestore (source of truth). */
export async function getSelectedPremiumTheme(uid) {
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? (snap.data().selectedTheme || null) : null;
  } catch (err) {
    console.error('[Melody] Premium theme read failed.', err);
    return null;
  }
}

/**
 * Saves the user's Premium Theme choice. `themeKey` may be null to clear
 * it (go back to Default). Uses a merge write so nothing else on the
 * profile is ever touched.
 */
export async function setSelectedPremiumTheme(uid, themeKey) {
  if (!uid) return;
  await setDoc(doc(db, 'users', uid), { selectedTheme: themeKey || null }, { merge: true });
  if (themeKey && isPremiumThemeUnlocked(themeKey)) {
    applyPremiumThemeColors(themeKey);
  } else {
    applyPremiumThemeColors(null);
  }
}

/**
 * Applies the saved Premium Theme, but ONLY once premium status has been
 * verified via Firestore and only if the account currently qualifies for
 * it. If premium has expired, the saved selection is left alone in
 * Firestore (never erased) and the app simply falls back to the Default
 * theme until the plan renews.
 */
export async function applyPremiumThemeIfAny(uid) {
  if (!uid) {
    applyPremiumThemeColors(null);
    return;
  }
  await waitForPremiumReady();
  const themeKey = await getSelectedPremiumTheme(uid);
  const theme = themeKey ? PREMIUM_THEMES[themeKey] : null;
  if (theme && isPremiumThemeUnlocked(themeKey)) {
    applyPremiumThemeColors(themeKey);
  } else {
    applyPremiumThemeColors(null); // expired, never purchased, or never selected — Default Theme, selection preserved server-side
  }
}

/** Called whenever premium status changes (e.g. expiry sweep) to re-evaluate immediately. */
export async function refreshPremiumThemeForUid(uid) {
  return applyPremiumThemeIfAny(uid);
}

let mediaQuery = null;
let systemListenerAttached = false;

/** Resolve "system" down to an actual "light"/"dark" value. */
function resolveSystemPreference() {
  if (!mediaQuery) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  }
  return mediaQuery.matches ? 'dark' : 'light';
}

/** Apply a resolved theme ("light" | "dark") to the document immediately. */
function applyResolvedTheme(resolved) {
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.style.colorScheme = resolved;

  // Keep the browser chrome (status bar / task switcher) in sync
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', resolved === 'dark' ? '#171614' : '#F5F1EC');
  }
}

/**
 * Call this as early as possible (before first paint) to avoid a
 * light-mode flash on load. Reads the stored preference synchronously
 * where possible; falls back to "system" instantly, then corrects once
 * IndexedDB responds (usually within a frame or two).
 */
export async function initTheme() {
  const stored = (await getItem(STORAGE_KEY)) || 'system';
  const mode = VALID_MODES.includes(stored) ? stored : 'system';
  const resolved = mode === 'system' ? resolveSystemPreference() : mode;
  applyResolvedTheme(resolved);
  attachSystemListener(mode);
  return mode;
}

/** Get the currently stored mode ("light" | "dark" | "system"). */
export async function getThemeMode() {
  const stored = (await getItem(STORAGE_KEY)) || 'system';
  return VALID_MODES.includes(stored) ? stored : 'system';
}

/** Set and immediately apply a new theme mode. */
export async function setThemeMode(mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid theme mode "${mode}". Use "light", "dark", or "system".`);
  }
  await setItem(STORAGE_KEY, mode);
  // Mirrored synchronously so index.html's inline boot script can read it
  // before IndexedDB responds, preventing a flash of the wrong theme.
  try { localStorage.setItem('melody-theme-sync', mode); } catch (_) {}

  const resolved = mode === 'system' ? resolveSystemPreference() : mode;
  applyResolvedTheme(resolved);
  attachSystemListener(mode);
}

/** Convenience toggle between light and dark (ignores/exits "system"). */
export async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  await setThemeMode(next);
  return next;
}

function attachSystemListener(mode) {
  if (!mediaQuery) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  }
  if (systemListenerAttached) return;

  mediaQuery.addEventListener('change', async () => {
    const currentMode = await getThemeMode();
    if (currentMode === 'system') {
      applyResolvedTheme(resolveSystemPreference());
    }
  });
  systemListenerAttached = true;
}
