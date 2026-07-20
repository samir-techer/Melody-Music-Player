/**
 * theme-fade.js
 * A brief full-viewport crossfade played across a theme switch. CSS
 * custom properties (how every Premium Theme is applied) don't reliably
 * animate on their own, so instead of fighting that, a themed overlay
 * fades in, the swap happens at the peak (hidden underneath it), then it
 * fades back out — reads as one smooth transition either way.
 */

export function playThemeSwitchFade(applyChange) {
  const overlay = document.createElement('div');
  overlay.className = 'theme-switch-fade';
  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.add('peak');
    setTimeout(() => {
      Promise.resolve(applyChange()).catch((err) => console.error('[Melody] Theme switch failed.', err));
      overlay.classList.remove('peak');
      setTimeout(() => overlay.remove(), 260);
    }, 160);
  });
}
