/**
 * greeting-screen.js
 * Shown exactly once, immediately after the nickname is captured.
 * Sets "hasSeenGreeting" so it never appears again — app.js checks this
 * flag on every future launch and routes straight to Home instead.
 */

import { getItem, setItem } from '../utils/storage.js';
import { navigate } from '../utils/router.js';
import { getTimeOfDayLabel } from '../utils/time-of-day.js';

export async function renderGreetingScreen() {
  const nickname = (await getItem('nickname')) || 'friend';
  const timeLabel = getTimeOfDayLabel(); // "Morning" | "Afternoon" | "Evening" | "Night"

  const el = document.createElement('div');
  el.className = 'screen greeting-screen';
  el.innerHTML = `
    <svg class="vinyl-decor" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <circle cx="50" cy="50" r="48" fill="#232323"/>
      <circle cx="50" cy="50" r="40" fill="none" stroke="#5c564d" stroke-width="1"/>
      <circle cx="50" cy="50" r="32" fill="none" stroke="#5c564d" stroke-width="1"/>
      <circle cx="50" cy="50" r="24" fill="none" stroke="#5c564d" stroke-width="1"/>
      <circle cx="50" cy="50" r="6" fill="#F5F1EC"/>
    </svg>

    <div class="greeting-body">
      <h1>Good ${timeLabel}, ${escapeHtml(nickname)}.<br/>Welcome to Melody.</h1>
      <p>Every song tells a story. Every melody holds a memory. Every playlist becomes another chapter of your life.</p>
      <p>Whether you're chasing dreams, celebrating victories, finding peace, or healing from heartbreak — music has always been there.</p>
      <p class="emphasis">This is more than a music player. This is your personal soundtrack.</p>
      <p>Take a deep breath. Press play. Enjoy every moment.</p>
    </div>

    <button class="btn-primary" id="start-listening">Start Listening →</button>
  `;

  el.querySelector('#start-listening').addEventListener('click', async () => {
    await setItem('hasSeenGreeting', true);
    await navigate('home');
  });

  return el;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
