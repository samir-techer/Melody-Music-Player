/**
 * settings-screen.js
 * The Settings tab. The Home screen's quick theme-cycle button still
 * works (kept, per "don't redesign"), but this is the real Settings
 * screen with an explicit Light/Dark/System picker plus basic library
 * info, matching what the README described as "coming next."
 */

import { getThemeMode, setThemeMode } from '../services/theme-service.js';
import { getSongCount, getAllSongs, removeSong } from '../services/library-service.js';
import { getFavoriteIds } from '../services/favorites-service.js';
import { attachShell } from './shell.js';

const THEME_OPTIONS = [
  { key: 'system', label: 'System' },
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
];

export async function renderSettingsScreen() {
  const currentMode = await getThemeMode();
  const songCount = await getSongCount().catch(() => 0);
  const favCount = (await getFavoriteIds().catch(() => [])).length;

  const el = document.createElement('div');
  el.className = 'screen settings-screen has-shell';
  el.innerHTML = `
    <header class="screen-header">
      <h1>Settings</h1>
    </header>

    <section class="section">
      <button class="settings-list premium-promo" id="premium-promo-btn" type="button">
        <div class="settings-row">
          <span>⭐ Melody Premium</span>
          <span class="settings-value">Preview &rsaquo;</span>
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

  el.querySelector('#theme-picker').addEventListener('click', async (e) => {
    const btn = e.target.closest('.segment');
    if (!btn) return;
    await setThemeMode(btn.dataset.theme);
    el.querySelectorAll('.segment').forEach((s) => s.classList.toggle('active', s === btn));
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

  const unsubscribeShell = attachShell(el, 'settings');
  el._onLeave = unsubscribeShell;

  return el;
}
