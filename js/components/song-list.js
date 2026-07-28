/**
 * song-list.js
 * A single reusable "song row" renderer + event wiring, shared by Search
 * and Library so both screens look and behave identically.
 *
 * Phase 1/2 additions:
 *  - Multi-select mode (checkboxes + bulk toolbar driven by the caller)
 *  - A dedicated small play button per row, since the row itself now
 *    opens the Music Hub (Phase 2) instead of playing directly
 *  - Optional "Most Played" play-count badge
 */

import { getArtworkUrl } from '../services/artwork-service.js';
import { subscribeFavorites, toggleFavorite } from '../services/favorites-service.js';
import { subscribe as subscribePlayer } from '../services/player-service.js';

export function renderSongListHtml(songs, options = {}) {
  const { selectMode = false, selectedIds = new Set(), showPlayCount = false } = options;

  if (songs.length === 0) {
    return `<div class="empty-state"><p class="title">Nothing here yet</p><p>Songs will show up here once available.</p></div>`;
  }
  return `
    <div class="song-list">
      ${songs.map((song) => `
        <div class="song-row ${selectMode ? 'select-mode' : ''} ${selectedIds.has(song.id) ? 'selected' : ''}" data-id="${song.id}">
          ${selectMode ? `<button class="select-checkbox" data-id="${song.id}" aria-label="Select song">${selectedIds.has(song.id) ? '✓' : ''}</button>` : ''}
          <div class="art">${placeholderArtSvg(song)}</div>
          <div class="info">
            <div class="title">${escapeHtml(song.title)}</div>
            <div class="meta">${escapeHtml(song.artist)}${song.album && song.album !== 'Unknown Album' ? ' · ' + escapeHtml(song.album) : ''}${showPlayCount ? ` · ${song.playCount || 0} plays` : ''}</div>
          </div>
          ${!selectMode ? `
            <button class="row-play-btn" data-id="${song.id}" aria-label="Play now">
              <span class="row-play-icon">▶</span>
              <span class="row-playing-bars" aria-hidden="true"><span></span><span></span><span></span></span>
            </button>
            <button class="favorite-btn" data-id="${song.id}" aria-label="Toggle favorite">♥</button>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Wires row taps, the per-row play button, and favorite-heart taps within
 * `containerEl`. Returns a cleanup function to unsubscribe from favorites
 * updates.
 *
 * options:
 *   onOpen(song)          - row tap when not in select mode (opens Music Hub)
 *   onPlay(songs, index)  - row-play-button tap (plays immediately, full list as queue)
 *   selectMode            - if true, row tap toggles selection instead
 *   onToggleSelect(id)    - called when a row/checkbox is tapped in select mode
 */
export function wireSongList(containerEl, songs, { onOpen, onPlay, selectMode = false, onToggleSelect } = {}) {
  containerEl.querySelectorAll('.song-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.favorite-btn') || e.target.closest('.row-play-btn')) return;
      const id = row.dataset.id;
      if (selectMode) {
        onToggleSelect?.(id);
        return;
      }
      const song = songs.find((s) => s.id === id);
      if (song) onOpen?.(song);
    });
  });

  containerEl.querySelectorAll('.select-checkbox').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggleSelect?.(btn.dataset.id);
    });
  });

  containerEl.querySelectorAll('.row-play-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const songIndex = songs.findIndex((s) => s.id === btn.dataset.id);
      if (songIndex === -1) return;
      onPlay?.(songs, songIndex);
    });
  });

  containerEl.querySelectorAll('.favorite-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite(btn.dataset.id);
    });
  });

  const unsubscribeFavs = subscribeFavorites((favSet) => {
    containerEl.querySelectorAll('.favorite-btn').forEach((btn) => {
      btn.classList.toggle('is-favorite', favSet.has(btn.dataset.id));
    });
  });

  // ---------- Now-playing highlight ----------
  // Marks whichever row matches the currently playing song — works
  // wherever this shared row renderer is used (Library, Music Hub,
  // Search, drilldowns) without each caller having to wire it separately.
  const unsubscribePlayer = subscribePlayer((state) => {
    const playingId = state.currentSong?.id || null;
    containerEl.querySelectorAll('.song-row').forEach((row) => {
      const isThisRow = row.dataset.id === playingId;
      row.classList.toggle('now-playing', isThisRow);
      row.classList.toggle('now-playing-paused', isThisRow && !state.isPlaying);
    });
  });

  // Resolve real embedded/override artwork without blocking initial render.
  songs.forEach((song) => {
    const artEl = containerEl.querySelector(`.song-row[data-id="${song.id}"] .art`);
    if (!artEl) return;
    getArtworkUrl(song).then((url) => {
      if (!url || url.startsWith('data:image/svg+xml')) return;
      artEl.innerHTML = `<img src="${url}" alt="" />`;
    });
  });

  return () => {
    unsubscribeFavs();
    unsubscribePlayer();
  };
}

function placeholderArtSvg(song) {
  const seed = hashSeed(String(song?.id ?? song?.title ?? 'melody'));
  const hue1 = seed % 360;
  const hue2 = (hue1 + 45 + (seed % 40)) % 360;
  return `
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
      <defs>
        <linearGradient id="g${seed}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="hsl(${hue1}, 70%, 55%)" />
          <stop offset="100%" stop-color="hsl(${hue2}, 70%, 45%)" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" fill="url(#g${seed})"/>
      <path d="M62 30 L62 62 A10 10 0 1 1 56 53 L56 40 L44 44 L44 66 A10 10 0 1 1 38 57 L38 34 Z" fill="rgba(255,255,255,0.9)"/>
    </svg>
  `;
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (Math.imul(31, h) + str.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
