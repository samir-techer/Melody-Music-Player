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
    // transitionend is the normal path, but it can silently never fire
    // (an interrupted transition, prefers-reduced-motion collapsing the
    // duration to ~0 in some browsers, the tab being backgrounded mid-
    // transition, etc.) — and unlike a normal in-flow element, this is a
    // position:fixed, inset:0 overlay, so if it's never removed it just
    // sits there invisible and silently eats every tap on the entire app
    // forever. A timeout fallback guarantees it always gets cleaned up;
    // calling .remove() twice is harmless if transitionend does fire.
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    setTimeout(() => overlay.remove(), 400);
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#upgrade-dialog-cta').addEventListener('click', async () => {
    close();
    const { navigate } = await import('./router.js');
    navigate('premium');
  });
}
