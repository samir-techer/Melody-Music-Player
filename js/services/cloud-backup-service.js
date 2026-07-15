/**
 * cloud-backup-service.js
 * Premium (Basic+) — Firestore sync for Favorites, Playlists, Queue, and
 * User Settings, per spec. Song audio itself is local-only (imported
 * files, never uploaded) — what's backed up is the *structure* (which
 * song ids are favorited, which playlist contains which song ids, the
 * last queue + index, and simple settings like theme mode) so it can be
 * restored after a reinstall as long as the same files get re-imported.
 *
 * Elite widens the "Settings" that get backed up to include Equalizer,
 * Audio Processing mode, the selected Premium Theme, and Listening
 * Statistics — see buildFullPayload()'s Elite branch below.
 *
 * "Only upload changed data. Avoid unnecessary Firestore writes." — this
 * keeps an in-memory fingerprint of the last-written payload and skips
 * the write entirely when nothing changed.
 */

import { doc, setDoc, getDoc } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { hasPremiumAccess } from './premium-service.js';
import { getFavoriteIds, subscribeFavorites } from './favorites-service.js';
import { subscribePlaylists } from './playlist-service.js';
import {
  subscribe as subscribePlayer,
  getEqualizerPreset,
  getCleanBass,
  getAudioProcessingMode,
} from './player-service.js';
import { getThemeMode, getSelectedPremiumTheme } from './theme-service.js';
import { getStatsSnapshot } from './stats-service.js';

const REQUIRED_PLAN = 'Basic';
let activeUid = null;
let unsubscribers = [];
let lastFingerprint = null;
let writeTimer = null;

function fingerprint(payload) {
  return JSON.stringify(payload);
}

async function writeBackup(uid, payload) {
  const fp = fingerprint(payload);
  if (fp === lastFingerprint) return; // nothing changed — skip the write
  lastFingerprint = fp;
  try {
    await setDoc(doc(db, 'users', uid), { cloudBackup: payload }, { merge: true });
  } catch (err) {
    console.error('[Melody] Cloud Backup: write failed.', err);
  }
}

function scheduleWrite(uid, buildPayload) {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    try {
      const payload = await buildPayload(uid);
      await writeBackup(uid, payload);
    } catch (err) {
      console.error('[Melody] Cloud Backup: sync failed.', err);
    }
  }, 1200); // small debounce so rapid changes (bulk favoriting, etc.) collapse into one write
}

async function buildFullPayload(uid) {
  const [favoriteIds, playlists, themeMode] = await Promise.all([
    getFavoriteIds().catch(() => []),
    import('./playlist-service.js').then((m) => m.getAllPlaylists()).catch(() => []),
    getThemeMode().catch(() => 'system'),
  ]);
  const playerState = subscribePlayerSnapshotOnce();

  const payload = {
    favoriteIds,
    playlists: playlists.map((p) => ({ id: p.id, name: p.name, songIds: p.songIds })),
    queue: {
      songIds: playerState.queue.map((s) => s.id),
      index: playerState.index,
    },
    settings: { themeMode },
    syncedAt: Date.now(),
  };

  // Elite — Cloud Backup additionally covers Equalizer, Audio Processing,
  // the selected Premium Theme, and Listening Statistics. Everything else
  // (Favorites/Playlists/Settings/Queue) is already backed up at Basic+
  // per spec — Elite just widens what "Settings" and "the account" mean.
  if (hasPremiumAccess('Elite')) {
    const [selectedPremiumTheme, listeningStats] = await Promise.all([
      getSelectedPremiumTheme(uid).catch(() => null),
      getStatsSnapshot().catch(() => null),
    ]);
    payload.settings.equalizerPreset = getEqualizerPreset();
    payload.settings.audioProcessingMode = getAudioProcessingMode();
    payload.settings.cleanBass = getCleanBass();
    payload.settings.premiumTheme = selectedPremiumTheme;
    payload.listeningStats = listeningStats;
  }

  return payload;
}

function subscribePlayerSnapshotOnce() {
  let snap = { queue: [], index: -1 };
  const unsub = subscribePlayer((state) => { snap = state; });
  unsub();
  return snap;
}

/**
 * Starts (or stops) live backup syncing for this account. Safe to call on
 * every boot/settings change — it's a no-op if the account isn't Basic+
 * or hasn't enabled Cloud Backup.
 */
export function setCloudBackupActive(uid, enabled) {
  // Tear down any previous listeners first — avoids stacking duplicate
  // subscriptions if this is toggled on/off repeatedly in one session.
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];
  lastFingerprint = null;
  activeUid = uid;

  if (!uid || !enabled || !hasPremiumAccess(REQUIRED_PLAN)) return;

  const trigger = () => scheduleWrite(uid, buildFullPayload);

  unsubscribers.push(subscribeFavorites(trigger));
  unsubscribers.push(subscribePlaylists(trigger));
  unsubscribers.push(subscribePlayer(trigger));

  trigger(); // initial sync
}

export async function getCloudBackupSnapshot(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? (snap.data().cloudBackup || null) : null;
}
