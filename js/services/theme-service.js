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
      primary: '#59171B',
      secondary: '#7A2328',
      accent: '#FED7B8',
      background: '#0D0D0D',
      card: '#1A1313',
      text: '#FFFFFF',
      mutedText: '#C9C4C4', // "Light Gray" per spec
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
      primary: '#1A1611',
      secondary: '#0D0B08',
      accent: '#FBBF24',
      highlight: '#FDE68A',
      background: '#0B0A08',
      card: 'rgba(251, 191, 36, 0.06)', // matte black with a faint gold glass card
      text: '#F5F1EC',
      mutedText: '#C9BFA6',
    },
  },
};

function applyPremiumThemeColors(themeKey) {
  const theme = PREMIUM_THEMES[themeKey];
  const root = document.documentElement;
  if (!theme) {
    root.removeAttribute('data-premium-theme');
    ['primary', 'secondary', 'accent', 'highlight', 'background', 'card', 'text', 'muted-text'].forEach((prop) => {
      root.style.removeProperty(`--premium-${prop}`);
    });
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
  if (themeKey && hasPremiumAccess(PREMIUM_THEMES[themeKey]?.requiredPlan)) {
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
  if (theme && hasPremiumAccess(theme.requiredPlan)) {
    applyPremiumThemeColors(themeKey);
  } else {
    applyPremiumThemeColors(null); // expired or never selected — Default Theme, selection preserved server-side
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
