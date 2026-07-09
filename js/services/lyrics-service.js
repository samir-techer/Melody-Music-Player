/**
 * lyrics-service.js
 * Fetches synced/plain lyrics from LRCLIB (https://lrclib.net) - a free,
 * keyless, CORS-friendly lyrics API - for display on the Music Hub page.
 *
 * Search strategy (Phase 1 - Smarter Lyrics Search):
 *   1. Title/artist are normalized before anything is sent to LRCLIB.
 *   2. The LRCLIB *search* endpoint (/api/search) is used first, since it
 *      returns a ranked list of candidates instead of requiring an exact
 *      field match like /api/get does.
 *   3. When a query returns multiple candidates, each is scored against the
 *      song's title/artist/album/duration and the best match is kept.
 *   4. If a query comes back empty (or nothing scores high enough to trust),
 *      the search is automatically retried with progressively looser query
 *      variants: original metadata -> cleaned title -> artist + cleaned
 *      title -> title only -> album + artist + title combined.
 *
 * Results are cached two ways:
 *   - Per-song, onto the song record itself (song.lyrics) via
 *     library-service, so repeat visits to the same song's Hub don't re-fetch.
 *   - Per artist+title, in a standalone `lyricsCache` IndexedDB store, so a
 *     successful match can be reused for any other song with the same
 *     artist/title (duplicate files, re-imports) and read back offline.
 *
 * Never throws: any network failure, 404 (no lyrics found), or malformed
 * response just resolves to a `{ found: false }` result.
 */

import { getSong } from './library-service.js';
import { getDB, SONGS_STORE, LYRICS_CACHE_STORE } from '../utils/db.js';

const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';

// Minimum weighted score (0-1) required to trust a search candidate as a
// real match. Below this we keep retrying with looser queries instead of
// risking mismatched lyrics.
const MATCH_ACCEPT_THRESHOLD = 0.55;
// If every attempt is exhausted without crossing MATCH_ACCEPT_THRESHOLD, we
// still fall back to the single best-scoring candidate seen across all
// attempts as long as it clears this much lower floor - better than nothing
// for songs with sparse/odd metadata, while still refusing wildly wrong hits.
const MATCH_FALLBACK_FLOOR = 0.38;

const EMPTY_RESULT = Object.freeze({ found: false, plainLyrics: null, syncedLyrics: null });

/**
 * Get lyrics for a song, using cached copies (per-song, then the shared
 * artist+title cache) before ever touching the network.
 * Returns { found, plainLyrics, syncedLyrics } - syncedLyrics is the raw
 * LRC-format string (with [mm:ss.xx] tags) when LRCLIB has it, else null.
 */
export async function getLyricsForSong(song) {
  if (song.lyrics) return song.lyrics;

  const cacheKey = buildCacheKey(song);
  const shared = await getSharedLyricsCache(cacheKey);
  if (shared) {
    await cacheLyrics(song.id, shared);
    return shared;
  }

  // Don't burn time on failed fetches (and don't poison the cache with a
  // false negative) if we know we have no connection.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return EMPTY_RESULT;
  }

  const result = await fetchLyricsWithRetries(song);
  await cacheLyrics(song.id, result);
  if (result.found) {
    await setSharedLyricsCache(cacheKey, result);
  }
  return result;
}

/**
 * Runs the full normalize -> search -> score -> retry pipeline for a song.
 */
async function fetchLyricsWithRetries(song) {
  try {
    const attempts = buildSearchAttempts(song);
    const target = {
      title: song.title || '',
      artist: song.artist || '',
      album: song.album && song.album !== 'Unknown Album' ? song.album : '',
      duration: Math.round(song.duration || 0),
    };

    let bestOverall = null; // { candidate, score }

    for (const attempt of attempts) {
      const candidates = await searchLRCLIB(attempt.params);
      if (!candidates.length) continue;

      const best = pickBestCandidate(candidates, target);
      if (!best) continue;

      if (!bestOverall || best.score > bestOverall.score) bestOverall = best;

      if (best.score >= MATCH_ACCEPT_THRESHOLD) {
        return candidateToResult(best.candidate);
      }
    }

    // Nothing crossed the confident threshold - use the best thing we saw,
    // if it's at least plausibly related.
    if (bestOverall && bestOverall.score >= MATCH_FALLBACK_FLOOR) {
      return candidateToResult(bestOverall.candidate);
    }

    return { ...EMPTY_RESULT };
  } catch (err) {
    console.warn(`[Melody] Lyrics lookup failed for "${song.title}".`, err);
    return { ...EMPTY_RESULT };
  }
}

/**
 * Builds the ordered list of query variants to try against /api/search,
 * from most-specific (original metadata) to loosest (title only / combined
 * free-text query). Later attempts only run if earlier ones fail to
 * produce a confident match. Duplicate/empty variants are skipped.
 */
function buildSearchAttempts(song) {
  const rawTitle = (song.title || '').trim();
  const rawArtist = (song.artist || '').trim();
  const rawAlbum = song.album && song.album !== 'Unknown Album' ? song.album.trim() : '';
  const cleanedTitle = normalizeSearchTitle(rawTitle);

  const attempts = [];
  const seen = new Set();

  const push = (params) => {
    const filtered = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
    if (!filtered.track_name && !filtered.q) return; // nothing to search on
    const dedupeKey = JSON.stringify(filtered);
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    attempts.push({ params: filtered });
  };

  // 1. Original metadata, untouched.
  push({
    track_name: rawTitle,
    artist_name: rawArtist,
    album_name: rawAlbum,
  });

  // 2. Cleaned title only (strips "(feat. X)", "- Remastered 2011", etc.)
  if (cleanedTitle && cleanedTitle !== rawTitle) {
    push({ track_name: cleanedTitle });
  }

  // 3. Artist + cleaned title.
  if (cleanedTitle && rawArtist) {
    push({ track_name: cleanedTitle, artist_name: rawArtist });
  }

  // 4. Title only (raw), no artist - helps when the artist tag is wrong.
  push({ track_name: rawTitle });

  // 5. Album + artist + title combined into LRCLIB's free-text `q` search.
  if (rawAlbum || rawArtist) {
    push({ q: [rawAlbum, rawArtist, rawTitle].filter(Boolean).join(' ') });
  }

  return attempts;
}

/** Calls LRCLIB's search endpoint; returns [] on any failure or empty result. */
async function searchLRCLIB(params) {
  try {
    const query = new URLSearchParams(params);
    const res = await fetch(`${LRCLIB_SEARCH_URL}?${query.toString()}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('[Melody] LRCLIB search request failed.', err);
    return [];
  }
}

/** Scores every candidate against the target and returns the best { candidate, score }, or null. */
function pickBestCandidate(candidates, target) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate || (!candidate.plainLyrics && !candidate.syncedLyrics)) continue;
    const score = scoreCandidate(candidate, target);
    if (!best || score > best.score) best = { candidate, score };
  }
  return best;
}

/**
 * Weighted similarity score (0-1) between an LRCLIB candidate and the
 * song we're trying to match, based on title, artist, album, and duration.
 */
function scoreCandidate(candidate, target) {
  const titleSim = diceCoefficient(normalizeForCompare(candidate.trackName), normalizeForCompare(target.title));
  const artistSim = diceCoefficient(normalizeForCompare(candidate.artistName), normalizeForCompare(target.artist));

  const hasAlbum = Boolean(target.album && candidate.albumName);
  const albumSim = hasAlbum ? diceCoefficient(normalizeForCompare(candidate.albumName), normalizeForCompare(target.album)) : 0.5;

  const hasDuration = Boolean(target.duration && candidate.duration);
  const durationSim = hasDuration
    ? Math.max(0, 1 - Math.abs(candidate.duration - target.duration) / 12)
    : 0.5;

  // A wrong artist should tank the score even if the title matches well.
  const artistGate = artistSim < 0.25 ? 0.5 : 1;

  const weighted = titleSim * 0.4 + artistSim * 0.35 + durationSim * 0.15 + albumSim * 0.1;
  return weighted * artistGate;
}

function candidateToResult(candidate) {
  return {
    found: Boolean(candidate.plainLyrics || candidate.syncedLyrics),
    plainLyrics: candidate.plainLyrics || null,
    syncedLyrics: candidate.syncedLyrics || null,
  };
}

/**
 * Strips common noise from a title before searching: featured-artist
 * credits, bracketed/parenthesized tags like "(Official Video)" or
 * "[Remastered]", and trailing " - Live" / " - Radio Edit" style suffixes.
 * Intentionally lighter-touch than filename-cleaner.js, since a title tag
 * (unlike a raw filename) is usually already close to correct.
 */
function normalizeSearchTitle(title) {
  if (!title) return '';
  let out = title;
  out = out.replace(/[\(\[][^)\]]*[\)\]]/g, ' '); // (feat. X), [Remastered], etc.
  out = out.replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, ' ');
  out = out.replace(/\s-\s?(live|remaster(ed)?(\s\d{4})?|radio edit|single version|mono|stereo|acoustic|demo)\b.*$/i, ' ');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
}

/** Lowercases, strips diacritics/punctuation, collapses whitespace for fuzzy comparison. */
function normalizeForCompare(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Dice's coefficient (bigram overlap) similarity between two strings, 0-1. */
function diceCoefficient(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;

  const bigrams = (str) => {
    const s = str.replace(/\s+/g, ' ');
    const grams = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.substring(i, i + 2);
      grams.set(gram, (grams.get(gram) || 0) + 1);
    }
    return grams;
  };

  const aGrams = bigrams(a);
  const bGrams = bigrams(b);
  if (aGrams.size === 0 || bGrams.size === 0) return 0;

  let intersection = 0;
  for (const [gram, countA] of aGrams) {
    const countB = bGrams.get(gram);
    if (countB) intersection += Math.min(countA, countB);
  }

  const total = [...aGrams.values()].reduce((s, v) => s + v, 0) + [...bGrams.values()].reduce((s, v) => s + v, 0);
  return (2 * intersection) / total;
}

/**
 * Phase 2 - Manual Lyrics Search.
 * Runs every query variant for user-supplied title/artist/album (never the
 * song's own stored metadata, and never written back to it) and returns
 * *all* distinct candidates LRCLIB has, ranked best-first, so the person
 * can pick the right one themselves. Unlike the automatic pipeline this
 * doesn't stop at the first confident match - manual search only runs when
 * automatic search already failed, so the goal here is showing everything
 * plausible rather than picking one for the user.
 *
 * Returns an array of plain objects safe to hand straight to the UI:
 *   { id, title, artist, album, duration, hasSynced, hasPlain,
 *     plainLyrics, syncedLyrics, score }
 */
export async function searchLyricsManually({ title, artist, album } = {}) {
  const query = {
    title: (title || '').trim(),
    artist: (artist || '').trim(),
    album: (album || '').trim(),
  };
  if (!query.title && !query.artist) return [];

  const attempts = buildSearchAttempts(query);
  const target = { ...query, duration: 0 };

  const byKey = new Map();
  for (const attempt of attempts) {
    const candidates = await searchLRCLIB(attempt.params);
    for (const candidate of candidates) {
      if (!candidate || (!candidate.plainLyrics && !candidate.syncedLyrics)) continue;
      const dedupeKey = candidate.id != null
        ? `id:${candidate.id}`
        : `${candidate.trackName}|${candidate.artistName}|${candidate.albumName}|${candidate.duration}`;
      if (!byKey.has(dedupeKey)) byKey.set(dedupeKey, candidate);
    }
  }

  return [...byKey.values()]
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, target) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ candidate, score }) => ({
      id: candidate.id ?? null,
      title: candidate.trackName || '',
      artist: candidate.artistName || '',
      album: candidate.albumName || '',
      duration: candidate.duration || 0,
      hasSynced: Boolean(candidate.syncedLyrics),
      hasPlain: Boolean(candidate.plainLyrics),
      plainLyrics: candidate.plainLyrics || null,
      syncedLyrics: candidate.syncedLyrics || null,
      score,
    }));
}

/**
 * Applies a user-picked manual-search result as the song's lyrics. This
 * only ever touches the lyrics caches (per-song and the shared artist+title
 * cache, both keyed off the song's real, unmodified metadata) - it never
 * edits song.title/song.artist/song.album themselves.
 */
export async function applyManualLyricsSelection(song, selection) {
  const result = {
    found: Boolean(selection?.plainLyrics || selection?.syncedLyrics),
    plainLyrics: selection?.plainLyrics || null,
    syncedLyrics: selection?.syncedLyrics || null,
  };
  await cacheLyrics(song.id, result);
  if (result.found) {
    await setSharedLyricsCache(buildCacheKey(song), result);
  }
  return result;
}

/** Merges `patch` into the song's IndexedDB record and writes it back. Returns the updated record, or null if the song doesn't exist. */
async function patchSongRecord(songId, patch) {
  const db = await getDB();
  const song = await getSong(songId);
  if (!song) return null;
  const updated = { ...song, ...patch };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(SONGS_STORE, 'readwrite');
    tx.objectStore(SONGS_STORE).put(updated);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
  return updated;
}

/** Cache the lyrics result directly onto the song's IndexedDB record. */
async function cacheLyrics(songId, lyricsResult) {
  try {
    await patchSongRecord(songId, { lyrics: lyricsResult });
  } catch (err) {
    console.warn('[Melody] Failed to cache lyrics result.', err);
  }
}

const LYRICS_OFFSET_MIN = -10;
const LYRICS_OFFSET_MAX = 10;

/**
 * Phase 4 - Lyrics Sync Offset.
 * Reads the saved per-song timing offset (seconds), defaulting to 0 if the
 * song has never had one set. Positive values delay the lyrics (they'll
 * appear later relative to playback); negative values advance them.
 */
export async function getLyricsOffset(songId) {
  try {
    const song = await getSong(songId);
    const offset = song?.lyricsOffset;
    return typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
  } catch (err) {
    console.warn('[Melody] Failed to read lyrics offset.', err);
    return 0;
  }
}

/**
 * Saves a per-song lyrics timing offset, clamped to [-10, 10] seconds.
 * Returns the clamped value actually saved.
 */
export async function setLyricsOffset(songId, offsetSeconds) {
  const clamped = clampOffset(offsetSeconds);
  try {
    await patchSongRecord(songId, { lyricsOffset: clamped });
  } catch (err) {
    console.warn('[Melody] Failed to save lyrics offset.', err);
  }
  return clamped;
}

function clampOffset(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  // Round to 1 decimal place (0.1s resolution) to avoid float drift from
  // repeated +/-0.5s taps or slider drags.
  return Math.round(Math.min(LYRICS_OFFSET_MAX, Math.max(LYRICS_OFFSET_MIN, safe)) * 10) / 10;
}

/** Builds the shared cache key ("artist||title", normalized) for a song. */
function buildCacheKey(song) {
  return `${normalizeForCompare(song.artist)}::${normalizeForCompare(song.title)}`;
}

/** Reads a positive lyrics match from the shared artist+title cache store, if present. */
async function getSharedLyricsCache(key) {
  try {
    const db = await getDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(LYRICS_CACHE_STORE, 'readonly');
      const req = tx.objectStore(LYRICS_CACHE_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    return record ? record.result : null;
  } catch (err) {
    console.warn('[Melody] Failed to read shared lyrics cache.', err);
    return null;
  }
}

/** Writes a positive lyrics match into the shared artist+title cache store for offline reuse. */
async function setSharedLyricsCache(key, result) {
  try {
    const db = await getDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LYRICS_CACHE_STORE, 'readwrite');
      tx.objectStore(LYRICS_CACHE_STORE).put({ key, result, cachedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[Melody] Failed to write shared lyrics cache.', err);
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

/**
 * Binary search for the index of the currently-active line given a
 * playback time — the line whose timestamp is the latest one at or
 * before `time`. Returns -1 if playback hasn't reached the first line
 * yet. `lines` must already be sorted ascending by `.time` (as returned
 * by parseSyncedLyrics). Cheap enough to call on every playback tick —
 * a typical synced-lyrics file is well under a few hundred lines.
 */
export function findActiveLineIndex(lines, time) {
  if (!lines || lines.length === 0) return -1;
  if (time < lines[0].time) return -1;

  let lo = 0, hi = lines.length - 1, result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}
