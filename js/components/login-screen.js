/**
 * login-screen.js
 * The gate every unauthenticated visit lands on. One screen, two modes
 * (Login / Sign Up) toggled without a route change, plus an inline
 * "Forgot password" panel. Premium black theme per the auth spec — this
 * screen intentionally does NOT use the light/dark token palette, since
 * it's meant to look the same regardless of the user's chosen app theme.
 */

import { navigate } from '../utils/router.js';
import {
  signInWithEmail,
  signUpWithEmail,
  signInWithGoogle,
  sendResetPasswordEmail,
  friendlyAuthError,
} from '../services/auth-service.js';

export function renderLoginScreen() {
  const el = document.createElement('div');
  el.className = 'screen auth-screen';
  el.innerHTML = `
    <div class="auth-card">
      <svg class="auth-mark" viewBox="0 0 100 100" fill="none" aria-hidden="true">
        <circle cx="50" cy="50" r="48" fill="#141414"/>
        <circle cx="50" cy="50" r="38" fill="none" stroke="#3a352c" stroke-width="1.2"/>
        <circle cx="50" cy="50" r="28" fill="none" stroke="#3a352c" stroke-width="1.2"/>
        <path d="M52 30 L52 62 A9 9 0 1 1 46 53.5 L46 38 L62 42 L62 34 Z" fill="#D4AF6A"/>
      </svg>

      <p class="auth-eyebrow">Melody</p>
      <h1 class="auth-title" id="auth-title">Welcome back</h1>
      <p class="auth-subtitle" id="auth-subtitle">Log in to sync your music and unlock Premium.</p>

      <button type="button" class="auth-google-btn" id="google-btn">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/>
          <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"/>
          <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z"/>
          <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
        </svg>
        <span>Continue with Google</span>
      </button>

      <div class="auth-divider"><span>or</span></div>

      <form class="auth-form" id="auth-form" novalidate>
        <label class="auth-field">
          <span class="auth-label">Email</span>
          <input class="auth-input" id="email-input" type="email" autocomplete="email" placeholder="you@example.com" required />
        </label>

        <label class="auth-field">
          <span class="auth-label">Password</span>
          <div class="auth-password-wrap">
            <input class="auth-input" id="password-input" type="password" autocomplete="current-password" placeholder="••••••••" minlength="6" required />
            <button type="button" class="auth-eye-btn" id="toggle-password" aria-label="Show password">
              <svg id="eye-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
                <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            </button>
          </div>
        </label>

        <label class="auth-field auth-field-confirm" id="confirm-field" hidden>
          <span class="auth-label">Confirm password</span>
          <input class="auth-input" id="confirm-input" type="password" autocomplete="new-password" placeholder="••••••••" minlength="6" />
        </label>

        <button type="button" class="auth-forgot-link" id="forgot-link">Forgot password?</button>

        <p class="auth-error" id="auth-error" role="alert" hidden></p>

        <button type="submit" class="auth-submit-btn" id="submit-btn">
          <span id="submit-label">Log In</span>
          <span class="auth-spinner" id="submit-spinner" hidden></span>
        </button>
      </form>

      <p class="auth-switch">
        <span id="switch-copy">Don't have an account?</span>
        <button type="button" class="auth-switch-btn" id="switch-mode-btn">Sign Up</button>
      </p>
    </div>

    <!-- Forgot password overlay -->
    <div class="auth-overlay" id="forgot-overlay" hidden>
      <div class="auth-card auth-forgot-card">
        <h1 class="auth-title">Reset your password</h1>
        <p class="auth-subtitle">Enter your account email and we'll send you a reset link.</p>
        <label class="auth-field">
          <span class="auth-label">Email</span>
          <input class="auth-input" id="forgot-email-input" type="email" autocomplete="email" placeholder="you@example.com" />
        </label>
        <p class="auth-error" id="forgot-error" role="alert" hidden></p>
        <p class="auth-success" id="forgot-success" role="status" hidden>Reset email sent — check your inbox.</p>
        <button type="button" class="auth-submit-btn" id="forgot-submit-btn">
          <span id="forgot-submit-label">Send Reset Link</span>
          <span class="auth-spinner" id="forgot-submit-spinner" hidden></span>
        </button>
        <button type="button" class="auth-switch-btn auth-forgot-cancel" id="forgot-cancel-btn">Back to Log In</button>
      </div>
    </div>
  `;

  let mode = 'login'; // 'login' | 'signup'

  const titleEl = el.querySelector('#auth-title');
  const subtitleEl = el.querySelector('#auth-subtitle');
  const confirmField = el.querySelector('#confirm-field');
  const confirmInput = el.querySelector('#confirm-input');
  const submitLabel = el.querySelector('#submit-label');
  const submitSpinner = el.querySelector('#submit-spinner');
  const submitBtn = el.querySelector('#submit-btn');
  const switchCopy = el.querySelector('#switch-copy');
  const switchBtn = el.querySelector('#switch-mode-btn');
  const errorEl = el.querySelector('#auth-error');
  const forgotLink = el.querySelector('#forgot-link');
  const googleBtn = el.querySelector('#google-btn');
  const emailInput = el.querySelector('#email-input');
  const passwordInput = el.querySelector('#password-input');
  const form = el.querySelector('#auth-form');

  function setMode(next) {
    mode = next;
    const isSignup = mode === 'signup';
    titleEl.textContent = isSignup ? 'Create your account' : 'Welcome back';
    subtitleEl.textContent = isSignup
      ? 'Sign up to save your music and unlock Premium.'
      : 'Log in to sync your music and unlock Premium.';
    confirmField.hidden = !isSignup;
    confirmInput.required = isSignup;
    submitLabel.textContent = isSignup ? 'Create Account' : 'Log In';
    switchCopy.textContent = isSignup ? 'Already have an account?' : "Don't have an account?";
    switchBtn.textContent = isSignup ? 'Log In' : 'Sign Up';
    passwordInput.autocomplete = isSignup ? 'new-password' : 'current-password';
    hideError();
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }
  function hideError() {
    errorEl.hidden = true;
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    googleBtn.disabled = loading;
    submitSpinner.hidden = !loading;
    submitLabel.style.opacity = loading ? '0' : '1';
  }

  switchBtn.addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));

  // Password visibility toggle
  el.querySelector('#toggle-password').addEventListener('click', () => {
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    el.querySelector('#toggle-password').setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    el.querySelector('#toggle-password').classList.toggle('is-visible', isHidden);
  });

  googleBtn.addEventListener('click', async () => {
    hideError();
    setLoading(true);
    try {
      await signInWithGoogle();
      await goToNextScreen();
    } catch (err) {
      if (err?.code !== 'auth/popup-closed-by-user' && err?.code !== 'auth/cancelled-popup-request') {
        console.error('[Melody] Google sign-in failed.', err);
      }
      showError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showError('Please fill in both fields.');
      return;
    }
    if (mode === 'signup' && password !== confirmInput.value) {
      showError('Passwords don\u2019t match.');
      return;
    }
    if (mode === 'signup' && password.length < 6) {
      showError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signup') {
        await signUpWithEmail(email, password);
        await navigate('verify-email');
      } else {
        await signInWithEmail(email, password);
        await goToNextScreen();
      }
    } catch (err) {
      console.error(`[Melody] ${mode} failed.`, err);
      showError(friendlyAuthError(err));
    } finally {
      setLoading(false);
    }
  });

  // ---------- Forgot password overlay ----------
  const overlay = el.querySelector('#forgot-overlay');
  const forgotEmailInput = el.querySelector('#forgot-email-input');
  const forgotError = el.querySelector('#forgot-error');
  const forgotSuccess = el.querySelector('#forgot-success');
  const forgotSubmitBtn = el.querySelector('#forgot-submit-btn');
  const forgotSubmitLabel = el.querySelector('#forgot-submit-label');
  const forgotSubmitSpinner = el.querySelector('#forgot-submit-spinner');

  forgotLink.addEventListener('click', () => {
    forgotEmailInput.value = emailInput.value.trim();
    forgotError.hidden = true;
    forgotSuccess.hidden = true;
    overlay.hidden = false;
    requestAnimationFrame(() => forgotEmailInput.focus());
  });

  el.querySelector('#forgot-cancel-btn').addEventListener('click', () => {
    overlay.hidden = true;
  });

  el.querySelector('#forgot-submit-btn').addEventListener('click', async () => {
    const email = forgotEmailInput.value.trim();
    forgotError.hidden = true;
    forgotSuccess.hidden = true;
    if (!email) {
      forgotError.textContent = 'Please enter your email.';
      forgotError.hidden = false;
      return;
    }
    forgotSubmitBtn.disabled = true;
    forgotSubmitSpinner.hidden = false;
    forgotSubmitLabel.style.opacity = '0';
    try {
      await sendResetPasswordEmail(email);
      forgotSuccess.hidden = false;
    } catch (err) {
      console.error('[Melody] Password reset failed.', err);
      forgotError.textContent = friendlyAuthError(err);
      forgotError.hidden = false;
    } finally {
      forgotSubmitBtn.disabled = false;
      forgotSubmitSpinner.hidden = true;
      forgotSubmitLabel.style.opacity = '1';
    }
  });

  async function goToNextScreen() {
    // app.js owns the full "what screen comes after auth" decision tree
    // (verification -> nickname -> greeting -> home) so login doesn't
    // have to duplicate that logic.
    const { resolvePostAuthRoute } = await import('../app.js');
    const nextRoute = await resolvePostAuthRoute();
    await navigate(nextRoute);
  }

  return el;
}
