/**
 * upgrade-dialog.js
 * The bottom-sheet "Upgrade to unlock this" prompt shown when a Free/lower-
 * plan user taps a gated feature — styled by css/premium.css's
 * .upgrade-dialog-overlay rules. Its CTA sends the user to the Premium
 * screen via the router rather than performing any purchase itself.
 */

import { navigate } from './router.js';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function showUpgradeDialog(message, requiredPlan = 'Premium') {
  const overlay = document.createElement('div');
  overlay.className = 'upgrade-dialog-overlay';
  overlay.innerHTML = `
    <div class="upgrade-dialog" role="dialog" aria-modal="true" aria-labelledby="upgrade-dialog-title">
      <h2 id="upgrade-dialog-title">Upgrade to ${escapeHtml(requiredPlan)}</h2>
      <p>${escapeHtml(message)}</p>
      <button type="button" id="upgrade-dialog-cta">See ${escapeHtml(requiredPlan)} Plans</button>
    </div>
  `;

  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  function close() {
    overlay.classList.remove('open');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    setTimeout(() => overlay.remove(), 400); // fallback in case transitionend never fires
  }

  overlay.querySelector('#upgrade-dialog-cta').addEventListener('click', () => {
    close();
    navigate('premium');
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}
