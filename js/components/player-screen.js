/**
 * player-screen.js
 * The full "Now Playing" screen. Renders once, then updates in place from
 * player-service state changes rather than re-rendering the whole screen,
 * so the seek bar and vinyl animation stay smooth.
 */

import { navigate } from '../utils/router.js';
import {
  subscribe, togglePlay, next, previous, seek,
  toggleShuffle, cycleRepeatMode, playFromQueue, removeFromQueue, moveInQueue,
} from '../services/player-service.js';
import { isFavorite, toggleFavorite, subscribeFavorites } from '../services/favorites-service.js';
import { hasPremiumAccess } from '../services/premium-service.js';
import { subscribe as subscribeAd } from '../services/ad-manager.js';
import { showUpgradeDialog } from '../utils/upgrade-dialog.js';

export async function renderPlayerScreen() {
  const el = document.createElement('div');
  el.className = 'screen player-screen';
  el.innerHTML = `
    <div class="player-topbar">
      <button id="player-back" aria-label="Minimize">︿</button>
      <span class="player-topbar-label">Now Playing</span>
      <div class="player-topbar-actions">
        <button id="lyrics-toggle" aria-label="Lyrics">Aa</button>
        <button id="queue-toggle" aria-label="Queue">☰</button>
      </div>
    </div>

    <div class="ad-overlay" id="ad-overlay">
      <span class="ad-badge">Advertisement</span>
      <div class="ad-progress-track"><div class="ad-progress-fill" id="ad-progress-fill"></div></div>
      <span class="ad-remaining" id="ad-remaining">0:00</span>
    </div>

    <div class="vinyl-stage">
      <div class="vinyl-disc" id="vinyl-disc" aria-hidden="true"></div>
      <div class="album-art" id="album-art">
        <img src="" alt="" id="album-art-img" />
      </div>
    </div>

    <div class="now-playing-info">
      <div class="now-playing-heading">
        <div>
          <h1 id="now-playing-title">—</h1>
          <p id="now-playing-artist">—</p>
        </div>
        <button class="favorite-btn large" id="favorite-btn" aria-label="Toggle favorite">♥</button>
      </div>
    </div>

    <div class="seek-area">
      <input type="range" id="seek-bar" min="0" max="100" value="0" step="0.1"
             aria-label="Seek" />
      <div class="seek-times">
        <span id="current-time">0:00</span>
        <span id="total-duration">0:00</span>
      </div>
    </div>

    <div class="transport-controls">
      <button id="btn-shuffle" class="secondary-control" aria-label="Shuffle">⤨</button>
      <button id="btn-previous" aria-label="Previous">⏮</button>
      <button id="btn-play-pause" class="play-pause" aria-label="Play or pause">
        <span class="ppicon play-glyph">▶</span><span class="ppicon pause-glyph">⏸</span>
      </button>
      <button id="btn-next" aria-label="Next">⏭</button>
      <button id="btn-repeat" class="secondary-control" aria-label="Repeat">⟲</button>
    </div>

    <div class="queue-sheet" id="queue-sheet" hidden>
      <div class="queue-sheet-header">
        <h2>Up Next</h2>
        <button id="queue-close" aria-label="Close queue">✕</button>
      </div>
      <div class="queue-list" id="queue-list"></div>
    </div>
  `;

  const disc = el.querySelector('#vinyl-disc');
  const artImg = el.querySelector('#album-art-img');
  const albumArt = el.querySelector('#album-art');
  const titleEl = el.querySelector('#now-playing-title');
  const artistEl = el.querySelector('#now-playing-artist');
  const seekBar = el.querySelector('#seek-bar');
  const currentTimeEl = el.querySelector('#current-time');
  const totalDurationEl = el.querySelector('#total-duration');
  const playPauseBtn = el.querySelector('#btn-play-pause');
  const shuffleBtn = el.querySelector('#btn-shuffle');
  const repeatBtn = el.querySelector('#btn-repeat');
  const favoriteBtn = el.querySelector('#favorite-btn');
  const queueSheet = el.querySelector('#queue-sheet');
  const queueList = el.querySelector('#queue-list');
  const adOverlay = el.querySelector('#ad-overlay');
  const adProgressFill = el.querySelector('#ad-progress-fill');
  const adRemaining = el.querySelector('#ad-remaining');

  let isDraggingSeek = false;
  let latestState = null;
  let rafId = null;
  let lastKnownAudioTime = 0;
  let lastKnownAt = performance.now();

  // ---------- Smooth seek bar: interpolate between timeupdate ticks with
  // requestAnimationFrame so the bar glides instead of stepping ~4x/sec. ----------
  function animateSeekBar() {
    rafId = requestAnimationFrame(animateSeekBar);
    if (!latestState || isDraggingSeek || !latestState.isPlaying) return;
    const elapsed = (performance.now() - lastKnownAt) / 1000;
    const estimated = Math.min(lastKnownAudioTime + elapsed, latestState.duration || lastKnownAudioTime);
    seekBar.value = estimated;
    currentTimeEl.textContent = formatTime(estimated);
  }
  rafId = requestAnimationFrame(animateSeekBar);

  const queueToggleBtn = el.querySelector('#queue-toggle');
  const previousBtn = el.querySelector('#btn-previous');
  const nextBtn = el.querySelector('#btn-next');

  // ---------- Ad overlay: badge, progress, remaining time; disables
  // Next/Previous/Seek/Shuffle/Repeat/Queue for the duration of the ad. ----------
  const unsubscribeAd = subscribeAd((adState) => {
    adOverlay.classList.toggle('active', adState.isAdPlaying);
    [shuffleBtn, previousBtn, nextBtn, repeatBtn, seekBar, queueToggleBtn].forEach((ctrl) => {
      ctrl.disabled = adState.isAdPlaying;
    });
    if (adState.isAdPlaying) {
      const pct = adState.duration > 0 ? (adState.currentTime / adState.duration) * 100 : 0;
      adProgressFill.style.width = `${pct}%`;
      adRemaining.textContent = formatTime(Math.max(0, (adState.duration || 0) - adState.currentTime));
    }
  });

  const unsubscribe = subscribe((state) => {
    latestState = state;
    const song = state.currentSong;

    titleEl.textContent = song ? song.title : 'Nothing playing';
    artistEl.textContent = song ? song.artist : 'Import some music to get started';
    artImg.src = state.artUrl;
    artImg.alt = song ? `${song.title} album art` : '';

    playPauseBtn.classList.toggle('is-playing', state.isPlaying);
    playPauseBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');

    // Persist rotation angle across play/pause instead of resetting to 0
    // (animation-play-state keeps the disc's current frame; only the
    // `spinning` class controls whether it advances).
    disc.classList.toggle('spinning', state.isPlaying);
    albumArt.classList.toggle('breathing', state.isPlaying);

    shuffleBtn.classList.toggle('active', state.shuffle);
    repeatBtn.classList.toggle('active', state.repeatMode !== 'off');
    repeatBtn.textContent = state.repeatMode === 'one' ? '⟲¹' : '⟲';

    lastKnownAudioTime = state.currentTime || 0;
    lastKnownAt = performance.now();

    // Don't fight the user's finger while they're dragging the seek bar.
    if (!isDraggingSeek) {
      seekBar.max = state.duration || 0;
      seekBar.value = state.currentTime || 0;
      currentTimeEl.textContent = formatTime(state.currentTime);
      totalDurationEl.textContent = formatTime(state.duration);
    }

    renderQueue(state);
    if (song) refreshFavoriteButton(song.id);
  });

  function refreshFavoriteButton(songId) {
    isFavorite(songId).then((fav) => favoriteBtn.classList.toggle('is-favorite', fav));
  }

  const unsubscribeFavs = subscribeFavorites((favSet) => {
    const song = latestState?.currentSong;
    if (song) favoriteBtn.classList.toggle('is-favorite', favSet.has(song.id));
  });

  function renderQueue(state) {
    if (queueSheet.hidden) return; // no need to rebuild DOM while closed
    if (!state.queue.length) {
      queueList.innerHTML = `<div class="empty-state"><p class="title">Queue is empty</p></div>`;
      return;
    }
    // Queue Reordering is Basic+ (per spec). Free still sees and can play/
    // remove from the queue exactly as before — only drag-to-reorder is
    // new and gated, so nothing existing regresses for Free accounts.
    const canReorder = hasPremiumAccess('Basic');

    queueList.innerHTML = state.queue.map((song, i) => `
      <div class="queue-row ${i === state.index ? 'current' : ''}" data-index="${i}" draggable="${canReorder}">
        ${canReorder ? '<span class="queue-drag-handle" aria-hidden="true">⠿</span>' : '<span class="queue-drag-handle locked" aria-hidden="true">🔒</span>'}
        <div class="info">
          <div class="title">${escapeHtml(song.title)}</div>
          <div class="meta">${escapeHtml(song.artist)}</div>
        </div>
        <button class="queue-remove" data-index="${i}" aria-label="Remove from queue">✕</button>
      </div>
    `).join('');

    queueList.querySelectorAll('.queue-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.queue-remove')) return;
        if (e.target.closest('.queue-drag-handle.locked')) {
          showUpgradeDialog('Upgrade to Basic to reorder your queue by dragging.', 'Basic');
          return;
        }
        playFromQueue(Number(row.dataset.index));
      });

      if (canReorder) {
        row.addEventListener('dragstart', (e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.dataset.index);
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => e.preventDefault());
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          const from = Number(e.dataTransfer.getData('text/plain'));
          const to = Number(row.dataset.index);
          moveInQueue(from, to);
        });
      }
    });
    queueList.querySelectorAll('.queue-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromQueue(Number(btn.dataset.index));
      });
    });
  }

  // Clean up the subscription when this screen is navigated away from,
  // so it doesn't keep updating a detached DOM tree forever.
  el._onLeave = () => {
    unsubscribe();
    unsubscribeFavs();
    unsubscribeAd();
    if (rafId) cancelAnimationFrame(rafId);
  };

  el.querySelector('#player-back').addEventListener('click', () => navigate('home'));
  el.querySelector('#lyrics-toggle').addEventListener('click', () => navigate('lyrics'));
  playPauseBtn.addEventListener('click', () => togglePlay());
  el.querySelector('#btn-next').addEventListener('click', () => next());
  el.querySelector('#btn-previous').addEventListener('click', () => previous());
  shuffleBtn.addEventListener('click', () => toggleShuffle());
  repeatBtn.addEventListener('click', () => cycleRepeatMode());
  favoriteBtn.addEventListener('click', () => {
    const song = latestState?.currentSong;
    if (song) toggleFavorite(song.id);
  });

  el.querySelector('#queue-toggle').addEventListener('click', () => {
    queueSheet.hidden = !queueSheet.hidden;
    if (!queueSheet.hidden && latestState) renderQueue(latestState);
  });
  el.querySelector('#queue-close').addEventListener('click', () => { queueSheet.hidden = true; });

  seekBar.addEventListener('input', () => {
    isDraggingSeek = true;
    currentTimeEl.textContent = formatTime(Number(seekBar.value));
  });
  seekBar.addEventListener('change', () => {
    seek(Number(seekBar.value));
    isDraggingSeek = false;
  });

  return el;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
