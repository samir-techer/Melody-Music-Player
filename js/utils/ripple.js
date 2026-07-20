/**
 * ripple.js
 * A soft Material-style ripple on tap. Call from a click handler with the
 * triggering event and the element to ripple on top of (must have
 * position:relative/absolute and the .ripple-surface class — see
 * css/achievements.css).
 */
export function spawnRipple(target, event) {
  const rect = target.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const x = (event.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2;
  const y = (event.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2;

  const span = document.createElement('span');
  span.className = 'ripple-effect';
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.style.left = `${x}px`;
  span.style.top = `${y}px`;

  target.classList.add('ripple-surface');
  target.appendChild(span);
  span.addEventListener('animationend', () => span.remove(), { once: true });
}
