/**
 * home-screen.js
 * Landing screen after onboarding. Renders the structural shell (header,
 * search, sections, bottom nav, mini player placeholder) and now wires up
 * real music import + a live library render pulled from IndexedDB.
 */

import { getUserItem } from '../utils/storage.js';
import { getTimeOfDayLabel, getTimeOfDayEmoji } from '../utils/time-of-day.js';
import { toggleTheme, getThemeMode } from '../services/theme-service.js';
import { importFiles } from '../services/import-service.js';
import { getAllSongs } from '../services/library-service.js';
import { loadQueue } from '../services/player-service.js';
import { getArtworkUrl } from '../services/artwork-service.js';
import { navigate } from '../utils/router.js';
import { attachShell } from './shell.js';
import { getCurrentUser } from '../services/auth-service.js';
import { getEffectivePlan } from '../services/premium-service.js';

const LIBRARY_LINKS = [
  { key: 'albums', label: 'Albums' },
  { key: 'artists', label: 'Artists' },
  { key: 'playlists', label: 'Playlists' },
  { key: 'folders', label: 'Folders' },
  { key: 'favorites', label: 'Favorites ❤️' },
  { key: 'recent', label: 'Recently Played' },
];

export async function renderHomeScreen() {
  let nickname = 'friend';
  try {
    const currentUser = getCurrentUser();
    nickname = (currentUser && (await getUserItem(currentUser.uid, 'nickname'))) || 'friend';
  } catch (err) {
    console.error('[Melody] Home: failed to load nickname — using default.', err);
  }

  const timeLabel = getTimeOfDayLabel();
  const emoji = getTimeOfDayEmoji();
  const effectivePlan = getEffectivePlan();
  const badgeHtml = effectivePlan !== 'Free'
    ? ` <span class="premium-badge plan-${effectivePlan.toLowerCase()}">⭐ ${escapeHtml(effectivePlan)}</span>`
    : '';

  let currentThemeMode = 'system';
  try {
    currentThemeMode = await getThemeMode();
  } catch (err) {
    console.error('[Melody] Home: failed to load theme mode — using default.', err);
  }

  let songs = [];
  try {
    songs = await getAllSongs();
    console.log(`[Melody] Library loaded (${songs.length} song${songs.length === 1 ? '' : 's'})`);
  } catch (err) {
    console.error('[Melody] Home: failed to load library — rendering with an empty library instead of blocking.', err);
    songs = [];
  }

  const el = document.createElement('div');
  el.className = 'screen home-screen';
  el.innerHTML = `
    <header class="home-header">
      <div class="home-header-row">
        <div>
          <h1>Good ${timeLabel}, ${escapeHtml(nickname)} ${emoji}${badgeHtml}</h1>
          <p class="subline">Let's find your next favorite song.</p>
        </div>
        <button class="theme-toggle" id="theme-toggle" aria-label="Toggle dark mode" title="Toggle appearance">
          ${themeIcon(currentThemeMode)}
        </button>
      </div>
    </header>

    <div class="home-search" role="search" id="home-search-trigger">
      <span aria-hidden="true">⌕</span>
      <input type="search" placeholder="Search songs, artists, albums…" id="home-search-input" readonly />
    </div>

    <section class="section" id="section-recent">
      <div class="section-heading">
        <h2>Recently Added</h2>
        ${songs.length ? '<span class="see-all">See all</span>' : ''}
      </div>
      ${renderRecentRow(songs)}
    </section>

    <section class="section" id="section-library">
      <div class="section-heading">
        <h2>Your Library</h2>
      </div>
      <div class="grid-links">
        ${LIBRARY_LINKS.map((l) => `
          <button class="grid-link" data-key="${l.key}">
            <span class="icon" aria-hidden="true">●</span>
            <span>${l.label}</span>
          </button>
        `).join('')}
      </div>
    </section>

    <section class="section" id="section-import">
      ${songs.length ? `
        <button class="btn-secondary" id="import-btn">＋ Import More Music</button>
      ` : `
        <div class="empty-state">
          <p class="title">Your library is empty</p>
          <p>Tap below to import songs from your device.</p>
          <button class="btn-primary" id="import-btn" style="margin-top: 12px;">Import Music</button>
        </div>
      `}
      <input type="file" id="import-file-input" accept="audio/*,.mp3,.flac,.m4a,.aac,.wav,.ogg" multiple hidden />
      <p class="import-status" id="import-status" hidden></p>
    </section>
  `;

  // ---------- Theme toggle ----------
  const themeBtn = el.querySelector('#theme-toggle');
  themeBtn.addEventListener('click', async () => {
    const newMode = await toggleTheme();
    themeBtn.innerHTML = themeIcon(newMode);
  });

  // ---------- Import wiring ----------
  const fileInput = el.querySelector('#import-file-input');
  const statusEl = el.querySelector('#import-status');

  const wireImportButton = () => {
    const btn = el.querySelector('#import-btn');
    if (btn) btn.addEventListener('click', () => fileInput.click());
  };
  wireImportButton();

  fileInput.addEventListener('change', async () => {
    if (!fileInput.files || fileInput.files.length === 0) return;

    statusEl.hidden = false;
    statusEl.textContent = `Importing ${fileInput.files.length} file${fileInput.files.length > 1 ? 's' : ''}…`;

    const summary = await importFiles(fileInput.files, {
      onDuplicate: async (duplicate, incoming) => {
        // Simple, accessible confirm-based flow for now; a proper modal
        // component can replace this once the shared modal system exists.
        const message =
          `"${incoming.title}" looks like it might already be in your library ` +
          `as "${duplicate.title}". Replace the existing copy?\n\n` +
          `OK = Replace   Cancel = Keep Both`;
        return window.confirm(message) ? 'replace' : 'keep-both';
      },
    });

    statusEl.textContent = summaryMessage(summary);
    fileInput.value = '';

    // Re-render the whole screen so the new songs show up in the sections.
    setTimeout(async () => {
      const { navigate } = await import('../utils/router.js');
      navigate('home');
    }, 900);
  });

  // ---------- Search bar: tap through to the real Search screen ----------
  el.querySelector('#home-search-trigger').addEventListener('click', () => navigate('search'));

  // ---------- Library shortcut buttons ----------
  el.querySelectorAll('.grid-link').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (key === 'playlists' || key === 'folders') {
        alert(`"${btn.textContent.trim()}" is coming in a future build pass.`);
        return;
      }
      if (key === 'recent') {
        navigate('library', { tab: 'recent' });
        return;
      }
      navigate('library', { tab: key });
    });
  });

  // ---------- Tap a song card to start playing it ----------
  const recentSongs = songs.slice(0, 10);
  el.querySelectorAll('.media-card[data-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const songIndex = recentSongs.findIndex((s) => s.id === card.dataset.id);
      if (songIndex === -1) return;
      loadQueue(recentSongs, songIndex);
      navigate('player');
    });
  });

  // Fill in real embedded artwork for recent cards once resolved, without
  // blocking the initial render (placeholder shows immediately).
  recentSongs.forEach((song) => {
    const card = el.querySelector(`.media-card[data-id="${song.id}"] .art`);
    if (!card) return;
    getArtworkUrl(song).then((url) => {
      if (!url || url.startsWith('data:image/svg+xml')) return; // keep the crisp inline placeholder
      card.innerHTML = `<img src="${url}" alt="" />`;
    });
  });

  // ---------- Shared bottom nav + mini player ----------
  const unsubscribe = attachShell(el, 'home');

  // Unsubscribe when this screen is navigated away from, so state updates
  // don't keep firing against a detached DOM tree.
  el._onLeave = unsubscribe;

  return el;
}

function renderRecentRow(songs) {
  if (songs.length === 0) {
    return `
      <div class="empty-state">
        <p class="title">Nothing here yet</p>
        <p>Songs you import will show up here.</p>
      </div>
    `;
  }

  const recent = songs.slice(0, 10);
  return `
    <div class="card-row" id="recent-row">
      ${recent.map((song) => `
        <div class="media-card" data-id="${song.id}">
          <div class="art">${song.coverArt ? '' : placeholderArtSvg()}</div>
          <div class="title">${escapeHtml(song.title)}</div>
          <div class="meta">${escapeHtml(song.artist)} · ${formatDuration(song.duration)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function placeholderArtSvg() {
  return `
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
      <rect width="100" height="100" fill="#EAE3DB"/>
      <circle cx="50" cy="50" r="30" fill="#232323"/>
      <circle cx="50" cy="50" r="6" fill="#F5F1EC"/>
    </svg>
  `;
}

function formatDuration(seconds) {
  if (!seconds) return '--:--';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function summaryMessage(summary) {
  const parts = [];
  if (summary.imported) parts.push(`${summary.imported} imported`);
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  if (summary.failed) parts.push(`${summary.failed} failed`);
  return parts.length ? parts.join(' · ') : 'Nothing to import.';
}

function themeIcon(mode) {
  // Sun for light, moon for dark, half-circle for system
  if (mode === 'dark') return '☾';
  if (mode === 'system') return '◐';
  return '☀';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
