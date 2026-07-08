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
 *   id: string,             // uuid
 *   title: string,
 *   artist: string,
 *   album: string,
 *   albumArtist: string,
 *   genre: string,
 *   year: string,
 *   trackNumber: string,
 *   discNumber: string,
 *   composer: string,
 *   comment: string,
 *   duration: number,       // seconds
 *   fileName: string,       // original filename, kept for reference
 *   mimeType: string,
 *   format: string,         // display format, e.g. "MP3"
 *   fileSize: number,       // bytes
 *   bitrate: number | null, // kbps estimate (fileSize*8 / duration), when derivable
 *   folderPath: string,     // "On My Device" unless a real relative path was available
 *   blob: Blob,             // the actual audio data, stored locally for offline playback
 *   coverArt: Blob | null,  // embedded/override artwork if the file had any
 *   dateAdded: number,      // epoch ms
 *   playCount: number,      // "Most Played" sort + Music Hub stat
 *   lastPlayedAt: number | null,
 *   lyrics: object | null,  // cached LRCLIB result, see lyrics-service.js
 *   metadataSource: 'id3' | 'filename-guess' | 'edited',
 *   originalMetadata: object,         // first-seen snapshot, for "Reset to Original Metadata"
 *   previousMetadata: object | null,  // one level of history, for "Undo Changes"
 *   fileWriteSupported: boolean,      // whether edits can be written back into the file itself
 * }
 */

import { getDB, SONGS_STORE } from '../utils/db.js';

const EDITABLE_FIELDS = [
  'title', 'artist', 'album', 'albumArtist', 'genre', 'year',
  'trackNumber', 'discNumber', 'composer', 'comment',
];

/** Add one song record to the library, filling in any new fields with safe defaults. */
export async function addSong(song) {
  const normalized = normalizeSong(song);
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SONGS_STORE, 'readwrite');
    tx.objectStore(SONGS_STORE).put(normalized);
    tx.oncomplete = () => resolve(normalized);
    tx.onerror = () => reject(tx.error);
  });
}

/** Fill in defaults for any fields older records (or a fresh Phase 1 import) don't have yet. */
function normalizeSong(song) {
  const withDefaults = {
    albumArtist: '',
    genre: '',
    year: '',
    trackNumber: '',
    discNumber: '',
    composer: '',
    comment: '',
    format: (song.fileName || '').split('.').pop()?.toUpperCase() || '',
    fileSize: song.blob?.size ?? 0,
    bitrate: song.duration ? Math.round(((song.blob?.size ?? 0) * 8) / song.duration / 1000) : null,
    folderPath: song.folderPath || 'On My Device',
    playCount: 0,
    lastPlayedAt: null,
    lyrics: null,
    metadataSource: song.metadata?.source || 'filename-guess',
    fileWriteSupported: (song.mimeType || '').includes('mpeg') || (song.fileName || '').toLowerCase().endsWith('.mp3'),
    previousMetadata: null,
    ...song,
  };

  if (!withDefaults.originalMetadata) {
    const snapshot = {};
    EDITABLE_FIELDS.forEach((f) => { snapshot[f] = withDefaults[f] ?? ''; });
    withDefaults.originalMetadata = snapshot;
  }

  return withDefaults;
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
/**
 * Apply a metadata patch (EDITABLE_FIELDS, plus optionally coverArt /
 * fileWriteSupported) to a song, keeping one level of undo history.
 */
export async function updateSongMetadata(id, patch) {
  const song = await getSong(id);
  if (!song) throw new Error(`Song "${id}" not found`);

  const previousSnapshot = {};
  EDITABLE_FIELDS.forEach((f) => { previousSnapshot[f] = song[f] ?? ''; });

  const updated = {
    ...song,
    ...patch,
    metadataSource: 'edited',
    previousMetadata: previousSnapshot,
  };
  return addSong(updated);
}

/** Undo the most recent metadata edit (one level deep). */
export async function undoSongMetadata(id) {
  const song = await getSong(id);
  if (!song || !song.previousMetadata) return song;
  const updated = {
    ...song,
    ...song.previousMetadata,
    previousMetadata: null,
    metadataSource: 'edited',
  };
  return addSong(updated);
}

/** Reset every editable field (and previous-edit history) back to first-seen values. */
export async function resetSongMetadata(id) {
  const song = await getSong(id);
  if (!song) return null;
  const updated = {
    ...song,
    ...song.originalMetadata,
    previousMetadata: null,
    metadataSource: 'filename-guess',
  };
  return addSong(updated);
}

/** Replace (or clear, with null) a song's cover art. */
export async function updateSongCoverArt(id, coverArtBlobOrNull) {
  const song = await getSong(id);
  if (!song) throw new Error(`Song "${id}" not found`);
  return addSong({ ...song, coverArt: coverArtBlobOrNull });
}

/** Bump play count + last-played timestamp for "Most Played" sort + Music Hub stats. */
export async function incrementPlayCount(id) {
  const song = await getSong(id);
  if (!song) return;
  return addSong({ ...song, playCount: (song.playCount || 0) + 1, lastPlayedAt: Date.now() });
}

/** Distinct genre names present in the library (blank genres excluded), alphabetical. */
export async function getGenres() {
  const all = await getAllSongs();
  const set = new Set(all.map((s) => (s.genre || '').trim()).filter(Boolean));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Distinct folder names present in the library, alphabetical. */
export async function getFolders() {
  const all = await getAllSongs();
  const set = new Set(all.map((s) => s.folderPath || 'On My Device'));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

const SORTERS = {
  name: (a, b) => (a.title || '').localeCompare(b.title || ''),
  artist: (a, b) => (a.artist || '').localeCompare(b.artist || ''),
  album: (a, b) => (a.album || '').localeCompare(b.album || ''),
  dateAdded: (a, b) => (b.dateAdded || 0) - (a.dateAdded || 0),
  duration: (a, b) => (a.duration || 0) - (b.duration || 0),
  mostPlayed: (a, b) => (b.playCount || 0) - (a.playCount || 0),
};

/** Sort a song array (returns a new array). `sortKey` is one of SORTERS' keys. */
export function sortSongs(songs, sortKey = 'dateAdded') {
  const sorter = SORTERS[sortKey] || SORTERS.dateAdded;
  return [...songs].sort(sorter);
}

/** Text search across title/artist/album/genre — used by the Library search bar. */
export function searchSongs(songs, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return songs;
  return songs.filter((s) =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.artist || '').toLowerCase().includes(q) ||
    (s.album || '').toLowerCase().includes(q) ||
    (s.genre || '').toLowerCase().includes(q)
  );
}

/** Remove multiple songs at once (multi-select "Delete"). */
export async function removeSongs(ids) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SONGS_STORE, 'readwrite');
    const store = tx.objectStore(SONGS_STORE);
    ids.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}
