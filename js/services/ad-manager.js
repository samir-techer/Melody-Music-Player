/**
 * ad-manager.js
 * Dedicated manager for the audio advertisement system. Deliberately
 * separate from player-service.js — player-service just calls
 * `await adManager.notifySongCompleted()` at each song boundary (natural
 * end or manual Next) and otherwise knows nothing about ads.
 *
 * Rules implemented (see spec):
 *  - Free: one ad every 6 completed songs (manual Next OR natural end
 *    both count). Counter resets once the ad finishes.
 *  - Basic / Plus / Elite: never hear an ad, full stop — verified live
 *    against Firestore via hasPremiumAccess(), never a cached/local flag.
 *  - If the account upgrades mid-session, no further ad is scheduled,
 *    and an ad already mid-playback is stopped immediately and the song
 *    resumes — an active Basic+ plan should never hear an ad, including
 *    in that split-second edge case.
 *  - Ad files are never hardcoded: the folder's contents are read from
 *    assets/audio/ad/manifest.json (see scripts/generate-ad-manifest.js —
 *    Melody has no backend, so a static manifest is the practical
 *    equivalent of "auto-load whatever is in the folder" for a
 *    client-only app).
 *  - Missing/empty manifest, or a clip that fails to load: skip safely,
 *    log it, never crash, never block music.
 */

import { hasPremiumAccess, subscribePremium } from './premium-service.js';

const MANIFEST_URL = './assets/audio/ad/manifest.json';
const AD_DIR = './assets/audio/ad/';
const SONGS_BETWEEN_ADS = 6;
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg'];

let adFiles = [];          // full URLs, built from the manifest
let initPromise = null;    // in-flight/completed init, so concurrent callers share one fetch
let lastPlayedUrl = null;
let completedSongs = 0;

let isAdPlaying = false;
let currentAdAudio = null;
let currentAdResolve = null; // resolves notifySongCompleted()'s pending promise once the ad ends

const listeners = new Set();

function notify() {
  const state = getState();
  listeners.forEach((fn) => {
    try { fn(state); } catch (err) { console.error('[Melody] AdManager subscriber threw:', err); }
  });
}

export function subscribe(listener) {
  listeners.add(listener);
  listener(getState());
  return () => listeners.delete(listener);
}

export function getState() {
  return {
    isAdPlaying,
    currentTime: currentAdAudio?.currentTime || 0,
    duration: (currentAdAudio && Number.isFinite(currentAdAudio.duration)) ? currentAdAudio.duration : 0,
  };
}

/** Loads the manifest once. Safe to call repeatedly/concurrently — only fetches the first time. */
export function initAdManager() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
      const data = await res.json();
      const names = Array.isArray(data?.files) ? data.files : [];
      adFiles = names
        .filter((name) => SUPPORTED_EXTENSIONS.includes(getExtension(name)))
        .map((name) => AD_DIR + name);
    } catch (err) {
      console.error('[Melody] AdManager: could not load ad manifest — ads disabled for this session.', err);
      adFiles = []; // empty folder / missing manifest -> ads skipped safely, never a crash
    }
  })();

  // If the account upgrades while an ad happens to be mid-playback, stop
  // it immediately rather than let a Basic+ account finish hearing it.
  subscribePremium((state) => {
    if (state.ready && hasPremiumAccess('Basic') && isAdPlaying) {
      stopAdImmediately();
    }
  });

  return initPromise;
}

function getExtension(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

function pickAdUrl() {
  if (adFiles.length === 0) return null;
  if (adFiles.length === 1) return adFiles[0];
  // Avoid repeating the same ad twice in a row whenever more than one exists.
  const candidates = adFiles.filter((url) => url !== lastPlayedUrl);
  const pool = candidates.length > 0 ? candidates : adFiles;
  return pool[Math.floor(Math.random() * pool.length)];
}

function stopAdImmediately() {
  if (!currentAdAudio) return;
  currentAdAudio.pause();
  finishAd();
}

function finishAd() {
  isAdPlaying = false;
  currentAdAudio = null;
  notify();
  if (currentAdResolve) {
    const resolve = currentAdResolve;
    currentAdResolve = null;
    resolve();
  }
}

function playAd(url) {
  return new Promise((resolve) => {
    currentAdResolve = resolve;
    isAdPlaying = true;
    lastPlayedUrl = url;
    notify();

    const adAudio = new Audio(url);
    currentAdAudio = adAudio;

    const onEnded = () => finishAd();
    const onError = (e) => {
      console.error('[Melody] AdManager: ad clip failed to load/play — resuming music immediately.', e);
      finishAd();
    };
    const onTimeUpdate = () => notify();

    adAudio.addEventListener('ended', onEnded, { once: true });
    adAudio.addEventListener('error', onError, { once: true });
    adAudio.addEventListener('timeupdate', onTimeUpdate);

    adAudio.play().catch(onError);
  });
}

/**
 * Call this at every song-completion boundary — natural end AND manual
 * Next both count. Resolves immediately if no ad is due right now;
 * resolves after the ad finishes if one plays. Never throws.
 */
export async function notifySongCompleted() {
  try {
    if (hasPremiumAccess('Basic')) return; // Basic/Plus/Elite — never counted, never scheduled

    completedSongs += 1;
    if (completedSongs < SONGS_BETWEEN_ADS) return;

    completedSongs = 0; // reset regardless of whether a clip actually played
    await initAdManager();
    const url = pickAdUrl();
    if (!url) return; // empty folder — skip safely

    await playAd(url);
  } catch (err) {
    // Absolute last resort — an ad should never be able to stall playback.
    console.error('[Melody] AdManager: unexpected error — resuming music.', err);
    finishAd();
  }
}

export function isAdCurrentlyPlaying() {
  return isAdPlaying;
}
