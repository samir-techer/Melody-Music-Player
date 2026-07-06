/**
 * history-service.js
 * Records a lightweight "Recently Played" trail — just song ids + a
 * timestamp, capped at MAX_ENTRIES, most-recent-first, deduplicated (a
 * replayed song moves back to the top instead of appearing twice).
 * Actual song data is looked up from library-service by the caller.
 */

import { getItem, setItem } from '../utils/storage.js';

const STORAGE_KEY = 'recentlyPlayed';
const MAX_ENTRIES = 50;

export async function recordPlay(songId) {
  if (!songId) return;
  try {
    const stored = (await getItem(STORAGE_KEY)) || [];
    const filtered = stored.filter((entry) => entry.id !== songId);
    filtered.unshift({ id: songId, playedAt: Date.now() });
    await setItem(STORAGE_KEY, filtered.slice(0, MAX_ENTRIES));
  } catch (err) {
    console.error('[Melody] History: failed to record play.', err);
  }
}

/** Returns [{id, playedAt}], most recent first. */
export async function getRecentlyPlayedEntries() {
  try {
    const stored = (await getItem(STORAGE_KEY)) || [];
    return Array.isArray(stored) ? stored : [];
  } catch (err) {
    console.error('[Melody] History: failed to load.', err);
    return [];
  }
}

export async function clearHistory() {
  await setItem(STORAGE_KEY, []);
}
