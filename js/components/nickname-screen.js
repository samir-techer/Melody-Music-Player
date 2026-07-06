/**
 * nickname-screen.js
 * First thing a brand-new user ever sees. No accounts, no login —
 * just a name we use to greet them, stored only on this device.
 */

import { setItem } from '../utils/storage.js';
import { navigate } from '../utils/router.js';

export function renderNicknameScreen() {
  const el = document.createElement('div');
  el.className = 'screen onboarding-screen';
  el.innerHTML = `
    <svg class="onboarding-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <circle cx="50" cy="50" r="48" fill="#232323"/>
      <circle cx="50" cy="50" r="38" fill="none" stroke="#5c564d" stroke-width="1.2"/>
      <circle cx="50" cy="50" r="28" fill="none" stroke="#5c564d" stroke-width="1.2"/>
      <path d="M52 30 L52 62 A9 9 0 1 1 46 53.5 L46 38 L62 42 L62 34 Z" fill="#F5F1EC"/>
    </svg>

    <div class="onboarding-copy">
      <p class="eyebrow">Welcome to Melody</p>
      <h1>What should we call you?</h1>
    </div>

    <form class="onboarding-form" id="nickname-form" novalidate>
      <input
        class="text-input"
        id="nickname-input"
        type="text"
        placeholder="Samir"
        maxlength="24"
        autocomplete="off"
        autocapitalize="words"
        required
      />
      <p class="hint">This nickname stays only on this device.</p>
      <button type="submit" class="btn-primary" id="nickname-submit" disabled>
        Continue →
      </button>
    </form>
  `;

  const input = el.querySelector('#nickname-input');
  const submitBtn = el.querySelector('#nickname-submit');
  const form = el.querySelector('#nickname-form');

  input.addEventListener('input', () => {
    submitBtn.disabled = input.value.trim().length === 0;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nickname = input.value.trim();
    if (!nickname) return;

    submitBtn.disabled = true;
    await setItem('nickname', nickname);
    await navigate('greeting');
  });

  // Autofocus feels premium, but don't fight mobile keyboard timing
  requestAnimationFrame(() => input.focus());

  return el;
}
