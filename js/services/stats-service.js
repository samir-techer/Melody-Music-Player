/**
 * stats-service.js
 * Elite — Advanced Listening Insights. A lightweight, fully-local
 * aggregator (no analytics backend) that player-service feeds directly:
 *   - recordSongStart(song)   -> on every new-song play start
 *   - tickListening(time, isPlaying) -> on every 'timeupdate', accumulates
 *                                        real listened seconds (pauses and
 *                                        seeks are naturally excluded)
 *   - recordSkip()            -> on every manual "Next"
 *
 * Stored under a single "listeningStats" key via storage.js (debounced
 * writes) rather than a dedicated IndexedDB store, since this is small,
 * flat, aggregate data — no need for a schema/version bump.
 *
 * "Most Played Songs" deliberately is NOT duplicated here — it reads
 * library-service's existing per-song playCount (already tracked for the
 * Music Hub), so there's exactly one source of truth for that number.
 */

import { getItem, setItem } from '../utils/storage.js';
import { hasPremiumAccess } from './premium-service.js';

const STATS_KEY = 'listeningStats';
const SESSION_GAP_MS = 10 * 60 * 1000; // >10 min idle between plays starts a new "session"
const SAVE_DEBOUNCE_MS = 1500;

let stats = null;
let lastTickSongTime = null; // audio.currentTime at the previous tick, for delta accumulation
let saveTimer = null;
let dirty = false;

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function defaultStats() {
  return {
    totalListeningMs: 0,
    totalSongsPlayed: 0,
    totalSkips: 0,
    dailyMs: {},
    artistPlayCounts: {},
    genrePlayCounts: {},
    streak: { current: 0, longest: 0, lastDate: null },
    sessionCount: 0,
    lastActivityAt: 0,
  };
}

async function ensureLoaded() {
  if (stats) return stats;
  const saved = await getItem(STATS_KEY).catch(() => null);
  stats = { ...defaultStats(), ...(saved || {}) };
  stats.dailyMs = { ...(saved?.dailyMs || {}) };
  stats.artistPlayCounts = { ...(saved?.artistPlayCounts || {}) };
  stats.genrePlayCounts = { ...(saved?.genrePlayCounts || {}) };
  stats.streak = { ...defaultStats().streak, ...(saved?.streak || {}) };
  return stats;
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!dirty || !stats) return;
    dirty = false;
    await setItem(STATS_KEY, stats).catch((err) => console.error('[Melody] Stats: save failed.', err));
  }, SAVE_DEBOUNCE_MS);
}

function updateStreak(now) {
  const today = todayKey(now);
  if (stats.streak.lastDate === today) return; // already counted today
  const yesterday = todayKey(now - 24 * 60 * 60 * 1000);
  stats.streak.current = stats.streak.lastDate === yesterday ? stats.streak.current + 1 : 1;
  stats.streak.longest = Math.max(stats.streak.longest, stats.streak.current);
  stats.streak.lastDate = today;
}

/** Call once at boot so the first render has data ready. */
export async function initStats() {
  await ensureLoaded();
}

/** Called once per song-start (dedup already handled by the caller). */
export async function recordSongStart(song) {
  if (!hasPremiumAccess('Elite')) return;
  await ensureLoaded();
  const now = Date.now();
  stats.totalSongsPlayed += 1;
  if (song?.artist) stats.artistPlayCounts[song.artist] = (stats.artistPlayCounts[song.artist] || 0) + 1;
  if (song?.genre) stats.genrePlayCounts[song.genre] = (stats.genrePlayCounts[song.genre] || 0) + 1;

  if (!stats.lastActivityAt || (now - stats.lastActivityAt) > SESSION_GAP_MS) {
    stats.sessionCount += 1;
  }
  stats.lastActivityAt = now;
  updateStreak(now);
  lastTickSongTime = null; // reset the per-song accumulator baseline
  scheduleSave();
}

/** Called on every 'timeupdate' — accumulates genuinely-listened time only. */
export function tickListening(currentTime, isPlaying) {
  if (!hasPremiumAccess('Elite') || !stats || !isPlaying) { lastTickSongTime = null; return; }
  if (lastTickSongTime === null) { lastTickSongTime = currentTime; return; }
  const delta = currentTime - lastTickSongTime;
  lastTickSongTime = currentTime;
  if (!Number.isFinite(delta) || delta <= 0 || delta > 2) return; // ignore seeks/track boundaries
  const ms = delta * 1000;
  stats.totalListeningMs += ms;
  stats.dailyMs[todayKey()] = (stats.dailyMs[todayKey()] || 0) + ms;
  stats.lastActivityAt = Date.now();
  scheduleSave();
}

export async function recordSkip() {
  if (!hasPremiumAccess('Elite')) return;
  await ensureLoaded();
  stats.totalSkips += 1;
  scheduleSave();
}

function sumLastNDays(dailyMs, n) {
  let total = 0;
  for (let i = 0; i < n; i++) total += dailyMs[todayKey(Date.now() - i * 86400000)] || 0;
  return total;
}

function buildLastNDays(dailyMs, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const ts = Date.now() - i * 86400000;
    const key = todayKey(ts);
    out.push({ date: key, label: new Date(ts).toLocaleDateString(undefined, { weekday: 'short' }), ms: dailyMs[key] || 0 });
  }
  return out;
}

/** Full snapshot for the Listening Insights screen. */
export async function getStatsSnapshot() {
  await ensureLoaded();
  const topArtists = Object.entries(stats.artistPlayCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topGenres = Object.entries(stats.genrePlayCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const avgSessionMs = stats.sessionCount > 0 ? stats.totalListeningMs / stats.sessionCount : 0;

  return {
    totalListeningMs: stats.totalListeningMs,
    totalSongsPlayed: stats.totalSongsPlayed,
    totalSkips: stats.totalSkips,
    last7Days: buildLastNDays(stats.dailyMs, 7),
    todayMs: stats.dailyMs[todayKey()] || 0,
    weekMs: sumLastNDays(stats.dailyMs, 7),
    monthMs: sumLastNDays(stats.dailyMs, 30),
    topArtists,
    topGenres,
    streak: stats.streak,
    sessionCount: stats.sessionCount,
    avgSessionMs,
  };
}

export async function clearStats() {
  stats = defaultStats();
  await setItem(STATS_KEY, stats).catch(() => {});
}
