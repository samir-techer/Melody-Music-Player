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
          <div class="art">${placeholderArtSvg()}</div>
          <div class="info">
            <div class="title">${escapeHtml(song.title)}</div>
            <div class="meta">${escapeHtml(song.artist)}${song.album && song.album !== 'Unknown Album' ? ' · ' + escapeHtml(song.album) : ''}${showPlayCount ? ` · ${song.playCount || 0} plays` : ''}</div>
          </div>
          ${!selectMode ? `
            <button class="row-play-btn" data-id="${song.id}" aria-label="Play now">▶</button>
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

  const unsubscribe = subscribeFavorites((favSet) => {
    containerEl.querySelectorAll('.favorite-btn').forEach((btn) => {
      btn.classList.toggle('is-favorite', favSet.has(btn.dataset.id));
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

  return unsubscribe;
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
