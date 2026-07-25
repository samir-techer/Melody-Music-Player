/**
 * storage.js
 * Small async key/value wrapper over localStorage. Two flavors:
 *   - getItem/setItem        — app-wide settings (theme, EQ preset, queue…)
 *   - getUserItem/setUserItem — namespaced per signed-in uid (nickname,
 *                               hasSeenGreeting, etc.) so a second account
 *                               signing in on the same device never reads
 *                               the first account's cached values.
 * Everything is async (returns Promises) even though localStorage itself is
 * synchronous — callers already `await` these, and it keeps the door open
 * to swapping the backing store later without touching call sites.
 */

const PREFIX = 'melody:';
const USER_PREFIX = 'melody:user:';

function globalKey(key) {
  return `${PREFIX}${key}`;
}

function userKey(uid, key) {
  return `${USER_PREFIX}${uid}:${key}`;
}

/** Reads and JSON-parses a value, returning null if missing or unreadable. */
export async function getItem(key) {
  try {
    const raw = localStorage.getItem(globalKey(key));
    return raw === null ? null : JSON.parse(raw);
  } catch (err) {
    console.warn(`[Melody] storage.getItem("${key}") failed:`, err);
    return null;
  }
}

/** JSON-serializes and stores a value under the app-wide namespace. */
export async function setItem(key, value) {
  try {
    localStorage.setItem(globalKey(key), JSON.stringify(value));
  } catch (err) {
    console.warn(`[Melody] storage.setItem("${key}") failed:`, err);
  }
}

/** Reads a value scoped to a specific signed-in user. */
export async function getUserItem(uid, key) {
  if (!uid) return null;
  try {
    const raw = localStorage.getItem(userKey(uid, key));
    return raw === null ? null : JSON.parse(raw);
  } catch (err) {
    console.warn(`[Melody] storage.getUserItem("${uid}", "${key}") failed:`, err);
    return null;
  }
}

/** Stores a value scoped to a specific signed-in user. */
export async function setUserItem(uid, key, value) {
  if (!uid) return;
  try {
    localStorage.setItem(userKey(uid, key), JSON.stringify(value));
  } catch (err) {
    console.warn(`[Melody] storage.setUserItem("${uid}", "${key}") failed:`, err);
  }
}

/** Wipes every cached value for one uid — called on sign-out. */
export async function clearUserCache(uid) {
  if (!uid) return;
  const prefix = `${USER_PREFIX}${uid}:`;
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch (err) {
    console.warn(`[Melody] storage.clearUserCache("${uid}") failed:`, err);
  }
}
