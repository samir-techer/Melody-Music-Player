/**
 * filename-cleaner.js
 * Best-effort title/artist guess from a raw filename, used as a fallback
 * during import before (or when) ID3 tags and online lookup can fill the
 * rest in. Handles the common "Artist - Title.mp3" convention plus messy
 * underscores/dashes/bracketed tags from web downloads.
 */

const KNOWN_EXTENSIONS = /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma)$/i;

export function cleanFilename(filename) {
  let name = String(filename || '').replace(KNOWN_EXTENSIONS, '');

  // Strip common download noise: [Official Video], (Lyrics), 320kbps, etc.
  name = name
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b\d{2,3}\s?kbps\b/gi, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // "Artist - Title" (also tolerates en/em dashes)
  const dashSplit = name.split(/\s[-–—]\s/);
  if (dashSplit.length >= 2) {
    const [artist, ...rest] = dashSplit;
    const title = rest.join(' - ').trim();
    if (artist.trim() && title) {
      return { title, artist: artist.trim() };
    }
  }

  return { title: name || 'Unknown Title', artist: '' };
}
