/**
 * ripple.js
 * Material-style tap ripple for redeem/apply buttons. Matches
 * .ripple-surface / .ripple-effect / the melody-ripple keyframes already
 * defined in css/achievements.css.
 */

export function spawnRipple(target, event) {
  if (!target) return;
  target.classList.add('ripple-surface');

  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const x = (event?.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2;
  const y = (event?.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2;

  const ripple = document.createElement('span');
  ripple.className = 'ripple-effect';
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;

  target.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
  setTimeout(() => ripple.remove(), 650); // fallback in case animationend never fires
}
