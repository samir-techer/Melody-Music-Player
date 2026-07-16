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
import { recordSongStart, tickListening, recordSkip as recordStatsSkip } from './stats-service.js';

const PLAYBACK_STATE_KEY = 'playbackState';
const EQ_PRESET_KEY = 'equalizerPreset';
const CLEAN_BASS_KEY = 'cleanBassEnabled';
const AUDIO_PROCESSING_KEY = 'audioProcessingMode';
const ACOUSTIC_MODE_KEY = 'acousticModeEnabled';

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
// Chain: source -> gain (crossfade) -> EQ (bass/mid/treble) -> Clean Bass
//   compressor (free, always present) -> mid/side stereo widening network
//   (Enhanced/Studio) -> loudness/limiter compressor (Enhanced/Studio) ->
//   final anti-clip ceiling (always present) -> destination.
// Everything below Standard tier stays at neutral/unity parameters rather
// than being physically disconnected, so the graph topology is built once
// and plan/setting changes are just parameter automation — no runtime
// rewiring, no risk of leaving the graph in a half-connected state.
let audioCtx = null;
let gainNode = null; // dedicated to crossfade fades — never repurposed for volume/EQ
let eqBass = null;
let eqMid = null;
let eqTreble = null;
let currentEqPreset = 'normal';
let eqSmoothingConstant = 0.05; // shorter = snappier, longer = smoother transitions (Enhanced/Studio use a longer constant)

// Clean Bass (free, ON by default) — a gentle bus compressor tuned to
// catch bass-driven peaks specifically, sitting right after the EQ.
let cleanBassCompressor = null;
let cleanBassEnabled = true;

// Mid/side stereo widening network (Enhanced/Studio only — unity/no-op
// for Standard). See setAudioProcessingMode() for the node graph.
let stereoSplitter = null;
let midGainL = null, midGainR = null, midSum = null;
let sideGainL = null, sideGainR = null, sideSum = null, sideWiden = null;
let reconL = null, reconR = null, reconLFromSide = null, reconRFromSide = null;
let stereoMerger = null;

// Loudness/limiter compressor (Standard: neutral/no-op; Enhanced: gentle
// leveling; Studio: a tighter, more precise limiter).
let processingCompressor = null;

// Always-on final ceiling so nothing downstream can ever hard-clip,
// tuned tighter for Studio ("improved anti-clipping").
let finalLimiter = null;

let currentProcessingMode = 'standard'; // 'standard' | 'enhanced' | 'studio'

/* -------------------------------------------------------------------- */
/*  Acoustic Mode (free, OFF by default) — a real, dedicated DSP        */
/*  subchain, not a preset: Preamp -> EQ (mud cut / presence / air) ->  */
/*  very light convolver reverb (wet/dry mix) -> gentle compressor ->   */
/*  subtle M/S stereo widener -> transparent limiter -> master gain.    */
/*  Spliced right after the user's 3-band Equalizer and before Clean    */
/*  Bass, so it composes with Equalizer, Clean Bass, Enhanced/Studio    */
/*  Audio Processing, and Crossfade rather than replacing any of them.  */
/*  Every node is built once here and left permanently connected —      */
/*  toggling just automates parameters back to a fully transparent      */
/*  unity/no-op state, the same philosophy as Clean Bass/Standard       */
/*  above, so there is never a reconnect, click, or dropout.            */
let acousticEnabled = false;
let acousticPreamp = null;
let acousticEqMud = null;       // peaking ~220Hz — gently reduces muddiness
let acousticEqPresence = null;  // peaking ~3kHz — vocal presence
let acousticEqAir = null;       // highshelf ~10kHz — gentle "air", never harsh
let acousticConvolver = null;   // very short, synthetic small-room impulse
let acousticDryGain = null;
let acousticWetGain = null;
let acousticReverbSum = null;
let acousticCompressor = null;
let acousticSplitter = null;
let acousticMidGainL = null, acousticMidGainR = null, acousticMidSum = null;
let acousticSideGainL = null, acousticSideGainR = null, acousticSideSum = null, acousticSideWiden = null;
let acousticReconL = null, acousticReconR = null, acousticReconLFromSide = null, acousticReconRFromSide = null;
let acousticMerger = null;
let acousticLimiter = null;
let acousticMasterGain = null;

// Analyser tap for the Elite Advanced Audio Visualizer — connected in
// parallel off the final limiter (never inline in the playback chain, so
// it can never affect audio) and only actually pulled from when a
// visualizer is on-screen. Built here (not lazily) so it's always ready
// the moment Elite opens the visualizer, with zero graph rewiring.
let analyserNode = null;

/**
 * Generates a very short, synthetic "small room" impulse response for
 * Acoustic Mode's convolver — dense, fast early reflections with a sharp
 * decay envelope and no long smooth tail, so it reads as "a little bit
 * of room" rather than a hall/cathedral. Built in-memory (no network
 * fetch, no bundled asset), so it works fully offline with local music.
 */
function createSmallRoomImpulse(ctx) {
  const durationSeconds = 0.32; // short decay, per spec
  const decayExponent = 3.2;    // steep curve = dense early reflections, fast falloff
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSeconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const envelope = Math.pow(1 - t, decayExponent);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return impulse;
}

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

    // Clean Bass — available to every plan, ON by default. When enabled,
    // catches bass-driven peaks before they distort; when disabled, it's
    // parked at neutral values (threshold 0dB, ratio 1:1 = a no-op) so
    // the signal passes through completely untouched, preserving the
    // "aggressive bass" behavior the OFF setting promises.
    cleanBassCompressor = audioCtx.createDynamicsCompressor();
    applyCleanBassParams();

    // ---- Mid/side stereo widening network (Enhanced/Studio) ----
    // side = 0.5*(L-R), mid = 0.5*(L+R); widen the side signal, then
    // reconstruct L' = mid + side*w, R' = mid - side*w. At w=1 this is
    // an exact identity (L'=L, R'=R) — that's the Standard/unity state.
    stereoSplitter = audioCtx.createChannelSplitter(2);

    midGainL = audioCtx.createGain(); midGainL.gain.value = 0.5;
    midGainR = audioCtx.createGain(); midGainR.gain.value = 0.5;
    midSum = audioCtx.createGain(); midSum.gain.value = 1;

    sideGainL = audioCtx.createGain(); sideGainL.gain.value = 0.5;
    sideGainR = audioCtx.createGain(); sideGainR.gain.value = -0.5;
    sideSum = audioCtx.createGain(); sideSum.gain.value = 1;
    sideWiden = audioCtx.createGain(); sideWiden.gain.value = 1; // 1 = no widening (Standard)

    reconL = audioCtx.createGain(); reconL.gain.value = 1;        // mid -> L
    reconR = audioCtx.createGain(); reconR.gain.value = 1;        // mid -> R
    reconLFromSide = audioCtx.createGain(); reconLFromSide.gain.value = 1;  // +side -> L
    reconRFromSide = audioCtx.createGain(); reconRFromSide.gain.value = -1; // -side -> R
    stereoMerger = audioCtx.createChannelMerger(2);

    // ---- Acoustic Mode subchain (built once, unity/no-op until enabled) ----
    acousticPreamp = audioCtx.createGain();

    acousticEqMud = audioCtx.createBiquadFilter();
    acousticEqMud.type = 'peaking';
    acousticEqMud.frequency.value = 220; // 150-300Hz muddiness pocket
    acousticEqMud.Q.value = 1.0;

    acousticEqPresence = audioCtx.createBiquadFilter();
    acousticEqPresence.type = 'peaking';
    acousticEqPresence.frequency.value = 3000; // 2-4kHz vocal presence
    acousticEqPresence.Q.value = 1.1;

    acousticEqAir = audioCtx.createBiquadFilter();
    acousticEqAir.type = 'highshelf';
    acousticEqAir.frequency.value = 9500; // 8-12kHz air, gentle so it never turns harsh

    // Very light convolver reverb — parallel wet/dry mix rather than
    // replacing the signal, so "wet" only ever adds a faint sense of
    // space on top of the untouched dry path.
    acousticConvolver = audioCtx.createConvolver();
    acousticConvolver.normalize = true;
    acousticConvolver.buffer = createSmallRoomImpulse(audioCtx);
    acousticDryGain = audioCtx.createGain(); acousticDryGain.gain.value = 1;
    acousticWetGain = audioCtx.createGain(); acousticWetGain.gain.value = 0; // 0 = off
    acousticReverbSum = audioCtx.createGain(); acousticReverbSum.gain.value = 1;

    acousticCompressor = audioCtx.createDynamicsCompressor();

    // Subtle M/S stereo widener — identical technique (and identical
    // mono-compatibility guarantee: L+R always cancels the side term
    // regardless of widen factor) to the Enhanced/Studio network above,
    // duplicated here so Acoustic Mode's stereo image is independently
    // controllable and composes with whatever Audio Processing mode is
    // also active.
    acousticSplitter = audioCtx.createChannelSplitter(2);
    acousticMidGainL = audioCtx.createGain(); acousticMidGainL.gain.value = 0.5;
    acousticMidGainR = audioCtx.createGain(); acousticMidGainR.gain.value = 0.5;
    acousticMidSum = audioCtx.createGain(); acousticMidSum.gain.value = 1;
    acousticSideGainL = audioCtx.createGain(); acousticSideGainL.gain.value = 0.5;
    acousticSideGainR = audioCtx.createGain(); acousticSideGainR.gain.value = -0.5;
    acousticSideSum = audioCtx.createGain(); acousticSideSum.gain.value = 1;
    acousticSideWiden = audioCtx.createGain(); acousticSideWiden.gain.value = 1; // 1 = no widening (off)
    acousticReconL = audioCtx.createGain(); acousticReconL.gain.value = 1;
    acousticReconR = audioCtx.createGain(); acousticReconR.gain.value = 1;
    acousticReconLFromSide = audioCtx.createGain(); acousticReconLFromSide.gain.value = 1;
    acousticReconRFromSide = audioCtx.createGain(); acousticReconRFromSide.gain.value = -1;
    acousticMerger = audioCtx.createChannelMerger(2);

    acousticLimiter = audioCtx.createDynamicsCompressor();
    acousticMasterGain = audioCtx.createGain();

    applyAcousticModeParams(); // sets every node above to its OFF/unity state

    // Loudness/limiter compressor — neutral (no-op) for Standard.
    processingCompressor = audioCtx.createDynamicsCompressor();

    // Always-on final ceiling — prevents hard clipping regardless of
    // tier; Studio tunes it tighter ("improved anti-clipping").
    finalLimiter = audioCtx.createDynamicsCompressor();

    applyProcessingModeParams(); // sets processingCompressor/finalLimiter/sideWiden for 'standard'

    // Wire it all up.
    sourceNode.connect(gainNode).connect(eqBass).connect(eqMid).connect(eqTreble);

    // ---- Acoustic Mode subchain: Preamp -> EQ -> reverb (wet/dry) ->
    // compressor -> stereo widener -> limiter -> master gain ----
    eqTreble.connect(acousticPreamp);
    acousticPreamp.connect(acousticEqMud).connect(acousticEqPresence).connect(acousticEqAir);
    acousticEqAir.connect(acousticDryGain);
    acousticEqAir.connect(acousticConvolver);
    acousticConvolver.connect(acousticWetGain);
    acousticDryGain.connect(acousticReverbSum);
    acousticWetGain.connect(acousticReverbSum);
    acousticReverbSum.connect(acousticCompressor);

    acousticCompressor.connect(acousticSplitter);
    acousticSplitter.connect(acousticMidGainL, 0);
    acousticSplitter.connect(acousticMidGainR, 1);
    acousticMidGainL.connect(acousticMidSum);
    acousticMidGainR.connect(acousticMidSum);
    acousticSplitter.connect(acousticSideGainL, 0);
    acousticSplitter.connect(acousticSideGainR, 1);
    acousticSideGainL.connect(acousticSideSum);
    acousticSideGainR.connect(acousticSideSum);
    acousticSideSum.connect(acousticSideWiden);
    acousticMidSum.connect(acousticReconL);
    acousticSideWiden.connect(acousticReconLFromSide);
    acousticReconL.connect(acousticMerger, 0, 0);
    acousticReconLFromSide.connect(acousticMerger, 0, 0);
    acousticMidSum.connect(acousticReconR);
    acousticSideWiden.connect(acousticReconRFromSide);
    acousticReconR.connect(acousticMerger, 0, 1);
    acousticReconRFromSide.connect(acousticMerger, 0, 1);

    acousticMerger.connect(acousticLimiter).connect(acousticMasterGain);
    acousticMasterGain.connect(cleanBassCompressor);

    cleanBassCompressor.connect(stereoSplitter);
    stereoSplitter.connect(midGainL, 0);
    stereoSplitter.connect(midGainR, 1);
    midGainL.connect(midSum);
    midGainR.connect(midSum);

    stereoSplitter.connect(sideGainL, 0);
    stereoSplitter.connect(sideGainR, 1);
    sideGainL.connect(sideSum);
    sideGainR.connect(sideSum);
    sideSum.connect(sideWiden);

    midSum.connect(reconL);
    sideWiden.connect(reconLFromSide);
    reconL.connect(stereoMerger, 0, 0);
    reconLFromSide.connect(stereoMerger, 0, 0);

    midSum.connect(reconR);
    sideWiden.connect(reconRFromSide);
    reconR.connect(stereoMerger, 0, 1);
    reconRFromSide.connect(stereoMerger, 0, 1);

    stereoMerger.connect(processingCompressor).connect(finalLimiter).connect(audioCtx.destination);

    // Elite visualizer tap — parallel branch, never in the main signal
    // path to destination, so it's physically impossible for it to alter
    // playback even if something misbehaves.
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.75;
    finalLimiter.connect(analyserNode);
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
    eqBass.gain.setTargetAtTime(preset.bass, now, eqSmoothingConstant);
    eqMid.gain.setTargetAtTime(preset.mid, now, eqSmoothingConstant);
    eqTreble.gain.setTargetAtTime(preset.treble, now, eqSmoothingConstant);
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

/* -------------------------------------------------------------------- */
/*  Clean Bass — free for every plan, ON by default                      */
/* -------------------------------------------------------------------- */

function applyCleanBassParams() {
  if (!cleanBassCompressor || !audioCtx) return;
  const now = audioCtx.currentTime;
  const c = cleanBassCompressor;
  if (cleanBassEnabled) {
    // Tuned toward the low end: a fairly low threshold with a soft knee
    // so it engages before bass boosts start distorting, fast enough to
    // catch transient bass hits without visibly pumping the mix.
    c.threshold.setTargetAtTime(-18, now, 0.05);
    c.knee.setTargetAtTime(12, now, 0.05);
    c.ratio.setTargetAtTime(6, now, 0.05);
    c.attack.setTargetAtTime(0.003, now, 0.02);
    c.release.setTargetAtTime(0.15, now, 0.05);
  } else {
    // Neutral / no-op — passes the signal through untouched, preserving
    // the louder, more aggressive (and potentially distorting) bass the
    // OFF state explicitly promises.
    c.threshold.setTargetAtTime(0, now, 0.05);
    c.knee.setTargetAtTime(0, now, 0.05);
    c.ratio.setTargetAtTime(1, now, 0.05);
    c.attack.setTargetAtTime(0.02, now, 0.02);
    c.release.setTargetAtTime(0.05, now, 0.05);
  }
}

export function setCleanBass(enabled) {
  cleanBassEnabled = Boolean(enabled);
  setItem(CLEAN_BASS_KEY, cleanBassEnabled).catch(() => {});
  ensureAudioGraph();
  applyCleanBassParams();
  return cleanBassEnabled;
}

export function getCleanBass() {
  return cleanBassEnabled;
}

/** Loads the saved Clean Bass preference (default ON) — call once at boot. */
export async function initCleanBassFromStorage() {
  const saved = await getItem(CLEAN_BASS_KEY).catch(() => null);
  setCleanBass(saved === null || saved === undefined ? true : Boolean(saved));
}

/* -------------------------------------------------------------------- */
/*  Audio Processing — Standard (Free) / Enhanced (Plus) / Studio (Elite) */
/* -------------------------------------------------------------------- */

export const AUDIO_PROCESSING_MODES = {
  standard: { key: 'standard', label: 'Standard', requiredPlan: 'Free' },
  enhanced: { key: 'enhanced', label: 'Enhanced', requiredPlan: 'Plus' },
  studio: { key: 'studio', label: 'Studio', requiredPlan: 'Elite' },
};

function applyProcessingModeParams() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const mode = currentProcessingMode;

  if (mode === 'standard') {
    // Everything neutral/unity — Standard's audio path is identical to
    // Melody's original single-band-EQ-only chain.
    sideWiden.gain.setTargetAtTime(1, now, 0.05);       // no stereo widening
    processingCompressor.threshold.setTargetAtTime(0, now, 0.05);
    processingCompressor.ratio.setTargetAtTime(1, now, 0.05);
    processingCompressor.knee.setTargetAtTime(0, now, 0.05);
    processingCompressor.attack.setTargetAtTime(0.02, now, 0.02);
    processingCompressor.release.setTargetAtTime(0.05, now, 0.05);
    finalLimiter.threshold.setTargetAtTime(-1, now, 0.05); // light safety ceiling only
    finalLimiter.ratio.setTargetAtTime(4, now, 0.05);
    finalLimiter.knee.setTargetAtTime(6, now, 0.05);
    eqSmoothingConstant = 0.05;
  } else if (mode === 'enhanced') {
    // Plus — "better loudness balancing", "smoother EQ transitions",
    // "better stereo imaging", "reduced processing artifacts".
    sideWiden.gain.setTargetAtTime(1.25, now, 0.4); // modest, gentle widening
    processingCompressor.threshold.setTargetAtTime(-24, now, 0.05);
    processingCompressor.ratio.setTargetAtTime(3, now, 0.05);
    processingCompressor.knee.setTargetAtTime(18, now, 0.05); // soft knee = fewer audible artifacts
    processingCompressor.attack.setTargetAtTime(0.01, now, 0.02);
    processingCompressor.release.setTargetAtTime(0.25, now, 0.05);
    finalLimiter.threshold.setTargetAtTime(-0.5, now, 0.05);
    finalLimiter.ratio.setTargetAtTime(8, now, 0.05);
    finalLimiter.knee.setTargetAtTime(4, now, 0.05);
    eqSmoothingConstant = 0.15; // smoother EQ transitions
  } else if (mode === 'studio') {
    // Elite — "highest precision", "advanced limiter", "better dynamic
    // range", "improved anti-clipping", "highest quality playback path".
    sideWiden.gain.setTargetAtTime(1.4, now, 0.4); // wider, still natural
    processingCompressor.threshold.setTargetAtTime(-20, now, 0.05);
    processingCompressor.ratio.setTargetAtTime(2.5, now, 0.05); // gentler ratio preserves more dynamic range
    processingCompressor.knee.setTargetAtTime(24, now, 0.05);  // very soft knee, most transparent
    processingCompressor.attack.setTargetAtTime(0.008, now, 0.02);
    processingCompressor.release.setTargetAtTime(0.3, now, 0.05);
    finalLimiter.threshold.setTargetAtTime(-0.2, now, 0.05); // tightest ceiling = most precise anti-clip
    finalLimiter.ratio.setTargetAtTime(20, now, 0.05);        // near brick-wall = "advanced limiter"
    finalLimiter.knee.setTargetAtTime(2, now, 0.05);
    eqSmoothingConstant = 0.2; // smoothest of all three tiers
  }
}

/**
 * Sets the Audio Processing mode. Free accounts are always forced to
 * "standard" here — same enforcement pattern as the equalizer — so the
 * actual audio path can never end up in Enhanced/Studio without a
 * verified Plus/Elite plan, regardless of what's stored locally or what
 * the Settings UI shows.
 */
export function setAudioProcessingMode(modeKey) {
  const requested = AUDIO_PROCESSING_MODES[modeKey] ? modeKey : 'standard';
  const allowed = hasPremiumAccess(AUDIO_PROCESSING_MODES[requested].requiredPlan) ? requested : 'standard';
  currentProcessingMode = allowed;
  setItem(AUDIO_PROCESSING_KEY, allowed).catch(() => {});
  ensureAudioGraph();
  applyProcessingModeParams();
  return allowed;
}

export function getAudioProcessingMode() {
  return currentProcessingMode;
}

/** Loads the saved mode (if any) and re-applies plan gating — call once at boot. */
export async function initAudioProcessingFromStorage() {
  const saved = await getItem(AUDIO_PROCESSING_KEY).catch(() => null);
  setAudioProcessingMode(saved || 'standard');
}

/* -------------------------------------------------------------------- */
/*  Acoustic Mode — free for every plan, OFF by default                  */
/* -------------------------------------------------------------------- */

function applyAcousticModeParams() {
  if (!audioCtx || !acousticPreamp) return;
  const now = audioCtx.currentTime;
  const t = 0.06; // shared smoothing constant — click-free, still responsive

  if (acousticEnabled) {
    // Preamp: a touch of headroom before the EQ boosts below.
    acousticPreamp.gain.setTargetAtTime(0.9, now, t);

    // EQ: reduce mud, lift presence, add gentle air. Bass (<150Hz) is
    // untouched on purpose to preserve warmth; nothing above ~12kHz is
    // touched so treble never turns harsh.
    acousticEqMud.gain.setTargetAtTime(-2.5, now, t);
    acousticEqMud.Q.setTargetAtTime(1.0, now, t);
    acousticEqPresence.gain.setTargetAtTime(2.0, now, t);
    acousticEqPresence.Q.setTargetAtTime(1.1, now, t);
    acousticEqAir.gain.setTargetAtTime(1.5, now, t);

    // Reverb: very light — most of the signal stays dry, only a faint
    // sense of space is blended in. Short decay handles "no cathedral".
    acousticDryGain.gain.setTargetAtTime(1, now, t);
    acousticWetGain.gain.setTargetAtTime(0.07, now, t);

    // Compressor: gentle — preserves dynamics, avoids pumping, just
    // rounds off harsh peaks.
    acousticCompressor.threshold.setTargetAtTime(-20, now, t);
    acousticCompressor.knee.setTargetAtTime(20, now, t);
    acousticCompressor.ratio.setTargetAtTime(1.8, now, t);
    acousticCompressor.attack.setTargetAtTime(0.015, now, 0.02);
    acousticCompressor.release.setTargetAtTime(0.25, now, t);

    // Stereo: very subtle widening. The M/S math cancels the side term
    // whenever L+R are summed, so this stays mono-compatible at any
    // widen factor — 1.12 was chosen to be felt, not heard as an effect.
    acousticSideWiden.gain.setTargetAtTime(1.12, now, 0.4);

    // Limiter: transparent, fast enough to catch anything the stages
    // above let through, well ahead of the app's own always-on ceiling.
    acousticLimiter.threshold.setTargetAtTime(-1.2, now, t);
    acousticLimiter.knee.setTargetAtTime(3, now, t);
    acousticLimiter.ratio.setTargetAtTime(10, now, t);
    acousticLimiter.attack.setTargetAtTime(0.002, now, 0.01);
    acousticLimiter.release.setTargetAtTime(0.06, now, t);

    // Master gain: small compensation so the compressor's gain reduction
    // doesn't read as "quieter" — kept modest, the limiter (both this
    // one and the app's final ceiling) is the actual clip safety net.
    acousticMasterGain.gain.setTargetAtTime(1.05, now, t);
  } else {
    // Fully transparent / unity — identical to the signal path before
    // Acoustic Mode existed. Nothing here is disconnected, only
    // automated back to a no-op, so re-enabling never clicks or drops.
    acousticPreamp.gain.setTargetAtTime(1, now, t);
    acousticEqMud.gain.setTargetAtTime(0, now, t);
    acousticEqPresence.gain.setTargetAtTime(0, now, t);
    acousticEqAir.gain.setTargetAtTime(0, now, t);
    acousticDryGain.gain.setTargetAtTime(1, now, t);
    acousticWetGain.gain.setTargetAtTime(0, now, t);
    acousticCompressor.threshold.setTargetAtTime(0, now, t);
    acousticCompressor.knee.setTargetAtTime(0, now, t);
    acousticCompressor.ratio.setTargetAtTime(1, now, t);
    acousticCompressor.attack.setTargetAtTime(0.02, now, 0.02);
    acousticCompressor.release.setTargetAtTime(0.05, now, t);
    acousticSideWiden.gain.setTargetAtTime(1, now, 0.4);
    acousticLimiter.threshold.setTargetAtTime(0, now, t);
    acousticLimiter.knee.setTargetAtTime(0, now, t);
    acousticLimiter.ratio.setTargetAtTime(1, now, t);
    acousticLimiter.attack.setTargetAtTime(0.02, now, 0.01);
    acousticLimiter.release.setTargetAtTime(0.05, now, t);
    acousticMasterGain.gain.setTargetAtTime(1, now, t);
  }
}

/**
 * Toggles Acoustic Mode. Free for every plan — this is an audio-quality
 * feature, not a gated one. Composes with the Equalizer, Clean Bass,
 * Audio Processing mode, and Crossfade, since it's simply spliced into
 * the same always-connected graph rather than replacing any stage.
 */
export function setAcousticMode(enabled) {
  acousticEnabled = Boolean(enabled);
  setItem(ACOUSTIC_MODE_KEY, acousticEnabled).catch(() => {});
  ensureAudioGraph();
  applyAcousticModeParams();
  return acousticEnabled;
}

export function getAcousticMode() {
  return acousticEnabled;
}

/** Loads the saved Acoustic Mode preference (default OFF) — call once at boot. */
export async function initAcousticModeFromStorage() {
  const saved = await getItem(ACOUSTIC_MODE_KEY).catch(() => null);
  setAcousticMode(Boolean(saved));
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

  // Fire-and-forget — never block starting the new queue on this.
  pushQueueHistoryIfElite(queue).catch(() => {});

  const limit = queueLimitForCurrentPlan();
  if (songs.length > limit) {
    // Keep a `limit`-sized window centered on the requested start index
    // rather than just truncating from 0, so "play this song" still
    // plays THIS song even deep in a long list.
    const windowStart = Math.max(0, Math.min(startIndex - Math.floor(limit / 2), songs.length - limit));
    songs = songs.slice(windowStart, windowStart + limit);
    startIndex -= windowStart;
    showToast(`Free and Basic queues are capped at ${QUEUE_LIMIT_FREE_BASIC} songs — upgrade to Plus for an unlimited queue.`);
  }

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
  recordStatsSkip().catch(() => {});

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

// Premium — Unlimited Queue (Plus+). Free/Basic get a generous but real
// cap; Plus and above have none. Chosen high enough that it never bites
// normal listening, but it's a genuine limit, not just a marketing line.
const QUEUE_LIMIT_FREE_BASIC = 200;

function queueLimitForCurrentPlan() {
  return hasPremiumAccess('Plus') ? Infinity : QUEUE_LIMIT_FREE_BASIC;
}

/** Append a song to the end of the queue without interrupting playback. */
export function addToQueue(song) {
  if (!song) return;
  if (queue.length >= queueLimitForCurrentPlan()) {
    showToast(`Free and Basic queues are capped at ${QUEUE_LIMIT_FREE_BASIC} songs — upgrade to Plus for an unlimited queue.`);
    return;
  }
  queue.push(song);
  if (shuffle) shuffleOrder.push(queue.length - 1);
  notify();
}

/** Insert a song to play immediately after the current one. */
export function playNext(song) {
  if (!song) return;
  if (queue.length >= queueLimitForCurrentPlan()) {
    showToast(`Free and Basic queues are capped at ${QUEUE_LIMIT_FREE_BASIC} songs — upgrade to Plus for an unlimited queue.`);
    return;
  }
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

/* -------------------------------------------------------------------- */
/*  Elite — Advanced Audio Visualizer                                     */
/* -------------------------------------------------------------------- */
// Read-only tap into the live signal, wired in ensureAudioGraph() as a
// parallel branch off the final limiter. Returns null until the graph
// has been built (i.e. before the first user-gesture play), which the
// visualizer component handles by simply drawing nothing that frame.
export function getAnalyserNode() {
  ensureAudioGraph();
  return analyserNode;
}

/* -------------------------------------------------------------------- */
/*  Elite — Smart Queue                                                   */
/* -------------------------------------------------------------------- */
// Save Queue / Restore Queue / Queue History, gated to Elite. Stored
// locally (via storage.js) rather than in Firestore directly — Cloud
// Backup (Elite) picks these up as part of its normal payload so they
// still travel with the account, without duplicating the sync logic here.
const SAVED_QUEUE_KEY = 'eliteSavedQueue';
const QUEUE_HISTORY_KEY = 'eliteQueueHistory';
const QUEUE_HISTORY_MAX = 10;

function queueSignature(songs) {
  return songs.map((s) => s.id).join(',');
}

/** Called automatically whenever a *different* queue replaces a non-empty
 *  one (Elite only) — this is what makes "Queue History" build itself up
 *  passively instead of requiring an explicit save every time. */
async function pushQueueHistoryIfElite(previousQueue) {
  if (!hasPremiumAccess('Elite') || !previousQueue || previousQueue.length === 0) return;
  try {
    const history = (await getItem(QUEUE_HISTORY_KEY)) || [];
    const sig = queueSignature(previousQueue);
    if (history[0]?.signature === sig) return; // avoid back-to-back duplicate entries
    history.unshift({
      signature: sig,
      songIds: previousQueue.map((s) => s.id),
      titles: previousQueue.slice(0, 3).map((s) => s.title),
      count: previousQueue.length,
      at: Date.now(),
    });
    await setItem(QUEUE_HISTORY_KEY, history.slice(0, QUEUE_HISTORY_MAX));
  } catch (err) {
    console.error('[Melody] Smart Queue: failed to record history.', err);
  }
}

/** Explicit "Save Queue" — snapshots the current queue + position. */
export async function saveQueueSnapshot() {
  if (!hasPremiumAccess('Elite')) return null;
  if (queue.length === 0) return null;
  const snap = { songIds: queue.map((s) => s.id), index, savedAt: Date.now() };
  await setItem(SAVED_QUEUE_KEY, snap);
  return snap;
}

export async function getSavedQueueSnapshot() {
  if (!hasPremiumAccess('Elite')) return null;
  return (await getItem(SAVED_QUEUE_KEY).catch(() => null)) || null;
}

async function resolveSongIds(ids) {
  const songs = await Promise.all(ids.map((id) => getSong(id).catch(() => null)));
  return songs.filter(Boolean);
}

/** "Restore Queue" — brings back the last explicitly-saved queue. */
export async function restoreQueueSnapshot() {
  if (!hasPremiumAccess('Elite')) return false;
  const snap = await getSavedQueueSnapshot();
  if (!snap?.songIds?.length) return false;
  const songs = await resolveSongIds(snap.songIds);
  if (songs.length === 0) return false;
  await loadQueue(songs, Math.min(snap.index, songs.length - 1));
  return true;
}

export async function getQueueHistory() {
  if (!hasPremiumAccess('Elite')) return [];
  return (await getItem(QUEUE_HISTORY_KEY).catch(() => [])) || [];
}

/** Restore a specific past queue from history by its index in the list. */
export async function restoreQueueFromHistory(historyIndex) {
  if (!hasPremiumAccess('Elite')) return false;
  const history = await getQueueHistory();
  const entry = history[historyIndex];
  if (!entry?.songIds?.length) return false;
  const songs = await resolveSongIds(entry.songIds);
  if (songs.length === 0) return false;
  await loadQueue(songs, 0);
  return true;
}

/**
 * Smart Queue suggestions — a lightweight, fully-local heuristic (no
 * network/AI call): ranks `candidateSongs` (typically the user's whole
 * library, passed in by the caller) by play count, favors songs sharing
 * an artist or genre with the currently playing track, and excludes
 * anything already queued. Deterministic and instant.
 */
export function getSmartQueueSuggestions(candidateSongs, count = 5) {
  if (!hasPremiumAccess('Elite') || !Array.isArray(candidateSongs)) return [];
  const queuedIds = new Set(queue.map((s) => s.id));
  const current = queue[index];

  const scored = candidateSongs
    .filter((s) => !queuedIds.has(s.id))
    .map((s) => {
      let score = (s.playCount || 0);
      if (current) {
        if (s.artist && s.artist === current.artist) score += 8;
        if (s.genre && s.genre === current.genre) score += 4;
      }
      return { song: s, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((entry) => entry.song);

  return scored;
}

// ---------- Audio element event wiring (set up once) ----------

audio.addEventListener('timeupdate', notify);
audio.addEventListener('timeupdate', () => tickListening(audio.currentTime, !audio.paused));
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
    recordSongStart(song).catch((err) => console.error('[Melody] Stats: song-start record failed.', err));

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
