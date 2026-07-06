/**
 * filename-cleaner.js
 * Turns messy downloaded filenames into a clean "Title — Artist" guess.
 * This is a first pass used before the metadata engine (MusicBrainz / AcoustID)
 * confirms real tags — see js/services/metadata-service.js (upcoming module).
 *
 * Example:
 *   "Bruno_Mars_-505-song.mp3"  ->  { title: "505", artist: "Bruno Mars" }
 */

const NOISE_WORDS = [
  'official', 'official audio', 'official video', 'official music video',
  'lyrics', 'lyric video', 'audio', 'hd', '4k', '8k',
  '320kbps', '128kbps', 'mp3', 'm4a', 'flac',
  'video', 'full song', 'full track', 'clean', 'explicit',
];

export function cleanFilename(rawName) {
  let name = rawName.replace(/\.(mp3|flac|m4a|aac|wav|ogg)$/i, '');

  // Underscores/dashes/dots used as spaces
  name = name.replace(/[_.]+/g, ' ');

  // Strip bracketed/parenthesized noise like (Official Video), [HD], etc.
  name = name.replace(/[\(\[\{][^)\]\}]*[\)\]\}]/g, ' ');

  // Strip known noise words (word-boundary, case-insensitive)
  const noisePattern = new RegExp(`\\b(${NOISE_WORDS.join('|')})\\b`, 'gi');
  name = name.replace(noisePattern, ' ');

  // Strip long random ID-like tokens (8+ alphanumeric with mixed case/digits)
  name = name.replace(/\b[a-zA-Z0-9]{9,}\b/g, ' ');

  // Collapse duplicate dashes/spaces
  name = name.replace(/-{2,}/g, '-');
  name = name.replace(/\s{2,}/g, ' ').trim();
  name = name.replace(/^-|-$/g, '').trim();

  // Try "Artist - Title" or "Title - Artist" split on a single dash
  const parts = name.split(/\s-\s|-(?=[A-Za-z])/).map((p) => p.trim()).filter(Boolean);

  let title = name;
  let artist = '';

  if (parts.length >= 2) {
    // Heuristic: assume "Artist - Title" ordering, the more common convention.
    [artist, title] = [parts[0], parts.slice(1).join(' ')];
  }

  title = toTitleCase(title);
  artist = toTitleCase(artist);

  return { title: title || rawName, artist };
}

function toTitleCase(str) {
  if (!str) return str;
  return str
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
