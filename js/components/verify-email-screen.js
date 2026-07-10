/**
 * verify-email-screen.js
 * Shown right after email/password sign-up (Google accounts are already
 * verified and skip this entirely). Blocks entry to the app until the
 * user confirms the link in their inbox, with a resend option and a
 * manual "I've verified" recheck since Firebase doesn't push verification
 * status changes to an open session automatically.
 */

import { navigate } from '../utils/router.js';
import {
  getCurrentUser,
  refreshCurrentUser,
  resendVerificationEmail,
  signOutUser,
} from '../services/auth-service.js';

export function renderVerifyEmailScreen() {
  const user = getCurrentUser();
  const email = user?.email || 'your email';

  const el = document.createElement('div');
  el.className = 'screen auth-screen';
  el.innerHTML = `
    <div class="auth-card">
      <svg class="auth-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
        <circle cx="50" cy="50" r="48" fill="#141414"/>
        <path d="M28 38h44a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H28a4 4 0 0 1-4-4V42a4 4 0 0 1 4-4Z" stroke="#D4AF6A" stroke-width="2"/>
        <path d="M24 42l26 18 26-18" stroke="#D4AF6A" stroke-width="2" fill="none"/>
      </svg>

      <p class="auth-eyebrow">One more step</p>
      <h1 class="auth-title">Verify your email</h1>
      <p class="auth-subtitle">We sent a verification link to<br/><strong>${escapeHtml(email)}</strong>. Open it, then come back here.</p>

      <p class="auth-error" id="verify-error" role="alert" hidden></p>
      <p class="auth-success" id="verify-success" role="status" hidden></p>

      <button type="button" class="auth-submit-btn" id="ive-verified-btn">
        <span id="verified-label">I've Verified — Continue</span>
        <span class="auth-spinner" id="verified-spinner" hidden></span>
      </button>

      <button type="button" class="auth-switch-btn auth-forgot-cancel" id="resend-btn">Resend Email</button>
      <button type="button" class="auth-switch-btn auth-forgot-cancel" id="signout-btn">Use a different account</button>
    </div>
  `;

  const errorEl = el.querySelector('#verify-error');
  const successEl = el.querySelector('#verify-success');
  const verifiedBtn = el.querySelector('#ive-verified-btn');
  const verifiedLabel = el.querySelector('#verified-label');
  const verifiedSpinner = el.querySelector('#verified-spinner');
  const resendBtn = el.querySelector('#resend-btn');

  verifiedBtn.addEventListener('click', async () => {
    errorEl.hidden = true;
    successEl.hidden = true;
    verifiedBtn.disabled = true;
    verifiedSpinner.hidden = false;
    verifiedLabel.style.opacity = '0';
    try {
      const refreshed = await refreshCurrentUser();
      if (refreshed?.emailVerified) {
        const { resolvePostAuthRoute } = await import('../app.js');
        const nextRoute = await resolvePostAuthRoute();
        await navigate(nextRoute);
        return;
      }
      errorEl.textContent = 'Still not verified — check your inbox (and spam folder) for the link.';
      errorEl.hidden = false;
    } catch (err) {
      console.error('[Melody] Verification recheck failed.', err);
      errorEl.textContent = 'Something went wrong checking your status. Please try again.';
      errorEl.hidden = false;
    } finally {
      verifiedBtn.disabled = false;
      verifiedSpinner.hidden = true;
      verifiedLabel.style.opacity = '1';
    }
  });

  resendBtn.addEventListener('click', async () => {
    errorEl.hidden = true;
    successEl.hidden = true;
    resendBtn.disabled = true;
    try {
      await resendVerificationEmail();
      successEl.textContent = 'Verification email resent.';
      successEl.hidden = false;
    } catch (err) {
      console.error('[Melody] Resend verification failed.', err);
      errorEl.textContent = 'Couldn\u2019t resend right now — please wait a moment and try again.';
      errorEl.hidden = false;
    } finally {
      resendBtn.disabled = false;
    }
  });

  el.querySelector('#signout-btn').addEventListener('click', async () => {
    await signOutUser();
    await navigate('login');
  });

  return el;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
