/**
 * app.js
 * Boot sequence for Melody.
 *
 * Every stage is wrapped so a failure in one (a broken import, a blocked
 * IndexedDB upgrade, a settings read that throws, etc.) is logged and
 * skipped rather than left to silently hang the module graph or freeze
 * the page. Login is the guaranteed final fallback: if we cannot even
 * determine where to route, we still send the person to the login screen
 * rather than show a blank screen or, worse, an unauthenticated Home.
 *
 * Flow (login is required — Melody has no guest mode):
 *   1. No signed-in user                        -> login-screen
 *   2. Signed in, email/password + not verified  -> verify-email-screen
 *   3. Signed in + verified, no nickname on
 *      the Firestore profile yet                -> nickname-screen (first launch)
 *   4. Nickname set, greeting not yet seen       -> greeting-screen  (shown once)
 *   5. Nickname + greeting both done             -> home-screen       (every launch after)
 */

import { getUserItem, setUserItem } from './utils/storage.js';
import { initRouter, registerRoute, navigate, setAuthGuard } from './utils/router.js';
import { initTheme, applyPremiumThemeIfAny } from './services/theme-service.js';
import {
  restoreState, setCrossfadeConfig, initEqualizerFromStorage,
  setAudioProcessingMode, setCleanBass, initAudioProcessingFromStorage, initCleanBassFromStorage,
} from './services/player-service.js';
import { initAdManager } from './services/ad-manager.js';
import { onAuthChange, getUserProfile, getCurrentUser, waitForInitialUser, signOutUser } from './services/auth-service.js';
import { initPremium, subscribePremium, hasPremiumAccess, waitForPremiumReady, isAdmin } from './services/premium-service.js';
import { setCloudBackupActive } from './services/cloud-backup-service.js';
import { renderLoginScreen } from './components/login-screen.js';
import { renderVerifyEmailScreen } from './components/verify-email-screen.js';
import { renderNicknameScreen } from './components/nickname-screen.js';
import { renderGreetingScreen } from './components/greeting-screen.js';
import { renderHomeScreen } from './components/home-screen.js';
import { renderPlayerScreen } from './components/player-screen.js';
import { renderSearchScreen } from './components/search-screen.js';
import { renderLibraryScreen } from './components/library-screen.js';
import { renderSettingsScreen } from './components/settings-screen.js';
import { renderPremiumScreen } from './components/premium-screen.js';
import { renderMusicHubScreen } from './components/music-hub.js';
import { renderMetadataEditorScreen } from './components/metadata-editor.js';
import { renderLyricsScreen } from './components/lyrics-screen.js';
import { renderAdminScreen } from './components/admin-screen.js';

let currentAuthUser = null;

async function boot() {
  console.log('[Melody] App boot started');

  const root = document.getElementById('app-root');
  if (!root) {
    // Nothing we can do without a mount point — but log loudly so this
    // is never mistaken for a silent hang again.
    console.error('[Melody] FATAL: #app-root not found in index.html — cannot mount app.');
    return;
  }

  initRouter(root);

  // Public — reachable while signed out.
  registerRoute('login', renderLoginScreen);
  registerRoute('verify-email', renderVerifyEmailScreen);

  // Everything else requires an authenticated session. Cloud Sync, Admin,
  // and Artist Portal screens plug into this same `requiresAuth: true`
  // pattern once they're built.
  registerRoute('nickname', renderNicknameScreen, { requiresAuth: true });
  registerRoute('greeting', renderGreetingScreen, { requiresAuth: true });
  registerRoute('home', renderHomeScreen, { requiresAuth: true });
  registerRoute('player', renderPlayerScreen, { requiresAuth: true });
  registerRoute('search', renderSearchScreen, { requiresAuth: true });
  registerRoute('library', renderLibraryScreen, { requiresAuth: true });
  registerRoute('settings', renderSettingsScreen, { requiresAuth: true });
  registerRoute('premium', renderPremiumScreen, { requiresAuth: true });
  registerRoute('music-hub', renderMusicHubScreen, { requiresAuth: true });
  registerRoute('metadata-editor', renderMetadataEditorScreen, { requiresAuth: true });
  registerRoute('lyrics', renderLyricsScreen, { requiresAuth: true });
  registerRoute('admin', renderAdminScreen, {
    requiresAuth: true,
    // Re-verified against the live Firestore-backed premium-service state
    // on EVERY navigation attempt — never a cached flag, never trusting
    // that the Admin button simply wasn't clicked by mistake. Waits for
    // the first snapshot if premium-service hasn't resolved yet (e.g. a
    // very fast navigation right after boot) rather than racing to a
    // false negative.
    guard: async () => {
      await waitForPremiumReady();
      return isAdmin();
    },
  });

  setAuthGuard(() => !!currentAuthUser);
  console.log('[Melody] Router mounted');

  // ---------- Restore last playback session (queue + position) ----------
  // Runs in the background; never blocks first paint, and any failure is
  // just logged — a fresh empty player is a safe fallback either way.
  restoreState().catch((err) => {
    console.error('[Melody] Playback state restore failed — starting with an empty player.', err);
  });
  initEqualizerFromStorage().catch((err) => {
    console.error('[Melody] Equalizer preset restore failed — using Normal.', err);
  });
  initAudioProcessingFromStorage().catch((err) => {
    console.error('[Melody] Audio Processing mode restore failed — using Standard.', err);
  });
  initCleanBassFromStorage().catch((err) => {
    console.error('[Melody] Clean Bass preference restore failed — defaulting to on.', err);
  });
  initAdManager().catch((err) => {
    console.error('[Melody] Ad manifest load failed — ads disabled for this session.', err);
  });

  // ---------- Theme / settings ----------
  try {
    await initTheme();
    console.log('[Melody] Settings loaded (theme applied)');
  } catch (err) {
    console.error('[Melody] Settings failed to load — continuing with default theme.', err);
  }

  // ---------- Firebase auth + route decision ----------
  // Firebase's local persistence means this resolves with the existing
  // session on relaunch (no flash of the login screen) and with `null`
  // only for genuinely signed-out visitors.
  let startRoute = 'login'; // safe fallback if anything below throws
  try {
    currentAuthUser = await waitForInitialUser();
    initPremium(currentAuthUser?.uid || null);
    // Premium theme (if selected on Basic+) restores only after premium
    // status is verified via Firestore — never applied optimistically.
    applyPremiumThemeIfAny(currentAuthUser?.uid || null).catch(() => {});
    loadCrossfadeConfigForUser(currentAuthUser?.uid || null).catch(() => {});
    startRoute = await resolveRouteForUser(currentAuthUser);
    console.log(`[Melody] Auth resolved — start route resolved to "${startRoute}"`);
  } catch (err) {
    console.error('[Melody] Auth/init failed — falling back to Login.', err);
    startRoute = 'login';
  }

  // Keep routing in sync with auth changes that happen *after* boot too
  // (e.g. the session is signed out in another tab, or a token expires).
  onAuthChange((user) => {
    const wasSignedIn = !!currentAuthUser;
    const uidChanged = (currentAuthUser?.uid || null) !== (user?.uid || null);
    currentAuthUser = user;
    if (uidChanged) {
      initPremium(user?.uid || null);
      if (user?.uid) {
        applyPremiumThemeIfAny(user.uid).catch(() => {});
        loadCrossfadeConfigForUser(user.uid).catch(() => {});
      } else {
        setCrossfadeConfig({ enabled: false });
        setCloudBackupActive(null, false);
      }
    }
    if (wasSignedIn && !user) {
      navigate('login').catch((err) => console.error('[Melody] Failed to route to login after sign-out.', err));
    }
  });

  // ---------- Render ----------
  try {
    await navigate(startRoute);
    console.log(`[Melody] ${capitalize(startRoute)} rendered`);
  } catch (err) {
    console.error(`[Melody] Failed to render "${startRoute}" — attempting Login as last resort.`, err);
    if (startRoute !== 'login') {
      try {
        await navigate('login');
        console.log('[Melody] Login rendered (fallback path)');
      } catch (fallbackErr) {
        console.error('[Melody] FATAL: Login screen itself failed to render.', fallbackErr);
        renderCrashFallback(root, fallbackErr);
      }
    } else {
      renderCrashFallback(root, err);
    }
  }

  registerServiceWorker();

  // ---------- React immediately to premium status changes ----------
  // Whenever the effective plan changes (expiry passing, a renewal
  // arriving from another tab/device, sign-out), re-evaluate the Premium
  // Theme right away rather than waiting for the next screen navigation.
  // Crossfade/Equalizer/Queue features/Cloud Backup all read
  // hasPremiumAccess() live at the moment they're used, so they don't
  // need an explicit reset here — but the applied theme is a standing
  // document-level effect, so it's the one thing that needs to be pushed.
  let lastEffectivePlan = null;
  subscribePremium((state) => {
    if (!state.ready) return;
    if (lastEffectivePlan !== null && lastEffectivePlan !== state.effectivePlan) {
      applyPremiumThemeIfAny(currentAuthUser?.uid || null).catch(() => {});
    }
    lastEffectivePlan = state.effectivePlan;
  });
}

/**
 * The single source of truth for "what screen should this signed-in (or
 * signed-out) user see". Used both at boot and by login-screen /
 * verify-email-screen right after a successful auth action, via
 * `resolvePostAuthRoute()` below, so the decision tree only lives here.
 */
async function resolveRouteForUser(user) {
  if (!user) return 'login';

  // Google accounts are pre-verified by Google; only email/password
  // accounts go through Melody's own verification step.
  const isPasswordProvider = user.providerData.some((p) => p.providerId === 'password');
  if (isPasswordProvider && !user.emailVerified) return 'verify-email';

  let profile = null;
  try {
    profile = await getUserProfile(user.uid);
  } catch (err) {
    console.error('[Melody] Could not read user profile — assuming nickname still needed.', err);
  }

  if (!profile?.nickname) return 'nickname';

  if (profile?.accountDisabled === true) {
    console.warn(`[Melody] Account ${user.uid} is disabled — signing out.`);
    const { showToast } = await import('./utils/toast.js');
    showToast('This account has been disabled. Contact support if you think this is a mistake.');
    await signOutUser().catch(() => {});
    return 'login';
  }

  // Keep the local mirror in sync so greeting-screen and any offline
  // reads of "nickname" stay correct without a Firestore round-trip.
  // Scoped to this uid so a different account signing in later (or a
  // shared/kiosk device) never reads someone else's cached nickname.
  setUserItem(user.uid, 'nickname', profile.nickname).catch(() => {});

  const hasSeenGreeting = await getUserItem(user.uid, 'hasSeenGreeting');
  if (!hasSeenGreeting) return 'greeting';

  return 'home';
}

/**
 * Reads crossfadeEnabled/crossfadeDuration from Firestore and applies
 * them to the player, honoring premium gating — only takes effect once
 * premium status has actually been verified, same rule as the theme.
 */
async function loadCrossfadeConfigForUser(uid) {
  if (!uid) return;
  await waitForPremiumReady();
  const profile = await getUserProfile(uid).catch(() => null);
  const enabled = hasPremiumAccess('Basic') && Boolean(profile?.crossfadeEnabled);
  const duration = Number.isFinite(profile?.crossfadeDuration) ? profile.crossfadeDuration : 3;
  setCrossfadeConfig({ enabled, duration });
  setCloudBackupActive(uid, Boolean(profile?.cloudBackupEnabled));

  // Audio Processing mode is plan-gated (setAudioProcessingMode() itself
  // forces non-entitled accounts back to "standard"); Clean Bass is free
  // for everyone and defaults ON if the field has never been set.
  setAudioProcessingMode(profile?.audioProcessingMode || 'standard');
  setCleanBass(profile?.cleanBassEnabled === undefined ? true : Boolean(profile.cleanBassEnabled));
}

/**
 * Exported for login-screen.js / verify-email-screen.js post-auth
 * redirects. Deliberately reads `getCurrentUser()` (Firebase's
 * synchronous `auth.currentUser`) rather than the module-level
 * `currentAuthUser` cache: `auth.currentUser` is updated synchronously as
 * part of the sign-in call resolving, while `currentAuthUser` here is only
 * updated by the async `onAuthStateChanged` listener below, which can fire
 * a tick later. Using the stale variable right after a fresh sign-in was a
 * real race — it could momentarily read `null` and bounce the user back to
 * the login screen instead of onboarding/home.
 */
export async function resolvePostAuthRoute() {
  const user = getCurrentUser();
  currentAuthUser = user;
  return resolveRouteForUser(user);
}

/**
 * Last-resort UI so a total failure still shows *something* instead of a
 * blank screen — this should be effectively unreachable given the guards
 * above, but a visible, actionable message beats a silent freeze.
 */
function renderCrashFallback(root, err) {
  root.innerHTML = `
    <div style="padding:32px;text-align:center;font-family:sans-serif;color:#1F1F1F;background:#F5F1EC;min-height:100vh;">
      <h1 style="font-size:20px;margin-bottom:12px;">Melody couldn't start</h1>
      <p style="color:#7A7A7A;margin-bottom:16px;">Something went wrong during startup. Try reloading — if this keeps happening, clearing site data usually fixes it.</p>
      <button onclick="location.reload()" style="padding:12px 24px;border-radius:999px;background:#232323;color:#F5F1EC;border:none;font-weight:600;">Reload</button>
    </div>
  `;
  console.error('[Melody] Rendered crash fallback UI.', err);
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((err) => {
        console.warn('[Melody] Service worker registration failed:', err);
      });
    });
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

document.addEventListener('DOMContentLoaded', boot);
