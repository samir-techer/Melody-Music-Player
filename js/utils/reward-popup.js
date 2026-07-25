/**
 * reward-popup.js
 * Fires the "🏆 Achievement Unlocked +50 MP" style popup (styled by
 * css/achievements.css's .reward-popup rules). A fresh element is created
 * per call and fully removed from the DOM once its fade-out finishes,
 * rather than a single reused/hidden singleton — so overlapping unlocks
 * each get their own popup instead of clobbering one shared node.
 *
 * payload: { icon: string, label: string, mp: number }
 */

const SHOW_MS = 2200;
const FADE_MS = 320;

export function showRewardPopup(payload = {}) {
  const { icon = '🏆', label = '', mp = 0 } = payload;

  const el = document.createElement('div');
  el.className = 'reward-popup';
  const sign = mp > 0 ? '+' : '';
  el.innerHTML = `
    <span class="reward-popup-icon">${icon}</span>
    <span class="reward-popup-text">
      <span class="reward-popup-title">${escapeHtml(label)}</span>
      <span class="reward-popup-mp">${sign}${mp} MP</span>
    </span>
  `;
  document.body.appendChild(el);

  // Force reflow so the class addition below actually transitions in.
  void el.offsetWidth;
  el.classList.add('show');

  setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => el.remove(), FADE_MS);
  }, SHOW_MS);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
