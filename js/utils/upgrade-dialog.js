/**
 * upgrade-dialog.js
 * The single "Upgrade to <Plan> to unlock this feature." dialog every
 * locked premium control opens on tap (per spec: premium features never
 * disappear — they show, disabled, with a lock icon and this dialog).
 */

export function showUpgradeDialog(message, requiredPlan = 'Basic') {
  const existing = document.querySelector('.upgrade-dialog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'upgrade-dialog-overlay';
  overlay.innerHTML = `
    <div class="upgrade-dialog" role="dialog" aria-modal="true">
      <h2>🔒 ${requiredPlan}+ Feature</h2>
      <p>${message || `Upgrade to ${requiredPlan} to unlock this feature.`}</p>
      <button type="button" id="upgrade-dialog-cta">See Melody Premium</button>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  function close() {
    overlay.classList.remove('open');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#upgrade-dialog-cta').addEventListener('click', async () => {
    close();
    const { navigate } = await import('./router.js');
    navigate('premium');
  });
}
