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

/* -------------------------------------------------------------------- */
/*  User-scoped keys                                                     */
/* -------------------------------------------------------------------- */
// Account-specific values (nickname, "has seen greeting", etc.) must NOT
// live under a plain global key like "nickname" — on a shared/reused
// device, signing out of Account A and into Account B would otherwise
// still read Account A's cached nickname and "hasSeenGreeting" flag,
// silently skipping onboarding for the new account or greeting them with
// the wrong name. Every per-account read/write goes through these helpers
// so the uid is always baked into the key.

function userKey(uid, key) {
  if (!uid) throw new Error(`[Melody] userKey("${key}") called without a uid.`);
  return `user:${uid}:${key}`;
}

export function getUserItem(uid, key) {
  return getItem(userKey(uid, key));
}

export function setUserItem(uid, key, value) {
  return setItem(userKey(uid, key), value);
}

export function removeUserItem(uid, key) {
  return removeItem(userKey(uid, key));
}

/**
 * Wipes every per-account cached value for `uid`. Called on sign-out so a
 * subsequent sign-in (same account or a different one, on the same
 * device) never reads stale onboarding state. Safe to call even if the
 * key list grows later — add new user-scoped keys to USER_SCOPED_KEYS.
 */
const USER_SCOPED_KEYS = ['nickname', 'hasSeenGreeting'];

export async function clearUserCache(uid) {
  if (!uid) return;
  await Promise.all(
    USER_SCOPED_KEYS.map((key) => removeUserItem(uid, key).catch(() => {})),
  );
}
