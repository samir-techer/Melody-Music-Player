/**
 * metadata-service.js
 * "Library & Metadata" auto-fetch — the module referenced as upcoming in
 * import-service.js/library-service.js/filename-cleaner.js. Handles two
 * things:
 *
 *   1. The two Settings toggles (Auto Fetch Cover Art / Auto Fetch Song
 *      Metadata), persisted in the shared "kv" IndexedDB store via
 *      utils/storage.js. Both default to ON.
 *   2. Looking up missing metadata (album, genre, year, track/disc number,
 *      composer, and an "Unknown Artist" placeholder) and missing cover
 *      art via the iTunes Search API — no API key required, same source
 *      coverart-service.js already uses for the manual "pick a cover"
 *      flow in the Metadata Editor.
 *
 * The golden rule everywhere in this file: only ever fill in a field that
 * is currently empty/missing. Existing values (whether from real ID3 tags
 * or a manual edit) are never touched — a user has to explicitly replace
 * something via the Metadata Editor for that to happen. Every network
 * call is defensive and resolves to "nothing found" rather than throwing,
 * so a lookup failure never blocks an import or a library scan.
 */

import { getItem, setItem } from '../utils/storage.js';
import { findCoverArtCandidates, downloadCoverArt } from './coverart-service.js';
import { updateSongMetadata, updateSongCoverArt } from './library-service.js';

const AUTO_FETCH_COVER_ART_KEY = 'autoFetchCoverArt';
const AUTO_FETCH_METADATA_KEY = 'autoFetchSongMetadata';
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';

// Fields we're willing to auto-fill. Deliberately excludes "title" — the
// filename-cleaner guess (or a real ID3 tag) is already what plays in the
// song list, and silently rewriting the displayed title from a fuzzy
// online match is more likely to surprise someone than help them.
const AUTO_FILLABLE_FIELDS = [
  'artist', 'album', 'albumArtist', 'genre', 'year',
  'trackNumber', 'discNumber', 'composer',
];

/* ---------------------------------------------------------------------- */
/* Preferences (Settings toggles)                                         */
/* ---------------------------------------------------------------------- */

/** Auto Fetch Cover Art toggle — defaults to ON when never set before. */
export async function getAutoFetchCoverArt() {
  const stored = await getItem(AUTO_FETCH_COVER_ART_KEY);
  return stored === null || stored === undefined ? true : Boolean(stored);
}

export async function setAutoFetchCoverArt(enabled) {
  await setItem(AUTO_FETCH_COVER_ART_KEY, Boolean(enabled));
}

/** Auto Fetch Song Metadata toggle — defaults to ON when never set before. */
export async function getAutoFetchMetadata() {
  const stored = await getItem(AUTO_FETCH_METADATA_KEY);
  return stored === null || stored === undefined ? true : Boolean(stored);
}

export async function setAutoFetchMetadata(enabled) {
  await setItem(AUTO_FETCH_METADATA_KEY, Boolean(enabled));
}

/* ---------------------------------------------------------------------- */
/* Lookup                                                                  */
/* ---------------------------------------------------------------------- */

/** Treat blanks and the library's own placeholders as "missing". */
function isEmptyField(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'Unknown Artist' || trimmed === 'Unknown Album';
}

/**
 * Search the iTunes Search API (song entity) for a best-guess match and
 * return the fields we're able to fill in, plus an upsized artwork URL
 * for the same result (so a single lookup can satisfy both toggles).
 * Resolves to null if nothing usable was found.
 */
export async function searchSongMetadata({ artist, title, album } = {}) {
  const term = [artist && artist !== 'Unknown Artist' ? artist : '', title].filter(Boolean).join(' ') || album;
  if (!term || !term.trim()) return null;

  try {
    const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(term)}&entity=song&limit=5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) return null;

    // Prefer a result whose track name actually contains our title guess;
    // fall back to the top hit if nothing matches closely.
    const match = (title && results.find((r) =>
      (r.trackName || '').toLowerCase().includes(title.toLowerCase())
    )) || results[0];

    return {
      artist: match.artistName || '',
      album: match.collectionName || '',
      albumArtist: match.artistName || '',
      genre: match.primaryGenreName || '',
      year: match.releaseDate ? String(new Date(match.releaseDate).getFullYear()) : '',
      trackNumber: match.trackNumber ? String(match.trackNumber) : '',
      discNumber: match.discNumber ? String(match.discNumber) : '',
      composer: '',
      artworkUrl: match.artworkUrl100 ? upsizeArtworkUrl(match.artworkUrl100) : '',
    };
  } catch (err) {
    console.warn('[Melody] Metadata lookup failed - continuing without online results.', err);
    return null;
  }
}

function upsizeArtworkUrl(url) {
  return url.replace(/\d+x\d+bb(\.\w+)$/, '600x600bb$1');
}

/* ---------------------------------------------------------------------- */
/* Enrichment                                                              */
/* ---------------------------------------------------------------------- */

/**
 * Fill in whatever's missing on one song — metadata fields and/or cover
 * art — respecting the current toggle settings and never overwriting a
 * field that already has a value. Safe to call on every song, every time:
 * it's a no-op if nothing is missing or both toggles are off.
 *
 * @param {Object} song a full song record (must already be saved, i.e. have an id)
 * @param {Object} [opts]
 * @param {boolean} [opts.force] bypass the toggles (used by the manual
 *        "Replace" action in the Metadata Editor, not by auto-import/scan)
 * @returns {Promise<{metadataUpdated: boolean, coverArtUpdated: boolean}>}
 */
export async function autoEnrichSong(song, opts = {}) {
  const { force = false } = opts;
  if (!song || !song.id) return { metadataUpdated: false, coverArtUpdated: false };

  const [wantMetadata, wantCoverArt] = await Promise.all([
    force ? true : getAutoFetchMetadata(),
    force ? true : getAutoFetchCoverArt(),
  ]);

  const missingFields = AUTO_FILLABLE_FIELDS.filter((f) => isEmptyField(song[f]));
  const needsMetadata = wantMetadata && missingFields.length > 0;
  const needsCoverArt = wantCoverArt && !song.coverArt;

  const result = { metadataUpdated: false, coverArtUpdated: false };
  if (!needsMetadata && !needsCoverArt) return result;

  const lookup = await searchSongMetadata({ artist: song.artist, title: song.title, album: song.album });

  if (needsMetadata && lookup) {
    const patch = {};
    missingFields.forEach((field) => {
      if (!isEmptyField(lookup[field])) patch[field] = lookup[field];
    });
    if (Object.keys(patch).length > 0) {
      await updateSongMetadata(song.id, patch);
      result.metadataUpdated = true;
    }
  }

  if (needsCoverArt) {
    let artworkUrl = lookup?.artworkUrl || '';
    if (!artworkUrl) {
      const candidates = await findCoverArtCandidates(
        { artist: song.artist, album: song.album, title: song.title },
        1
      );
      artworkUrl = candidates[0]?.artworkUrl || '';
    }
    if (artworkUrl) {
      const blob = await downloadCoverArt(artworkUrl);
      if (blob) {
        await updateSongCoverArt(song.id, blob);
        result.coverArtUpdated = true;
      }
    }
  }

  return result;
}

/**
 * Scan a batch of songs (typically the whole library, via the Settings
 * "Scan Existing Library" button) and enrich each in turn, reporting
 * progress after every song so the caller can drive a progress bar.
 *
 * @param {Object[]} songs
 * @param {Object} [opts]
 * @param {(progress: {scanned: number, total: number, metadataUpdated: number, coverArtUpdated: number}) => void} [opts.onProgress]
 */
export async function scanLibraryForMetadata(songs, opts = {}) {
  const { onProgress } = opts;
  const summary = { scanned: 0, total: songs.length, metadataUpdated: 0, coverArtUpdated: 0 };

  for (const song of songs) {
    try {
      // Respects the current toggle values, same as an auto-import would —
      // if both are off there's nothing to do, which matches turning them
      // off in the first place. Still only ever fills in missing fields.
      const { metadataUpdated, coverArtUpdated } = await autoEnrichSong(song);
      if (metadataUpdated) summary.metadataUpdated += 1;
      if (coverArtUpdated) summary.coverArtUpdated += 1;
    } catch (err) {
      console.warn(`[Melody] Library scan: enrichment failed for "${song.title}".`, err);
    }
    summary.scanned += 1;
    onProgress?.({ ...summary });
  }

  return summary;
}
