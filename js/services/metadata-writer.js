/**
 * metadata-writer.js
 * Writes an ID3v2.3 tag (title/artist/album/album artist/genre/year/track/
 * disc/composer/comment + optional cover art) directly into an MP3 file's
 * bytes, replacing any existing ID3v2 tag at the front of the file.
 *
 * This is the "save changes directly to the music file when supported"
 * half of the Metadata Editor. Only MP3 is supported for real writes —
 * FLAC/M4A/WAV/OGG use different container formats (METADATA_BLOCK_PICTURE,
 * MP4 atoms, Vorbis comments) and are intentionally out of scope here, same
 * as artwork-service.js's read side; callers fall back to a local-only
 * override (see library-service.updateSongMetadata) for those formats.
 *
 * Every entry point is defensive: a malformed/unexpected input never
 * throws past its caller uncaught — metadata-editor.js checks
 * `fileWriteSupported` before calling this at all, but this module double
 * checks the format itself too.
 */

const FRAME_MAP = {
  title: 'TIT2',
  artist: 'TPE1',
  album: 'TALB',
  albumArtist: 'TPE2',
  genre: 'TCON',
  year: 'TYER',
  trackNumber: 'TRCK',
  discNumber: 'TPOS',
  composer: 'TCOM',
};

/** Returns true if this file/song looks like an MP3 we can safely rewrite. */
export function canWriteToFile(song) {
  const ext = (song.fileName || '').split('.').pop()?.toLowerCase();
  return ext === 'mp3' || song.mimeType === 'audio/mpeg';
}

/**
 * Build a brand-new audio Blob with an updated ID3v2.3 tag prepended,
 * given the song's *current* blob and a metadata patch (any subset of
 * FRAME_MAP's keys, plus `comment` and/or `coverArtBlob`).
 * Returns the new Blob, or null if writing isn't supported/something
 * about the source file couldn't be parsed safely.
 */
export async function writeId3Tags(song, patch) {
  if (!canWriteToFile(song)) return null;

  try {
    const buffer = await song.blob.arrayBuffer();
    const audioStart = findExistingTagEnd(buffer);
    const audioBytes = new Uint8Array(buffer, audioStart);

    const merged = {
      title: patch.title ?? song.title ?? '',
      artist: patch.artist ?? song.artist ?? '',
      album: patch.album ?? song.album ?? '',
      albumArtist: patch.albumArtist ?? song.albumArtist ?? '',
      genre: patch.genre ?? song.genre ?? '',
      year: patch.year ?? song.year ?? '',
      trackNumber: patch.trackNumber ?? song.trackNumber ?? '',
      discNumber: patch.discNumber ?? song.discNumber ?? '',
      composer: patch.composer ?? song.composer ?? '',
      comment: patch.comment ?? song.comment ?? '',
    };

    const frames = [];
    Object.entries(FRAME_MAP).forEach(([key, frameId]) => {
      if (merged[key]) frames.push(buildTextFrame(frameId, merged[key]));
    });
    if (merged.comment) frames.push(buildCommentFrame(merged.comment));

    const coverArtBlob = patch.coverArtBlob !== undefined ? patch.coverArtBlob : song.coverArt;
    if (coverArtBlob) {
      const apicBytes = await buildApicFrame(coverArtBlob);
      if (apicBytes) frames.push(apicBytes);
    }

    const framesBytes = concatBytes(frames);
    const header = buildTagHeader(framesBytes.length);

    const newBlob = new Blob([header, framesBytes, audioBytes], {
      type: song.mimeType || 'audio/mpeg',
    });
    return newBlob;
  } catch (err) {
    console.warn(`[Melody] ID3 write failed for "${song.title}" — falling back to local-only edit.`, err);
    return null;
  }
}

/** Find where any existing ID3v2 tag ends (0 if there isn't one), so we can strip it before rewriting. */
function findExistingTagEnd(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 10) return 0;
  if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return 0;
  const tagSize = synchsafeToInt(view, 6);
  return Math.min(10 + tagSize, buffer.byteLength);
}

function synchsafeToInt(view, offset) {
  return (
    ((view.getUint8(offset) & 0x7f) << 21) |
    ((view.getUint8(offset + 1) & 0x7f) << 14) |
    ((view.getUint8(offset + 2) & 0x7f) << 7) |
    (view.getUint8(offset + 3) & 0x7f)
  );
}

function intToSynchsafe(size) {
  return new Uint8Array([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
}

/** 10-byte ID3v2.3 header for a tag whose frame payload is `frameSize` bytes. */
function buildTagHeader(frameSize) {
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33], 0); // "ID3"
  header[3] = 3; // version 2.3
  header[4] = 0; // revision
  header[5] = 0; // flags
  header.set(intToSynchsafe(frameSize), 6);
  return header;
}

/** Build a UTF-8 text-information frame (TIT2/TPE1/TALB/...). Encoding byte 3 = UTF-8. */
function buildTextFrame(frameId, text) {
  const textBytes = new TextEncoder().encode(String(text));
  const body = new Uint8Array(textBytes.length + 1);
  body[0] = 3; // UTF-8 encoding
  body.set(textBytes, 1);
  return wrapFrame(frameId, body);
}

/** COMM frame: [encoding][lang:3][short-desc:zstr][text]. Language "eng", no short description. */
function buildCommentFrame(text) {
  const textBytes = new TextEncoder().encode(String(text));
  const body = new Uint8Array(1 + 3 + 1 + textBytes.length);
  body[0] = 3; // UTF-8
  body.set([0x65, 0x6e, 0x67], 1); // "eng"
  body[4] = 0x00; // empty short description terminator
  body.set(textBytes, 5);
  return wrapFrame('COMM', body);
}

/** APIC frame: [encoding][mime:zstr][pictureType][description:zstr][image bytes]. */
async function buildApicFrame(coverArtBlob) {
  try {
    const imageBytes = new Uint8Array(await coverArtBlob.arrayBuffer());
    const mime = coverArtBlob.type || 'image/jpeg';
    const mimeBytes = new TextEncoder().encode(mime);
    const body = new Uint8Array(1 + mimeBytes.length + 1 + 1 + 1 + imageBytes.length);
    let i = 0;
    body[i++] = 0; // ISO-8859-1 encoding (ascii mime string, keeps things simple)
    body.set(mimeBytes, i); i += mimeBytes.length;
    body[i++] = 0x00; // mime terminator
    body[i++] = 0x03; // picture type: front cover
    body[i++] = 0x00; // empty description terminator
    body.set(imageBytes, i);
    return wrapFrame('APIC', body);
  } catch (err) {
    console.warn('[Melody] Failed to build APIC frame — cover art will not be embedded.', err);
    return null;
  }
}

/**
 * 10-byte frame header + body. NOTE: unlike the tag header's size field,
 * ID3v2.3 frame sizes are a plain 32-bit big-endian integer (not
 * synchsafe) - v2.4 is the version that made frame sizes synchsafe too.
 * We write v2.3 tags, matching how artwork-service.js already parses
 * frame sizes for major version 3.
 */
function wrapFrame(frameId, bodyBytes) {
  const idBytes = new TextEncoder().encode(frameId);
  const frame = new Uint8Array(10 + bodyBytes.length);
  frame.set(idBytes, 0);
  const size = bodyBytes.length;
  frame[4] = (size >>> 24) & 0xff;
  frame[5] = (size >>> 16) & 0xff;
  frame[6] = (size >>> 8) & 0xff;
  frame[7] = size & 0xff;
  frame[8] = 0; frame[9] = 0; // flags
  frame.set(bodyBytes, 10);
  return frame;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((c) => { out.set(c, offset); offset += c.length; });
  return out;
}
