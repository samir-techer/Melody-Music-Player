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

import { getItem, setItem } from './utils/storage.js';
import { initRouter, registerRoute, navigate, setAuthGuard } from './utils/router.js';
import { initTheme } from './services/theme-service.js';
import { restoreState } from './services/player-service.js';
import { onAuthChange, getUserProfile } from './services/auth-service.js';
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

  setAuthGuard(() => !!currentAuthUser);
  console.log('[Melody] Router mounted');

  // ---------- Restore last playback session (queue + position) ----------
  // Runs in the background; never blocks first paint, and any failure is
  // just logged — a fresh empty player is a safe fallback either way.
  restoreState().catch((err) => {
    console.error('[Melody] Playback state restore failed — starting with an empty player.', err);
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
    currentAuthUser = await waitForFirstAuthState();
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
    currentAuthUser = user;
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
}

function waitForFirstAuthState() {
  return new Promise((resolve) => {
    const unsubscribe = onAuthChange((user) => {
      unsubscribe();
      resolve(user);
    });
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

  // Keep the local mirror in sync so greeting-screen and any offline
  // reads of "nickname" stay correct without a Firestore round-trip.
  setItem('nickname', profile.nickname).catch(() => {});

  const hasSeenGreeting = await getItem('hasSeenGreeting');
  if (!hasSeenGreeting) return 'greeting';

  return 'home';
}

/** Exported for login-screen.js / verify-email-screen.js post-auth redirects. */
export async function resolvePostAuthRoute() {
  return resolveRouteForUser(currentAuthUser);
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
