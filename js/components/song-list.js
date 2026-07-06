/**
 * song-list.js
 * A single reusable "song row" renderer + event wiring, shared by Search
 * and Library so both screens look and behave identically instead of
 * each re-implementing list rendering, favorite hearts, and art loading.
 */

import { getArtworkUrl } from '../services/artwork-service.js';
import { subscribeFavorites, toggleFavorite } from '../services/favorites-service.js';

export function renderSongListHtml(songs) {
  if (songs.length === 0) {
    return `<div class="empty-state"><p class="title">Nothing here yet</p><p>Songs will show up here once available.</p></div>`;
  }
  return `
    <div class="song-list">
      ${songs.map((song) => `
        <div class="song-row" data-id="${song.id}">
          <div class="art">${placeholderArtSvg()}</div>
          <div class="info">
            <div class="title">${escapeHtml(song.title)}</div>
            <div class="meta">${escapeHtml(song.artist)}${song.album && song.album !== 'Unknown Album' ? ' · ' + escapeHtml(song.album) : ''}</div>
          </div>
          <button class="favorite-btn" data-id="${song.id}" aria-label="Toggle favorite">♥</button>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Wires row taps (play that song, with the full displayed list as the
 * queue) and favorite-heart taps within `containerEl`. Returns a cleanup
 * function to unsubscribe from favorites updates.
 */
export function wireSongList(containerEl, songs, { onPlay } = {}) {
  containerEl.querySelectorAll('.song-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.favorite-btn')) return;
      const songIndex = songs.findIndex((s) => s.id === row.dataset.id);
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

  // Resolve real embedded artwork without blocking initial render.
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
