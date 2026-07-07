/**
 * db.js
 * The ONE place that opens melody-db and defines its schema.
 * Every module that needs IndexedDB (storage.js, library-service.js, and
 * future services) imports getDB() from here instead of calling
 * indexedDB.open() itself — opening the same database at different
 * versions from different files is a classic source of "blocked" errors.
 *
 * Object stores:
 *   - "kv"    : simple key/value app state (nickname, theme, flags)
 *   - "songs" : imported track records (see library-service.js for shape)
 */

export const DB_NAME = 'melody-db';
export const DB_VERSION = 2;
export const KV_STORE = 'kv';
export const SONGS_STORE = 'songs';

let dbPromise = null;

export function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE);
      }

      if (!db.objectStoreNames.contains(SONGS_STORE)) {
        const store = db.createObjectStore(SONGS_STORE, { keyPath: 'id' });
        store.createIndex('dateAdded', 'dateAdded');
        store.createIndex('artist', 'artist');
        store.createIndex('album', 'album');
      }
    };

    request.onblocked = () => {
      console.warn('melody-db upgrade blocked — another tab may have it open.');
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}
