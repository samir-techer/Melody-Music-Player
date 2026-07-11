/**
 * settings-screen.js
 * The Settings tab. The Home screen's quick theme-cycle button still
 * works (kept, per "don't redesign"), but this is the real Settings
 * screen with an explicit Light/Dark/System picker plus basic library
 * info, matching what the README described as "coming next."
 *
 * Premium (Basic+) sections added here:
 *  - Premium Themes (locked preview for Free, selectable for Basic+)
 *  - Crossfade toggle + duration slider
 *  - Cloud Backup toggle (Favorites/Playlists/Queue/Settings -> Firestore)
 *  - Equalizer presets
 *  - Nickname change (Basic+ only, capped at 2/month)
 * Every one of these follows the same pattern: always visible, locked
 * with a lock icon for accounts that don't qualify, upgrade dialog on tap.
 */

import { getThemeMode, setThemeMode, PREMIUM_THEMES, getSelectedPremiumTheme, setSelectedPremiumTheme } from '../services/theme-service.js';
import { getSongCount, getAllSongs, removeSong } from '../services/library-service.js';
import { getFavoriteIds } from '../services/favorites-service.js';
import {
  getAutoFetchCoverArt, setAutoFetchCoverArt,
  getAutoFetchMetadata, setAutoFetchMetadata,
  scanLibraryForMetadata,
} from '../services/metadata-service.js';
import { attachShell } from './shell.js';
import {
  getCurrentUser, getUserProfile, signOutUser, resendVerificationEmail,
  getNicknameChangeStatus, changeNicknameWithLimit, friendlyAuthError,
} from '../services/auth-service.js';
import {
  hasPremiumAccess, getEffectivePlan, subscribePremium,
} from '../services/premium-service.js';
import {
  setCrossfadeConfig, getCrossfadeConfig, EQ_PRESETS, setEqualizerPreset, getEqualizerPreset,
} from '../services/player-service.js';
import { setCloudBackupActive } from '../services/cloud-backup-service.js';
import { showUpgradeDialog } from '../utils/upgrade-dialog.js';
import { doc, setDoc } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { db } from '../services/firebase-config.js';

const THEME_OPTIONS = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

export async function renderSettingsScreen() {
  const currentMode = await getThemeMode();
  const songCount = await getSongCount().catch(() => 0);
  const favCount = (await getFavoriteIds().catch(() => [])).length;
  const autoFetchCoverArt = await getAutoFetchCoverArt().catch(() => true);
  const autoFetchMetadata = await getAutoFetchMetadata().catch(() => true);

  const authUser = getCurrentUser();
  const profile = authUser ? await getUserProfile(authUser.uid).catch(() => null) : null;
  const isPasswordAccount = authUser?.providerData.some((p) => p.providerId === 'password');
  const isVerified = !isPasswordAccount || authUser?.emailVerified;

  const isBasicPlus = hasPremiumAccess('Basic');
  const effectivePlan = getEffectivePlan();
  const selectedPremiumTheme = authUser ? await getSelectedPremiumTheme(authUser.uid) : null;
  const crossfade = getCrossfadeConfig();
  const eqPreset = getEqualizerPreset();
  const nicknameStatus = authUser ? await getNicknameChangeStatus(authUser.uid) : { used: 0, remaining: 0, limit: 2 };

  const el = document.createElement('div');
  el.className = 'screen settings-screen has-shell';
  el.innerHTML = `
    <header class="screen-header">
      <h1>Settings</h1>
    </header>

    <section class="section">
      <div class="section-heading"><h2>Account</h2></div>
      <div class="settings-list">
        <div class="settings-row">
          <span>Email</span>
          <span class="settings-value">${escapeHtml(authUser?.email || '—')}</span>
        </div>
        <div class="settings-row">
          <span>Plan</span>
          <span class="settings-value">
            ${effectivePlan !== 'Free' ? `<span class="premium-badge">⭐ ${escapeHtml(effectivePlan)}</span>` : escapeHtml(profile?.premiumPlan || 'Free')}
          </span>
        </div>
        <div class="settings-row">
          <span>Role</span>
          <span class="settings-value">${escapeHtml(profile?.role || 'User')}</span>
        </div>
        <div class="settings-row">
          <span>Signed in with</span>
          <span class="settings-value">${escapeHtml(profile?.provider || 'Email')}</span>
        </div>

        <!-- Nickname change — locked for Free, capped 2/month for Basic+ -->
        <div class="settings-row-toggle ${isBasicPlus ? '' : 'settings-row-locked'}" id="nickname-row">
          <div class="settings-row-label">
            <span>Nickname ${isBasicPlus ? '' : '<span class="lock-icon">🔒</span>'}</span>
            <p class="settings-hint-inline">
              ${escapeHtml(profile?.nickname || '—')}${isBasicPlus ? ` · ${nicknameStatus.remaining} of ${nicknameStatus.limit} changes left this month` : ' · Upgrade to Basic to change your nickname later'}
            </p>
          </div>
          <button class="btn-secondary" id="nickname-change-btn" type="button" style="width:auto;" ${isBasicPlus && nicknameStatus.remaining > 0 ? '' : 'disabled'}>Change</button>
        </div>

        ${!isVerified ? `
        <div class="settings-row-toggle" style="padding-top: var(--space-2);">
          <div class="settings-row-label">
            <span>⚠️ Email not verified</span>
            <p class="settings-hint-inline">Verify your email to keep full account access.</p>
          </div>
          <button class="btn-secondary" id="resend-verify-btn" type="button" style="width:auto;">Resend</button>
        </div>` : ''}
      </div>
      <button class="btn-secondary danger" id="logout-btn" type="button">Log Out</button>
    </section>

    <section class="section">
      <button class="settings-list premium-promo" id="premium-promo-btn" type="button">
        <div class="settings-row">
          <span>⭐ Melody Premium</span>
          <span class="settings-value">${effectivePlan !== 'Free' ? escapeHtml(effectivePlan) : 'Preview'} &rsaquo;</span>
        </div>
      </button>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Appearance</h2></div>
      <div class="segmented" id="theme-picker" role="tablist">
        ${THEME_OPTIONS.map((opt) => `
          <button class="segment ${opt.key === currentMode ? 'active' : ''}" data-theme="${opt.key}">${opt.label}</button>
        `).join('')}
      </div>

      <div class="section-heading" style="margin-top: var(--space-4);"><h3>Premium Themes</h3></div>
      <div class="theme-swatch-grid" id="premium-theme-grid">
        <button type="button" class="theme-swatch theme-swatch-default ${!selectedPremiumTheme ? 'active' : ''}" data-theme-key="">
          <div class="theme-swatch-preview"></div>
          <span>Default</span>
        </button>
        ${Object.values(PREMIUM_THEMES).map((theme) => {
          const unlocked = hasPremiumAccess(theme.requiredPlan);
          return `
          <button type="button" class="theme-swatch theme-swatch-${theme.key} ${selectedPremiumTheme === theme.key && unlocked ? 'active' : ''} ${unlocked ? '' : 'locked'}" data-theme-key="${theme.key}" data-required-plan="${theme.requiredPlan}">
            <div class="theme-swatch-preview">${unlocked ? '' : '<span class="lock-icon">🔒</span>'}</div>
            <span>${escapeHtml(theme.label)}</span>
          </button>`;
        }).join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Playback</h2></div>
      <div class="settings-list">
        <div class="settings-row-toggle ${isBasicPlus ? '' : 'settings-row-locked'}" id="crossfade-row">
          <div class="settings-row-label">
            <span>Crossfade ${isBasicPlus ? '' : '<span class="lock-icon">🔒</span>'}</span>
            <p class="settings-hint-inline">${isBasicPlus ? 'Fade between songs instead of a hard cut.' : 'Available with Basic Plan.'}</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-crossfade" ${crossfade.enabled ? 'checked' : ''} ${isBasicPlus ? '' : 'disabled'} />
            <span class="toggle-track"><span class="toggle-thumb-switch"></span></span>
          </label>
        </div>
        <div class="crossfade-slider-row" id="crossfade-slider-row" ${crossfade.enabled && isBasicPlus ? '' : 'hidden'}>
          <input type="range" id="crossfade-duration" min="0" max="5" step="0.5" value="${crossfade.duration}" />
          <span class="crossfade-value" id="crossfade-value">${crossfade.duration}s</span>
        </div>

        <div class="settings-row-toggle ${isBasicPlus ? '' : 'settings-row-locked'}" id="cloud-backup-row">
          <div class="settings-row-label">
            <span>Cloud Backup ${isBasicPlus ? '' : '<span class="lock-icon">🔒</span>'}</span>
            <p class="settings-hint-inline">${isBasicPlus ? 'Sync your Favorites, Playlists, Queue and Settings.' : 'Available with Basic Plan.'}</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-cloud-backup" ${profile?.cloudBackupEnabled ? 'checked' : ''} ${isBasicPlus ? '' : 'disabled'} />
            <span class="toggle-track"><span class="toggle-thumb-switch"></span></span>
          </label>
        </div>
      </div>

      <div class="section-heading" style="margin-top: var(--space-4);"><h3>Equalizer</h3></div>
      <div class="eq-preset-grid" id="eq-preset-grid">
        ${Object.entries(EQ_PRESETS).map(([key, preset]) => {
          const unlocked = hasPremiumAccess(preset.requiredPlan);
          return `<button type="button" class="eq-preset-chip ${eqPreset === key ? 'active' : ''} ${unlocked ? '' : 'locked'}" data-eq-key="${key}" data-required-plan="${preset.requiredPlan}">${unlocked ? '' : '🔒 '}${escapeHtml(preset.label)}</button>`;
        }).join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Your Library</h2></div>
      <div class="settings-list">
        <div class="settings-row">
          <span>Songs</span>
          <span class="settings-value">${songCount}</span>
        </div>
        <div class="settings-row">
          <span>Favorites</span>
          <span class="settings-value">${favCount}</span>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Library &amp; Metadata</h2></div>
      <div class="settings-list">
        <div class="settings-row settings-row-toggle">
          <div class="settings-row-label">
            <span>Auto Fetch Cover Art</span>
            <p class="settings-hint-inline">Look up missing album artwork online when songs are imported.</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-auto-cover-art" ${autoFetchCoverArt ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb-switch"></span></span>
          </label>
        </div>
        <div class="settings-row settings-row-toggle">
          <div class="settings-row-label">
            <span>Auto Fetch Song Metadata</span>
            <p class="settings-hint-inline">Fill in missing genre, year, album, and other tags automatically.</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-auto-metadata" ${autoFetchMetadata ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb-switch"></span></span>
          </label>
        </div>
      </div>
      <button class="btn-secondary" id="scan-library-btn" type="button">Scan Existing Library</button>
      <p class="settings-hint">Applies these settings to songs you already imported. Existing tags and artwork are never overwritten.</p>
      <div class="scan-progress" id="scan-progress" hidden>
        <div class="scan-progress-bar"><div class="scan-progress-fill" id="scan-progress-fill"></div></div>
        <p class="scan-progress-label" id="scan-progress-label">Scanning…</p>
      </div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Storage</h2></div>
      <button class="btn-secondary danger" id="clear-library-btn">Clear Library</button>
      <p class="settings-hint">Removes every imported song from this device. This can't be undone.</p>
    </section>

    <section class="section">
      <div class="section-heading"><h2>About</h2></div>
      <div class="settings-list">
        <div class="settings-row"><span>Melody</span><span class="settings-value">Build Pass 5</span></div>
      </div>
    </section>
  `;

  el.querySelector('#premium-promo-btn').addEventListener('click', async () => {
    const { navigate } = await import('../utils/router.js');
    navigate('premium');
  });

  el.querySelector('#logout-btn').addEventListener('click', async () => {
    if (!window.confirm('Log out of Melody?')) return;
    const { navigate } = await import('../utils/router.js');
    const { showToast } = await import('../utils/toast.js');
    try {
      await signOutUser();
      await navigate('login');
    } catch (err) {
      console.error('[Melody] Logout failed.', err);
      showToast('Couldn\u2019t log out — please try again.');
    }
  });

  el.querySelector('#resend-verify-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const { showToast } = await import('../utils/toast.js');
    btn.disabled = true;
    try {
      await resendVerificationEmail();
      showToast('Verification email resent.');
    } catch (err) {
      console.error('[Melody] Resend verification failed.', err);
      showToast('Couldn\u2019t resend right now — try again shortly.');
    } finally {
      btn.disabled = false;
    }
  });

  el.querySelector('#theme-picker').addEventListener('click', async (e) => {
    const btn = e.target.closest('.segment');
    if (!btn) return;
    await setThemeMode(btn.dataset.theme);
    el.querySelectorAll('.segment').forEach((s) => s.classList.toggle('active', s === btn));
  });

  el.querySelector('#toggle-auto-cover-art').addEventListener('change', async (e) => {
    await setAutoFetchCoverArt(e.target.checked);
  });

  el.querySelector('#toggle-auto-metadata').addEventListener('change', async (e) => {
    await setAutoFetchMetadata(e.target.checked);
  });

  el.querySelector('#scan-library-btn').addEventListener('click', async () => {
    const btn = el.querySelector('#scan-library-btn');
    const progressWrap = el.querySelector('#scan-progress');
    const fill = el.querySelector('#scan-progress-fill');
    const label = el.querySelector('#scan-progress-label');
    const { showToast } = await import('../utils/toast.js');

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Scanning…';
    progressWrap.hidden = false;
    fill.style.width = '0%';
    label.textContent = 'Preparing…';

    try {
      const songs = await getAllSongs();
      if (songs.length === 0) {
        label.textContent = 'No songs in your library yet.';
      } else {
        const summary = await scanLibraryForMetadata(songs, {
          onProgress: (progress) => {
            const pct = Math.round((progress.scanned / progress.total) * 100);
            fill.style.width = `${pct}%`;
            label.textContent = `Scanning ${progress.scanned} of ${progress.total} songs…`;
          },
        });

        const parts = [];
        if (summary.metadataUpdated > 0) {
          parts.push(`${summary.metadataUpdated} song${summary.metadataUpdated === 1 ? '' : 's'} updated`);
        }
        if (summary.coverArtUpdated > 0) {
          parts.push(`${summary.coverArtUpdated} cover${summary.coverArtUpdated === 1 ? '' : 's'} found`);
        }
        label.textContent = parts.length ? `Done — ${parts.join(', ')}.` : 'Done — nothing was missing.';
        showToast(parts.length ? `Library scan complete: ${parts.join(', ')}.` : 'Library scan complete — nothing was missing.');
      }
    } catch (err) {
      console.error('[Melody] Library scan failed.', err);
      label.textContent = 'Scan failed — please try again.';
      showToast('Library scan failed — please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
      setTimeout(() => { progressWrap.hidden = true; }, 2000);
    }
  });

  el.querySelector('#clear-library-btn').addEventListener('click', async () => {
    if (!window.confirm('Remove every song in your library from this device? This cannot be undone.')) return;
    try {
      const songs = await getAllSongs();
      for (const song of songs) {
        await removeSong(song.id);
      }
      const { navigate } = await import('../utils/router.js');
      navigate('settings');
    } catch (err) {
      console.error('[Melody] Settings: failed to clear library.', err);
    }
  });

  /* ---------------------------------------------------------------- */
  /*  Premium: Nickname change (Basic+, capped 2/month)                */
  /* ---------------------------------------------------------------- */
  el.querySelector('#nickname-row').addEventListener('click', (e) => {
    if (isBasicPlus) return;
    if (e.target.closest('#nickname-change-btn')) return;
    showUpgradeDialog('Upgrade to Basic to change your nickname after onboarding.', 'Basic');
  });

  el.querySelector('#nickname-change-btn')?.addEventListener('click', async () => {
    if (!isBasicPlus) {
      showUpgradeDialog('Upgrade to Basic to change your nickname after onboarding.', 'Basic');
      return;
    }
    if (nicknameStatus.remaining <= 0) {
      showUpgradeDialog(`You've used all ${nicknameStatus.limit} nickname changes for this month. Try again next month.`, 'Basic');
      return;
    }
    const next = window.prompt('New nickname', profile?.nickname || '');
    if (!next || !next.trim()) return;
    const { showToast } = await import('../utils/toast.js');
    try {
      await changeNicknameWithLimit(authUser.uid, next.trim());
      showToast('Nickname updated.');
      const { navigate } = await import('../utils/router.js');
      navigate('settings');
    } catch (err) {
      console.error('[Melody] Nickname change failed.', err);
      showToast(err.message || friendlyAuthError(err));
    }
  });

  /* ---------------------------------------------------------------- */
  /*  Premium: Themes                                                   */
  /* ---------------------------------------------------------------- */
  el.querySelector('#premium-theme-grid').addEventListener('click', async (e) => {
    const swatch = e.target.closest('.theme-swatch');
    if (!swatch || !authUser) return;
    const themeKey = swatch.dataset.themeKey || null;
    const requiredPlan = swatch.dataset.requiredPlan;

    if (themeKey && !hasPremiumAccess(requiredPlan)) {
      showUpgradeDialog(`Upgrade to ${requiredPlan} to unlock Premium Themes.`, requiredPlan);
      return;
    }

    await setSelectedPremiumTheme(authUser.uid, themeKey);
    el.querySelectorAll('.theme-swatch').forEach((s) => s.classList.toggle('active', s === swatch));
  });

  /* ---------------------------------------------------------------- */
  /*  Premium: Crossfade                                                */
  /* ---------------------------------------------------------------- */
  el.querySelector('#crossfade-row').addEventListener('click', (e) => {
    if (isBasicPlus) return;
    if (e.target.closest('input')) return;
    showUpgradeDialog('Upgrade to Basic to unlock Crossfade.', 'Basic');
  });

  el.querySelector('#toggle-crossfade').addEventListener('change', async (e) => {
    if (!isBasicPlus) {
      e.target.checked = false;
      showUpgradeDialog('Upgrade to Basic to unlock Crossfade.', 'Basic');
      return;
    }
    const enabled = e.target.checked;
    const duration = Number(el.querySelector('#crossfade-duration').value) || 3;
    setCrossfadeConfig({ enabled, duration });
    el.querySelector('#crossfade-slider-row').hidden = !enabled;
    await setDoc(doc(db, 'users', authUser.uid), { crossfadeEnabled: enabled, crossfadeDuration: duration }, { merge: true });
  });

  el.querySelector('#crossfade-duration').addEventListener('input', (e) => {
    el.querySelector('#crossfade-value').textContent = `${e.target.value}s`;
  });
  el.querySelector('#crossfade-duration').addEventListener('change', async (e) => {
    if (!isBasicPlus) return;
    const duration = Number(e.target.value);
    setCrossfadeConfig({ duration });
    await setDoc(doc(db, 'users', authUser.uid), { crossfadeDuration: duration }, { merge: true });
  });

  /* ---------------------------------------------------------------- */
  /*  Premium: Cloud Backup                                             */
  /* ---------------------------------------------------------------- */
  el.querySelector('#cloud-backup-row').addEventListener('click', (e) => {
    if (isBasicPlus) return;
    if (e.target.closest('input')) return;
    showUpgradeDialog('Upgrade to Basic to unlock Cloud Backup.', 'Basic');
  });

  el.querySelector('#toggle-cloud-backup').addEventListener('change', async (e) => {
    if (!isBasicPlus) {
      e.target.checked = false;
      showUpgradeDialog('Upgrade to Basic to unlock Cloud Backup.', 'Basic');
      return;
    }
    const enabled = e.target.checked;
    await setDoc(doc(db, 'users', authUser.uid), { cloudBackupEnabled: enabled }, { merge: true });
    setCloudBackupActive(authUser.uid, enabled);
    const { showToast } = await import('../utils/toast.js');
    showToast(enabled ? 'Cloud Backup enabled.' : 'Cloud Backup turned off.');
  });

  /* ---------------------------------------------------------------- */
  /*  Premium: Equalizer                                                */
  /* ---------------------------------------------------------------- */
  el.querySelector('#eq-preset-grid').addEventListener('click', (e) => {
    const chip = e.target.closest('.eq-preset-chip');
    if (!chip) return;
    const key = chip.dataset.eqKey;
    const requiredPlan = chip.dataset.requiredPlan;

    if (!hasPremiumAccess(requiredPlan)) {
      showUpgradeDialog(`Upgrade to ${requiredPlan} to unlock Premium Equalizer Presets.`, requiredPlan);
      return;
    }
    setEqualizerPreset(key);
    el.querySelectorAll('.eq-preset-chip').forEach((c) => c.classList.toggle('active', c === chip));
  });

  /* ---------------------------------------------------------------- */
  /*  Re-render if premium status changes while Settings is open        */
  /*  (e.g. expiry passing) so locked/unlocked state never goes stale.  */
  /* ---------------------------------------------------------------- */
  let lastPlan = effectivePlan;
  const unsubscribePremium = subscribePremium((state) => {
    if (state.ready && state.effectivePlan !== lastPlan) {
      lastPlan = state.effectivePlan;
      import('../utils/router.js').then(({ navigate }) => navigate('settings'));
    }
  });

  const unsubscribeShell = attachShell(el, 'settings');
  el._onLeave = () => {
    unsubscribeShell();
    unsubscribePremium();
  };

  return el;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
