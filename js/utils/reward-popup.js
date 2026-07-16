/**
 * reward-popup.js
 * The "🏆 Achievement Unlocked +50 MP" banner. Subscribed once from
 * app.js (subscribeAchievementUnlocks) so it fires app-wide, no matter
 * which screen the person is currently on.
 *
 * Popups queue rather than stack — a burst of several achievements
 * unlocking at once (e.g. hitting "Add first favorite" while also
 * crossing "Listen 1 hour") shows them one at a time instead of piling
 * overlapping banners.
 */

let queue = [];
let showing = false;

function ensureContainer() {
  let el = document.getElementById('reward-popup');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'reward-popup';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <span class="reward-popup-icon"></span>
    <span class="reward-popup-text">
      <strong class="reward-popup-title"></strong>
      <span class="reward-popup-mp"></span>
    </span>
  `;
  document.body.appendChild(el);
  return el;
}

function showNext() {
  if (showing || queue.length === 0) return;
  showing = true;

  const { icon, label, mp } = queue.shift();
  const el = ensureContainer();
  el.querySelector('.reward-popup-icon').textContent = icon || '🏆';
  el.querySelector('.reward-popup-title').textContent = label ? `${label} Unlocked` : 'Achievement Unlocked';
  el.querySelector('.reward-popup-mp').textContent = `+${mp} MP`;

  requestAnimationFrame(() => el.classList.add('show'));

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => {
      showing = false;
      showNext();
    }, 320); // matches the CSS exit transition
  }, 2800);
}

/** Call with { icon, label, mp } whenever an achievement/reward fires. */
export function showRewardPopup(payload) {
  queue.push(payload);
  showNext();
}
