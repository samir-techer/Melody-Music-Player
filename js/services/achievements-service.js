/**
 * achievements-service.js
 * Melody Points (MP) + Achievements. Free for every account tier — this
 * is deliberately independent of premium-service/hasPremiumAccess.
 *
 * Storage: users/{uid} in Firestore (same document every other profile
 * field lives on), under these fields:
 *   melodyPoints           number
 *   completedAchievements  string[]   — achievement ids already paid out.
 *                                        An id in this array is NEVER
 *                                        awarded again (see evaluate()).
 *   achievementCounters    { listenSeconds, songsPlayedCount,
 *                             favoritesCount, playlistsCount,
 *                             themesAppliedCount }
 *   streak                 { current, longest, lastDate }
 *   lastDailyRewardDate    "YYYY-MM-DD" | null
 *   achievementHistory     array of { id, icon, label, mp, unlockedAt },
 *                          capped to the most recent 50 entries.
 *
 * All of these are owner-writable under the existing firestore.rules —
 * only role/premiumPlan/premiumExpiry/accountDisabled are admin-locked —
 * so no rules changes were needed to ship this.
 *
 * Sync model: a live onSnapshot listener (same shape as premium-service)
 * keeps the in-memory cache current across tabs/devices for the parts of
 * the UI that just need to *display* MP/progress. Local events (a song
 * crossing 30s, a favorite added, etc.) mutate the cache optimistically
 * and are flushed to Firestore on a short debounce, so a rapid string of
 * timeupdate ticks turns into one write, not dozens.
 *
 * Anti-farming: a play only counts toward "Songs Played" / listening-time
 * achievements once the ACCUMULATED, genuinely-elapsed playback time for
 * that song reaches 30 real seconds (seeks/track-boundary jumps are
 * filtered the same way stats-service already does it). Skipping before
 * 30s simply never credits anything — there is nothing to "farm".
 */

import { doc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { subscribe as subscribePlayer } from './player-service.js';
import { subscribeFavorites } from './favorites-service.js';
import { subscribePlaylists } from './playlist-service.js';

const SAVE_DEBOUNCE_MS = 1200;
const HISTORY_LIMIT = 50;

/* -------------------------------------------------------------------- */
/*  Achievement configuration — the ONLY place new achievements need to  */
/*  be added. Nothing else in this file (or the UI) hardcodes an id.    */
/* -------------------------------------------------------------------- */
export const ACHIEVEMENTS = [
  // 🎧 Listening
  { id: 'listen-first-song', category: 'listening', icon: '🎧', label: 'First Song', metric: 'songsPlayedCount', threshold: 1, mp: 10 },
  { id: 'listen-30-min', category: 'listening', icon: '🎧', label: 'Listen 30 Minutes', metric: 'listenSeconds', threshold: 30 * 60, mp: 10 },
  { id: 'listen-1-hour', category: 'listening', icon: '🎧', label: 'Listen 1 Hour', metric: 'listenSeconds', threshold: 60 * 60, mp: 20 },
  { id: 'listen-10-hours', category: 'listening', icon: '🎧', label: 'Listen 10 Hours', metric: 'listenSeconds', threshold: 10 * 3600, mp: 100 },
  { id: 'listen-50-hours', category: 'listening', icon: '🎧', label: 'Listen 50 Hours', metric: 'listenSeconds', threshold: 50 * 3600, mp: 300 },
  { id: 'listen-100-hours', category: 'listening', icon: '🎧', label: 'Listen 100 Hours', metric: 'listenSeconds', threshold: 100 * 3600, mp: 500 },

  // ❤️ Favorites
  { id: 'fav-first', category: 'favorites', icon: '❤️', label: 'Add First Favorite', metric: 'favoritesCount', threshold: 1, mp: 10 },
  { id: 'fav-25', category: 'favorites', icon: '❤️', label: 'Add 25 Favorites', metric: 'favoritesCount', threshold: 25, mp: 30 },
  { id: 'fav-50', category: 'favorites', icon: '❤️', label: 'Add 50 Favorites', metric: 'favoritesCount', threshold: 50, mp: 60 },
  { id: 'fav-100', category: 'favorites', icon: '❤️', label: 'Add 100 Favorites', metric: 'favoritesCount', threshold: 100, mp: 150 },

  // 📂 Playlists
  { id: 'playlist-first', category: 'playlists', icon: '📂', label: 'Create First Playlist', metric: 'playlistsCount', threshold: 1, mp: 20 },
  { id: 'playlist-5', category: 'playlists', icon: '📂', label: 'Create 5 Playlists', metric: 'playlistsCount', threshold: 5, mp: 50 },
  { id: 'playlist-10', category: 'playlists', icon: '📂', label: 'Create 10 Playlists', metric: 'playlistsCount', threshold: 10, mp: 100 },

  // 🔥 Streaks (free for everyone)
  { id: 'streak-7', category: 'streaks', icon: '🔥', label: '7 Day Streak', metric: 'streakCurrent', threshold: 7, mp: 50 },
  { id: 'streak-15', category: 'streaks', icon: '🔥', label: '15 Day Streak', metric: 'streakCurrent', threshold: 15, mp: 100 },
  { id: 'streak-30', category: 'streaks', icon: '🔥', label: '30 Day Streak', metric: 'streakCurrent', threshold: 30, mp: 250 },
  { id: 'streak-60', category: 'streaks', icon: '🔥', label: '60 Day Streak', metric: 'streakCurrent', threshold: 60, mp: 500 },
  { id: 'streak-100', category: 'streaks', icon: '🔥', label: '100 Day Streak', metric: 'streakCurrent', threshold: 100, mp: 1000 },

  // 🎵 Songs Played
  { id: 'songs-100', category: 'songs', icon: '🎵', label: '100 Songs Played', metric: 'songsPlayedCount', threshold: 100, mp: 30 },
  { id: 'songs-500', category: 'songs', icon: '🎵', label: '500 Songs Played', metric: 'songsPlayedCount', threshold: 500, mp: 150 },
  { id: 'songs-1000', category: 'songs', icon: '🎵', label: '1,000 Songs Played', metric: 'songsPlayedCount', threshold: 1000, mp: 300 },
  { id: 'songs-5000', category: 'songs', icon: '🎵', label: '5,000 Songs Played', metric: 'songsPlayedCount', threshold: 5000, mp: 1000 },

  // 🎨 Themes
  { id: 'theme-first', category: 'themes', icon: '🎨', label: 'Apply First Theme', metric: 'themesAppliedCount', threshold: 1, mp: 20 },
];

const CATEGORY_LABELS = {
  listening: '🎧 Listening',
  favorites: '❤️ Favorites',
  playlists: '📂 Playlists',
  streaks: '🔥 Streaks',
  songs: '🎵 Songs Played',
  themes: '🎨 Themes',
};

function defaultState() {
  return {
    melodyPoints: 0,
    completed: new Set(),
    counters: { listenSeconds: 0, songsPlayedCount: 0, favoritesCount: 0, playlistsCount: 0, themesAppliedCount: 0 },
    streak: { current: 0, longest: 0, lastDate: null },
    lastDailyRewardDate: null,
    history: [],
  };
}

let state = defaultState();
let currentUid = null;
let unsubscribeSnapshot = null;
let saveTimer = null;
let dirty = false;
let applyingRemote = false; // true while a snapshot is being merged in, so we don't re-save what we just received

const changeListeners = new Set();   // fn(snapshotForUI) — MP/progress changed
const unlockListeners = new Set();   // fn({ icon, label, mp }) — fire the reward popup

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function notifyChange() {
  const snap = getAchievementsSnapshot();
  changeListeners.forEach((fn) => {
    try { fn(snap); } catch (err) { console.error('[Melody] Achievements subscriber threw:', err); }
  });
}

function notifyUnlock(payload) {
  unlockListeners.forEach((fn) => {
    try { fn(payload); } catch (err) { console.error('[Melody] Achievement-unlock subscriber threw:', err); }
  });
}

function scheduleSave() {
  if (!currentUid || applyingRemote) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!dirty || !currentUid) return;
    dirty = false;
    const payload = {
      melodyPoints: state.melodyPoints,
      completedAchievements: Array.from(state.completed),
      achievementCounters: state.counters,
      streak: state.streak,
      lastDailyRewardDate: state.lastDailyRewardDate,
      achievementHistory: state.history.slice(-HISTORY_LIMIT),
    };
    try {
      await setDoc(doc(db, 'users', currentUid), payload, { merge: true });
    } catch (err) {
      console.error('[Melody] Achievements: save failed.', err);
    }
  }, SAVE_DEBOUNCE_MS);
}

function metricValue(metric) {
  if (metric === 'streakCurrent') return state.streak.current;
  return state.counters[metric] || 0;
}

/** Checks every not-yet-completed achievement against current counters. */
function evaluate() {
  for (const a of ACHIEVEMENTS) {
    if (state.completed.has(a.id)) continue;
    if (metricValue(a.metric) >= a.threshold) {
      state.completed.add(a.id);
      state.melodyPoints += a.mp;
      state.history.push({ id: a.id, icon: a.icon, label: a.label, mp: a.mp, unlockedAt: Date.now() });
      notifyUnlock({ icon: a.icon, label: a.label, mp: a.mp });
    }
  }
}

function bumpCounterDelta(key, delta) {
  state.counters[key] = (state.counters[key] || 0) + delta;
  evaluate();
  notifyChange();
  scheduleSave();
}

function setCounterAbsolute(key, value) {
  if (state.counters[key] === value) return;
  state.counters[key] = value;
  evaluate();
  notifyChange();
  scheduleSave();
}

function markQualifyingListenToday() {
  const today = todayKey();
  if (state.streak.lastDate === today) return; // already counted today
  const yesterday = todayKey(Date.now() - 24 * 60 * 60 * 1000);
  state.streak.current = state.streak.lastDate === yesterday ? state.streak.current + 1 : 1;
  state.streak.longest = Math.max(state.streak.longest, state.streak.current);
  state.streak.lastDate = today;
  evaluate();
  notifyChange();
  scheduleSave();
}

/* -------------------------------------------------------------------- */
/*  Playback tracking — 30s-real-listening dwell before anything counts */
/* -------------------------------------------------------------------- */
let lastTickTime = null;
let lastSongId = null;
let creditedThisPlay = false;
let accumulatedThisPlay = 0;

subscribePlayer((playerState) => {
  if (!playerState.currentSong) { lastTickTime = null; return; }

  if (playerState.currentSong.id !== lastSongId) {
    lastSongId = playerState.currentSong.id;
    lastTickTime = null;
    creditedThisPlay = false;
    accumulatedThisPlay = 0;
  }

  if (!playerState.isPlaying) { lastTickTime = null; return; }
  if (lastTickTime === null) { lastTickTime = playerState.currentTime; return; }

  const delta = playerState.currentTime - lastTickTime;
  lastTickTime = playerState.currentTime;
  if (!Number.isFinite(delta) || delta <= 0 || delta > 2) return; // ignore seeks/track jumps

  accumulatedThisPlay += delta;
  bumpCounterDelta('listenSeconds', delta);

  // Anti-farming: only credit "a song played" + the day's streak once
  // this specific play has accumulated 30 REAL seconds — repeatedly
  // skipping before that point never earns anything.
  if (!creditedThisPlay && accumulatedThisPlay >= 30) {
    creditedThisPlay = true;
    bumpCounterDelta('songsPlayedCount', 1);
    markQualifyingListenToday();
  }
});

/* -------------------------------------------------------------------- */
/*  Favorites / Playlists — mirror the current count directly           */
/* -------------------------------------------------------------------- */
subscribeFavorites((set) => setCounterAbsolute('favoritesCount', set.size));
subscribePlaylists((list) => setCounterAbsolute('playlistsCount', list.length));

/* -------------------------------------------------------------------- */
/*  Public API                                                          */
/* -------------------------------------------------------------------- */

/** Call once auth resolves a uid (and again with null on sign-out). */
export function initAchievements(uid) {
  if (uid === currentUid) return;
  currentUid = uid;

  if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }

  if (!uid) {
    state = defaultState();
    notifyChange();
    return;
  }

  unsubscribeSnapshot = onSnapshot(
    doc(db, 'users', uid),
    (snap) => {
      const data = snap.data() || {};
      applyingRemote = true;
      state.melodyPoints = data.melodyPoints || 0;
      state.completed = new Set(data.completedAchievements || []);
      state.counters = { ...defaultState().counters, ...(data.achievementCounters || {}) };
      state.streak = { ...defaultState().streak, ...(data.streak || {}) };
      state.lastDailyRewardDate = data.lastDailyRewardDate || null;
      state.history = Array.isArray(data.achievementHistory) ? data.achievementHistory : [];
      applyingRemote = false;
      notifyChange();
    },
    (err) => console.error('[Melody] Achievements: live listener failed.', err),
  );
}

/** Subscribe to MP/progress changes. Immediately called with current state. */
export function subscribeAchievements(listener) {
  changeListeners.add(listener);
  listener(getAchievementsSnapshot());
  return () => changeListeners.delete(listener);
}

/** Subscribe to "an achievement (or daily reward) was just unlocked" events, for the reward popup. */
export function subscribeAchievementUnlocks(listener) {
  unlockListeners.add(listener);
  return () => unlockListeners.delete(listener);
}

export function getMelodyPoints() {
  return state.melodyPoints;
}

/** Full data for the Achievements screen: every config entry + live progress. */
export function getAchievementsSnapshot() {
  const items = ACHIEVEMENTS.map((a) => {
    const value = metricValue(a.metric);
    const percent = Math.max(0, Math.min(100, Math.round((value / a.threshold) * 100)));
    return { ...a, value, percent, completed: state.completed.has(a.id) };
  });
  const nextUp = items.filter((i) => !i.completed).sort((a, b) => b.percent - a.percent)[0] || null;

  return {
    melodyPoints: state.melodyPoints,
    completedCount: state.completed.size,
    totalCount: ACHIEVEMENTS.length,
    streak: state.streak,
    items,
    categories: CATEGORY_LABELS,
    nextUp,
    canClaimDaily: state.lastDailyRewardDate !== todayKey(),
    history: [...state.history].reverse(),
  };
}

/** Once-per-calendar-day +5 MP. Resets naturally at local midnight. */
export function claimDailyReward() {
  const today = todayKey();
  if (state.lastDailyRewardDate === today) return { claimed: false };
  state.lastDailyRewardDate = today;
  state.melodyPoints += 5;
  state.history.push({ id: 'daily-login', icon: '📅', label: 'Daily Login', mp: 5, unlockedAt: Date.now() });
  notifyUnlock({ icon: '📅', label: 'Daily Login', mp: 5 });
  notifyChange();
  scheduleSave();
  return { claimed: true, mp: 5 };
}

/** Called from settings-screen.js right after a premium theme is successfully applied. */
export function recordThemeApplied() {
  bumpCounterDelta('themesAppliedCount', 1);
}

/**
 * Spends MP directly (used by rewards-service.js for theme/coupon
 * redemption). Returns false without spending anything if the balance is
 * insufficient — callers should check this before showing a success state.
 */
export function spendMelodyPoints(amount) {
  if (amount <= 0 || state.melodyPoints < amount) return false;
  state.melodyPoints -= amount;
  notifyChange();
  scheduleSave();
  return true;
}
