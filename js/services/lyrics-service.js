/**
 * lyrics-service.js
 * Fetches synced (LRC) lyrics for a song from LRCLIB (https://lrclib.net)
 * — a free, keyless, community lyrics API. Results are cached in memory
 * per song id so re-visiting a track (or reopening the Player screen)
 * never re-fetches.
 *
 * Any network failure, or a track LRCLIB simply doesn't have, resolves
 * to `{ synced: null, plain: null }` rather than throwing — the caller
 * shows a single, calm "No synced lyrics available" state instead of
 * surfacing errors.
 */

const cache = new Map();    // songId -> { synced: [{time,text}]|null, plain: string|null }
const inflight = new Map(); // songId -> Promise, guards against duplicate concurrent fetches

const API_BASE = 'https://lrclib.net/api';

/** Get lyrics for a song (cached after the first successful/failed lookup). */
export async function getLyrics(song) {
  if (!song) return { synced: null, plain: null };
  if (cache.has(song.id)) return cache.get(song.id);
  if (inflight.has(song.id)) return inflight.get(song.id);

  const promise = fetchLyrics(song)
    .then((result) => {
      cache.set(song.id, result);
      inflight.delete(song.id);
      return result;
    })
    .catch((err) => {
      console.warn('[Melody] Lyrics: lookup failed, showing "no lyrics" state.', err);
      const result = { synced: null, plain: null };
      cache.set(song.id, result);
      inflight.delete(song.id);
      return result;
    });

  inflight.set(song.id, promise);
  return promise;
}

/** Synchronous read of whatever's already cached — avoids a loading flash on a song we've already looked up. */
export function getCachedLyrics(songId) {
  return cache.has(songId) ? cache.get(songId) : null;
}

async function fetchLyrics(song) {
  const direct = await tryGet(song);
  if (direct) return direct;
  const searched = await trySearch(song);
  if (searched) return searched;
  return { synced: null, plain: null };
}

/** Exact lookup — LRCLIB's `/get` endpoint, keyed on title/artist/album/duration. */
async function tryGet(song) {
  try {
    const params = new URLSearchParams({
      track_name: song.title || '',
      artist_name: song.artist || '',
    });
    if (song.album) params.set('album_name', song.album);
    if (song.duration) params.set('duration', String(Math.round(song.duration)));

    const res = await fetch(`${API_BASE}/get?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    return toResult(data);
  } catch (err) {
    return null;
  }
}

/** Fuzzier fallback — LRCLIB's `/search` endpoint, picking the closest-duration match. */
async function trySearch(song) {
  try {
    const params = new URLSearchParams({
      track_name: song.title || '',
      artist_name: song.artist || '',
    });
    const res = await fetch(`${API_BASE}/search?${params.toString()}`);
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return null;

    const withSynced = list.filter((item) => item.syncedLyrics);
    const pool = withSynced.length ? withSynced : list;
    pool.sort((a, b) =>
      Math.abs((a.duration || 0) - (song.duration || 0)) - Math.abs((b.duration || 0) - (song.duration || 0))
    );
    return toResult(pool[0]);
  } catch (err) {
    return null;
  }
}

function toResult(data) {
  if (!data) return null;
  const synced = data.syncedLyrics ? parseLrc(data.syncedLyrics) : null;
  const plain = data.plainLyrics || null;
  if (!synced && !plain) return null;
  return { synced, plain };
}

/** Parses LRC-format text (`[mm:ss.xx]line`) into a time-sorted array of { time, text }. */
function parseLrc(lrcText) {
  const lines = [];
  const tagRegex = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\]/g;

  for (const raw of lrcText.split('\n')) {
    const tags = [...raw.matchAll(tagRegex)];
    if (tags.length === 0) continue; // metadata lines ([ar:...], [ti:...], etc.) — skip
    const text = raw.replace(tagRegex, '').trim();
    if (!text) continue;
    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      lines.push({ time: minutes * 60 + seconds, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines.length ? lines : null;
}
