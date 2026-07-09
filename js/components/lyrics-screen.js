/**
 * lyrics-screen.js
 * The premium "Synced Lyrics" experience — a full-screen, Apple Music/
 * Spotify-style companion view for whatever's currently playing:
 *
 *   - Timed (LRC) lyrics from LRCLIB when available, one active line
 *     centered, previous lines faded/receded above, upcoming lines
 *     dimmed below, smooth-scrolling to follow the timeline.
 *   - Tap any line to seek there instantly (with a light haptic tap).
 *   - Falls back to plain scrolling lyrics if LRCLIB has text but no
 *     timing, and to a friendly empty state if it has neither.
 *   - The active line's glow/highlight color is pulled from the album
 *     art's dominant color (artwork-service.getDominantColor), with a
 *     safe fallback to the theme accent everywhere it's used.
 *
 * Always tracks the live player-service queue rather than a fixed song:
 * if the user skips tracks while this screen is open, lyrics reload for
 * the new song automatically, same as the vinyl/art on the Player screen.
 *
 * Performance: highlighting only recomputes when the *active line index*
 * actually changes (checked on each player-service tick, which fires a
 * few times a second on 'timeupdate' — plenty of resolution for lines
 * that are seconds apart). The visual glide between lines is a plain CSS
 * transition on a single `transform`, so it's compositor-driven and free
 * whether or not it's actually animating — no per-frame JS/rAF loop is
 * kept running, so this screen can't compete with audio decoding for
 * main-thread time.
 */

import { navigate } from '../utils/router.js';
import { subscribe, seek } from '../services/player-service.js';
import { getLyricsForSong, parseSyncedLyrics, findActiveLineIndex } from '../services/lyrics-service.js';
import { getSong } from '../services/library-service.js';
import { getDominantColor } from '../services/artwork-service.js';

export async function renderLyricsScreen() {
  const el = document.createElement('div');
  el.className = 'screen lyrics-screen';
  el.innerHTML = `
    <div class="lyrics-topbar">
      <button id="lyrics-back" aria-label="Back to Now Playing">⌄</button>
      <div class="lyrics-topbar-title">
        <p class="eyebrow">Lyrics</p>
        <h2 id="lyrics-song-title">—</h2>
        <p class="lyrics-song-artist" id="lyrics-song-artist"></p>
      </div>
      <span class="lyrics-topbar-spacer" aria-hidden="true"></span>
    </div>
    <div class="lyrics-body" id="lyrics-body"></div>
  `;

  el.querySelector('#lyrics-back').addEventListener('click', () => navigate('player'));

  const bodyEl = el.querySelector('#lyrics-body');
  const titleEl = el.querySelector('#lyrics-song-title');
  const artistEl = el.querySelector('#lyrics-song-artist');

  let loadedSongId = null;
  let lines = [];        // parsed synced lines: [{ time, text }, ...]
  let lineEls = [];       // cached DOM refs, parallel to `lines`
  let lineOffsets = [];   // cached vertical center per line, measured once per song
  let activeIndex = -1;
  let loadToken = 0;      // guards against a song change superseding an in-flight fetch
  let resizeScheduled = false;

  // ---------- Loading a song's lyrics ----------

  async function loadForSong(song) {
    const myToken = ++loadToken;
    loadedSongId = song.id;
    lines = [];
    lineEls = [];
    lineOffsets = [];
    activeIndex = -1;

    titleEl.textContent = song.title || 'Untitled';
    artistEl.textContent = song.artist || '';
    el.style.removeProperty('--lyrics-glow-color');

    bodyEl.innerHTML = `
      <div class="lyrics-loading">
        <div class="lyrics-spinner" aria-hidden="true"></div>
        <p>Finding lyrics…</p>
      </div>
    `;

    // Best-effort, never blocks the lyrics themselves from showing.
    getDominantColor(song).then((color) => {
      if (myToken !== loadToken || !color) return;
      el.style.setProperty('--lyrics-glow-color', color);
    });

    let result = { found: false, plainLyrics: null, syncedLyrics: null };
    try {
      // Re-fetch the song record fresh so we pick up any lyrics already
      // cached to IndexedDB by a previous visit (the in-memory queue copy
      // won't have that field set unless it was loaded after the cache write).
      const freshSong = await getSong(song.id).catch(() => null);
      result = await getLyricsForSong(freshSong || song);
    } catch (err) {
      console.error('[Melody] Lyrics screen: lookup failed.', err);
    }
    if (myToken !== loadToken) return; // a track change already superseded this

    if (result.syncedLyrics) {
      const parsed = parseSyncedLyrics(result.syncedLyrics);
      if (parsed.length > 0) {
        renderSyncedLyrics(parsed);
        return;
      }
    }
    if (result.plainLyrics) {
      renderPlainLyrics(result.plainLyrics);
      return;
    }
    renderEmptyState();
  }

  function renderEmptyState() {
    bodyEl.innerHTML = `
      <div class="lyrics-empty">
        <div class="lyrics-empty-icon" aria-hidden="true">🎤</div>
        <p class="title">Lyrics not available</p>
        <p>We couldn't find lyrics for this song.</p>
      </div>
    `;
  }

  function renderPlainLyrics(text) {
    bodyEl.innerHTML = `
      <div class="lyrics-plain-wrap">
        <p class="lyrics-plain-note">Synced lyrics aren't available for this song — here are the full lyrics.</p>
        <div class="lyrics-plain">${text.split('\n').map(escapeHtml).join('<br/>')}</div>
      </div>
    `;
  }

  function renderSyncedLyrics(parsedLines) {
    lines = parsedLines;
    bodyEl.innerHTML = `
      <div class="lyrics-viewport" id="lyrics-viewport">
        <div class="lyrics-track" id="lyrics-track">
          ${lines.map((l) => `
            <button type="button" class="lyrics-line">
              <span class="lyrics-line-glow" aria-hidden="true"></span>
              <span class="lyrics-eq" aria-hidden="true"><i></i><i></i><i></i></span>
              <span class="lyrics-line-text">${escapeHtml(l.text) || '&hellip;'}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;

    lineEls = Array.from(bodyEl.querySelectorAll('.lyrics-line'));
    lineEls.forEach((lineEl, i) => {
      lineEl.addEventListener('click', () => {
        // seek() notifies synchronously, so the active line updates (and
        // glides there) as an immediate, direct result of this tap.
        seek(lines[i].time);
        vibrate();
      });
    });

    measureLineOffsets();
    applyActiveIndex({ instant: true });
  }

  // ---------- Centering / highlighting ----------

  function measureLineOffsets() {
    lineOffsets = lineEls.map((lineEl) => lineEl.offsetTop + lineEl.offsetHeight / 2);
  }

  function applyActiveIndex({ instant = false } = {}) {
    const viewport = bodyEl.querySelector('#lyrics-viewport');
    const track = bodyEl.querySelector('#lyrics-track');
    if (!viewport || !track) return;

    lineEls.forEach((lineEl, i) => {
      const isActive = i === activeIndex;
      lineEl.classList.toggle('is-active', isActive);
      lineEl.classList.toggle('is-past', i < activeIndex);
      lineEl.classList.toggle('is-future', i > activeIndex);
      if (isActive) lineEl.setAttribute('aria-current', 'true');
      else lineEl.removeAttribute('aria-current');
    });

    const translateY = activeIndex >= 0 && lineOffsets[activeIndex] !== undefined
      ? viewport.clientHeight / 2 - lineOffsets[activeIndex]
      : 0;

    if (instant) track.style.transition = 'none';
    track.style.transform = `translateY(${translateY}px)`;
    if (instant) {
      void track.offsetHeight; // force reflow so "none" actually applies before re-enabling
      track.style.transition = '';
    }

    updatePlayingClass();
  }

  function updatePlayingClass() {
    const isPlaying = Boolean(latestState?.isPlaying);
    lineEls.forEach((lineEl, i) => {
      lineEl.classList.toggle('is-playing', isPlaying && i === activeIndex);
    });
  }

  // ---------- Player-service tracking ----------

  let latestState = null;

  function handleStateTick(state) {
    const wasPlaying = latestState?.isPlaying;
    latestState = state;

    if (!state.currentSong) {
      loadedSongId = null;
      lines = []; lineEls = []; lineOffsets = []; activeIndex = -1;
      bodyEl.innerHTML = `
        <div class="lyrics-empty">
          <div class="lyrics-empty-icon" aria-hidden="true">🎤</div>
          <p class="title">Nothing playing</p>
          <p>Play a song to see its lyrics here.</p>
        </div>
      `;
      titleEl.textContent = '—';
      artistEl.textContent = '';
      return;
    }

    if (state.currentSong.id !== loadedSongId) {
      loadForSong(state.currentSong);
      return;
    }

    if (lines.length === 0) return; // plain/empty/loading states don't track time

    const idx = findActiveLineIndex(lines, state.currentTime || 0);
    if (idx !== activeIndex) {
      activeIndex = idx;
      applyActiveIndex();
    } else if (wasPlaying !== state.isPlaying) {
      updatePlayingClass();
    }
  }

  function vibrate() {
    if (navigator.vibrate) {
      try { navigator.vibrate(12); } catch (err) { /* unsupported/blocked — ignore */ }
    }
  }

  function handleResize() {
    if (resizeScheduled || lineEls.length === 0) return;
    resizeScheduled = true;
    requestAnimationFrame(() => {
      resizeScheduled = false;
      measureLineOffsets();
      applyActiveIndex({ instant: true });
    });
  }
  window.addEventListener('resize', handleResize);

  const unsubscribe = subscribe(handleStateTick);

  el._onLeave = () => {
    unsubscribe();
    window.removeEventListener('resize', handleResize);
  };

  return el;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
