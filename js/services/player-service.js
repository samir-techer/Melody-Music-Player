/**
 * player-service.js
 * The single source of truth for playback. One shared <audio> element for
 * the whole app (so playback survives screen navigation), a small pub/sub
 * so any screen can reflect live state without polling, and a Media
 * Session integration so lock-screen/Bluetooth/PWA background controls
 * work for free.
 *
 * State shape (immutable snapshots handed to subscribers):
 * {
 *   queue: Song[],          // the current play queue, in order
 *   index: number,          // index into queue of the current song, -1 if none
 *   currentSong: Song|null,
 *   isPlaying: boolean,
 *   currentTime: number,    // seconds
 *   duration: number,       // seconds
 *   artUrl: string,         // resolved cover art (embedded or placeholder)
 * }
 *
 * Queue-advance policy for this pass: next()/previous() wrap around the
 * queue (so playback never just dead-ends), and reaching the end of a
 * song auto-advances the same way. Explicit Repeat Off/One/All modes are
 * a follow-up pass — this wrap-around is the sane default until then.
 */

import { getArtworkUrl, DEFAULT_ART_URL } from './artwork-service.js';
import { showToast } from '../utils/toast.js';

const audio = new Audio();
audio.preload = 'auto';

let queue = [];
let index = -1;
let currentObjectUrl = null;
let currentArtUrl = DEFAULT_ART_URL;
let consecutiveErrors = 0; // safety valve against an all-corrupt queue looping forever

const listeners = new Set();

function snapshot() {
  return {
    queue,
    index,
    currentSong: index >= 0 ? queue[index] : null,
    isPlaying: !audio.paused && !audio.ended && index >= 0,
    currentTime: audio.currentTime || 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : (queue[index]?.duration || 0),
    artUrl: currentArtUrl,
  };
}

function notify() {
  const state = snapshot();
  listeners.forEach((fn) => {
    try { fn(state); } catch (err) { console.error('[Melody] Player subscriber threw:', err); }
  });
}

/** Subscribe to playback state changes. Returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  listener(snapshot()); // immediate current state, so UI doesn't wait for the next event
  return () => listeners.delete(listener);
}

export function getState() {
  return snapshot();
}

/**
 * Replace the queue and start playing at `startIndex`.
 * @param {Array} songs - song records (as returned by library-service)
 * @param {number} startIndex
 */
export async function loadQueue(songs, startIndex = 0) {
  if (!Array.isArray(songs) || songs.length === 0) return;
  queue = songs;
  consecutiveErrors = 0;
  await loadIndex(startIndex, { autoplay: true });
}

async function loadIndex(newIndex, { autoplay }) {
  if (queue.length === 0) {
    index = -1;
    notify();
    return;
  }

  // Wrap safely regardless of direction
  index = ((newIndex % queue.length) + queue.length) % queue.length;
  const song = queue[index];

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  if (!song || !song.blob) {
    console.warn('[Melody] Player: queue entry missing audio data — skipping.', song);
    return handlePlaybackFailure('This song is missing its audio data.');
  }

  try {
    currentObjectUrl = URL.createObjectURL(song.blob);
    audio.src = currentObjectUrl;

    // Resolve artwork without blocking playback start
    currentArtUrl = DEFAULT_ART_URL;
    getArtworkUrl(song).then((url) => {
      currentArtUrl = url;
      updateMediaSessionMetadata(song, url);
      notify();
    });

    updateMediaSessionMetadata(song, currentArtUrl);

    if (autoplay) {
      await audio.play();
    }
    consecutiveErrors = 0;
    notify();
  } catch (err) {
    console.error(`[Melody] Player: failed to load/play "${song.title}".`, err);
    handlePlaybackFailure(`Couldn't play "${song.title}" — skipping.`);
  }
}

/**
 * Called whenever a song fails to load/decode/play. Skips to the next
 * track automatically, but stops trying after a full pass through the
 * queue fails so a library of entirely corrupt files can't spin forever.
 */
function handlePlaybackFailure(message) {
  showToast(message);
  consecutiveErrors += 1;

  if (consecutiveErrors >= queue.length) {
    console.error('[Melody] Player: every song in the queue failed to play — stopping.');
    showToast("None of these songs could be played.");
    index = -1;
    notify();
    return;
  }

  // Small delay so rapid-fire failures (e.g. importing a batch of broken
  // files) don't produce a jarring stutter of toasts and play() calls.
  setTimeout(() => loadIndex(index + 1, { autoplay: true }), 400);
}

export function play() {
  if (index === -1 && queue.length > 0) {
    return loadIndex(0, { autoplay: true });
  }
  return audio.play().catch((err) => {
    console.error('[Melody] Player: play() rejected.', err);
  });
}

export function pause() {
  audio.pause();
}

export function togglePlay() {
  if (audio.paused) return play();
  pause();
}

export function next() {
  if (queue.length === 0) return;
  return loadIndex(index + 1, { autoplay: true });
}

export function previous() {
  if (queue.length === 0) return;
  // If we're more than 3s into the song, "previous" restarts it first —
  // standard player convention — a second tap within that window goes
  // back a track.
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    notify();
    return;
  }
  return loadIndex(index - 1, { autoplay: true });
}

/** Seek to an absolute time in seconds. */
export function seek(time) {
  if (!Number.isFinite(time)) return;
  audio.currentTime = Math.max(0, Math.min(time, audio.duration || time));
  notify();
}

// ---------- Audio element event wiring (set up once) ----------

audio.addEventListener('timeupdate', notify);
audio.addEventListener('play', notify);
audio.addEventListener('pause', notify);
audio.addEventListener('loadedmetadata', notify);

audio.addEventListener('ended', () => {
  // Natural end of a song that played fine — auto-advance, and don't let
  // it count against the corrupt-file safety valve.
  consecutiveErrors = 0;
  loadIndex(index + 1, { autoplay: true });
});

audio.addEventListener('error', () => {
  const song = queue[index];
  const label = song ? `"${song.title}"` : 'This song';
  console.error('[Melody] Audio element error while playing', song, audio.error);
  handlePlaybackFailure(`${label} couldn't be played — it may be unsupported or corrupted.`);
});

// ---------- Media Session (lock screen / Bluetooth / PWA background controls) ----------

function updateMediaSessionMetadata(song, artUrl) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title || 'Unknown Title',
    artist: song.artist || 'Unknown Artist',
    album: song.album || '',
    artwork: [
      { src: artUrl, sizes: '512x512', type: artUrl.startsWith('data:') ? 'image/svg+xml' : 'image/png' },
    ],
  });
}

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => play());
  navigator.mediaSession.setActionHandler('pause', () => pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => previous());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) seek(details.seekTime);
  });
}
