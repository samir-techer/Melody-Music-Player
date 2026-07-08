/**
 * coverart-service.js
 * "Cover Art Finder" - looks up candidate album artwork online (via the
 * iTunes Search API, which needs no API key and allows CORS) so the
 * Metadata Editor can offer a pick-a-cover flow instead of only manual
 * upload/crop. Embedded-artwork extraction from the file itself still
 * lives in artwork-service.js; this module is strictly the "find art on
 * the internet for a song that doesn't have any" half.
 *
 * Every function is defensive: network failures, empty results, or a
 * missing connection just resolve to an empty array rather than throwing,
 * so a lookup failure never blocks the rest of the editor.
 */

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';

/**
 * Search for cover art candidates matching an artist/album (falls back to
 * artist/title if there's no album). Returns up to `limit` candidates as
 * { artworkUrl, collectionName, artistName }, largest artwork variant
 * available (iTunes serves 100x100 by default; we upsize the URL to a
 * much larger square crop).
 */
export async function findCoverArtCandidates({ artist, album, title }, limit = 8) {
  const term = [artist, album || title].filter(Boolean).join(' ');
  if (!term.trim()) return [];

  try {
    const url = `${ITUNES_SEARCH_URL}?term=${encodeURIComponent(term)}&entity=album&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];

    return results
      .filter((r) => r.artworkUrl100)
      .map((r) => ({
        artworkUrl: upsizeArtworkUrl(r.artworkUrl100),
        collectionName: r.collectionName || '',
        artistName: r.artistName || '',
      }));
  } catch (err) {
    console.warn('[Melody] Cover Art Finder lookup failed - continuing without online results.', err);
    return [];
  }
}

/** iTunes artwork URLs support swapping the "100x100" segment for a larger size. */
function upsizeArtworkUrl(url) {
  return url.replace(/\d+x\d+bb(\.\w+)$/, '600x600bb$1');
}

/** Download a chosen candidate's artwork as a Blob, ready to save via updateSongCoverArt(). */
export async function downloadCoverArt(artworkUrl) {
  try {
    const res = await fetch(artworkUrl);
    if (!res.ok) return null;
    return await res.blob();
  } catch (err) {
    console.warn('[Melody] Cover Art Finder: failed to download selected artwork.', err);
    return null;
  }
}
