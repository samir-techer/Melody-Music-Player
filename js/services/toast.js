/**
 * toast.js
 * Small, non-blocking message shown at the bottom of the screen — used
 * for things like "Skipped a song that couldn't be played" without
 * interrupting playback or requiring a dismiss tap.
 *
 * Deliberately a single reused element so rapid messages (e.g. several
 * corrupted files in a row while auto-skipping) queue politely instead
 * of stacking duplicate DOM nodes.
 */

let toastEl = null;
let hideTimer = null;

function ensureToastEl() {
  if (toastEl) return toastEl;
  toastEl = document.createElement('div');
  toastEl.id = 'melody-toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);
  return toastEl;
}

export function showToast(message, duration = 3200) {
  const el = ensureToastEl();
  el.textContent = message;
  el.classList.add('visible');

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, duration);
}
