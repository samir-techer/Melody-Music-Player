/**
 * elite-startup.js
 * "✨ Melody Elite — Welcome back." A brief fade-in/fade-out overlay shown
 * once per app open for Elite accounts. Pure DOM + CSS (see
 * .elite-startup-* rules in css/elite.css) — no framework, no layout
 * shift, and it's appended/removed rather than baked into index.html so
 * it costs nothing for every other plan.
 */

let shown = false; // once per page load — re-navigating within the app never re-triggers it

export function showEliteStartupSplash() {
  if (shown) return;
  shown = true;

  const overlay = document.createElement('div');
  overlay.className = 'elite-startup-overlay';
  overlay.innerHTML = `
    <div class="elite-startup-mark">✨ Melody Elite</div>
    <div class="elite-startup-sub">Welcome back.</div>
  `;
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add('show'));

  // Short and non-blocking by design — the app underneath is already
  // fully rendered and interactive while this plays.
  setTimeout(() => {
    overlay.classList.add('fade-out');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    setTimeout(() => overlay.remove(), 900); // safety net if transitionend never fires
  }, 1400);
}
