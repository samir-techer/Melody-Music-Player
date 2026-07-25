/**
 * elite-startup.js
 * The one-time gold splash shown "when an Elite user opens Melody" and
 * lands on Home (see app.js) — styled entirely by css/elite.css's
 * .elite-startup-* rules, this just builds/mounts the overlay and drives
 * its show -> hold -> fade-out lifecycle.
 */

const HOLD_MS = 1600;
const FADE_MS = 480;

export function showEliteStartupSplash() {
  const overlay = document.createElement('div');
  overlay.className = 'elite-startup-overlay';
  overlay.innerHTML = `
    <div class="elite-startup-mark">✦ Melody Elite</div>
    <div class="elite-startup-sub">Welcome back</div>
  `;
  document.body.appendChild(overlay);

  // Force reflow so adding .show actually transitions in.
  void overlay.offsetWidth;
  overlay.classList.add('show');

  setTimeout(() => {
    overlay.classList.add('fade-out');
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), FADE_MS);
  }, HOLD_MS);
}
