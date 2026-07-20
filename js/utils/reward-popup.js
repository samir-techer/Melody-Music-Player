/**
 * reward-popup.js
 * The "🏆 Achievement Unlocked +50 MP" banner. Subscribed once from
 * app.js (subscribeAchievementUnlocks) so it fires app-wide, no matter
 * which screen the person is currently on.
 *
 * Popups queue rather than stack — a burst of several achievements
 * unlocking at once shows them one at a time instead of piling
 * overlapping banners. Each popup element is created fresh and fully
 * removed from the DOM once its fade-out finishes (rather than being
 * reused/hidden), so there's never a stale node left behind.
 *
 * MAX_QUEUE_LENGTH exists purely as a safety net: it caps how far behind
 * the queue can get if something upstream ever re-fires the same
 * unlock repeatedly (that root cause — a Firestore snapshot race that
 * could momentarily "un-complete" an achievement — is fixed in
 * achievements-service.js; this is just a belt-and-suspenders limit so
 * a bug like that can never again look like "a popup stuck forever").
 */

const VISIBLE_MS = 2800;
const FADE_MS = 320;
const MAX_QUEUE_LENGTH = 5;

let queue = [];
let showing = false;

function createPopupElement({ icon, label, mp }) {
  const el = document.createElement('div');
  el.className = 'reward-popup';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <span class="reward-popup-icon">${icon || '🏆'}</span>
    <span class="reward-popup-text">
      <strong class="reward-popup-title">${label ? `${label} Unlocked` : 'Achievement Unlocked'}</strong>
      <span class="reward-popup-mp">${mp >= 0 ? '+' : ''}${mp} MP</span>
    </span>
  `;
  return el;
}

function showNext() {
  if (showing || queue.length === 0) return;
  showing = true;

  const payload = queue.shift();
  const el = createPopupElement(payload);
  document.body.appendChild(el);

  // Two rAFs (not one): the element must be painted in its initial
  // (opacity: 0) state at least once before we add the class that
  // transitions it, or the browser can coalesce both changes into a
  // single frame and skip the fade-in entirely.
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));

  setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    const cleanup = () => {
      el.remove(); // actually gone from the DOM, not just hidden
      showing = false;
      showNext();
    };
    el.addEventListener('transitionend', cleanup, { once: true });
    // Fallback in case transitionend never fires (e.g. the tab was
    // backgrounded and CSS transitions were paused) — guarantees this
    // never gets stuck waiting on an event that might not arrive.
    setTimeout(cleanup, FADE_MS + 200);
  }, VISIBLE_MS);
}

/** Call with { icon, label, mp } whenever an achievement/reward fires. */
export function showRewardPopup(payload) {
  if (queue.length >= MAX_QUEUE_LENGTH) queue.shift(); // drop the oldest, not the newest
  queue.push(payload);
  showNext();
}
