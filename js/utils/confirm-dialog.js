/**
 * confirm-dialog.js
 * A generic Confirm / Cancel bottom-sheet, reusing the same
 * .upgrade-dialog-overlay / .upgrade-dialog markup and CSS
 * (css/premium.css) as upgrade-dialog.js so it re-themes automatically
 * with Crimson Velvet / Royal Navy / Gold Elite like everything else.
 * Used by the Rewards Store before spending MP.
 */

export function showConfirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const existing = document.querySelector('.upgrade-dialog-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'upgrade-dialog-overlay';
    overlay.innerHTML = `
      <div class="upgrade-dialog" role="dialog" aria-modal="true">
        <h2>${title}</h2>
        <p>${message}</p>
        <button type="button" id="confirm-dialog-yes">${confirmLabel}</button>
        <button type="button" id="confirm-dialog-no" style="background:transparent;color:var(--color-text-secondary);margin-top:8px;">${cancelLabel}</button>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    function close(result) {
      overlay.classList.remove('open');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      setTimeout(() => overlay.remove(), 400);
      resolve(result);
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('#confirm-dialog-yes').addEventListener('click', () => close(true));
    overlay.querySelector('#confirm-dialog-no').addEventListener('click', () => close(false));
  });
}

/** Single-button informational variant — e.g. "What does Acoustic Mode do?" */
export function showInfoDialog({ title = '', message = '', buttonLabel = 'Got it' } = {}) {
  return new Promise((resolve) => {
    const existing = document.querySelector('.upgrade-dialog-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'upgrade-dialog-overlay';
    overlay.innerHTML = `
      <div class="upgrade-dialog" role="dialog" aria-modal="true">
        <h2>${title}</h2>
        <p>${message}</p>
        <button type="button" id="info-dialog-ok">${buttonLabel}</button>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    function close() {
      overlay.classList.remove('open');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      setTimeout(() => overlay.remove(), 400);
      resolve();
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#info-dialog-ok').addEventListener('click', close);
  });
}
