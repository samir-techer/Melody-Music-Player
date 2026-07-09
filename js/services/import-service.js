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
 * ID3 tags are read locally during import (see getEmbeddedTags below).
 * Whatever's still missing after that — genre, year, album, cover art,
 * etc. — gets handed to metadata-service.js, which looks it up online
 * (iTunes Search API) if the corresponding "Library & Metadata" Settings
 * toggle is on, filling in only the fields that are actually empty.
 */

import { cleanFilename } from '../utils/filename-cleaner.js';
import { addSong, findPossibleDuplicate } from './library-service.js';
import { getEmbeddedTags } from './artwork-service.js';
import { autoEnrichSong } from './metadata-service.js';

const SUPPORTED_EXTENSIONS = ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg'];
const SUPPORTED_MIME_PREFIXES = ['audio/'];

/**
 * Import a FileList/array of Files.
 * @param {FileList|File[]} files
 * @param {Object} [options]
 * @param {(result: ImportProgress) => void} [options.onProgress] called after each file
 *        (status: 'imported' | 'enriched' | 'skipped-duplicate' | 'failed';
 *        'enriched' fires as a second, optional event per file once
 *        auto-fetched metadata/cover art has been applied, if any was)
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

      // Real ID3 tags (when present) beat the filename guess — embedded
      // tags are already sitting in the file and cost nothing extra to
      // read during import. Anything still missing after this gets a shot
      // at an online lookup below, via autoEnrichSong().
      const tags = await getEmbeddedTags({ fileName: file.name, mimeType: file.type, blob: file, title: guessedTitle })
        .catch(() => ({}));

      const usedTags = Boolean(tags.title || tags.artist || tags.album);
      const folderPath = file.webkitRelativePath
        ? (file.webkitRelativePath.split('/').slice(0, -1).join('/') || 'On My Device')
        : 'On My Device';

      const candidate = {
        id: crypto.randomUUID(),
        title: tags.title || guessedTitle,
        artist: tags.artist || guessedArtist || 'Unknown Artist',
        album: tags.album || 'Unknown Album',
        albumArtist: tags.albumArtist || '',
        genre: tags.genre || '',
        year: tags.year || '',
        trackNumber: tags.trackNumber || '',
        discNumber: tags.discNumber || '',
        composer: tags.composer || '',
        comment: tags.comment || '',
        duration,
        fileName: file.name,
        folderPath,
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

      // Best-effort: fill in whatever metadata/cover art is still missing
      // (per the Settings toggles) now that the song is safely saved. A
      // lookup failure here never fails the import — it just leaves the
      // fields as they were.
      try {
        const { metadataUpdated, coverArtUpdated } = await autoEnrichSong(candidate);
        if (metadataUpdated || coverArtUpdated) {
          onProgress?.({ file, status: 'enriched', song: candidate, metadataUpdated, coverArtUpdated });
        }
      } catch (err) {
        console.warn(`[Melody] Auto-enrichment failed for "${candidate.title}".`, err);
      }
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
