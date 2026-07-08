/**
 * lyrics-service.js
 * Fetches synced/plain lyrics from LRCLIB (https://lrclib.net) - a free,
 * keyless, CORS-friendly lyrics API - for display on the Music Hub page.
 * Results are cached onto the song record itself (song.lyrics) via
 * library-service so repeat visits to the same song's Hub don't re-fetch.
 *
 * Never throws: any network failure, 404 (no lyrics found), or malformed
 * response just resolves to a `{ found: false }` result.
 */

import { getSong } from './library-service.js';
import { getDB, SONGS_STORE } from '../utils/db.js';

const LRCLIB_URL = 'https://lrclib.net/api/get';

/**
 * Get lyrics for a song, using the cached copy on the record if present.
 * Returns { found, plainLyrics, syncedLyrics } - syncedLyrics is the raw
 * LRC-format string (with [mm:ss.xx] tags) when LRCLIB has it, else null.
 */
export async function getLyricsForSong(song) {
  if (song.lyrics) return song.lyrics;

  const result = await fetchLyrics(song);
  await cacheLyrics(song.id, result);
  return result;
}

async function fetchLyrics(song) {
  try {
    const params = new URLSearchParams({
      artist_name: song.artist || '',
      track_name: song.title || '',
      album_name: song.album && song.album !== 'Unknown Album' ? song.album : '',
      duration: String(Math.round(song.duration || 0)),
    });
    const res = await fetch(`${LRCLIB_URL}?${params.toString()}`);
    if (!res.ok) return { found: false, plainLyrics: null, syncedLyrics: null };

    const data = await res.json();
    return {
      found: Boolean(data.plainLyrics || data.syncedLyrics),
      plainLyrics: data.plainLyrics || null,
      syncedLyrics: data.syncedLyrics || null,
    };
  } catch (err) {
    console.warn(`[Melody] Lyrics lookup failed for "${song.title}".`, err);
    return { found: false, plainLyrics: null, syncedLyrics: null };
  }
}

/** Cache the lyrics result directly onto the song's IndexedDB record. */
async function cacheLyrics(songId, lyricsResult) {
  try {
    const db = await getDB();
    const song = await getSong(songId);
    if (!song) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SONGS_STORE, 'readwrite');
      tx.objectStore(SONGS_STORE).put({ ...song, lyrics: lyricsResult });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[Melody] Failed to cache lyrics result.', err);
  }
}

/**
 * Parse a raw LRC string into an array of { time (seconds), text } lines,
 * for a simple synced-lyrics view (no highlighting logic needed here -
 * just ordered, timestamped lines).
 */
export function parseSyncedLyrics(lrcText) {
  if (!lrcText) return [];
  const lineRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
  return lrcText
    .split('\n')
    .map((line) => {
      const matches = [...line.matchAll(lineRegex)];
      if (matches.length === 0) return null;
      const text = line.replace(lineRegex, '').trim();
      const [, mm, ss, ms] = matches[matches.length - 1];
      const time = parseInt(mm, 10) * 60 + parseInt(ss, 10) + (ms ? parseInt(ms.padEnd(3, '0'), 10) / 1000 : 0);
      return { time, text };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}
