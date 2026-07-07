/**
 * player-service.js
 * The single source of truth for playback. Two shared <audio> "decks"
 * power the whole app (so playback survives screen navigation), a small
 * pub/sub so any screen can reflect live state without polling, and a
 * Media Session integration so lock-screen/Bluetooth/PWA background
 * controls work for free.
 *
 * ---------------------------------------------------------------------
 * Pass 5 stability notes (distorted audio / single-source investigation)
 * ---------------------------------------------------------------------
 * Three real bugs were found and fixed here:
 *
 * 1. AUDIOCONTEXT NEVER RESUMED — a Web Audio graph (AudioContext ->
 *    MediaElementSource -> GainNode -> destination) is created lazily on
 *    the first user-initiated play(). Chrome/Safari create contexts in a
 *    "suspended" state until a user gesture resumes them; playing through
 *    a suspended/just-resumed context is what produces garbled, underrun
 *    audio. We explicitly `await audioCtx.resume()` before every play(),
 *    and each deck's gain node is pinned to 1.0 by default so there is
 *    never a double-gain/clipping stage.
 * 2. RACE CONDITION BETWEEN OVERLAPPING loadIndex() CALLS — rapid skips
 *    could let an older loadIndex() call revoke the object URL a newer
 *    call had just assigned, or resolve its play() after a different
 *    track had already loaded. A monotonically increasing `loadToken`
 *    guards every async step so a stale call is a no-op.
 * 3. PLAYBACK RATE / PITCH DRIFT — rate is force-applied on every load,
 *    with `preservesPitch` enabled so rate changes (now a real, exposed
 *    feature — see Pass 6) don't pitch-shift audio into "chipmunk"
 *    territory.
 *
 * ---------------------------------------------------------------------
 * Pass 6 — Crossfade / gapless / speed / normalization
 * ---------------------------------------------------------------------
 * Playback now runs on TWO audio elements ("decks"), each with its own
 * Web Audio gain node, sharing one AudioContext:
 *
 * - Manual navigation (skip, previous, tap a queue row) is always a hard
 *   cut on the active deck — instant, like before.
 * - Automatic advance at the end of a track has two modes:
 *     - Crossfade > 0s: the *next* track is preloaded on the inactive
 *       deck and started slightly before the current one ends; both
 *       play simultaneously while their gains ramp 1->0 / 0->1 over the
 *       chosen duration, then the decks swap roles.
 *     - Crossfade = 0s ("gapless"): the next track is still preloaded
 *       ahead of time on the inactive deck (fully decoded and ready), so
 *       the swap on `ended` is effectively instant instead of paying the
 *       cost of creating+loading a fresh object URL after the fact.
 * - Volume Normalization routes both decks through a shared
 *   DynamicsCompressorNode (a gentle loudness-leveling stage) instead of
 *   straight to the destination.
 * - Playback Speed (0.75x-2x) is applied to both decks and persisted.
 *
 * Single-source guarantee: this module owns the ONLY two <audio>
 * elements used for playback in the whole app. `ensureSingleSource()`
 * additionally pauses any other audio/video element that might exist on
 * the page.
 *
 * State shape (immutable snapshots handed to subscribers):
 * {
 *   queue, index, currentSong, isPlaying, currentTime, duration, artUrl,
 *   shuffle: boolean,
 *   repeatMode: 'off' | 'all' | 'one',
 *   playbackRate: number,
 *   crossfadeSeconds: number,
 *   volumeNormalization: boolean,
 * }
 */

import { getArtworkUrl, DEFAULT_ART_URL } from './artwork-service.js';
import { showToast } from '../utils/toast.js';
import { getItem, setItem } from '../utils/storage.js';
import { recordPlay } from './history-service.js';
import { getSong } from './library-service.js';

const PLAYBACK_STATE_KEY = 'playbackState';
const SETTINGS_KEY = 'playerSettings';
const VALID_RATES = [0.75, 1, 1.25, 1.5, 2];

// ---------- Deck setup (two <audio> elements so we can crossfade/gapless) ----------

function createDeck() {
  const audioEl = new Audio();
  audioEl.preload = 'auto';
  audioEl.playbackRate = 1;
  audioEl.defaultPlaybackRate = 1;
  try {
    audioEl.preservesPitch = true;
    audioEl.mozPreservesPitch = true;
    audioEl.webkitPreservesPitch = true;
  } catch (_) {}
  return { audio: audioEl, gainNode: null, sourceNode: null, objectUrl: null };
}

const decks = [createDeck(), createDeck()];
let active = 0; // index into `decks` of the currently audible deck

function mainAudio() { return decks[active].audio; }

// ---------- Web Audio graph (lazy — created on first user-gesture play) ----------
let audioCtx = null;
let compressorNode = null; // shared "volume normalization" stage
let compressorWired = false;
let normalizationEnabled = false;

function ensureAudioCtx() {
  if (audioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return; // very old browser — falls back to plain <audio>, still functional
    audioCtx = new Ctx();
    compressorNode = audioCtx.createDynamicsCompressor();
    // Gentle loudness-leveling defaults: pulls loud peaks down and lets
    // quiet passages sit closer to full scale, without being an obvious
    // "pumping" limiter.
    compressorNode.threshold.value = -24;
    compressorNode.knee.value = 24;
    compressorNode.ratio.value = 6;
    compressorNode.attack.value = 0.01;
    compressorNode.release.value = 0.25;
  } catch (err) {
    console.warn('[Melody] Player: Web Audio graph unavailable, using plain <audio> elements.', err);
  }
}

function ensureDeckGraph(deck) {
  ensureAudioCtx();
  if (!audioCtx || deck.gainNode) return;
  try {
    deck.sourceNode = audioCtx.createMediaElementSource(deck.audio);
    deck.gainNode = audioCtx.createGain();
    deck.gainNode.gain.value = 1;
    wireDeckOutput(deck);
  } catch (err) {
    console.warn('[Melody] Player: could not build Web Audio graph for a deck.', err);
  }
}

/** (Re)connects a deck's gain node to either the compressor or straight to destination. */
function wireDeckOutput(deck) {
  if (!audioCtx || !deck.gainNode) return;
  try { deck.gainNode.disconnect(); } catch (_) {}
  if (normalizationEnabled && compressorNode) {
    deck.gainNode.connect(compressorNode);
    if (!compressorWired) {
      compressorNode.connect(audioCtx.destination);
      compressorWired = true;
    }
  } else {
    deck.gainNode.connect(audioCtx.destination);
  }
}

async function resumeAudioGraphIfNeeded() {
  ensureAudioCtx();
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (err) { console.warn('[Melody] Player: AudioContext resume failed.', err); }
  }
}

/** Defensive single-source guarantee: pause any other media on the page. */
function ensureSingleSource() {
  document.querySelectorAll('audio, video').forEach((el) => {
    if (el !== decks[0].audio && el !== decks[1].audio && !el.paused) {
      try { el.pause(); } catch (_) {}
    }
  });
}

let queue = [];
let index = -1;
let currentArtUrl = DEFAULT_ART_URL;
let consecutiveErrors = 0; // safety valve against an all-corrupt queue looping forever
let loadToken = 0; // monotonic guard against overlapping loadIndex() races

let shuffle = false;
let shuffleOrder = []; // permutation of queue indices, used only when shuffle is on
let repeatMode = 'off'; // 'off' | 'all' | 'one'
let lastRecordedSongId = null;
let restoredTime = 0; // pending seek-on-load after a state restore

// ---------- Pass 6 playback settings ----------
let playbackRate = 1;
let crossfadeSeconds = 0;
let crossfading = false;
let crossfadeRAF = null;
let preloadedForIndex = -1; // which queue index is primed on the inactive deck, or -1

const listeners = new Set();

function snapshot() {
  const a = mainAudio();
  return {
    queue,
    index,
    currentSong: index >= 0 ? queue[index] : null,
    isPlaying: !a.paused && !a.ended && index >= 0,
    currentTime: a.currentTime || 0,
    duration: Number.isFinite(a.duration) ? a.duration : (queue[index]?.duration || 0),
    artUrl: currentArtUrl,
    shuffle,
    repeatMode,
    playbackRate,
    crossfadeSeconds,
    volumeNormalization: normalizationEnabled,
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

// ---------- Settings persistence (playback rate / crossfade / normalization) ----------

async function savePlayerSettings() {
  try {
    await setItem(SETTINGS_KEY, { playbackRate, crossfadeSeconds, normalizationEnabled });
  } catch (err) {
    console.error('[Melody] Player: failed to save playback settings.', err);
  }
}

(async function loadPlayerSettings() {
  try {
    const saved = await getItem(SETTINGS_KEY);
    if (!saved) return;
    if (VALID_RATES.includes(saved.playbackRate)) playbackRate = saved.playbackRate;
    if (Number.isFinite(saved.crossfadeSeconds)) crossfadeSeconds = Math.max(0, Math.min(12, saved.crossfadeSeconds));
    normalizationEnabled = Boolean(saved.normalizationEnabled);
    decks.forEach((d) => { d.audio.playbackRate = playbackRate; });
  } catch (err) {
    console.error('[Melody] Player: failed to load playback settings — using defaults.', err);
  }
})();

/** 0.75x - 2x. Applies to both decks immediately (and to whichever plays next). */
export function setPlaybackRate(rate) {
  playbackRate = VALID_RATES.includes(rate) ? rate : 1;
  decks.forEach((d) => { d.audio.playbackRate = playbackRate; });
  savePlayerSettings();
  notify();
}
export function getPlaybackRate() { return playbackRate; }

/** 0 (off/gapless) - 12 seconds. */
export function setCrossfadeSeconds(seconds) {
  crossfadeSeconds = Math.max(0, Math.min(12, Number(seconds) || 0));
  savePlayerSettings();
  notify();
}
export function getCrossfadeSeconds() { return crossfadeSeconds; }

/** Toggles a shared loudness-leveling compressor stage in/out of the signal path. */
export function setVolumeNormalization(enabled) {
  normalizationEnabled = Boolean(enabled);
  ensureAudioCtx();
  decks.forEach(wireDeckOutput);
  savePlayerSettings();
  notify();
}
export function isVolumeNormalizationOn() { return normalizationEnabled; }

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

/** Cancels any in-flight crossfade/preload — used before any manual navigation or queue mutation. */
function cancelCrossfadeAndPreload() {
  if (crossfadeRAF) { cancelAnimationFrame(crossfadeRAF); crossfadeRAF = null; }
  crossfading = false;
  const inactive = decks[1 - active];
  try { inactive.audio.pause(); } catch (_) {}
  if (inactive.gainNode) inactive.gainNode.gain.value = 1;
  preloadedForIndex = -1;
}

/** Hard-cut load — used for manual navigation (skip/previous/queue tap/restore/error-recovery). */
async function loadIndex(newIndex, { autoplay }) {
  cancelCrossfadeAndPreload();

  if (queue.length === 0) {
    index = -1;
    notify();
    return;
  }

  const myToken = ++loadToken;
  const deck = decks[active];
  const a = deck.audio;

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
    a.pause();

    const nextObjectUrl = URL.createObjectURL(song.blob);

    a.playbackRate = playbackRate;
    a.src = nextObjectUrl;
    a.load();

    // Only now that the new src is committed do we revoke the previous
    // one — revoking too early (or from a stale/overlapping call) can
    // corrupt whatever the audio element is mid-way through decoding.
    if (deck.objectUrl) URL.revokeObjectURL(deck.objectUrl);
    deck.objectUrl = nextObjectUrl;

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
        if (myToken === loadToken) a.currentTime = seekTime;
        a.removeEventListener('loadedmetadata', onLoaded);
      };
      a.addEventListener('loadedmetadata', onLoaded);
    }

    if (autoplay) {
      ensureSingleSource();
      ensureDeckGraph(deck);
      await resumeAudioGraphIfNeeded();
      if (myToken !== loadToken) return; // superseded while we awaited resume()
      await a.play();
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
 * Primes an inactive deck with a song's audio, ready to play, without
 * disturbing whatever's currently audible. Resolves once the deck can
 * play through (or after a safety timeout, so a slow/corrupt file can't
 * hang a crossfade/preload indefinitely).
 */
function primeDeck(deck, song) {
  return new Promise((resolve) => {
    if (!song || !song.blob) { resolve(false); return; }
    try {
      if (deck.objectUrl) URL.revokeObjectURL(deck.objectUrl);
      const url = URL.createObjectURL(song.blob);
      deck.objectUrl = url;
      deck.audio.pause();
      deck.audio.playbackRate = playbackRate;
      deck.audio.src = url;

      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        deck.audio.removeEventListener('canplay', onReady);
        deck.audio.removeEventListener('error', onError);
        resolve(ok);
      };
      const onReady = () => finish(true);
      const onError = () => finish(false);
      const timeoutId = setTimeout(() => finish(true), 4000); // don't hang forever on a slow decode

      deck.audio.addEventListener('canplay', onReady, { once: true });
      deck.audio.addEventListener('error', onError, { once: true });
      deck.audio.load();
    } catch (err) {
      console.warn('[Melody] Player: failed to prime a deck.', err);
      resolve(false);
    }
  });
}

/** Called whenever a song fails to load/decode/play. Skips to the next track automatically. */
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
  const deck = decks[active];
  ensureSingleSource();
  ensureDeckGraph(deck);
  await resumeAudioGraphIfNeeded();
  return deck.audio.play().catch((err) => {
    console.error('[Melody] Player: play() rejected.', err);
    showToast("Playback couldn't start. Tap play again to retry.");
  });
}

export function pause() {
  mainAudio().pause();
}

export function togglePlay() {
  if (mainAudio().paused) return play();
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

/** The index that would play next automatically, or null if playback should just stop. */
function computeNextIndexForAutoAdvance() {
  if (queue.length === 0) return null;
  const atEnd = shuffle
    ? shuffleOrder.indexOf(index) === shuffleOrder.length - 1
    : index === queue.length - 1;
  if (atEnd && repeatMode === 'off') return null;
  return stepIndex(1);
}

export function next() {
  if (queue.length === 0) return;
  return loadIndex(stepIndex(1), { autoplay: true });
}

export function previous() {
  if (queue.length === 0) return;
  // If we're more than 3s into the song, "previous" restarts it first —
  // standard player convention — a second tap within that window goes
  // back a track.
  if (mainAudio().currentTime > 3) {
    mainAudio().currentTime = 0;
    notify();
    return;
  }
  return loadIndex(stepIndex(-1), { autoplay: true });
}

/** Play a specific position in the current queue directly (e.g. from a Queue sheet). */
export function playFromQueue(queueIndex) {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  return loadIndex(queueIndex, { autoplay: true });
}

/** Seek to an absolute time in seconds. */
export function seek(time) {
  if (!Number.isFinite(time)) return;
  const a = mainAudio();
  try {
    a.currentTime = Math.max(0, Math.min(time, a.duration || time));
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
  cancelCrossfadeAndPreload();
  rebuildShuffleOrder(index);
  notify();
}

export function toggleShuffle() {
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
  cancelCrossfadeAndPreload();
  notify();
}

/** Insert a song to play immediately after the current one. */
export function playNext(song) {
  if (!song) return;
  const insertAt = index >= 0 ? index + 1 : queue.length;
  queue.splice(insertAt, 0, song);
  cancelCrossfadeAndPreload();
  rebuildShuffleOrder(index);
  notify();
}

/** Remove a song at a given queue position. Adjusts the playing index safely. */
export function removeFromQueue(queueIndex) {
  if (queueIndex < 0 || queueIndex >= queue.length) return;
  cancelCrossfadeAndPreload();
  const wasCurrent = queueIndex === index;
  queue.splice(queueIndex, 1);

  if (queue.length === 0) {
    index = -1;
    mainAudio().pause();
    mainAudio().removeAttribute('src');
  } else if (wasCurrent) {
    index = Math.min(queueIndex, queue.length - 1);
    loadIndex(index, { autoplay: !mainAudio().paused });
    return;
  } else if (queueIndex < index) {
    index -= 1;
  }

  rebuildShuffleOrder(index);
  notify();
}

/** Reorder the queue by moving the item at `from` to position `to`. */
export function moveInQueue(from, to) {
  if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) return;
  cancelCrossfadeAndPreload();
  const [moved] = queue.splice(from, 1);
  queue.splice(to, 0, moved);

  if (index === from) index = to;
  else if (from < index && to >= index) index -= 1;
  else if (from > index && to <= index) index += 1;

  rebuildShuffleOrder(index);
  notify();
}

// ---------- Pass 6: automatic-advance transition (crossfade / gapless) ----------

/** Called on every active-deck timeupdate to see if we should start preloading/crossfading. */
function maybeHandleTrackTransition() {
  if (crossfading || repeatMode === 'one') return;
  const a = mainAudio();
  if (!Number.isFinite(a.duration) || a.duration <= 0) return;

  const remaining = a.duration - a.currentTime;
  const nextIndex = computeNextIndexForAutoAdvance();
  if (nextIndex === null) return; // true end of queue, repeat off

  if (crossfadeSeconds > 0) {
    if (remaining <= crossfadeSeconds && remaining > 0.05) {
      beginCrossfade(nextIndex);
    }
  } else {
    // Gapless: prime the next track well before it's needed so the swap
    // on `ended` doesn't pay for object-URL creation + decode warm-up.
    if (remaining <= 3 && preloadedForIndex !== nextIndex) {
      preloadGapless(nextIndex);
    }
  }
}

async function preloadGapless(nextIndex) {
  const nextSong = queue[nextIndex];
  if (!nextSong || !nextSong.blob) return;
  preloadedForIndex = nextIndex;
  const deck = decks[1 - active];
  ensureDeckGraph(deck);
  if (deck.gainNode) deck.gainNode.gain.value = 1;
  const ok = await primeDeck(deck, nextSong);
  if (!ok) preloadedForIndex = -1; // fall back to a normal hard-cut load on `ended`
}

async function beginCrossfade(nextIndex) {
  const nextSong = queue[nextIndex];
  if (!nextSong || !nextSong.blob) return;

  crossfading = true;
  const oldDeckIdx = active;
  const newDeckIdx = 1 - active;
  const oldDeck = decks[oldDeckIdx];
  const newDeck = decks[newDeckIdx];

  ensureDeckGraph(oldDeck);
  ensureDeckGraph(newDeck);

  if (preloadedForIndex !== nextIndex) {
    const ok = await primeDeck(newDeck, nextSong);
    if (!ok) { crossfading = false; return; }
  }

  if (newDeck.gainNode) newDeck.gainNode.gain.value = 0;
  try { newDeck.audio.currentTime = 0; } catch (_) {}
  newDeck.audio.playbackRate = playbackRate;

  await resumeAudioGraphIfNeeded();
  ensureSingleSource();
  try {
    await newDeck.audio.play();
  } catch (err) {
    console.error('[Melody] Player: crossfade playback failed to start.', err);
    crossfading = false;
    return;
  }

  const durationMs = Math.max(200, crossfadeSeconds * 1000);
  const start = performance.now();
  const oldStartGain = oldDeck.gainNode ? oldDeck.gainNode.gain.value : 1;

  function step(now) {
    const t = Math.min(1, (now - start) / durationMs);
    if (oldDeck.gainNode) oldDeck.gainNode.gain.value = oldStartGain * (1 - t);
    if (newDeck.gainNode) newDeck.gainNode.gain.value = t;
    if (t < 1) {
      crossfadeRAF = requestAnimationFrame(step);
    } else {
      finishTransition(oldDeckIdx, newDeckIdx, nextIndex);
    }
  }
  crossfadeRAF = requestAnimationFrame(step);
}

/** Instant deck swap for the gapless path — the next deck is already primed and playing-ready. */
async function swapToPreloadedDeck(nextIndex) {
  const oldDeckIdx = active;
  const newDeckIdx = 1 - active;
  const newDeck = decks[newDeckIdx];

  ensureDeckGraph(newDeck);
  if (newDeck.gainNode) newDeck.gainNode.gain.value = 1;
  try { newDeck.audio.currentTime = 0; } catch (_) {}
  newDeck.audio.playbackRate = playbackRate;

  await resumeAudioGraphIfNeeded();
  ensureSingleSource();
  try {
    await newDeck.audio.play();
  } catch (err) {
    console.error('[Melody] Player: gapless swap failed to start — falling back to a normal load.', err);
    active = oldDeckIdx;
    return loadIndex(nextIndex, { autoplay: true });
  }

  finishTransition(oldDeckIdx, newDeckIdx, nextIndex);
}

function finishTransition(oldDeckIdx, newDeckIdx, nextIndex) {
  crossfading = false;
  crossfadeRAF = null;
  preloadedForIndex = -1;
  active = newDeckIdx;
  index = nextIndex;

  const oldDeck = decks[oldDeckIdx];
  try { oldDeck.audio.pause(); oldDeck.audio.currentTime = 0; } catch (_) {}
  if (oldDeck.gainNode) oldDeck.gainNode.gain.value = 1; // reset for whenever this deck is reused

  consecutiveErrors = 0;
  const song = queue[index];
  if (song) {
    if (lastRecordedSongId !== song.id) {
      lastRecordedSongId = song.id;
      recordPlay(song.id);
    }
    currentArtUrl = DEFAULT_ART_URL;
    getArtworkUrl(song).then((url) => {
      currentArtUrl = url;
      updateMediaSessionMetadata(song, url);
      notify();
    });
    updateMediaSessionMetadata(song, currentArtUrl);
  }
  notify();
}

// ---------- Audio element event wiring (set up once per deck) ----------

decks.forEach((deck) => {
  const a = deck.audio;

  a.addEventListener('timeupdate', () => {
    if (deck !== decks[active]) return;
    notify();
    scheduleSave();
    maybeHandleTrackTransition();
  });

  a.addEventListener('play', () => { if (deck === decks[active]) notify(); });
  a.addEventListener('pause', () => { if (deck === decks[active]) { notify(); persistState(); } });
  a.addEventListener('loadedmetadata', () => { if (deck === decks[active]) notify(); });

  a.addEventListener('playing', () => {
    if (deck !== decks[active]) return;
    const song = queue[index];
    if (!song) return;
    if (lastRecordedSongId !== song.id) {
      lastRecordedSongId = song.id;
      recordPlay(song.id);
    }
  });

  a.addEventListener('ended', () => {
    if (deck !== decks[active]) return; // an old deck finishing out its crossfade tail — ignore
    consecutiveErrors = 0;

    if (repeatMode === 'one') {
      a.currentTime = 0;
      a.play().catch((err) => console.error('[Melody] Player: repeat-one replay failed.', err));
      return;
    }

    const nextIndex = computeNextIndexForAutoAdvance();
    if (nextIndex === null) {
      notify(); // stop cleanly at the end of the queue
      return;
    }

    if (preloadedForIndex === nextIndex) {
      swapToPreloadedDeck(nextIndex);
    } else {
      loadIndex(nextIndex, { autoplay: true });
    }
  });

  a.addEventListener('error', () => {
    if (deck !== decks[active]) return; // priming errors on the inactive deck are non-fatal
    const song = queue[index];
    const label = song ? `"${song.title}"` : 'This song';
    console.error('[Melody] Audio element error while playing', song, a.error);
    handlePlaybackFailure(`${label} couldn't be played — it may be unsupported or corrupted.`);
  });

  a.addEventListener('stalled', () => {
    if (deck === decks[active]) console.warn('[Melody] Player: playback stalled (buffering/network hiccup).');
  });
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
      currentTime: mainAudio().currentTime || 0,
      shuffle,
      repeatMode,
      savedAt: Date.now(),
    });
  } catch (err) {
    console.error('[Melody] Player: failed to persist playback state.', err);
  }
}

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
