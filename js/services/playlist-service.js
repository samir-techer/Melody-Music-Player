/**
 * playlist-service.js
 * Owns the "playlists" object store. A playlist is just a name + an
 * ordered list of song ids — the songs themselves still live in
 * library-service. A tiny pub/sub (same pattern as favorites-service)
 * lets the Library screen and the "Add to Playlist" sheet stay in sync
 * without re-fetching.
 *
 * Playlist record shape:
 * {
 *   id: string,        // uuid
 *   name: string,
 *   songIds: string[], // ordered, deduplicated
 *   createdAt: number, // epoch ms
 * }
 */

import { getDB, PLAYLISTS_STORE } from '../utils/db.js';

const listeners = new Set();

function notify() {
  getAllPlaylists().then((playlists) => {
    listeners.forEach((fn) => {
      try { fn(playlists); } catch (err) { console.error('[Melody] Playlist subscriber threw:', err); }
    });
  });
}

/** Subscribe to playlist changes. Immediately called with the current list. */
export function subscribePlaylists(listener) {
  getAllPlaylists().then(listener);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getAllPlaylists() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readonly');
    const req = tx.objectStore(PLAYLISTS_STORE).getAll();
    req.onsuccess = () => {
      const playlists = req.result || [];
      playlists.sort((a, b) => b.createdAt - a.createdAt);
      resolve(playlists);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getPlaylist(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readonly');
    const req = tx.objectStore(PLAYLISTS_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function putPlaylist(playlist) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readwrite');
    tx.objectStore(PLAYLISTS_STORE).put(playlist);
    tx.oncomplete = () => resolve(playlist);
    tx.onerror = () => reject(tx.error);
  });
}

/** Create a new, empty (or pre-seeded) playlist. */
export async function createPlaylist(name, initialSongIds = []) {
  const playlist = {
    id: crypto.randomUUID(),
    name: (name || '').trim() || 'New Playlist',
    songIds: Array.from(new Set(initialSongIds)),
    createdAt: Date.now(),
  };
  await putPlaylist(playlist);
  notify();
  return playlist;
}

/** Add one or more song ids to a playlist (deduplicated, order preserved). */
export async function addSongsToPlaylist(playlistId, songIds) {
  const playlist = await getPlaylist(playlistId);
  if (!playlist) throw new Error(`Playlist "${playlistId}" not found`);
  const merged = new Set(playlist.songIds);
  (Array.isArray(songIds) ? songIds : [songIds]).forEach((id) => merged.add(id));
  const updated = { ...playlist, songIds: Array.from(merged) };
  await putPlaylist(updated);
  notify();
  return updated;
}

export async function removeSongFromPlaylist(playlistId, songId) {
  const playlist = await getPlaylist(playlistId);
  if (!playlist) return null;
  const updated = { ...playlist, songIds: playlist.songIds.filter((id) => id !== songId) };
  await putPlaylist(updated);
  notify();
  return updated;
}

export async function deletePlaylist(id) {
  const db = await getDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PLAYLISTS_STORE, 'readwrite');
    tx.objectStore(PLAYLISTS_STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
  notify();
}
