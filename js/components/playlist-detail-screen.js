/**
 * playlist-detail-screen.js
 * One playlist's contents. Reuses song-list.js so it automatically gets
 * the same now-playing highlight, favorite toggle, and artwork loading
 * as Library/Search/Music Hub — no separate implementation to drift out
 * of sync.
 */

import { navigate } from '../utils/router.js';
import {
  getPlaylist, removeSongFromPlaylist, deletePlaylist, renamePlaylist, subscribePlaylists,
} from '../services/playlist-service.js';
import { getAllSongs } from '../services/library-service.js';
import { loadQueue } from '../services/player-service.js';
import { renderSongListHtml, wireSongList } from './song-list.js';
import { showToast } from '../utils/toast.js';

export async function renderPlaylistDetailScreen(params = {}) {
  const el = document.createElement('div');
  el.className = 'screen playlist-detail-screen';

  const playlistId = params.id;
  let playlist = null;
  let allSongs = [];

  try {
    [playlist, allSongs] = await Promise.all([
      getPlaylist(playlistId),
      getAllSongs(),
    ]);
  } catch (err) {
    console.error('[Melody] Playlist detail: failed to load.', err);
  }

  if (!playlist) {
    el.innerHTML = `
      <header class="screen-header"><button class="profile-back" id="pd-back">‹</button><h1>Playlist</h1></header>
      <div class="empty-state"><p class="title">This playlist doesn't exist anymore</p><p>It may have been deleted.</p></div>
    `;
    el.querySelector('#pd-back').addEventListener('click', () => navigate('playlists'));
    return el;
  }

  const songById = new Map(allSongs.map((s) => [s.id, s]));
  let songs = playlist.songIds.map((id) => songById.get(id)).filter(Boolean);

  el.innerHTML = `
    <header class="screen-header playlist-detail-header">
      <button class="profile-back" id="pd-back">‹</button>
      <h1>${escapeHtml(playlist.name)}</h1>
      <div class="playlist-detail-actions">
        <button class="profile-back" id="pd-rename" aria-label="Rename playlist">✏️</button>
        <button class="profile-back" id="pd-delete" aria-label="Delete playlist">🗑️</button>
      </div>
    </header>
    <p class="settings-hint" style="margin-bottom: var(--space-3);">${songs.length} song${songs.length === 1 ? '' : 's'}</p>
    ${songs.length ? `<button class="btn-primary" id="pd-play-all" style="margin-bottom: var(--space-4);">▶ Play All</button>` : ''}
    <div id="pd-song-list"></div>
  `;

  const listEl = el.querySelector('#pd-song-list');
  let unsubscribeList = null;

  function renderList() {
    songs = playlist.songIds.map((id) => songById.get(id)).filter(Boolean);
    listEl.innerHTML = renderSongListHtml(songs);
    if (unsubscribeList) unsubscribeList();
    unsubscribeList = wireSongList(listEl, songs, {
      onOpen: (song) => {
        const idx = songs.findIndex((s) => s.id === song.id);
        loadQueue(songs, idx);
        navigate('player');
      },
      onPlay: (songList, idx) => {
        loadQueue(songList, idx);
        navigate('player');
      },
    });

    // "Remove from this playlist" affordance on long-press-free tap: a
    // small ✕ appended per row, distinct from the shared favorite/play
    // buttons so it doesn't collide with song-list.js's own wiring.
    listEl.querySelectorAll('.song-row').forEach((row) => {
      if (row.querySelector('.playlist-remove-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'playlist-remove-btn';
      btn.setAttribute('aria-label', 'Remove from playlist');
      btn.textContent = '✕';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await removeSongFromPlaylist(playlist.id, row.dataset.id);
        playlist.songIds = playlist.songIds.filter((id) => id !== row.dataset.id);
        showToast('Removed from playlist.');
        renderList();
      });
      row.appendChild(btn);
    });

    const playAllBtn = el.querySelector('#pd-play-all');
    if (playAllBtn) {
      playAllBtn.onclick = () => {
        if (songs.length === 0) return;
        loadQueue(songs, 0);
        navigate('player');
      };
    }
  }

  renderList();

  el.querySelector('#pd-back').addEventListener('click', () => navigate('playlists'));

  el.querySelector('#pd-rename').addEventListener('click', async () => {
    const newName = window.prompt('New playlist name', playlist.name);
    if (!newName || !newName.trim() || newName.trim() === playlist.name) return;
    playlist = await renamePlaylist(playlist.id, newName.trim());
    el.querySelector('.playlist-detail-header h1').textContent = playlist.name;
    showToast('Playlist renamed.');
  });

  el.querySelector('#pd-delete').addEventListener('click', async () => {
    if (!window.confirm(`Delete "${playlist.name}"? This can't be undone.`)) return;
    await deletePlaylist(playlist.id);
    showToast('Playlist deleted.');
    navigate('playlists');
  });

  const unsubscribePlaylists = subscribePlaylists((playlists) => {
    const fresh = playlists.find((p) => p.id === playlistId);
    if (!fresh) { navigate('playlists'); return; }
    playlist = fresh;
    renderList();
  });

  el._onLeave = () => {
    unsubscribeList?.();
    unsubscribePlaylists();
  };

  return el;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
