/**
 * artwork-service.js
 * Reads embedded cover art directly from a song's audio Blob, with no
 * external dependencies — just enough binary parsing to pull the APIC
 * frame out of an ID3v2 tag (the format virtually all MP3s use, and the
 * most common format users will be importing).
 *
 * FLAC/M4A/OGG embedded art extraction is intentionally out of scope for
 * this pass — those use different container formats (METADATA_BLOCK_PICTURE,
 * MP4 'covr' atoms, Vorbis comments) and are a natural extension once the
 * full metadata-service (MusicBrainz/Cover Art Archive) lands. Callers
 * always get back either a usable object URL or null — never a throw.
 *
 * Every call is defensive: any parsing failure or corrupt/truncated tag
 * results in `null` rather than an exception, so a bad file can never
 * block import or playback — it just falls back to the placeholder art.
 */

const DEFAULT_ART_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#EAE3DB"/>
  <circle cx="100" cy="100" r="60" fill="#232323"/>
  <circle cx="100" cy="100" r="10" fill="#F5F1EC"/>
</svg>`.trim();

export const DEFAULT_ART_URL = `data:image/svg+xml;utf8,${encodeURIComponent(DEFAULT_ART_SVG)}`;

const artUrlCache = new Map(); // songId -> objectURL, so we don't re-parse repeatedly
const dominantColorCache = new Map(); // songId -> '#rrggbb' | null, for the Synced Lyrics glow

/**
 * Get a usable art URL for a song. Tries embedded artwork first (cached
 * per song id), falls back to the shared default placeholder.
 */
export async function getArtworkUrl(song) {
  if (!song) return DEFAULT_ART_URL;

  if (artUrlCache.has(song.id)) {
    return artUrlCache.get(song.id);
  }

  let url = null;
  try {
    if (song.coverArt) {
      url = URL.createObjectURL(song.coverArt);
    } else if (isMp3(song)) {
      const blob = await extractId3Apic(song.blob);
      if (blob) url = URL.createObjectURL(blob);
    }
  } catch (err) {
    console.warn(`[Melody] Artwork extraction failed for "${song.title}" - using placeholder.`, err);
  }

  const resolved = url || DEFAULT_ART_URL;
  artUrlCache.set(song.id, resolved);
  return resolved;
}

export async function getEmbeddedArtworkBlob(song) {
  if (!song || !isMp3(song)) return null;
  try {
    return await extractId3Apic(song.blob);
  } catch (err) {
    console.warn(`[Melody] Embedded artwork extraction failed for "${song.title}".`, err);
    return null;
  }
}

/**
 * Get a rough "dominant color" for a song's artwork, as a '#rrggbb'
 * string, for premium touches like the Synced Lyrics screen's glow/
 * highlight color. Resolves to null when there's no real artwork (the
 * default placeholder), the image fails to load, or the canvas read
 * fails for any reason (e.g. a browser quirk with an unusual image
 * codec) — callers should always have a sensible fallback color ready.
 * Cached per song id, same lifetime as the artwork URL cache.
 */
export async function getDominantColor(song) {
  if (!song) return null;
  if (dominantColorCache.has(song.id)) return dominantColorCache.get(song.id);

  let color = null;
  try {
    const url = await getArtworkUrl(song);
    if (url && !url.startsWith('data:image/svg+xml')) {
      color = await extractDominantColor(url);
    }
  } catch (err) {
    console.warn(`[Melody] Dominant color extraction failed for "${song.title}".`, err);
  }

  dominantColorCache.set(song.id, color);
  return color;
}

/**
 * Downscale the artwork onto a tiny canvas and average the pixels,
 * skipping near-white/near-black extremes (album border mattes, deep
 * shadow) so the result reflects the art's actual hue rather than
 * whatever's most common at the edges.
 */
function extractDominantColor(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        let r = 0, g = 0, b = 0, count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 200) continue; // skip transparent pixels
          const rr = data[i], gg = data[i + 1], bb = data[i + 2];
          const max = Math.max(rr, gg, bb);
          const min = Math.min(rr, gg, bb);
          if (max > 245 && min > 235) continue; // near-white
          if (max < 18) continue; // near-black
          r += rr; g += gg; b += bb; count += 1;
        }

        if (count === 0) { resolve(null); return; }
        resolve(rgbToHex(Math.round(r / count), Math.round(g / count), Math.round(b / count)));
      } catch (err) {
        resolve(null); // e.g. a tainted canvas — fail closed, never throw
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

function invalidateArtworkCacheInternal(songId) {
  const existing = artUrlCache.get(songId);
  if (existing && existing.startsWith('blob:')) {
    try { URL.revokeObjectURL(existing); } catch (err) { /* already revoked, ignore */ }
  }
  artUrlCache.delete(songId);
}

export function invalidateArtworkCache(songId) {
  invalidateArtworkCacheInternal(songId);
  dominantColorCache.delete(songId);
}

function isMp3(song) {
  const ext = (song.fileName || '').split('.').pop()?.toLowerCase();
  return ext === 'mp3' || song.mimeType === 'audio/mpeg';
}

/**
 * Parse an ID3v2.3/2.4 tag out of the start of the file and return the
 * APIC (attached picture) frame's image data as a Blob, or null if there
 * isn't one / the tag is v2.2 (rare, different frame IDs) / anything
 * about the tag looks malformed.
 */
async function extractId3Apic(blob) {
  const frames = await readId3Frames(blob);
  if (!frames) return null;
  const apic = frames.find((f) => f.frameId === 'APIC');
  if (!apic) return null;
  return parseApicFrame(apic.buffer, apic.start, apic.size);
}

/**
 * Read real ID3v2 text tags (title/artist/album) for a song, so imports
 * aren't limited to filename guessing when the file already carries
 * proper metadata. Returns null fields for anything not present — the
 * caller decides how to fall back (e.g. to the filename-cleaner guess).
 * Never throws: any parse failure just yields an all-null result.
 */
export async function getEmbeddedTags(song) {
  const empty = {
    title: null, artist: null, album: null, albumArtist: null, genre: null,
    year: null, trackNumber: null, discNumber: null, composer: null, comment: null,
  };
  if (!song || !isMp3(song)) return empty;

  try {
    const frames = await readId3Frames(song.blob);
    if (!frames) return empty;

    const find = (id) => frames.find((f) => f.frameId === id);
    return {
      title: parseTextFrame(find('TIT2')),
      artist: parseTextFrame(find('TPE1')),
      album: parseTextFrame(find('TALB')),
      albumArtist: parseTextFrame(find('TPE2')),
      genre: parseTextFrame(find('TCON')),
      year: parseTextFrame(find('TYER')) || parseTextFrame(find('TDRC')),
      trackNumber: parseTextFrame(find('TRCK')),
      discNumber: parseTextFrame(find('TPOS')),
      composer: parseTextFrame(find('TCOM')),
      comment: parseCommentFrame(find('COMM')),
    };
  } catch (err) {
    console.warn(`[Melody] ID3 text tag extraction failed for "${song.title}".`, err);
    return empty;
  }
}

function parseCommentFrame(frame) {
  if (!frame) return null;
  const bytes = new Uint8Array(frame.buffer, frame.start, frame.size);
  if (bytes.length < 5) return null;

  const encoding = bytes[0];
  const isUtf16 = encoding === 1 || encoding === 2;
  let i = 4;
  i = isUtf16 ? indexOfDoubleNull(bytes, i) + 2 : indexOfNull(bytes, i) + 1;
  if (i <= 0 || i > bytes.length) return null;

  const textBytes = bytes.slice(i);
  try {
    const text = encoding === 0
      ? new TextDecoder('iso-8859-1').decode(textBytes)
      : encoding === 3
        ? new TextDecoder('utf-8').decode(textBytes)
        : new TextDecoder('utf-16').decode(textBytes);
    const trimmed = text.replace(/\u0000+$/g, '').trim();
    return trimmed || null;
  } catch (err) {
    return null;
  }
}

/**
 * Shared low-level walk over an ID3v2.3/2.4 tag's frames. Returns an array
 * of { frameId, buffer, start, size } so both artwork (APIC) and text tag
 * (TIT2/TPE1/TALB) readers can reuse the same parsing/bounds-checking
 * logic instead of duplicating it. Returns null if there's no valid tag.
 */
async function readId3Frames(blob) {
  // ID3v2 tags live at the very start of the file and are almost always
  // well under 1MB even with large embedded art — read a generous slice
  // rather than the whole file for speed on big FLAC-sized uploads.
  const headSlice = blob.slice(0, Math.min(blob.size, 2 * 1024 * 1024));
  const buffer = await headSlice.arrayBuffer();
  const view = new DataView(buffer);

  if (buffer.byteLength < 10) return null;
  // "ID3" magic
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) {
    return null;
  }

  const majorVersion = view.getUint8(3); // 3 = v2.3, 4 = v2.4
  const flags = view.getUint8(5);
  const hasExtendedHeader = (flags & 0x40) !== 0;
  const tagSize = synchsafeToInt(view, 6); // size after the 10-byte header

  let offset = 10;
  const tagEnd = Math.min(10 + tagSize, buffer.byteLength);

  if (hasExtendedHeader) {
    const extSize = majorVersion === 4
      ? synchsafeToInt(view, offset)
      : view.getUint32(offset, false);
    offset += extSize + (majorVersion === 4 ? 0 : 4);
  }

  const frames = [];

  while (offset + 10 <= tagEnd) {
    const frameId = readAscii(view, offset, 4);
    if (!frameId || frameId === '\0\0\0\0') break; // padding reached

    const frameSize = majorVersion === 4
      ? synchsafeToInt(view, offset + 4)
      : view.getUint32(offset + 4, false);

    const frameHeaderSize = 10;
    const frameStart = offset + frameHeaderSize;

    if (frameSize <= 0 || frameStart + frameSize > buffer.byteLength) break; // malformed, bail safely

    frames.push({ frameId, buffer, start: frameStart, size: frameSize });
    offset = frameStart + frameSize;
  }

  return frames;
}

/** Decode a text-information frame (TIT2/TPE1/TALB/...) to a plain string. */
function parseTextFrame(frame) {
  if (!frame) return null;
  const bytes = new Uint8Array(frame.buffer, frame.start, frame.size);
  if (bytes.length < 2) return null;

  const encoding = bytes[0];
  const body = bytes.slice(1);
  let text = '';

  try {
    if (encoding === 0) {
      text = new TextDecoder('iso-8859-1').decode(body); // ISO-8859-1
    } else if (encoding === 3) {
      text = new TextDecoder('utf-8').decode(body); // UTF-8
    } else {
      text = new TextDecoder('utf-16').decode(body); // UTF-16 (BOM or not) — encodings 1/2
    }
  } catch (err) {
    return null;
  }

  text = text.replace(/\u0000+$/g, '').trim();
  return text || null;
}

/** APIC frame layout: [encoding:1][mime:zstr][pictureType:1][description:zstr][imageData:...] */
function parseApicFrame(buffer, start, size) {
  const bytes = new Uint8Array(buffer, start, size);
  const encoding = bytes[0];
  let i = 1;

  const mimeEnd = indexOfNull(bytes, i);
  if (mimeEnd === -1) return null;
  const mime = asciiFromBytes(bytes, i, mimeEnd) || 'image/jpeg';
  i = mimeEnd + 1;

  i += 1; // picture type byte

  // Description is null-terminated; UTF-16 descriptions use a 2-byte
  // terminator. We don't need the text, just need to skip it correctly.
  const isUtf16 = encoding === 1 || encoding === 2;
  i = isUtf16 ? indexOfDoubleNull(bytes, i) + 2 : indexOfNull(bytes, i) + 1;
  if (i <= 0 || i > bytes.length) return null;

  const imageBytes = bytes.slice(i);
  if (imageBytes.length < 100) return null; // too small to be real art — treat as malformed

  return new Blob([imageBytes], { type: mime.startsWith('image/') ? mime : 'image/jpeg' });
}

function synchsafeToInt(view, offset) {
  return (
    ((view.getUint8(offset) & 0x7f) << 21) |
    ((view.getUint8(offset + 1) & 0x7f) << 14) |
    ((view.getUint8(offset + 2) & 0x7f) << 7) |
    (view.getUint8(offset + 3) & 0x7f)
  );
}

function readAscii(view, offset, length) {
  let str = '';
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i);
    if (code < 0x20 || code > 0x7e) return null; // not printable ASCII — not a real frame id
    str += String.fromCharCode(code);
  }
  return str;
}

function asciiFromBytes(bytes, start, end) {
  let str = '';
  for (let i = start; i < end; i++) str += String.fromCharCode(bytes[i]);
  return str;
}

function indexOfNull(bytes, from) {
  for (let i = from; i < bytes.length; i++) if (bytes[i] === 0x00) return i;
  return -1;
}

function indexOfDoubleNull(bytes, from) {
  for (let i = from; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x00 && bytes[i + 1] === 0x00) return i;
  }
  return -1;
}
