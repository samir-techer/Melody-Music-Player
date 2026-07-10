/**
 * nickname-screen.js
 * Shown once, right after a brand-new account finishes auth (and email
 * verification, for email/password accounts). Saves the nickname to the
 * user's Firestore profile — Google sign-ins arrive with a display name
 * already, but Melody still asks so the greeting always uses a name the
 * person actually wants to be called.
 */

import { setItem } from '../utils/storage.js';
import { navigate } from '../utils/router.js';
import { getCurrentUser, setUserNickname } from '../services/auth-service.js';

export function renderNicknameScreen() {
  const user = getCurrentUser();
  const suggested = user?.displayName || '';

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
      <p class="hint">You can change this later in Settings.</p>
      <p class="auth-error" id="nickname-error" role="alert" hidden></p>
      <button type="submit" class="btn-primary" id="nickname-submit" disabled>
        Continue →
      </button>
    </form>
  `;

  const input = el.querySelector('#nickname-input');
  const submitBtn = el.querySelector('#nickname-submit');
  const form = el.querySelector('#nickname-form');
  const errorEl = el.querySelector('#nickname-error');

  if (suggested) input.value = suggested;
  submitBtn.disabled = input.value.trim().length === 0;

  input.addEventListener('input', () => {
    submitBtn.disabled = input.value.trim().length === 0;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nickname = input.value.trim();
    if (!nickname) return;

    submitBtn.disabled = true;
    errorEl.hidden = true;
    try {
      const currentUser = getCurrentUser();
      if (currentUser) {
        await setUserNickname(currentUser.uid, nickname);
      }
      await setItem('nickname', nickname); // local mirror for fast/offline reads
      await navigate('greeting');
    } catch (err) {
      console.error('[Melody] Failed to save nickname.', err);
      errorEl.textContent = 'Couldn\u2019t save your nickname — check your connection and try again.';
      errorEl.hidden = false;
      submitBtn.disabled = false;
    }
  });

  // Autofocus feels premium, but don't fight mobile keyboard timing
  requestAnimationFrame(() => input.focus());

  return el;
}
