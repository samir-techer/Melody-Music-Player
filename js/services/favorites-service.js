/**
 * favorites-service.js
 * Tracks which song ids the user has hearted. Backed by a single array in
 * the shared kv store (favorites are just a list of song ids — the songs
 * themselves still live in library-service). A tiny pub/sub lets any
 * screen (Home, Library, Search, Player) reflect a heart toggle instantly
 * without re-fetching or re-rendering the whole screen.
 */

import { getItem, setItem } from '../utils/storage.js';

const STORAGE_KEY = 'favorites';
const listeners = new Set();

let cache = null; // Set<string> once loaded, so repeated calls don't hit IndexedDB

async function loadCache() {
  if (cache) return cache;
  try {
    const stored = await getItem(STORAGE_KEY);
    cache = new Set(Array.isArray(stored) ? stored : []);
  } catch (err) {
    console.error('[Melody] Favorites: failed to load — starting empty.', err);
    cache = new Set();
  }
  return cache;
}

async function persist() {
  try {
    await setItem(STORAGE_KEY, Array.from(cache));
  } catch (err) {
    console.error('[Melody] Favorites: failed to save.', err);
  }
  listeners.forEach((fn) => {
    try { fn(new Set(cache)); } catch (err) { console.error('[Melody] Favorites subscriber threw:', err); }
  });
}

/** Subscribe to favorites changes. Immediately called with the current set. */
export function subscribeFavorites(listener) {
  loadCache().then((set) => listener(new Set(set)));
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getFavoriteIds() {
  const set = await loadCache();
  return Array.from(set);
}

export async function isFavorite(songId) {
  const set = await loadCache();
  return set.has(songId);
}

export async function toggleFavorite(songId) {
  const set = await loadCache();
  const wasFavorite = set.has(songId);
  if (wasFavorite) set.delete(songId); else set.add(songId);
  await persist();
  return !wasFavorite;
}

export async function setFavorite(songId, isFav) {
  const set = await loadCache();
  if (isFav) set.add(songId); else set.delete(songId);
  await persist();
}
