/**
 * import-service.js
 * Turns a FileList (from an <input type="file"> or drag-and-drop) into
 * saved song records in the library.
 *
 * Pipeline per file:
 *   1. Validate it's a supported audio format
 *   2. Read duration via a throwaway <audio> element
 *   3. Clean the filename into a title/artist guess (filename-cleaner.js)
 *   4. Check for a likely duplicate already in the library
 *   5. Save (or ask the caller to resolve the duplicate first)
 *
 * The full ID3-tag reading + MusicBrainz/AcoustID lookup + embedded cover
 * art extraction described in the brief lives in metadata-service.js,
 * which is the next build pass — this service already leaves the right
 * hook (a `metadata` field on the song record) for it to fill in later.
 */

import { cleanFilename } from '../utils/filename-cleaner.js';
import { addSong, findPossibleDuplicate } from './library-service.js';
import { getEmbeddedTags } from './artwork-service.js';

const SUPPORTED_EXTENSIONS = ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg'];
const SUPPORTED_MIME_PREFIXES = ['audio/'];

/**
 * Import a FileList/array of Files.
 * @param {FileList|File[]} files
 * @param {Object} [options]
 * @param {(result: ImportProgress) => void} [options.onProgress] called after each file
 * @param {(duplicate, incoming) => Promise<'replace'|'keep-both'|'skip'>} [options.onDuplicate]
 *        called when a likely duplicate is found; defaults to "keep-both"
 * @returns {Promise<{imported: number, skipped: number, failed: number, errors: string[]}>}
 */
export async function importFiles(files, options = {}) {
  const { onProgress, onDuplicate } = options;
  const fileArray = Array.from(files);

  const summary = { imported: 0, skipped: 0, failed: 0, errors: [] };

  for (const file of fileArray) {
    try {
      if (!isSupportedAudioFile(file)) {
        summary.skipped += 1;
        summary.errors.push(`${file.name}: unsupported format`);
        continue;
      }

      const duration = await readDuration(file).catch(() => 0);
      const { title: guessedTitle, artist: guessedArtist } = cleanFilename(file.name);

      // Real ID3 tags (when present) beat the filename guess — a proper
      // metadata-service with MusicBrainz/AcoustID lookups is still a
      // future pass, but embedded tags are already sitting in the file
      // and cost nothing extra to read during import.
      const tags = await getEmbeddedTags({ fileName: file.name, mimeType: file.type, blob: file, title: guessedTitle })
        .catch(() => ({ title: null, artist: null, album: null }));

      const usedTags = Boolean(tags.title || tags.artist || tags.album);

      const candidate = {
        id: crypto.randomUUID(),
        title: tags.title || guessedTitle,
        artist: tags.artist || guessedArtist || 'Unknown Artist',
        album: tags.album || 'Unknown Album',
        duration,
        fileName: file.name,
        mimeType: file.type || guessMimeType(file.name),
        blob: file,
        coverArt: null,
        dateAdded: Date.now(),
        metadata: usedTags
          ? { source: 'id3', verified: true }
          : { source: 'filename-guess', verified: false },
      };

      const duplicate = await findPossibleDuplicate(candidate);

      if (duplicate) {
        const resolution = onDuplicate
          ? await onDuplicate(duplicate, candidate)
          : 'keep-both';

        if (resolution === 'skip') {
          summary.skipped += 1;
          onProgress?.({ file, status: 'skipped-duplicate' });
          continue;
        }
        if (resolution === 'replace') {
          candidate.id = duplicate.id; // overwrite in place
        }
        // 'keep-both' falls through and saves as a new record
      }

      await addSong(candidate);
      summary.imported += 1;
      onProgress?.({ file, status: 'imported', song: candidate });
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`${file.name}: ${err.message}`);
      onProgress?.({ file, status: 'failed', error: err });
    }
  }

  return summary;
}

function isSupportedAudioFile(file) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const mimeOk = SUPPORTED_MIME_PREFIXES.some((p) => (file.type || '').startsWith(p));
  return SUPPORTED_EXTENSIONS.includes(ext) || mimeOk;
}

function guessMimeType(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map = {
    mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4',
    aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg',
  };
  return map[ext] || 'application/octet-stream';
}

/** Read a file's duration in seconds using a throwaway <audio> element. */
function readDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';

    const cleanup = () => URL.revokeObjectURL(url);

    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? Math.round(audio.duration) : 0;
      cleanup();
      resolve(duration);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('Could not read audio metadata'));
    };
    audio.src = url;
  });
}
