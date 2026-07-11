/**
 * player-service.js
 * The single source of truth for playback. One shared <audio> element for
 * the whole app (so playback survives screen navigation), a small pub/sub
 * so any screen can reflect live state without polling, and a Media
 * Session integration so lock-screen/Bluetooth/PWA background controls
 * work for free.
 *
 * ---------------------------------------------------------------------
 * Pass 5 stability notes (distorted audio / single-source investigation)
 * ---------------------------------------------------------------------
 * Three real bugs were found and fixed here:
 *
 * 1. AUDIOCONTEXT NEVER RESUMED — a Web Audio graph (AudioContext ->
 *    MediaElementSource -> GainNode -> destination) is now created lazily
 *    on the first user-initiated play(). Chrome/Safari create contexts in
 *    a "suspended" state until a user gesture resumes them; playing
 *    through a suspended/just-resumed context is what produces garbled,
 *    underrun audio. We now explicitly `await audioCtx.resume()` before
 *    every play() call, and the gain node is pinned to a fixed 1.0 so
 *    there is never a double-gain/clipping stage.
 * 2. RACE CONDITION BETWEEN OVERLAPPING loadIndex() CALLS — rapid skips
 *    (e.g. double-tapping "next", or "ended" firing at the same moment as
 *    a manual skip) could let an older loadIndex() call revoke the
 *    object URL a newer call had just assigned to <audio>.src, or resolve
 *    its play() after a different track had already loaded — heard as a
 *    corrupted/garbled snippet of audio. A monotonically increasing
 *    `loadToken` now guards every async step so a stale call is a no-op.
 * 3. PLAYBACK RATE / PITCH DRIFT — nothing reset `playbackRate` explicitly
 *    before, so a stray rate change (e.g. from a future scrubbing/preview
 *    feature) could persist across tracks. Both are now force-reset to
 *    1.0 on every load, with `preservesPitch` enabled so any future rate
 *    changes don't pitch-shift audio into "chipmunk/distorted" territory.
 *
 * Single-source guarantee: this module owns the ONLY <audio> element used
 * for playback in the whole app (a module-level singleton, never
 * recreated). `ensureSingleSource()` additionally pauses any other
 * audio/video element that might exist on the page (defensive — nothing
 * else should ever create one, but this makes "only one source plays at
 * a time" true even if that ever changes).
 *
 * State shape (immutable snapshots handed to subscribers):
 * {
 *   queue, index, currentSong, isPlaying, currentTime, duration, artUrl,
 *   shuffle: boolean,
 *   repeatMode: 'off' | 'all' | 'one',
 * }
 */

import { getArtworkUrl, DEFAULT_ART_URL } from './artwork-service.js';
import { showToast } from '../utils/toast.js';
import { getItem, setItem } from '../utils/storage.js';
import { recordPlay } from './history-service.js';
import { getSong, incrementPlayCount } from './library-service.js';
import { hasPremiumAccess } from './premium-service.js';
import { notifySongCompleted, isAdCurrentlyPlaying, initAdManager } from './ad-manager.js';

const PLAYBACK_STATE_KEY = 'playbackState';
const EQ_PRESET_KEY = 'equalizerPreset';

/**
 * Premium — Equalizer presets (Basic+). Free is always forced to
 * "normal" regardless of what's stored locally, so a lapsed subscription
 * silently falls back to flat rather than erroring.
 * Values are dB gain for a 3-band shelf/peaking chain (bass/mid/treble).
 */
export const EQ_PRESETS = {
  normal:    { label: 'Normal',      bass: 0,  mid: 0,  treble: 0,  requiredPlan: 'Free'  },
  bassBoost: { label: 'Bass Boost',  bass: 7,  mid: 1,  treble: -1, requiredPlan: 'Basic' },
  vocal:     { label: 'Vocal',       bass: -2, mid: 5,  treble: 2,  requiredPlan: 'Basic' },
  rock:      { label: 'Rock',       bass: 4,  mid: -2, treble: 3,  requiredPlan: 'Basic' },
  pop:       { label: 'Pop',         bass: 2,  mid: 1,  treble: 2,  requiredPlan: 'Basic' },
  classical: { label: 'Classical',  bass: 1,  mid: 0,  treble: 3,  requiredPlan: 'Basic' },
};

/**
 * Premium — Crossfade (Basic+). Given player-service owns exactly ONE
 * <audio> element by design (see file header — this single-source
 * guarantee is what fixed the garbled-audio bugs above), true overlapping
 * dual-source crossfade would mean a second concurrent element, which
 * directly conflicts with that guarantee. Instead this implements a
 * fade-out / fade-in transition through the existing gainNode: the last
 * `crossfadeDuration` seconds of a track fade out, the next track loads,
 * and its first ~600ms fades back in. Audibly a crossfade-style
 * transition; architecturally still single-source.
 */
let crossfadeConfig = { enabled: false, duration: 3 };
let crossfadeArmed = false; // true once we've started fading out for the current track boundary

export function setCrossfadeConfig({ enabled, duration } = {}) {
  if (typeof enabled === 'boolean') crossfadeConfig.enabled = enabled;
  if (Number.isFinite(duration)) crossfadeConfig.duration = Math.max(0, Math.min(10, duration));
}

export function getCrossfadeConfig() {
  return { ...crossfadeConfig };
}

const audio = new Audio();
audio.preload = 'auto';
audio.playbackRate = 1;
audio.defaultPlaybackRate = 1;
try { audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true; } catch (_) {}

// ---------- Web Audio graph (lazy — created on first user-gesture play) ----------
let audioCtx = null;
let gainNode = null; // dedicated to crossfade fades — never repurposed for volume/EQ
let eqBass = null;
let eqMid = null;
let eqTreble = null;
let currentEqPreset = 'normal';

function ensureAudioGraph() {
  if (audioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return; // very old browser — fall back to plain <audio>, still functional
    audioCtx = new Ctx();
    const sourceNode = audioCtx.createMediaElementSource(audio);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1; // single, fixed gain stage — never doubled up elsewhere

    // 3-band EQ chain — flat (0 dB) by default, i.e. identical to "Normal".
    // Free accounts simply never have anything but "normal" applied to
    // this chain (see setEqualizerPreset), so the audio path for Free
    // users is unchanged from before this feature existed.
    eqBass = audioCtx.createBiquadFilter();
    eqBass.type = 'lowshelf';
    eqBass.frequency.value = 200;
    eqMid = audioCtx.createBiquadFilter();
    eqMid.type = 'peaking';
    eqMid.frequency.value = 1000;
    eqMid.Q.value = 0.9;
    eqTreble = audioCtx.createBiquadFilter();
    eqTreble.type = 'highshelf';
    eqTreble.frequency.value = 4000;

    sourceNode.connect(gainNode).connect(eqBass).connect(eqMid).connect(eqTreble).connect(audioCtx.destination);
  } catch (err) {
    // If this ever throws (e.g. graph already built for this element),
    // playback still works through the plain <audio> element unmodified.
    console.warn('[Melody] Player: Web Audio graph unavailable, using plain <audio> element.', err);
  }
}

/**
 * Applies an equalizer preset. Free accounts are always forced to
 * "normal" here regardless of what's asked for or what's stored locally —
 * this is the one place that enforces "Free users: Only Normal" for the
 * actual audio path, independent of whatever the Settings UI shows.
 */
export function setEqualizerPreset(presetKey) {
  const requestedPreset = EQ_PRESETS[presetKey] ? presetKey : 'normal';
  const allowed = hasPremiumAccess(EQ_PRESETS[requestedPreset].requiredPlan) ? requestedPreset : 'normal';
  currentEqPreset = allowed;
  setItem(EQ_PRESET_KEY, allowed).catch(() => {});

  ensureAudioGraph();
  const preset = EQ_PRESETS[allowed];
  if (eqBass && eqMid && eqTreble && audioCtx) {
    const now = audioCtx.currentTime;
    eqBass.gain.setTargetAtTime(preset.bass, now, 0.05);
    eqMid.gain.setTargetAtTime(preset.mid, now, 0.05);
    eqTreble.gain.setTargetAtTime(preset.treble, now, 0.05);
  }
  return allowed;
}

export function getEqualizerPreset() {
  return currentEqPreset;
}

/** Loads the saved preset (if any) and re-applies plan gating — call once at boot. */
export async function initEqualizerFromStorage() {
  const saved = await getItem(EQ_PRESET_KEY).catch(() => null);
  setEqualizerPreset(saved || 'normal');
}

async function resumeAudioGraphIfNeeded() {
  ensureAudioGraph();
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (err) { console.warn('[Melody] Player: AudioContext resume failed.', err); }
  }
}

/** Defensive single-source guarantee: pause any other media on the page. */
function ensureSingleSource() {
  document.querySelectorAll('audio, video').forEach((el) => {
    if (el !== audio && !el.paused) {
      try { el.pause(); } catch (_) {}
    }
  });
}

let queue = [];
let index = -1;
let currentObjectUrl = null;
let currentArtUrl = DEFAULT_ART_URL;
let consecutiveErrors = 0; // safety valve against an all-corrupt queue looping forever
let loadToken = 0; // monotonic guard against overlapping loadIndex() races

let shuffle = false;
let shuffleOrder = []; // permutation of queue indices, used only when shuffle is on
let repeatMode = 'off'; // 'off' | 'all' | 'one'
let lastRecordedSongId = null;
let restoredTime = 0; // pending seek-on-load after a state restore

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
    shuffle,
    repeatMode,
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

// ---------- Queue loading ----------

/**
 * Replace the queue and start playing at `startIndex`.
 * @param {Array} songs - song records (as returned by library-service)
 * @param {number} startIndex
 */
export async function loadQueue(songs, startIndex = 0) {
  if (!Array.isArray(songs) || songs.length === 0) return;
  queue = songs.slice();
  consecutiveErrors = 0;
  rebuildShuffleOrder(startIndex);
  await loadIndex(startIndex, { autoplay: true });
}

/** Load a previously-saved queue without autoplaying (used on app restart). */
async function loadQueueSilently(songs, startIndex, atTime) {
  if (!Array.isArray(songs) || songs.length === 0) return;
  queue = songs.slice();
  consecutiveErrors = 0;
  restoredTime = atTime || 0;
  rebuildShuffleOrder(startIndex);
  await loadIndex(startIndex, { autoplay: false });
}

async function loadIndex(newIndex, { autoplay }) {
  if (queue.length === 0) {
    index = -1;
    notify();
    return;
  }

  const myToken = ++loadToken;

  // Wrap safely regardless of direction
  index = ((newIndex % queue.length) + queue.length) % queue.length;
  const song = queue[index];

  if (!song || !song.blob) {
    console.warn('[Melody] Player: queue entry missing audio data — skipping.', song);
    return handlePlaybackFailure('This song is missing its audio data.', myToken);
  }

  try {
    // Fully stop any prior playback before swapping sources — prevents a
    // moment where the old buffer is still draining while the new src is
    // assigned (heard as a brief overlapping/garbled blip on fast skips).
    audio.pause();

    const nextObjectUrl = URL.createObjectURL(song.blob);

    audio.playbackRate = 1;
    audio.src = nextObjectUrl;
    audio.load();

    // Only now that the new src is committed do we revoke the previous
    // one — revoking too early (or from a stale/overlapping call) can
    // corrupt whatever the audio element is mid-way through decoding.
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = nextObjectUrl;

    // Resolve artwork without blocking playback start
    currentArtUrl = DEFAULT_ART_URL;
    getArtworkUrl(song).then((url) => {
      if (myToken !== loadToken) return; // a newer load has already superseded this one
      currentArtUrl = url;
      updateMediaSessionMetadata(song, url);
      notify();
    });

    updateMediaSessionMetadata(song, currentArtUrl);

    if (restoredTime > 0) {
      const seekTime = restoredTime;
      restoredTime = 0;
      const onLoaded = () => {
        if (myToken === loadToken) audio.currentTime = seekTime;
        audio.removeEventListener('loadedmetadata', onLoaded);
      };
      audio.addEventListener('loadedmetadata', onLoaded);
    }

    if (autoplay) {
      ensureSingleSource();
      await resumeAudioGraphIfNeeded();
      if (myToken !== loadToken) return; // superseded while we awaited resume()
      await audio.play();
    }

    if (myToken !== loadToken) return;
    consecutiveErrors = 0;
    notify();
  } catch (err) {
    if (myToken !== loadToken) return; // a newer load already took over — ignore this failure
    console.error(`[Melody] Player: failed to load/play "${song.title}".`, err);
    handlePlaybackFailure(`Couldn't play "${song.title}" — skipping.`, myToken);
  }
}

/**
 * Called whenever a song fails to load/decode/play. Skips to the next
 * track automatically, but stops trying after a full pass through the
 * queue fails so a library of entirely corrupt files can't spin forever.
 */
function handlePlaybackFailure(message, myToken) {
  if (myToken !== undefined && myToken !== loadToken) return;
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
  setTimeout(() => loadIndex(stepIndex(1), { autoplay: true }), 400);
}

// ---------- Transport ----------

export async function play() {
  if (index === -1 && queue.length > 0) {
    return loadIndex(0, { autoplay: true });
  }
  ensureSingleSource();
  await resumeAudioGraphIfNeeded();
  return audio.play().catch((err) => {
    console.error('[Melody] Player: play() rejected.', err);
    showToast("Playback couldn't start. Tap play again to retry.");
  });
}

export function pause() {
  audio.pause();
}

export function togglePlay() {
  if (audio.paused) return play();
  pause();
}

/** Compute the next/previous queue index, respecting shuffle order. */
function stepIndex(direction) {
  if (queue.length === 0) return index;
  if (!shuffle) return index + direction;

  const posInShuffle = shuffleOrder.indexOf(index);
  const nextPos = ((posInShuffle + direction) % shuffleOrder.length + shuffleOrder.length) % shuffleOrder.length;
  return shuffleOrder[nextPos];
}

export async function next() {
  if (queue.length === 0 || isAdCurrentlyPlaying()) return;
  const targetIndex = stepIndex(1);

  // Manual Next counts as a completed song, same as a natural end. Pause
  // the current song first — if an ad is due, it should never overlap
  // with the song being left behind.
  audio.pause();
  const myTokenAtAdTime = loadToken;
  await notifySongCompleted().catch((err) => console.error('[Melody] Ad playback failed (non-fatal).', err));
  if (myTokenAtAdTime !== loadToken) return; // superseded while the ad was playing

  return loadIndex(targetIndex, { autoplay: true });
}

export function previous() {
  if (queue.length === 0 || isAdCurrentlyPlaying()) return;
  // If we're more than 3s into the song, "previous" restarts it first —
  // standard player convention — a second tap within that window goes
  // back a track.
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    notify();
    return;
  }
  return loadIndex(stepIndex(-1), { autoplay: true });
}

/** Play a specific position in the current queue directly (e.g. from a Queue sheet). */
export function playFromQueue(queueIndex) {
  if (queueIndex < 0 || queueIndex >= queue.length || isAdCurrentlyPlaying()) return;
  return loadIndex(queueIndex, { autoplay: true });
}

/** Seek to an absolute time in seconds. */
export function seek(time) {
  if (!Number.isFinite(time) || isAdCurrentlyPlaying()) return;
  try {
    audio.currentTime = Math.max(0, Math.min(time, audio.duration || time));
  } catch (err) {
    console.error('[Melody] Player: seek failed.', err);
  }
  notify();
}

// ---------- Shuffle & repeat ----------

function rebuildShuffleOrder(anchorIndex = index) {
  shuffleOrder = queue.map((_, i) => i);
  if (!shuffle) return;
  // Fisher-Yates, keeping the anchor (currently playing / about-to-play)
  // track first so turning shuffle on mid-song doesn't jump anywhere.
  for (let i = shuffleOrder.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffleOrder[i], shuffleOrder[j]] = [shuffleOrder[j], shuffleOrder[i]];
  }
  if (anchorIndex >= 0) {
    const pos = shuffleOrder.indexOf(anchorIndex);
    if (pos > 0) {
      shuffleOrder.splice(pos, 1);
      shuffleOrder.unshift(anchorIndex);
    }
  }
}

export function setShuffle(enabled) {
  shuffle = Boolean(enabled);
  rebuildShuffleOrder(index);
  notify();
}

export function toggleShuffle() {
  if (isAdCurrentlyPlaying()) return shuffle;
  setShuffle(!shuffle);
  return shuffle;
}

export function setRepeatMode(mode) {
  if (!['off', 'all', 'one'].includes(mode)) return;
  repeatMode = mode;
  notify();
}

/** Cycles Off -> All -> One -> Off. */
export function cycleRepeatMode() {
  if (isAdCurrentlyPlaying()) return repeatMode;
  repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
  notify();
  return repeatMode;
}

export function getRepeatMode() {
  return repeatMode;
}

export function isShuffleOn() {
  return shuffle;
}

// ---------- Queue management ----------

/** Append a song to the end of the queue without interrupting playback. */
export function addToQueue(song) {
  if (!song) return;
  queue.push(song);
  if (shuffle) shuffleOrder.push(queue.length - 1);
  notify();
}

/** Insert a song to play immediately after the current one. */
export function playNext(song) {
  if (!song) return;
  const insertAt = index >= 0 ? index + 1 : queue.length;
  queue.splice(insertAt, 0, song);
  rebuildShuffleOrder(index);
  notify();
}

/** Remove a song at a given queue position. Adjusts the playing index safely. */
export function removeFromQueue(queueIndex) {
  if (queueIndex < 0 || queueIndex >= queue.length || isAdCurrentlyPlaying()) return;
  const wasCurrent = queueIndex === index;
  queue.splice(queueIndex, 1);

  if (queue.length === 0) {
    index = -1;
    audio.pause();
    audio.removeAttribute('src');
  } else if (wasCurrent) {
    index = Math.min(queueIndex, queue.length - 1);
    loadIndex(index, { autoplay: !audio.paused });
    return;
  } else if (queueIndex < index) {
    index -= 1;
  }

  rebuildShuffleOrder(index);
  notify();
}

/** Reorder the queue by moving the item at `from` to position `to`. */
export function moveInQueue(from, to) {
  if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to || isAdCurrentlyPlaying()) return;
  const [moved] = queue.splice(from, 1);
  queue.splice(to, 0, moved);

  if (index === from) index = to;
  else if (from < index && to >= index) index -= 1;
  else if (from > index && to <= index) index += 1;

  rebuildShuffleOrder(index);
  notify();
}

// ---------- Audio element event wiring (set up once) ----------

audio.addEventListener('timeupdate', notify);
audio.addEventListener('play', notify);
audio.addEventListener('pause', notify);
audio.addEventListener('loadedmetadata', notify);

audio.addEventListener('playing', () => {
  const song = queue[index];
  if (!song) return;
  // Record "recently played" once per playback start, not on every
  // resume-from-pause of the same track.
  if (lastRecordedSongId !== song.id) {
    lastRecordedSongId = song.id;
    recordPlay(song.id);
    incrementPlayCount(song.id).catch((err) => console.error('[Melody] Play count update failed.', err));

    // Crossfade fade-in: the previous track's "ended"/manual-skip path
    // just armed a new load with gain still ramped toward 0 — bring it
    // back up over the same configured duration (capped short, so a
    // manual skip mid-song never causes an audible multi-second fade-in).
    crossfadeArmed = false;
    if (crossfadeConfig.enabled && hasPremiumAccess('Basic') && gainNode && audioCtx) {
      const fadeIn = Math.min(crossfadeConfig.duration, 1.2) || 0.4;
      gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
      gainNode.gain.linearRampToValueAtTime(1, audioCtx.currentTime + fadeIn);
    } else if (gainNode) {
      gainNode.gain.cancelScheduledValues(audioCtx?.currentTime || 0);
      gainNode.gain.value = 1;
    }
  }
});

audio.addEventListener('ended', async () => {
  consecutiveErrors = 0;
  crossfadeArmed = false;
  if (gainNode) gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
  if (gainNode) gainNode.gain.value = 1;

  if (repeatMode === 'one') {
    audio.currentTime = 0;
    audio.play().catch((err) => console.error('[Melody] Player: repeat-one replay failed.', err));
    return;
  }

  const atEnd = shuffle
    ? shuffleOrder.indexOf(index) === shuffleOrder.length - 1
    : index === queue.length - 1;

  const myTokenAtAdTime = loadToken;
  await notifySongCompleted().catch((err) => console.error('[Melody] Ad playback failed (non-fatal).', err));
  if (myTokenAtAdTime !== loadToken) return; // a manual skip happened during the ad — don't double-advance

  if (atEnd && repeatMode === 'off') {
    // Stop cleanly at the end of the queue instead of wrapping forever.
    notify();
    return;
  }

  loadIndex(stepIndex(1), { autoplay: true });
});

// ---------- Crossfade (Basic+): fade-out near track end, fade-in on the next ----------
// Deliberately a fade transition rather than true dual-source overlap —
// see setCrossfadeConfig's doc comment for why, given the single <audio>
// element guarantee this file otherwise relies on.
audio.addEventListener('timeupdate', () => {
  if (!crossfadeConfig.enabled || !hasPremiumAccess('Basic') || !gainNode || !audioCtx) return;
  if (crossfadeArmed) return;
  if (repeatMode === 'one') return; // don't fade a track that's about to instantly repeat itself

  const dur = audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const remaining = dur - audio.currentTime;
  if (remaining <= crossfadeConfig.duration && remaining > 0) {
    crossfadeArmed = true;
    gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + remaining);
  }
});

audio.addEventListener('error', () => {
  const song = queue[index];
  const label = song ? `"${song.title}"` : 'This song';
  console.error('[Melody] Audio element error while playing', song, audio.error);
  handlePlaybackFailure(`${label} couldn't be played — it may be unsupported or corrupted.`);
});

audio.addEventListener('stalled', () => {
  console.warn('[Melody] Player: playback stalled (buffering/network hiccup).');
});

// ---------- Persistence (survive app restart) ----------

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistState, 800);
}

async function persistState() {
  try {
    if (index < 0 || !queue[index]) {
      await setItem(PLAYBACK_STATE_KEY, null);
      return;
    }
    await setItem(PLAYBACK_STATE_KEY, {
      songIds: queue.map((s) => s.id),
      index,
      currentTime: audio.currentTime || 0,
      shuffle,
      repeatMode,
      savedAt: Date.now(),
    });
  } catch (err) {
    console.error('[Melody] Player: failed to persist playback state.', err);
  }
}

audio.addEventListener('timeupdate', scheduleSave);
audio.addEventListener('pause', persistState);
window.addEventListener('pagehide', persistState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistState();
});

/**
 * Restore the last playback session (queue + position), without
 * autoplaying — the user returns to a ready-to-resume player rather than
 * music blaring on launch. Safe to call once at boot; silently no-ops if
 * there's nothing to restore or any referenced song was removed.
 */
export async function restoreState() {
  try {
    const saved = await getItem(PLAYBACK_STATE_KEY);
    if (!saved || !Array.isArray(saved.songIds) || saved.songIds.length === 0) return;

    const songs = [];
    for (const id of saved.songIds) {
      const song = await getSong(id);
      if (song) songs.push(song);
    }
    if (songs.length === 0) return;

    shuffle = Boolean(saved.shuffle);
    repeatMode = ['off', 'all', 'one'].includes(saved.repeatMode) ? saved.repeatMode : 'off';

    const clampedIndex = Math.max(0, Math.min(saved.index || 0, songs.length - 1));
    await loadQueueSilently(songs, clampedIndex, saved.currentTime || 0);
  } catch (err) {
    console.error('[Melody] Player: failed to restore playback state.', err);
  }
}

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
