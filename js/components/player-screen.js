/**
 * player-screen.js
 * The full "Now Playing" screen. Renders once, then updates in place from
 * player-service state changes rather than re-rendering the whole screen,
 * so the seek bar and vinyl animation stay smooth.
 */

import { navigate } from '../utils/router.js';
import { subscribe, togglePlay, next, previous, seek } from '../services/player-service.js';

export async function renderPlayerScreen() {
  const el = document.createElement('div');
  el.className = 'screen player-screen';
  el.innerHTML = `
    <div class="player-topbar">
      <button id="player-back" aria-label="Minimize">︿</button>
      <span class="player-topbar-label">Now Playing</span>
      <span class="player-topbar-spacer" aria-hidden="true"></span>
    </div>

    <div class="vinyl-stage">
      <div class="vinyl-disc" id="vinyl-disc" aria-hidden="true"></div>
      <div class="album-art" id="album-art">
        <img src="" alt="" id="album-art-img" />
      </div>
    </div>

    <div class="now-playing-info">
      <h1 id="now-playing-title">—</h1>
      <p id="now-playing-artist">—</p>
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
      <button id="btn-previous" aria-label="Previous">⏮</button>
      <button id="btn-play-pause" class="play-pause" aria-label="Play or pause">▶</button>
      <button id="btn-next" aria-label="Next">⏭</button>
    </div>
  `;

  const disc = el.querySelector('#vinyl-disc');
  const artImg = el.querySelector('#album-art-img');
  const titleEl = el.querySelector('#now-playing-title');
  const artistEl = el.querySelector('#now-playing-artist');
  const seekBar = el.querySelector('#seek-bar');
  const currentTimeEl = el.querySelector('#current-time');
  const totalDurationEl = el.querySelector('#total-duration');
  const playPauseBtn = el.querySelector('#btn-play-pause');

  let isDraggingSeek = false;

  const unsubscribe = subscribe((state) => {
    const song = state.currentSong;

    titleEl.textContent = song ? song.title : 'Nothing playing';
    artistEl.textContent = song ? song.artist : 'Import some music to get started';
    artImg.src = state.artUrl;
    artImg.alt = song ? `${song.title} album art` : '';

    playPauseBtn.textContent = state.isPlaying ? '⏸' : '▶';
    playPauseBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
    disc.classList.toggle('spinning', state.isPlaying);

    // Don't fight the user's finger while they're dragging the seek bar.
    if (!isDraggingSeek) {
      seekBar.max = state.duration || 0;
      seekBar.value = state.currentTime || 0;
      currentTimeEl.textContent = formatTime(state.currentTime);
      totalDurationEl.textContent = formatTime(state.duration);
    }
  });

  // Clean up the subscription when this screen is navigated away from,
  // so it doesn't keep updating a detached DOM tree forever.
  el._onLeave = unsubscribe;

  el.querySelector('#player-back').addEventListener('click', () => navigate('home'));
  playPauseBtn.addEventListener('click', () => togglePlay());
  el.querySelector('#btn-next').addEventListener('click', () => next());
  el.querySelector('#btn-previous').addEventListener('click', () => previous());

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
