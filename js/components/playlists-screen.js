/**
 * playlists-screen.js
 * The missing piece of playlist creation — until now there was a way to
 * *create* a playlist (via playlist-sheet.js) but nowhere to ever see it
 * again afterward. This screen lists every playlist and opens into
 * playlist-detail-screen.js.
 */

import { navigate } from '../utils/router.js';
import { attachShell } from './shell.js';
import { subscribePlaylists, createPlaylist, deletePlaylist } from '../services/playlist-service.js';
import { getAllSongs } from '../services/library-service.js';
import { getArtworkUrl } from '../services/artwork-service.js';
import { showToast } from '../utils/toast.js';

export async function renderPlaylistsScreen() {
  const el = document.createElement('div');
  el.className = 'screen playlists-screen has-shell';

  let songById = new Map();
  try {
    const songs = await getAllSongs();
    songById = new Map(songs.map((s) => [s.id, s]));
  } catch (err) {
    console.error('[Melody] Playlists: failed to load library for cover art.', err);
  }

  el.innerHTML = `
    <header class="screen-header">
      <h1>Playlists</h1>
    </header>
    <button class="btn-primary" id="new-playlist-btn" style="margin-bottom: var(--space-4);">＋ New Playlist</button>
    <div id="playlists-list"></div>
  `;

  const listEl = el.querySelector('#playlists-list');

  function renderList(playlists) {
    if (playlists.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p class="title">No playlists yet</p>
          <p>Create one above, or add a song to a new playlist from Now Playing.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = `
      <div class="song-list">
        ${playlists.map((p) => {
          return `
            <div class="song-row playlist-row" data-id="${p.id}">
              <div class="art">${placeholderArtSvg(p)}</div>
              <div class="info">
                <div class="title">${escapeHtml(p.name)}</div>
                <div class="meta">${p.songIds.length} song${p.songIds.length === 1 ? '' : 's'}</div>
              </div>
              <button class="row-delete-btn" data-id="${p.id}" aria-label="Delete playlist">🗑️</button>
            </div>
          `;
        }).join('')}
      </div>
    `;

    listEl.querySelectorAll('.playlist-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.row-delete-btn')) return;
        navigate('playlist-detail', { id: row.dataset.id });
      });
    });

    listEl.querySelectorAll('.row-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const playlist = playlists.find((p) => p.id === btn.dataset.id);
        if (!playlist) return;
        if (!window.confirm(`Delete "${playlist.name}"? This can't be undone.`)) return;
        await deletePlaylist(playlist.id);
        showToast('Playlist deleted.');
      });
    });

    // Resolve real artwork for whichever playlist rows have a first song.
    playlists.forEach((p) => {
      const firstSong = p.songIds.map((id) => songById.get(id)).find(Boolean);
      if (!firstSong) return;
      getArtworkUrl(firstSong).then((url) => {
        if (!url || url.startsWith('data:image/svg+xml')) return;
        const art = listEl.querySelector(`.playlist-row[data-id="${p.id}"] .art`);
        if (art) art.innerHTML = `<img src="${url}" alt="" />`;
      });
    });
  }

  const unsubscribePlaylists = subscribePlaylists(renderList);

  el.querySelector('#new-playlist-btn').addEventListener('click', async () => {
    const name = window.prompt('Name your playlist');
    if (!name || !name.trim()) return;
    const playlist = await createPlaylist(name.trim());
    showToast(`Created "${playlist.name}".`);
    navigate('playlist-detail', { id: playlist.id });
  });

  const unsubscribeShell = attachShell(el, 'library');
  el._onLeave = () => {
    unsubscribePlaylists();
    unsubscribeShell();
  };

  return el;
}

function placeholderArtSvg(playlist) {
  const seed = hashSeed(String(playlist?.id ?? playlist?.name ?? 'melody'));
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
