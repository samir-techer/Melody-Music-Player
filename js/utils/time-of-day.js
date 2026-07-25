/**
 * time-of-day.js
 * Powers the "Good Morning ☀️" style greeting on Home and the greeting
 * screen. Buckets are 5–11 Morning, 12–16 Afternoon, 17–20 Evening, else
 * Night, based on the device's local clock.
 */

export function getTimeOfDayLabel() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  if (hour >= 17 && hour < 21) return 'Evening';
  return 'Night';
}

export function getTimeOfDayEmoji() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return '☀️';
  if (hour >= 12 && hour < 17) return '🌤️';
  if (hour >= 17 && hour < 21) return '🌇';
  return '🌙';
}
