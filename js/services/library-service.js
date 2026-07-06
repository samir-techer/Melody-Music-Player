/**
 * library-service.js
 * Owns the "songs" object store — the single source of truth for every
 * track the user has imported. Metadata lookups (MusicBrainz/AcoustID)
 * and ID3 read/write land in metadata-service.js in a later pass; for now
 * each song record holds whatever we can read locally plus the cleaned
 * filename guess.
 *
 * Song record shape:
 * {
 *   id: string,            // uuid
 *   title: string,
 *   artist: string,
 *   album: string,
 *   duration: number,      // seconds
 *   fileName: string,      // original filename, kept for reference
 *   mimeType: string,
 *   blob: Blob,            // the actual audio data, stored locally for offline playback
 *   coverArt: Blob | null, // embedded artwork if the file had any
 *   dateAdded: number,     // epoch ms
 * }
 */

import { getDB, SONGS_STORE } from '../utils/db.js';

/** Add one song record to the library. */
export async function addSong(song) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SONGS_STORE, 'readwrite');
    tx.objectStore(SONGS_STORE).put(song);
    tx.oncomplete = () => resolve(song);
    tx.onerror = () => reject(tx.error);
  });
}

/** Get every song in the library, most recently added first. */
export async function getAllSongs() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SONGS_STORE, 'readonly');
    const req = tx.objectStore(SONGS_STORE).getAll();
    req.onsuccess = () => {
      const songs = req.result || [];
      songs.sort((a, b) => b.dateAdded - a.dateAdded);
      resolve(songs);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Get a single song by id. */
export async function getSong(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SONGS_STORE, 'readonly');
    const req = tx.objectStore(SONGS_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Remove a song from the library. */
export async function removeSong(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SONGS_STORE, 'readwrite');
    tx.objectStore(SONGS_STORE).delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/** Check for an existing song with the same title+artist+duration (basic duplicate check). */
export async function findPossibleDuplicate(candidate) {
  const all = await getAllSongs();
  return all.find((s) =>
    s.title.toLowerCase() === candidate.title.toLowerCase() &&
    s.artist.toLowerCase() === candidate.artist.toLowerCase() &&
    Math.abs((s.duration || 0) - (candidate.duration || 0)) < 2
  ) || null;
}

/** Total number of songs currently in the library. */
export async function getSongCount() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SONGS_STORE, 'readonly');
    const req = tx.objectStore(SONGS_STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
