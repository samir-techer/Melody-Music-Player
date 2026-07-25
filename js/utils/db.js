/**
 * db.js
 * Thin IndexedDB bootstrap shared by library-service, playlist-service, and
 * lyrics-service. Exposes the raw IDBDatabase (not a wrapper) so callers can
 * keep using the native `db.transaction(STORE, mode)` / `tx.objectStore(...)`
 * API directly, plus the object-store name constants they key off of.
 */

const DB_NAME = 'melody-db';
const DB_VERSION = 1;

export const SONGS_STORE = 'songs';
export const PLAYLISTS_STORE = 'playlists';
export const LYRICS_CACHE_STORE = 'lyricsCache';

let dbPromise = null;

/** Opens (or returns the already-open) shared database instance. */
export function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SONGS_STORE)) {
        db.createObjectStore(SONGS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
        db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(LYRICS_CACHE_STORE)) {
        db.createObjectStore(LYRICS_CACHE_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // If another tab upgrades the schema later, drop this handle so the
      // next getDB() call reopens cleanly instead of working against a
      // closed connection.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      dbPromise = null; // allow a retry on the next call instead of caching a failure
      reject(request.error);
    };
  });

  return dbPromise;
}
