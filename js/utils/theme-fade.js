/**
 * theme-fade.js
 * Covers the screen with a same-color overlay, runs `applyThemeFn` while
 * hidden behind it, then fades back out — so switching a premium theme or
 * gradient doesn't flash the old colors mid-transition. Matches
 * .theme-switch-fade in css/achievements.css.
 */

const FADE_MS = 180;

export function playThemeSwitchFade(applyThemeFn) {
  const overlay = document.createElement('div');
  overlay.className = 'theme-switch-fade';
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add('peak'));

  setTimeout(async () => {
    try {
      await applyThemeFn();
    } catch (err) {
      console.error('[Melody] playThemeSwitchFade: applyThemeFn threw.', err);
    } finally {
      overlay.classList.remove('peak');
      setTimeout(() => overlay.remove(), FADE_MS);
    }
  }, FADE_MS);
}
