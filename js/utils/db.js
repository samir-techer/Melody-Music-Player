/**
 * db.js
 * Thin IndexedDB bootstrap shared by library-service, playlist-service, and
 * lyrics-service. Exposes the raw IDBDatabase (not a wrapper) so callers can
 * keep using the native `db.transaction(STORE, mode)` / `tx.objectStore(...)`
 * API directly, plus the object-store name constants they key off of.
 */

const DB_NAME = 'melody-db';

export const SONGS_STORE = 'songs';
export const PLAYLISTS_STORE = 'playlists';
export const LYRICS_CACHE_STORE = 'lyricsCache';

// Every database name Melody (or a build/rename of it) has ever used to
// store the "songs" object store. If a future rename/rebrand ever changes
// DB_NAME again, add the old name here BEFORE removing it anywhere else —
// this list is what recoverLegacyDatabases() below checks so an existing
// user's library gets migrated forward instead of silently orphaned.
const LEGACY_DB_NAMES = ['melody-db', 'MelodyDB', 'melody', 'music-player-db', 'MusicPlayerDB'];

let dbPromise = null;

const REQUIRED_STORES = [
  [SONGS_STORE, 'id'],
  [PLAYLISTS_STORE, 'id'],
  [LYRICS_CACHE_STORE, 'key'],
];

function createMissingStores(db) {
  REQUIRED_STORES.forEach(([name, keyPath]) => {
    if (!db.objectStoreNames.contains(name)) {
      db.createObjectStore(name, { keyPath });
    }
  });
}

/** Opens (or returns the already-open) shared database instance. */
export function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = openHealed();
  return dbPromise;
}

/**
 * Opens melody-db and, if it's already sitting at DB_VERSION but is
 * missing one or more of the required object stores (a corrupted/partial
 * schema — e.g. a previous open created the database shell but the
 * upgrade transaction that creates the stores never actually ran/
 * completed), forces a real version-number bump so IndexedDB fires
 * onupgradeneeded again and the missing stores get created. Existing
 * stores and their data are never touched — this only ever ADDS stores
 * that aren't there yet, it never recreates or clears one that exists.
 */
async function openHealed() {
  let db = await openAtCurrentVersion();

  const missing = REQUIRED_STORES.filter(([name]) => !db.objectStoreNames.contains(name));
  if (missing.length) {
    console.warn(
      `[Melody] melody-db (v${db.version}) is missing object store(s): ${missing.map((m) => m[0]).join(', ')}. ` +
      'Repairing schema without touching existing data.'
    );
    const brokenVersion = db.version;
    db.close();
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, brokenVersion + 1);
      req.onupgradeneeded = () => createMissingStores(req.result);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('[Melody] Schema repair blocked — close other Melody tabs to let it finish.');
    });
    console.log(`[Melody] Schema repaired — melody-db is now at version ${db.version} with all required stores.`);
  }

  db.onversionchange = () => {
    db.close();
    dbPromise = null;
  };

  await recoverLegacyDatabases(db).catch((err) =>
    console.warn('[Melody] Legacy database recovery skipped:', err)
  );

  return db;
}

function openAtCurrentVersion() {
  return new Promise((resolve, reject) => {
    // No version argument: attaches at whatever version already exists
    // (or creates a fresh version-1 database with no stores if it truly
    // doesn't exist yet — handled by the missing-store repair above,
    // which is also what correctly bootstraps a first-ever install).
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => createMissingStores(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let recoveryAttempted = false;

/**
 * Looks for any other IndexedDB database on this origin (besides the one
 * we just opened) that has a `songs`-shaped object store with existing
 * records, and copies anything missing from it into the live database.
 * Safe to call every boot: it's a no-op once `songs` already has data or
 * once it has already run this session, and it only ever ADDs records
 * (via `put`, keyed by the song's own `id`) — never deletes or replaces.
 *
 * Relies on `indexedDB.databases()` (Chrome/Edge/Safari 16.4+/Firefox
 * 126+) to enumerate what's on the origin; on browsers without it, falls
 * back to just probing the LEGACY_DB_NAMES list directly.
 */
async function recoverLegacyDatabases(liveDb) {
  if (recoveryAttempted) return;
  recoveryAttempted = true;

  // Only bother if the live songs store looks empty — if there's already
  // data, there's nothing to recover.
  const existingCount = await countStore(liveDb, SONGS_STORE);
  if (existingCount > 0) return;

  const candidateNames = new Set(LEGACY_DB_NAMES);
  if (typeof indexedDB.databases === 'function') {
    try {
      const infos = await indexedDB.databases();
      infos.forEach((info) => { if (info?.name) candidateNames.add(info.name); });
    } catch (err) {
      console.warn('[Melody] indexedDB.databases() unavailable, falling back to known legacy names only.', err);
    }
  }
  candidateNames.delete(liveDb.name);

  for (const name of candidateNames) {
    await migrateFromLegacyDb(liveDb, name);
  }
}

function countStore(db, storeName) {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(storeName)) { resolve(0); return; }
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    } catch (err) {
      resolve(0);
    }
  });
}

/** Opens a legacy database read-only (never bumps its version) and copies any songs/playlists/lyrics it has into `liveDb`. */
function migrateFromLegacyDb(liveDb, legacyName) {
  return new Promise((resolve) => {
    // Opening without a version number attaches at whatever version the
    // database already is — this NEVER triggers onupgradeneeded, so it
    // can't accidentally wipe or restructure someone's existing library.
    const openReq = indexedDB.open(legacyName);

    openReq.onsuccess = async () => {
      const legacyDb = openReq.result;
      try {
        if (legacyDb.objectStoreNames.contains(SONGS_STORE)) {
          const songs = await getAllFromStore(legacyDb, SONGS_STORE);
          if (songs.length) {
            await putAllInto(liveDb, SONGS_STORE, songs);
            console.log(`[Melody] Recovered ${songs.length} song(s) from legacy database "${legacyName}".`);
          }
        }
        if (legacyDb.objectStoreNames.contains(PLAYLISTS_STORE)) {
          const playlists = await getAllFromStore(legacyDb, PLAYLISTS_STORE);
          if (playlists.length) await putAllInto(liveDb, PLAYLISTS_STORE, playlists);
        }
        if (legacyDb.objectStoreNames.contains(LYRICS_CACHE_STORE)) {
          const lyrics = await getAllFromStore(legacyDb, LYRICS_CACHE_STORE);
          if (lyrics.length) await putAllInto(liveDb, LYRICS_CACHE_STORE, lyrics);
        }
      } catch (err) {
        console.warn(`[Melody] Legacy database "${legacyName}" recovery failed.`, err);
      } finally {
        legacyDb.close();
        resolve();
      }
    };

    // Database doesn't exist / can't be opened read-only — nothing to
    // recover from it, just move on.
    openReq.onerror = () => resolve();
    openReq.onblocked = () => resolve();
  });
}

function getAllFromStore(db, storeName) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch (err) {
      resolve([]);
    }
  });
}

function putAllInto(db, storeName, records) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    records.forEach((record) => {
      // Never clobber a record that already exists locally — `add` fails
      // silently (caught, ignored) if the key is taken, which is exactly
      // the "don't overwrite existing data" behavior we want here.
      try { store.add(record); } catch (err) { /* duplicate key — already have it, skip */ }
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve(); // best-effort recovery; never blocks normal app use
  });
}
