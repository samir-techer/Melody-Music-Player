/**
 * home-screen.js
 * Melody's premium dashboard. Renders the structural shell (header, search,
 * hero "Continue Listening" card, Recently Played / Quick Picks rows,
 * library quick-access grid, MP Store + Premium shortcuts) and wires up
 * real music import + a live library render pulled from IndexedDB.
 *
 * Every data source here is real and already existed elsewhere in the app
 * (library-service, history-service, achievements-service, premium-service)
 * — this file only arranges it into a richer dashboard, it doesn't invent
 * new backend state.
 */

import { getUserItem } from '../utils/storage.js';
import { getTimeOfDayLabel, getTimeOfDayEmoji } from '../utils/time-of-day.js';
import { toggleTheme, getThemeMode } from '../services/theme-service.js';
import { importFiles } from '../services/import-service.js';
import { getAllSongs } from '../services/library-service.js';
import { loadQueue } from '../services/player-service.js';
import { getArtworkUrl } from '../services/artwork-service.js';
import { getRecentlyPlayedEntries } from '../services/history-service.js';
import { navigate } from '../utils/router.js';
import { attachShell } from './shell.js';
import { getCurrentUser, getUserProfile } from '../services/auth-service.js';
import { getEffectivePlan } from '../services/premium-service.js';
import { getMelodyPoints } from '../services/achievements-service.js';

const LIBRARY_LINKS = [
  { key: 'albums', label: 'Albums', icon: '◈' },
  { key: 'artists', label: 'Artists', icon: '♪' },
  { key: 'playlists', label: 'Playlists', icon: '☰' },
  { key: 'folders', label: 'Folders', icon: '▢' },
  { key: 'favorites', label: 'Favorites', icon: '♥' },
  { key: 'recent', label: 'Recently Played', icon: '↻' },
];

export async function renderHomeScreen() {
  let nickname = 'friend';
  let profilePhoto = null;
  try {
    const currentUser = getCurrentUser();
    if (currentUser) {
      nickname = (await getUserItem(currentUser.uid, 'nickname')) || 'friend';
      const profile = await getUserProfile(currentUser.uid).catch(() => null);
      profilePhoto = profile?.profilePhoto || null;
    }
  } catch (err) {
    console.error('[Melody] Home: failed to load nickname/photo — using defaults.', err);
  }

  const timeLabel = getTimeOfDayLabel();
  const emoji = getTimeOfDayEmoji();
  let effectivePlan = 'Free';
  try {
    effectivePlan = getEffectivePlan();
  } catch (err) {
    console.error('[Melody] Home: failed to read plan status — defaulting to Free.', err);
  }
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

  const songById = new Map(songs.map((s) => [s.id, s]));

  // ---------- Continue Listening / Recently Played (real playback history) ----------
  let recentlyPlayedSongs = [];
  try {
    const entries = await getRecentlyPlayedEntries();
    recentlyPlayedSongs = entries.map((e) => songById.get(e.id)).filter(Boolean);
  } catch (err) {
    console.error('[Melody] Home: failed to load play history — continuing without it.', err);
  }
  const continueListeningSong = recentlyPlayedSongs[0] || null;
  const recentlyPlayedRow = recentlyPlayedSongs.slice(1, 11);

  // ---------- Quick Picks: most-played songs, falling back to whatever's
  // newest for a library that's too fresh to have play counts yet. ----------
  const quickPicks = [...songs]
    .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
    .filter((s) => (s.playCount || 0) > 0)
    .slice(0, 10);
  const quickPicksFallback = quickPicks.length ? quickPicks : songs.slice(0, 10);

  const el = document.createElement('div');
  el.className = 'screen home-screen';
  el.innerHTML = `
    <header class="home-header">
      <div class="home-header-row">
        <div>
          <h1>Good ${timeLabel}, ${escapeHtml(nickname)} ${emoji}${badgeHtml}</h1>
          <p class="subline">Let's find your next favorite song.</p>
        </div>
        <div class="home-header-actions">
          <button class="icon-btn" id="notif-bell" aria-label="Notifications" title="Notifications">
            🔔<span class="notif-dot" id="notif-dot" hidden></span>
          </button>
          <button class="icon-btn profile-icon-btn" id="profile-btn" aria-label="Profile" title="Profile">${profilePhoto ? `<img src="${profilePhoto}" alt="" />` : '👤'}</button>
          <button class="theme-toggle" id="theme-toggle" aria-label="Toggle dark mode" title="Toggle appearance">
            ${themeIcon(currentThemeMode)}
          </button>
        </div>
      </div>
      <button class="mp-pill" id="mp-pill" type="button" title="View Achievements">⭐ ${safeMelodyPoints().toLocaleString()} MP</button>
    </header>

    <div class="home-search" role="search" id="home-search-trigger">
      <span aria-hidden="true">⌕</span>
      <input type="search" placeholder="Search songs, artists, albums…" id="home-search-input" readonly />
    </div>

    ${continueListeningSong ? `
    <section class="section" id="section-continue">
      <div class="section-heading"><h2>Continue Listening</h2></div>
      <div class="hero-card" id="continue-hero" data-id="${continueListeningSong.id}">
        <div class="hero-art" id="continue-hero-art">${placeholderArtSvg()}</div>
        <div class="hero-info">
          <p class="hero-eyebrow">Pick up where you left off</p>
          <p class="hero-title">${escapeHtml(continueListeningSong.title)}</p>
          <p class="hero-meta">${escapeHtml(continueListeningSong.artist)}</p>
        </div>
        <button class="hero-play" aria-label="Play">▶</button>
      </div>
    </section>` : ''}

    ${recentlyPlayedRow.length ? `
    <section class="section" id="section-recently-played">
      <div class="section-heading"><h2>Recently Played</h2></div>
      ${renderCardRow(recentlyPlayedRow, 'recently-played-row')}
    </section>` : ''}

    ${quickPicksFallback.length ? `
    <section class="section" id="section-quick-picks">
      <div class="section-heading"><h2>Quick Picks</h2></div>
      ${renderCardRow(quickPicksFallback, 'quick-picks-row')}
    </section>` : ''}

    <section class="section" id="section-recent">
      <div class="section-heading">
        <h2>Recently Added</h2>
        ${songs.length ? '<span class="see-all">See all</span>' : ''}
      </div>
      ${renderCardRow(songs.slice(0, 10), 'recent-row')}
    </section>

    <section class="section" id="section-library">
      <div class="section-heading">
        <h2>Your Library</h2>
      </div>
      <div class="grid-links">
        ${LIBRARY_LINKS.map((l) => `
          <button class="grid-link" data-key="${l.key}">
            <span class="tile-icon" aria-hidden="true">${l.icon}</span>
            <span>${l.label}</span>
          </button>
        `).join('')}
      </div>
    </section>

    <section class="section" id="section-promo">
      <div class="promo-row">
        <button class="promo-card promo-card-store" id="mp-store-shortcut">
          <span class="promo-icon" aria-hidden="true">🛍️</span>
          <span class="promo-label">MP Store</span>
          <span class="promo-sub">Themes &amp; rewards</span>
        </button>
        <button class="promo-card promo-card-premium" id="premium-shortcut">
          <span class="promo-icon" aria-hidden="true">⭐</span>
          <span class="promo-label">Go Premium</span>
          <span class="promo-sub">${effectivePlan === 'Free' ? 'Unlock more' : 'Manage plan'}</span>
        </button>
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

  // ---------- Melody Points quick-glance ----------
  el.querySelector('#mp-pill').addEventListener('click', () => navigate('achievements'));

  // ---------- Notifications / Profile ----------
  el.querySelector('#notif-bell').addEventListener('click', () => navigate('notifications'));
  el.querySelector('#profile-btn').addEventListener('click', () => navigate('profile'));

  // Live unread badge — updates without needing to reopen Home.
  const notifDot = el.querySelector('#notif-dot');
  let unsubscribeNotifications = null;
  {
    const currentUser = getCurrentUser();
    if (currentUser) {
      import('../services/notification-service.js').then(({ subscribeNotifications }) => {
        unsubscribeNotifications = subscribeNotifications(currentUser.uid, ({ unreadCount }) => {
          notifDot.hidden = unreadCount === 0;
        });
      });
    }
  }

  // ---------- MP Store / Premium shortcuts ----------
  el.querySelector('#mp-store-shortcut').addEventListener('click', () => navigate('rewards-store'));
  el.querySelector('#premium-shortcut').addEventListener('click', () => navigate('premium'));

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

    if (summary.imported > 0) {
      const currentUser = getCurrentUser();
      if (currentUser) {
        import('../services/notification-service.js').then(({ addNotification }) => {
          addNotification(currentUser.uid, {
            category: 'system',
            title: `Imported ${summary.imported} song${summary.imported === 1 ? '' : 's'}`,
            body: summary.skipped || summary.failed
              ? `${summary.skipped || 0} skipped, ${summary.failed || 0} failed.`
              : 'All set — they\u2019re in your library now.',
          }).catch((err) => console.error('[Melody] Failed to record import notification.', err));
        });
      }
    }

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
      if (key === 'playlists') {
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

  // ---------- Continue Listening hero ----------
  const heroCard = el.querySelector('#continue-hero');
  if (heroCard) {
    heroCard.addEventListener('click', () => playSongById(heroCard.dataset.id));
    if (continueListeningSong) {
      getArtworkUrl(continueListeningSong).then((url) => {
        if (!url || url.startsWith('data:image/svg+xml')) return;
        el.querySelector('#continue-hero-art').innerHTML = `<img src="${url}" alt="" />`;
      });
    }
  }

  // ---------- Any media-card row: play from the full library queue,
  // positioned at whichever song was tapped. ----------
  function playSongById(id) {
    const idx = songs.findIndex((s) => s.id === id);
    if (idx === -1) return;
    loadQueue(songs, idx);
    navigate('player');
  }

  el.querySelectorAll('.media-card[data-id]').forEach((card) => {
    card.addEventListener('click', () => playSongById(card.dataset.id));
  });

  // Fill in real embedded artwork for every card shelf once resolved,
  // without blocking the initial render (placeholder shows immediately).
  // Deduped so a song appearing in multiple shelves (e.g. also Recently
  // Added) only triggers one artwork lookup.
  const cardSongIds = new Set(
    [...el.querySelectorAll('.media-card[data-id]')].map((c) => c.dataset.id)
  );
  cardSongIds.forEach((id) => {
    const song = songById.get(id);
    if (!song) return;
    getArtworkUrl(song).then((url) => {
      if (!url || url.startsWith('data:image/svg+xml')) return; // keep the crisp inline placeholder
      el.querySelectorAll(`.media-card[data-id="${id}"] .art`).forEach((art) => {
        art.innerHTML = `<img src="${url}" alt="" />`;
      });
    });
  });

  // ---------- Shared bottom nav + mini player ----------
  const unsubscribe = attachShell(el, 'home');

  // Unsubscribe when this screen is navigated away from, so state updates
  // don't keep firing against a detached DOM tree.
  el._onLeave = () => {
    unsubscribe();
    unsubscribeNotifications?.();
  };

  return el;
}

function renderCardRow(songs, rowId) {
  if (songs.length === 0) {
    return `
      <div class="empty-state">
        <p class="title">Nothing here yet</p>
        <p>Songs you import will show up here.</p>
      </div>
    `;
  }

  return `
    <div class="card-row" id="${rowId}">
      ${songs.map((song) => `
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

function safeMelodyPoints() {
  try {
    return getMelodyPoints() || 0;
  } catch (err) {
    console.error('[Melody] Home: failed to read Melody Points — defaulting to 0.', err);
    return 0;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
