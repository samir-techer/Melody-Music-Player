/**
 * storage.js
 * Lightweight IndexedDB wrapper used across Melody.
 * Everything is local-first — nothing here ever touches a network request.
 *
 * Object store "kv" holds simple key/value app state:
 *   - "nickname"          -> string
 *   - "hasSeenGreeting"   -> boolean
 *   - "theme"             -> string
 * Later modules (library, playlists, favorites, queue) will add their own
 * object stores in this same database via a version bump + onupgradeneeded.
 */

const DB_NAME = 'melody-db';
const DB_VERSION = 1;
const KV_STORE = 'kv';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

/**
 * Get a value from the kv store. Falls back to localStorage if IndexedDB
 * is unavailable (older WebViews on some Android builds).
 */
export async function getItem(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(KV_STORE, 'readonly');
      const req = tx.objectStore(KV_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('IndexedDB unavailable, falling back to localStorage', err);
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }
}

/** Set a value in the kv store. */
export async function setItem(key, value) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('IndexedDB unavailable, falling back to localStorage', err);
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  }
}

/** Remove a value from the kv store. */
export async function removeItem(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(KV_STORE, 'readwrite');
      tx.objectStore(KV_STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    localStorage.removeItem(key);
    return true;
  }
}
