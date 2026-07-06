/**
 * app.js
 * Boot sequence for Melody.
 *
 * Every stage is wrapped so a failure in one (a broken import, a blocked
 * IndexedDB upgrade, a settings read that throws, etc.) is logged and
 * skipped rather than left to silently hang the module graph or freeze
 * the page. The Home screen is the guaranteed final fallback: if we
 * cannot even determine where to route, we still render Home rather than
 * show a blank screen.
 *
 * Flow:
 *   1. No nickname stored yet        -> nickname-screen (first launch)
 *   2. Nickname stored, greeting
 *      not yet seen                  -> greeting-screen  (shown once)
 *   3. Nickname + greeting both seen -> home-screen       (every launch after)
 */

import { getItem } from './utils/storage.js';
import { initRouter, registerRoute, navigate } from './utils/router.js';
import { initTheme } from './services/theme-service.js';
import { renderNicknameScreen } from './components/nickname-screen.js';
import { renderGreetingScreen } from './components/greeting-screen.js';
import { renderHomeScreen } from './components/home-screen.js';
import { renderPlayerScreen } from './components/player-screen.js';

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
  registerRoute('nickname', renderNicknameScreen);
  registerRoute('greeting', renderGreetingScreen);
  registerRoute('home', renderHomeScreen);
  registerRoute('player', renderPlayerScreen);
  console.log('[Melody] Router mounted');

  // ---------- Theme / settings ----------
  try {
    await initTheme();
    console.log('[Melody] Settings loaded (theme applied)');
  } catch (err) {
    console.error('[Melody] Settings failed to load — continuing with default theme.', err);
  }

  // ---------- Database + route decision ----------
  let startRoute = 'home'; // safe fallback if anything below throws
  try {
    startRoute = await determineStartRoute();
    console.log(`[Melody] Database initialized — start route resolved to "${startRoute}"`);
  } catch (err) {
    console.error('[Melody] Database/init failed — falling back to Home so the app still opens.', err);
    startRoute = 'home';
  }

  // ---------- Render ----------
  try {
    await navigate(startRoute);
    console.log(`[Melody] ${capitalize(startRoute)} rendered`);
  } catch (err) {
    console.error(`[Melody] Failed to render "${startRoute}" — attempting Home as last resort.`, err);
    if (startRoute !== 'home') {
      try {
        await navigate('home');
        console.log('[Melody] Home rendered (fallback path)');
      } catch (fallbackErr) {
        console.error('[Melody] FATAL: Home screen itself failed to render.', fallbackErr);
        renderCrashFallback(root, fallbackErr);
      }
    } else {
      renderCrashFallback(root, err);
    }
  }

  registerServiceWorker();
}

async function determineStartRoute() {
  const nickname = await getItem('nickname');
  console.log('[Melody] Library check skipped at boot (Home loads its own library data lazily)');
  if (!nickname) return 'nickname';

  const hasSeenGreeting = await getItem('hasSeenGreeting');
  if (!hasSeenGreeting) return 'greeting';

  return 'home';
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
