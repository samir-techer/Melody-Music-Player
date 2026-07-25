/**
 * confirm-dialog.js
 * General-purpose confirm/info dialogs, styled with the same
 * .premium-modal-overlay / .premium-modal classes premium-screen.js's
 * openComingSoonModal() already uses — no new CSS needed.
 */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function buildOverlay({ emoji, title, message, actionsHtml }) {
  const overlay = document.createElement('div');
  overlay.className = 'premium-modal-overlay';
  overlay.innerHTML = `
    <div class="premium-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
      <div class="modal-emoji">${emoji}</div>
      <h2 id="confirm-dialog-title">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <div class="premium-modal-actions">${actionsHtml}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));
  return overlay;
}

function closeOverlay(overlay) {
  overlay.classList.remove('open');
  overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  setTimeout(() => overlay.remove(), 400); // fallback in case transitionend never fires
}

/**
 * Two-button confirm. Resolves true if the user confirms, false on cancel
 * or backdrop dismiss.
 */
export function showConfirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const overlay = buildOverlay({
      emoji: '⚠️',
      title,
      message,
      actionsHtml: `
        <button type="button" class="btn-modal-primary" id="confirm-dialog-ok">${escapeHtml(confirmLabel)}</button>
        <button type="button" class="btn-modal-secondary" id="confirm-dialog-cancel">${escapeHtml(cancelLabel)}</button>
      `,
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      closeOverlay(overlay);
      resolve(result);
    };

    overlay.querySelector('#confirm-dialog-ok').addEventListener('click', () => finish(true));
    overlay.querySelector('#confirm-dialog-cancel').addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
  });
}

/**
 * Single-button acknowledgement dialog. Resolves once dismissed.
 */
export function showInfoDialog({ title = '', message = '', buttonLabel = 'Got it', emoji = 'ℹ️' } = {}) {
  return new Promise((resolve) => {
    const overlay = buildOverlay({
      emoji,
      title,
      message,
      actionsHtml: `<button type="button" class="btn-modal-primary" id="confirm-dialog-ok">${escapeHtml(buttonLabel)}</button>`,
    });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      closeOverlay(overlay);
      resolve();
    };

    overlay.querySelector('#confirm-dialog-ok').addEventListener('click', finish);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish();
    });
  });
}
