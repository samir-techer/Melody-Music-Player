/**
 * profile-screen.js
 * The person's own account hub — separate from Settings (which stays the
 * full app-configuration screen). This is identity-first: photo, name,
 * plan, and quick jumps into the account-related screens that already
 * exist elsewhere (Premium, Purchase History, MP Store, Achievements).
 */

import { navigate } from '../utils/router.js';
import {
  getCurrentUser, getUserProfile, setUserNickname, setUserProfilePhoto, signOutUser,
} from '../services/auth-service.js';
import { getEffectivePlan } from '../services/premium-service.js';
import { getUserItem, setUserItem } from '../utils/storage.js';
import { resizeImageFile } from '../utils/image-resize.js';
import { showToast } from '../utils/toast.js';

export async function renderProfileScreen() {
  const user = getCurrentUser();
  const el = document.createElement('div');
  el.className = 'screen profile-screen';

  let profile = null;
  try {
    profile = user ? await getUserProfile(user.uid) : null;
  } catch (err) {
    console.error('[Melody] Profile: failed to load profile — showing defaults.', err);
  }

  let effectivePlan = 'Free';
  try { effectivePlan = getEffectivePlan(); } catch (err) { console.error('[Melody] Profile: failed to read plan.', err); }

  let notificationsEnabled = true;
  try {
    notificationsEnabled = user ? (await getUserItem(user.uid, 'notificationsEnabled')) !== false : true;
  } catch (err) {
    console.error('[Melody] Profile: failed to load notification preference — defaulting to on.', err);
  }

  const nickname = profile?.nickname || 'friend';
  const email = profile?.email || user?.email || '';
  const photo = profile?.profilePhoto || null;

  el.innerHTML = `
    <div class="profile-header">
      <button class="profile-back" id="profile-back" aria-label="Back">‹</button>
      <span class="profile-header-title">Profile</span>
      <button class="profile-settings-link" id="profile-settings-link" aria-label="Settings">⚙</button>
      <div class="profile-avatar-wrap">
        <div class="profile-avatar" id="profile-avatar">
          ${photo ? `<img src="${photo}" alt="" />` : initialsAvatar(nickname)}
        </div>
        <button class="profile-avatar-edit" id="profile-avatar-edit" aria-label="Change profile photo">📷</button>
        <input type="file" id="profile-avatar-input" accept="image/*" hidden />
      </div>
    </div>

    <div class="profile-name-block">
      <h1>${escapeHtml(nickname)}</h1>
      <p class="profile-plan-line">⭐ ${escapeHtml(effectivePlan)} plan${email ? ` · ${escapeHtml(email)}` : ''}</p>
    </div>

    <section class="section">
      <div class="section-heading"><h2>Account</h2></div>
      <div class="settings-list">
        <button class="settings-row settings-row-link" id="row-personal-data">
          <span>👤 Personal Data</span>
          <span class="settings-value">›</span>
        </button>
        <button class="settings-row settings-row-link" id="row-premium">
          <span>⭐ ${effectivePlan === 'Free' ? 'Go Premium' : 'Manage Plan'}</span>
          <span class="settings-value">›</span>
        </button>
        <button class="settings-row settings-row-link" id="row-purchase-history">
          <span>🧾 Purchase History</span>
          <span class="settings-value">›</span>
        </button>
        <button class="settings-row settings-row-link" id="row-mp-store">
          <span>🛍️ MP Store</span>
          <span class="settings-value">›</span>
        </button>
        <button class="settings-row settings-row-link" id="row-achievements">
          <span>🏆 Achievements</span>
          <span class="settings-value">›</span>
        </button>
      </div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Notifications</h2></div>
      <div class="settings-list">
        <div class="settings-row settings-row-toggle">
          <div class="settings-row-label">
            <span>Enable notifications</span>
            <p class="settings-hint-inline">Applies once the notification center ships — this just saves your preference for now.</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-notifications" ${notificationsEnabled ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb-switch"></span></span>
          </label>
        </div>
      </div>
    </section>

    <section class="section">
      <button class="btn-secondary danger" id="profile-sign-out">Sign Out</button>
    </section>
  `;

  el.querySelector('#profile-back').addEventListener('click', () => navigate('home'));
  el.querySelector('#profile-settings-link').addEventListener('click', () => navigate('settings'));
  el.querySelector('#row-premium').addEventListener('click', () => navigate('premium'));
  el.querySelector('#row-purchase-history').addEventListener('click', () => navigate('purchase-history'));
  el.querySelector('#row-mp-store').addEventListener('click', () => navigate('rewards-store'));
  el.querySelector('#row-achievements').addEventListener('click', () => navigate('achievements'));

  // ---------- Personal Data: lightweight inline edit for now (a full
  // dedicated screen can replace this later) ----------
  el.querySelector('#row-personal-data').addEventListener('click', async () => {
    if (!user) return;
    const next = window.prompt('Your name', nickname);
    if (next === null || !next.trim() || next.trim() === nickname) return;
    try {
      await setUserNickname(user.uid, next.trim());
      await setUserItem(user.uid, 'nickname', next.trim()); // local mirror — matches nickname-screen.js's onboarding write
      showToast('Name updated.');
      navigate('profile'); // re-render with the new name
    } catch (err) {
      console.error('[Melody] Profile: failed to save name.', err);
      showToast('Couldn\u2019t save that — try again.');
    }
  });

  // ---------- Notifications toggle ----------
  el.querySelector('#toggle-notifications').addEventListener('change', async (e) => {
    if (!user) return;
    try {
      await setUserItem(user.uid, 'notificationsEnabled', e.target.checked);
    } catch (err) {
      console.error('[Melody] Profile: failed to save notification preference.', err);
    }
  });

  // ---------- Sign out ----------
  el.querySelector('#profile-sign-out').addEventListener('click', async () => {
    if (!window.confirm('Sign out of Melody?')) return;
    await signOutUser();
    navigate('login');
  });

  // ---------- Avatar upload ----------
  const avatarInput = el.querySelector('#profile-avatar-input');
  el.querySelector('#profile-avatar-edit').addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files?.[0];
    if (!file || !user) return;

    const avatarEl = el.querySelector('#profile-avatar');
    const previousContent = avatarEl.innerHTML;
    avatarEl.innerHTML = '<span class="profile-avatar-loading">…</span>';

    try {
      const dataUrl = await resizeImageFile(file, { maxSize: 256, quality: 0.85 });
      await setUserProfilePhoto(user.uid, dataUrl);
      avatarEl.innerHTML = `<img src="${dataUrl}" alt="" />`;
      showToast('Profile photo updated.');
      // Let Home's header avatar (and anywhere else showing it) pick up
      // the change immediately without needing a full navigation.
      document.dispatchEvent(new CustomEvent('melody:profile-photo-updated', { detail: { dataUrl } }));
    } catch (err) {
      console.error('[Melody] Profile: failed to save photo.', err);
      avatarEl.innerHTML = previousContent;
      showToast(err.message || 'Couldn\u2019t update your photo — try again.');
    } finally {
      avatarInput.value = '';
    }
  });

  return el;
}

function initialsAvatar(name) {
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="profile-avatar-initial">${escapeHtml(initial)}</span>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
