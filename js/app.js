/**
 * app.js
 * Boot sequence for Melody.
 *
 * Flow:
 *   1. No nickname stored yet        -> nickname-screen (first launch)
 *   2. Nickname stored, greeting
 *      not yet seen                  -> greeting-screen  (shown once)
 *   3. Nickname + greeting both seen -> home-screen       (every launch after)
 */

import { getItem } from './utils/storage.js';
import { initRouter, registerRoute, navigate } from './utils/router.js';
import { renderNicknameScreen } from './components/nickname-screen.js';
import { renderGreetingScreen } from './components/greeting-screen.js';
import { renderHomeScreen } from './components/home-screen.js';

function boot() {
  const root = document.getElementById('app-root');
  initRouter(root);

  registerRoute('nickname', renderNicknameScreen);
  registerRoute('greeting', renderGreetingScreen);
  registerRoute('home', renderHomeScreen);

  determineStartRoute().then((route) => navigate(route));

  registerServiceWorker();
}

async function determineStartRoute() {
  const nickname = await getItem('nickname');
  if (!nickname) return 'nickname';

  const hasSeenGreeting = await getItem('hasSeenGreeting');
  if (!hasSeenGreeting) return 'greeting';

  return 'home';
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', boot);
