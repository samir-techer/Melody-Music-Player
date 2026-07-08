/**
 * player-screen.js
 * The full "Now Playing" screen. Renders once, then updates in place from
 * player-service state changes rather than re-rendering the whole screen,
 * so the seek bar and vinyl animation stay smooth.
 *
 * Pass 6 additions: synced lyrics (LRCLIB), a crossfading album-art
 * layer, physically-eased vinyl spin-up/spin-down, a filled progress
 * track, a heart "pop" on favoriting, and a Playback Options sheet
 * (Sleep Timer, Playback Speed, Crossfade, Volume Normalization).
 */

import { navigate } from '../utils/router.js';
import {
  subscribe, togglePlay, next, previous, seek,
  toggleShuffle, cycleRepeatMode, playFromQueue, removeFromQueue,
  setPlaybackRate, setCrossfadeSeconds, setVolumeNormalization,
} from '../services/player-service.js';
import { isFavorite, toggleFavorite, subscribeFavorites } from '../services/favorites-service.js';
import { getLyrics, getCachedLyrics } from '../services/lyrics-service.js';
import { startSleepTimer, cancelSleepTimer, subscribeSleepTimer } from '../services/sleep-timer-service.js';

const SPEED_OPTIONS = [0.75, 1, 1.25, 1.5, 2];
const SLEEP_OPTIONS = [0, 15, 30, 45, 60];

export async function renderPlayerScreen() {
  const el = document.createElement('div');
  el.className = 'screen player-screen';
  el.innerHTML = `
    <div class="player-topbar">
      <button id="player-back" aria-label="Minimize">︿</button>
      <span class="player-topbar-label">Now Playing</span>
      <div class="topbar-actions">
        <button id="playback-options-toggle" aria-label="Playback options">⋯</button>
        <button id="queue-toggle" aria-label="Queue">☰</button>
      </div>
    </div>

    <div class="vinyl-stage">
      <div class="vinyl-disc" id="vinyl-disc" aria-hidden="true"></div>
      <div class="album-art" id="album-art">
        <div class="album-art-shadow" aria-hidden="true"></div>
        <div class="album-art-inner" id="album-art-inner">
          <img src="" alt="" id="album-art-img" class="art-layer active" />
          <img src="" alt="" id="album-art-img-prev" class="art-layer" />
        </div>
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

    <div class="lyrics-panel" id="lyrics-panel">
      <div class="lyrics-scroll" id="lyrics-scroll">
        <p class="lyrics-status">No synced lyrics available</p>
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

    <div class="queue-sheet playback-options-sheet" id="playback-options-sheet" hidden>
      <div class="queue-sheet-header">
        <h2>Playback Options</h2>
        <button id="playback-options-close" aria-label="Close playback options">✕</button>
      </div>

      <div class="option-group">
        <div class="option-label">Sleep Timer</div>
        <div class="chip-row" id="sleep-timer-chips">
          ${SLEEP_OPTIONS.map((m) => `<button class="chip" data-minutes="${m}">${m === 0 ? 'Off' : m + 'm'}</button>`).join('')}
        </div>
        <p class="option-hint" id="sleep-timer-hint"></p>
      </div>

      <div class="option-group">
        <div class="option-label">Playback Speed</div>
        <div class="chip-row" id="speed-chips">
          ${SPEED_OPTIONS.map((s) => `<button class="chip" data-speed="${s}">${s}x</button>`).join('')}
        </div>
      </div>

      <div class="option-group">
        <div class="option-label-row">
          <span>Crossfade</span>
          <span class="option-value" id="crossfade-value">Off</span>
        </div>
        <input type="range" id="crossfade-slider" min="0" max="12" step="1" value="0"
               aria-label="Crossfade duration in seconds" />
      </div>

      <div class="option-group">
        <div class="option-row-toggle">
          <span>Volume Normalization</span>
          <button class="switch" id="normalization-toggle" role="switch" aria-checked="false">
            <span class="switch-knob"></span>
          </button>
        </div>
        <p class="option-hint">Levels loud and quiet tracks to a consistent volume.</p>
      </div>

      <div class="option-group">
        <div class="option-row-toggle">
          <span>Gapless Playback</span>
          <span class="option-value">Always on</span>
        </div>
        <p class="option-hint">The next track is queued up ahead of time so there's no gap between songs.</p>
      </div>
    </div>
  `;

  const disc = el.querySelector('#vinyl-disc');
  const artImg = el.querySelector('#album-art-img');
  const artImgPrev = el.querySelector('#album-art-img-prev');
  const albumArtInner = el.querySelector('#album-art-inner');
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
  const lyricsScroll = el.querySelector('#lyrics-scroll');

  const optionsToggle = el.querySelector('#playback-options-toggle');
  const optionsSheet = el.querySelector('#playback-options-sheet');
  const sleepChips = [...el.querySelectorAll('#sleep-timer-chips .chip')];
  const sleepHint = el.querySelector('#sleep-timer-hint');
  const speedChips = [...el.querySelectorAll('#speed-chips .chip')];
  const crossfadeSlider = el.querySelector('#crossfade-slider');
  const crossfadeValue = el.querySelector('#crossfade-value');
  const normToggle = el.querySelector('#normalization-toggle');

  let isDraggingSeek = false;
  let isDraggingCrossfade = false;
  let chosenSleepMinutes = 0;
  let latestState = null;
  let rafId = null;
  let lastKnownAudioTime = 0;
  let lastKnownAt = performance.now();

  // ---------- Vinyl physics: eased spin-up / spin-down instead of an
  // instant on/off CSS animation, so pausing feels like a real turntable
  // decelerating rather than freezing mid-frame. ----------
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const VINYL_TARGET_SPEED = 360 / 3200; // degrees per ms, one turn per ~3.2s
  let vinylAngle = 0;
  let vinylSpeed = 0;
  let lastFrameTime = performance.now();

  function getDisplayTime() {
    if (isDraggingSeek) return Number(seekBar.value);
    if (!latestState) return 0;
    if (latestState.isPlaying) {
      const elapsed = (performance.now() - lastKnownAt) / 1000;
      return Math.min(lastKnownAudioTime + elapsed, latestState.duration || lastKnownAudioTime);
    }
    return latestState.currentTime || 0;
  }

  // ---------- Single RAF loop: smooth seek bar + progress fill + vinyl
  // rotation + lyric highlight, all driven off one shared clock. ----------
  let vinylAtRest = true;
  let lastShownSecond = -1;

  function frameLoop(now) {
    rafId = requestAnimationFrame(frameLoop);
    const dt = Math.min(64, now - lastFrameTime); // clamp so a tab-switch pause doesn't cause a huge jump
    lastFrameTime = now;

    const displayTime = latestState ? getDisplayTime() : 0;

    if (latestState && !isDraggingSeek) {
      seekBar.value = displayTime;
      updateSeekFill(displayTime, latestState.duration);
      const wholeSecond = Math.floor(displayTime);
      if (wholeSecond !== lastShownSecond) {
        lastShownSecond = wholeSecond;
        currentTimeEl.textContent = formatTime(displayTime);
      }
    }

    if (!reduceMotion) {
      const target = (latestState && latestState.isPlaying) ? VINYL_TARGET_SPEED : 0;
      // Skip the write entirely once the disc is fully stopped and staying
      // stopped — no point re-setting an identical transform 60x/sec.
      if (target !== 0 || vinylSpeed !== 0 || !vinylAtRest) {
        const rampMs = target > vinylSpeed ? 700 : 900; // slightly snappier spin-up than spin-down
        const lerp = rampMs > 0 ? Math.min(1, dt / rampMs) : 1;
        vinylSpeed += (target - vinylSpeed) * lerp;
        if (Math.abs(vinylSpeed) < 0.0002 && target === 0) vinylSpeed = 0;
        vinylAngle = (vinylAngle + vinylSpeed * dt) % 360;
        disc.style.transform = `rotate(${vinylAngle}deg)`;
        vinylAtRest = vinylSpeed === 0;
      }
    }

    updateLyricsHighlight(displayTime);
  }
  rafId = requestAnimationFrame(frameLoop);

  function updateSeekFill(value, duration) {
    const pct = duration > 0 ? Math.min(100, Math.max(0, (value / duration) * 100)) : 0;
    seekBar.style.setProperty('--progress', `${pct}%`);
  }

  // ---------- Crossfading album artwork ----------
  let currentArtSrc = null;
  let topLayer = artImg;

  function setAlbumArt(url, alt) {
    if (!url || url === currentArtSrc) return;
    currentArtSrc = url;
    const incoming = topLayer === artImg ? artImgPrev : artImg;
    const outgoing = topLayer;
    incoming.src = url;
    incoming.alt = alt || '';
    requestAnimationFrame(() => {
      incoming.classList.add('active');
      outgoing.classList.remove('active');
    });
    topLayer = incoming;
  }

  // ---------- Synced lyrics ----------
  let currentLyrics = null; // array of {time,text} | null
  let activeLyricIndex = -1;
  let lastLyricsSongId = null;
  let lyricsLoadToken = 0;

  function renderLyricsStatus(message) {
    lyricsScroll.innerHTML = `<p class="lyrics-status">${escapeHtml(message)}</p>`;
    activeLyricIndex = -1;
  }

  function renderLyricsLines() {
    lyricsScroll.innerHTML = currentLyrics
      .map((line, i) => `<p class="lyrics-line" data-index="${i}">${escapeHtml(line.text)}</p>`)
      .join('');
    activeLyricIndex = -1;
  }

  function applyLyricsResult(result, myToken) {
    if (myToken !== lyricsLoadToken) return; // the song changed again before this resolved
    if (result && result.synced && result.synced.length) {
      currentLyrics = result.synced;
      renderLyricsLines();
    } else {
      currentLyrics = null;
      renderLyricsStatus('No synced lyrics available');
    }
  }

  async function loadLyricsFor(song) {
    const myToken = ++lyricsLoadToken;
    currentLyrics = null;
    if (!song) { renderLyricsStatus('No synced lyrics available'); return; }

    const cached = getCachedLyrics(song.id);
    if (cached) { applyLyricsResult(cached, myToken); return; }

    renderLyricsStatus('Loading lyrics…');
    const result = await getLyrics(song);
    applyLyricsResult(result, myToken);
  }

  function updateLyricsHighlight(currentTime) {
    if (!currentLyrics || !currentLyrics.length) return;
    let idx = -1;
    for (let i = 0; i < currentLyrics.length; i++) {
      if (currentLyrics[i].time <= currentTime) idx = i; else break;
    }
    if (idx === activeLyricIndex) return;
    activeLyricIndex = idx;
    const lines = lyricsScroll.querySelectorAll('.lyrics-line');
    lines.forEach((lineEl, i) => lineEl.classList.toggle('active', i === idx));
    if (idx >= 0 && lines[idx]) {
      lines[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  const unsubscribe = subscribe((state) => {
    latestState = state;
    const song = state.currentSong;

    titleEl.textContent = song ? song.title : 'Nothing playing';
    artistEl.textContent = song ? song.artist : 'Import some music to get started';
    setAlbumArt(state.artUrl, song ? `${song.title} album art` : '');

    playPauseBtn.classList.toggle('is-playing', state.isPlaying);
    playPauseBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');

    disc.classList.toggle('spinning', state.isPlaying);
    albumArtInner.classList.toggle('breathing', state.isPlaying);

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
      updateSeekFill(state.currentTime, state.duration);
    }

    renderQueue(state);
    if (song) refreshFavoriteButton(song.id);

    if (song && song.id !== lastLyricsSongId) {
      lastLyricsSongId = song.id;
      loadLyricsFor(song);
    } else if (!song) {
      lastLyricsSongId = null;
      currentLyrics = null;
      renderLyricsStatus('No synced lyrics available');
    }

    // ---------- Playback Options sheet: keep controls in sync with state ----------
    speedChips.forEach((chip) => chip.classList.toggle('active', Number(chip.dataset.speed) === state.playbackRate));
    if (!isDraggingCrossfade) {
      crossfadeSlider.value = state.crossfadeSeconds;
      crossfadeValue.textContent = state.crossfadeSeconds > 0 ? `${state.crossfadeSeconds}s` : 'Off';
    }
    normToggle.classList.toggle('active', state.volumeNormalization);
    normToggle.setAttribute('aria-checked', String(state.volumeNormalization));
  });

  function refreshFavoriteButton(songId) {
    isFavorite(songId).then((fav) => favoriteBtn.classList.toggle('is-favorite', fav));
  }

  const unsubscribeFavs = subscribeFavorites((favSet) => {
    const song = latestState?.currentSong;
    if (song) favoriteBtn.classList.toggle('is-favorite', favSet.has(song.id));
  });

  const unsubscribeSleep = subscribeSleepTimer((sleepState) => {
    sleepChips.forEach((chip) => {
      const m = Number(chip.dataset.minutes);
      const isOffChip = m === 0;
      chip.classList.toggle('active', sleepState.active ? (m === chosenSleepMinutes) : isOffChip);
    });
    if (sleepState.active) {
      const mm = Math.floor(sleepState.remainingSeconds / 60);
      const ss = String(sleepState.remainingSeconds % 60).padStart(2, '0');
      sleepHint.textContent = `Playback will pause in ${mm}:${ss}`;
    } else {
      sleepHint.textContent = '';
      chosenSleepMinutes = 0;
    }
  });

  function renderQueue(state) {
    if (queueSheet.hidden) return; // no need to rebuild DOM while closed
    if (!state.queue.length) {
      queueList.innerHTML = `<div class="empty-state"><p class="title">Queue is empty</p></div>`;
      return;
    }
    queueList.innerHTML = state.queue.map((song, i) => `
      <div class="queue-row ${i === state.index ? 'current' : ''}" data-index="${i}">
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
        playFromQueue(Number(row.dataset.index));
      });
    });
    queueList.querySelectorAll('.queue-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeFromQueue(Number(btn.dataset.index));
      });
    });
  }

  // Clean up the subscriptions when this screen is navigated away from,
  // so it doesn't keep updating a detached DOM tree forever.
  el._onLeave = () => {
    unsubscribe();
    unsubscribeFavs();
    unsubscribeSleep();
    if (rafId) cancelAnimationFrame(rafId);
  };

  el.querySelector('#player-back').addEventListener('click', () => navigate('home'));
  playPauseBtn.addEventListener('click', () => togglePlay());
  el.querySelector('#btn-next').addEventListener('click', () => next());
  el.querySelector('#btn-previous').addEventListener('click', () => previous());
  shuffleBtn.addEventListener('click', () => toggleShuffle());
  repeatBtn.addEventListener('click', () => cycleRepeatMode());

  favoriteBtn.addEventListener('click', async () => {
    const song = latestState?.currentSong;
    if (!song) return;
    const nowFavorite = await toggleFavorite(song.id);
    if (nowFavorite) {
      favoriteBtn.classList.remove('pop');
      void favoriteBtn.offsetWidth; // restart the animation even on rapid re-favoriting
      favoriteBtn.classList.add('pop');
    }
  });

  el.querySelector('#queue-toggle').addEventListener('click', () => {
    queueSheet.hidden = !queueSheet.hidden;
    if (!queueSheet.hidden) { optionsSheet.hidden = true; renderQueue(latestState || { queue: [], index: -1 }); }
  });
  el.querySelector('#queue-close').addEventListener('click', () => { queueSheet.hidden = true; });

  optionsToggle.addEventListener('click', () => {
    optionsSheet.hidden = !optionsSheet.hidden;
    if (!optionsSheet.hidden) queueSheet.hidden = true;
  });
  el.querySelector('#playback-options-close').addEventListener('click', () => { optionsSheet.hidden = true; });

  sleepChips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const minutes = Number(chip.dataset.minutes);
      chosenSleepMinutes = minutes;
      if (minutes === 0) cancelSleepTimer();
      else startSleepTimer(minutes);
    });
  });

  speedChips.forEach((chip) => {
    chip.addEventListener('click', () => setPlaybackRate(Number(chip.dataset.speed)));
  });

  crossfadeSlider.addEventListener('input', () => {
    isDraggingCrossfade = true;
    crossfadeValue.textContent = Number(crossfadeSlider.value) > 0 ? `${crossfadeSlider.value}s` : 'Off';
  });
  crossfadeSlider.addEventListener('change', () => {
    setCrossfadeSeconds(Number(crossfadeSlider.value));
    isDraggingCrossfade = false;
  });

  normToggle.addEventListener('click', () => {
    setVolumeNormalization(!normToggle.classList.contains('active'));
  });

  seekBar.addEventListener('input', () => {
    isDraggingSeek = true;
    currentTimeEl.textContent = formatTime(Number(seekBar.value));
    updateSeekFill(Number(seekBar.value), latestState?.duration || 0);
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
