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

const STORAGE_KEY = 'theme';
const VALID_MODES = ['light', 'dark', 'system'];

/* -------------------------------------------------------------------- */
/*  Premium Themes — REMOVED                                             */
/* -------------------------------------------------------------------- */
// Melody now only ships Light / Dark / System. The purchasable premium
// themes (Crimson Velvet, Royal Navy, Gold Elite, and the Gradient
// Collection) have been removed from the Reward Store and Settings.
//
// The exports below are kept as inert stubs — rather than deleted
// outright — because several other modules (app.js, rewards-service.js,
// cloud-backup-service.js) still import them. Making them safe no-ops
// here means removing the *visible* purchase/selection UI in those files
// doesn't also require chasing down every import site; nothing ever
// applies a premium theme anymore, and no [data-premium-theme] attribute
// is ever set, so the removed CSS blocks in tokens.css have nothing left
// to key off of.
export const PREMIUM_THEMES = {};
export const GRADIENT_COLLECTION_KEYS = [];

export function setMpUnlockedThemeKeys() {
  // no-op — nothing to unlock anymore
}

export function isPremiumThemeUnlocked() {
  return false;
}

export async function getSelectedPremiumTheme() {
  return null;
}

export async function setSelectedPremiumTheme() {
  // no-op — premium theme selection has been removed
}

export async function applyPremiumThemeIfAny() {
  // no-op — nothing is ever applied
}

export async function refreshPremiumThemeForUid() {
  // no-op
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
