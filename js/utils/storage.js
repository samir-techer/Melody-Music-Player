/**
 * storage.js
 * Simple key/value helpers over the shared "kv" object store (see db.js).
 * Used for app state (nickname, theme, flags) — not for song data, which
 * lives in library-service.js.
 */

import { getDB, KV_STORE } from './db.js';

/**
 * Get a value from the kv store. Falls back to localStorage if IndexedDB
 * is unavailable (older WebViews on some Android builds).
 */
export async function getItem(key) {
  try {
    const db = await getDB();
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
    const db = await getDB();
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
    const db = await getDB();
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
