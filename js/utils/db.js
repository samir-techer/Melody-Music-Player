/**
 * db.js
 * The ONE place that opens melody-db and defines its schema.
 * Every module that needs IndexedDB (storage.js, library-service.js, and
 * future services) imports getDB() from here instead of calling
 * indexedDB.open() itself — opening the same database at different
 * versions from different files is a classic source of "blocked" errors.
 *
 * Object stores:
 *   - "kv"        : simple key/value app state (nickname, theme, flags)
 *   - "songs"     : imported track records (see library-service.js for shape)
 *   - "playlists" : user-created playlists (see playlist-service.js for shape)
 */

export const DB_NAME = 'melody-db';
export const DB_VERSION = 4;
export const KV_STORE = 'kv';
export const SONGS_STORE = 'songs';
export const PLAYLISTS_STORE = 'playlists';
export const LYRICS_CACHE_STORE = 'lyricsCache';

let dbPromise = null;

export function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const tx = event.target.transaction;

      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE);
      }

      let songsStore;
      if (!db.objectStoreNames.contains(SONGS_STORE)) {
        songsStore = db.createObjectStore(SONGS_STORE, { keyPath: 'id' });
        songsStore.createIndex('dateAdded', 'dateAdded');
        songsStore.createIndex('artist', 'artist');
        songsStore.createIndex('album', 'album');
      } else {
        songsStore = tx.objectStore(SONGS_STORE);
      }

      // Added in v3 (Smart Library): genre/folder/play-count grouping +
      // sorting need dedicated indexes so those tabs don't have to do a
      // full table scan every render.
      if (!songsStore.indexNames.contains('genre')) songsStore.createIndex('genre', 'genre');
      if (!songsStore.indexNames.contains('folderPath')) songsStore.createIndex('folderPath', 'folderPath');
      if (!songsStore.indexNames.contains('playCount')) songsStore.createIndex('playCount', 'playCount');

      if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
        const playlistsStore = db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id' });
        playlistsStore.createIndex('createdAt', 'createdAt');
      }

      // Added in v4 (Advanced Lyrics System): a standalone artist+title
      // keyed cache so successful LRCLIB matches can be reused across any
      // song with the same artist/title (including future re-imports and
      // duplicate files) and read back while offline, independent of the
      // per-song "songs" store record.
      if (!db.objectStoreNames.contains(LYRICS_CACHE_STORE)) {
        const lyricsCacheStore = db.createObjectStore(LYRICS_CACHE_STORE, { keyPath: 'key' });
        lyricsCacheStore.createIndex('cachedAt', 'cachedAt');
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
