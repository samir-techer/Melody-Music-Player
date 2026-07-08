/**
 * music-hub.js
 * Phase 2 - the detailed page a song opens into from any song list
 * (Songs/Albums/Artists/Genres/Folders/Favorites/Recently Added/Recently
 * Played, and Search). Shows full metadata, file stats, and synced/plain
 * LRCLIB lyrics, plus quick actions and the door into the Metadata Editor.
 */

import { getSong } from '../services/library-service.js';
import { getArtworkUrl } from '../services/artwork-service.js';
import { getLyricsForSong, parseSyncedLyrics } from '../services/lyrics-service.js';
import { subscribeFavorites, toggleFavorite } from '../services/favorites-service.js';
import { loadQueue, subscribe as subscribePlayer } from '../services/player-service.js';
import { openPlaylistSheet } from './playlist-sheet.js';
import { navigate } from '../utils/router.js';
import { attachShell } from './shell.js';
import { showToast } from '../utils/toast.js';

export async function renderMusicHubScreen(params = {}) {
  const songId = params.songId;
  const fromRoute = params.from || 'library';

  const el = document.createElement('div');
  el.className = 'screen music-hub-screen has-shell';

  const song = songId ? await getSong(songId).catch(() => null) : null;

  if (!song) {
    el.innerHTML = `
      <header class="screen-header"><button class="back-link" id="hub-back">‹ Back</button></header>
      <div class="empty-state"><p class="title">Song not found</p><p>It may have been deleted.</p></div>
    `;
    el.querySelector('#hub-back').addEventListener('click', () => navigate(fromRoute));
    const unsub = attachShell(el, fromRoute === 'search' ? 'search' : 'library');
    el._onLeave = unsub;
    return el;
  }

  el.innerHTML = `
    <header class="screen-header hub-header">
      <button class="back-link" id="hub-back">‹ Back</button>
    </header>

    <div class="hub-art-wrap">
      <div class="hub-art" id="hub-art">${placeholderArtSvg()}</div>
      <button class="hub-play-btn" id="hub-play" aria-label="Play"><span>▶</span></button>
    </div>

    <div class="hub-titles">
      <h1>${escapeHtml(song.title)}</h1>
      <p class="hub-artist">${escapeHtml(song.artist)}</p>
    </div>

    <div class="hub-quick-actions">
      <button class="hub-action favorite-btn" id="hub-favorite" aria-label="Toggle favorite">
        <span class="glyph">♥</span><span>Favorite</span>
      </button>
      <button class="hub-action" id="hub-share" aria-label="Share">
        <span class="glyph">↗</span><span>Share</span>
      </button>
      <button class="hub-action" id="hub-playlist" aria-label="Add to playlist">
        <span class="glyph">＋▤</span><span>Playlist</span>
      </button>
      <button class="hub-action" id="hub-edit" aria-label="Edit metadata">
        <span class="glyph">✎</span><span>Edit</span>
      </button>
    </div>

    <div class="hub-details section">
      <h2>Details</h2>
      <div class="hub-detail-grid">
        <div><span class="label">Album</span><span class="value">${escapeHtml(song.album || 'Unknown Album')}</span></div>
        <div><span class="label">Genre</span><span class="value">${escapeHtml(song.genre || '—')}</span></div>
        <div><span class="label">Year</span><span class="value">${escapeHtml(song.year || '—')}</span></div>
        <div><span class="label">Duration</span><span class="value">${formatDuration(song.duration)}</span></div>
        <div><span class="label">Bitrate</span><span class="value">${song.bitrate ? song.bitrate + ' kbps' : '—'}</span></div>
        <div><span class="label">Format</span><span class="value">${escapeHtml(song.format || '—')}</span></div>
        <div><span class="label">File Size</span><span class="value">${formatFileSize(song.fileSize)}</span></div>
        <div><span class="label">Plays</span><span class="value">${song.playCount || 0}</span></div>
      </div>
    </div>

    <div class="hub-lyrics section">
      <h2>Lyrics</h2>
      <div id="hub-lyrics-content" class="hub-lyrics-content">
        <p class="hub-lyrics-loading">Looking up lyrics…</p>
      </div>
    </div>
  `;

  el.querySelector('#hub-back').addEventListener('click', () => navigate(fromRoute));

  // ---------- Artwork ----------
  getArtworkUrl(song).then((url) => {
    if (!url || url.startsWith('data:image/svg+xml')) return;
    el.querySelector('#hub-art').innerHTML = `<img src="${url}" alt="" />`;
  });

  // ---------- Play ----------
  el.querySelector('#hub-play').addEventListener('click', () => {
    loadQueue([song], 0);
    navigate('player');
  });

  // ---------- Favorite ----------
  const favBtn = el.querySelector('#hub-favorite');
  const unsubscribeFav = subscribeFavorites((set) => {
    favBtn.classList.toggle('is-favorite', set.has(song.id));
  });
  favBtn.addEventListener('click', () => toggleFavorite(song.id));

  // ---------- Share ----------
  el.querySelector('#hub-share').addEventListener('click', async () => {
    const text = `${song.title} — ${song.artist}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Melody', text }); return; } catch (err) { if (err?.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied song info to clipboard');
    } catch (err) {
      showToast('Sharing is not supported on this device');
    }
  });

  // ---------- Add to Playlist ----------
  el.querySelector('#hub-playlist').addEventListener('click', () => openPlaylistSheet(song.id));

  // ---------- Edit Metadata ----------
  el.querySelector('#hub-edit').addEventListener('click', () => navigate('metadata-editor', { songId: song.id, from: 'music-hub' }));

  // ---------- Lyrics ----------
  loadLyrics(el, song);

  const unsubscribeShell = attachShell(el, fromRoute === 'search' ? 'search' : 'library');
  el._onLeave = () => {
    unsubscribeFav();
    unsubscribeShell();
  };

  return el;
}

async function loadLyrics(el, song) {
  const contentEl = el.querySelector('#hub-lyrics-content');
  if (!contentEl) return;

  try {
    const result = await getLyricsForSong(song);
    if (!result.found) {
      contentEl.innerHTML = `<p class="hub-lyrics-empty">No lyrics found for this song.</p>`;
      return;
    }
    if (result.syncedLyrics) {
      const lines = parseSyncedLyrics(result.syncedLyrics);
      contentEl.innerHTML = lines.length
        ? `<div class="synced-lyrics">${lines.map((l) => `<p data-time="${l.time}">${escapeHtml(l.text)}</p>`).join('')}</div>`
        : `<p class="hub-lyrics-plain">${escapeHtml(result.plainLyrics || '').split('\n').map(escapeHtml).join('<br/>')}</p>`;
    } else {
      contentEl.innerHTML = `<p class="hub-lyrics-plain">${(result.plainLyrics || '').split('\n').map(escapeHtml).join('<br/>')}</p>`;
    }
  } catch (err) {
    console.error('[Melody] Music Hub: lyrics lookup failed.', err);
    contentEl.innerHTML = `<p class="hub-lyrics-empty">Couldn't load lyrics right now.</p>`;
  }
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function placeholderArtSvg() {
  return `
    <svg viewBox="0 0 200 200" width="100%" height="100%" aria-hidden="true">
      <rect width="200" height="200" fill="#EAE3DB"/>
      <circle cx="100" cy="100" r="60" fill="#232323"/>
      <circle cx="100" cy="100" r="10" fill="#F5F1EC"/>
    </svg>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
