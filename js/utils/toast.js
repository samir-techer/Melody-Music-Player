/**
 * toast.js
 * Single reused toast element (styled by css/toast.css's #melody-toast
 * rules). One visible toast at a time — a new call replaces whatever's
 * currently showing rather than queuing.
 */

const DEFAULT_DURATION = 2600;
let hideTimer = null;

function getToastEl() {
  let el = document.getElementById('melody-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'melody-toast';
    document.body.appendChild(el);
  }
  return el;
}

/** Shows a brief message at the bottom of the screen. */
export function showToast(message, duration = DEFAULT_DURATION) {
  const el = getToastEl();
  el.textContent = message;

  // Restart the transition cleanly even if a previous toast is mid-fade.
  el.classList.remove('visible');
  // Force reflow so the re-added class re-triggers the CSS transition.
  void el.offsetWidth;
  el.classList.add('visible');

  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, duration);
}
