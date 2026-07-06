/**
 * time-of-day.js
 * Shared helper so the greeting screen and Home header always agree.
 */

export function getTimeOfDayLabel() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour < 22) return 'Evening';
  return 'Night';
}

export function getTimeOfDayEmoji() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return '☀️';
  if (hour >= 12 && hour < 17) return '☀️';
  if (hour >= 17 && hour < 22) return '🌙';
  return '🌌';
}
