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
    if (isMp3(song)) {
      const blob = await extractId3Apic(song.blob);
      if (blob) url = URL.createObjectURL(blob);
    }
  } catch (err) {
    console.warn(`[Melody] Artwork extraction failed for "${song.title}" — using placeholder.`, err);
  }

  const resolved = url || DEFAULT_ART_URL;
  artUrlCache.set(song.id, resolved);
  return resolved;
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

  while (offset + 10 <= tagEnd) {
    const frameId = readAscii(view, offset, 4);
    if (!frameId || frameId === '\0\0\0\0') break; // padding reached

    const frameSize = majorVersion === 4
      ? synchsafeToInt(view, offset + 4)
      : view.getUint32(offset + 4, false);

    const frameHeaderSize = 10;
    const frameStart = offset + frameHeaderSize;

    if (frameSize <= 0 || frameStart + frameSize > buffer.byteLength) break; // malformed, bail safely

    if (frameId === 'APIC') {
      const picture = parseApicFrame(buffer, frameStart, frameSize);
      if (picture) return picture;
    }

    offset = frameStart + frameSize;
  }

  return null;
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
