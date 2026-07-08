/**
 * metadata-editor.js
 * Phase 3 - manual metadata editing for a single song: Title, Artist,
 * Album, Album Artist, Genre, Year, Track Number, Disc Number, Composer,
 * Comment, plus replacing/cropping artwork (with an online "Cover Art
 * Finder" assist). Saves straight into the MP3's own ID3 tags when
 * possible (metadata-writer.js); anything else falls back to a
 * local-only IndexedDB override, same record either way.
 */

import { getSong, updateSongMetadata, undoSongMetadata, resetSongMetadata, updateSongCoverArt, addSong } from '../services/library-service.js';
import { writeId3Tags, canWriteToFile } from '../services/metadata-writer.js';
import { getArtworkUrl, invalidateArtworkCache, getEmbeddedArtworkBlob } from '../services/artwork-service.js';
import { findCoverArtCandidates, downloadCoverArt } from '../services/coverart-service.js';
import { navigate } from '../utils/router.js';
import { attachShell } from './shell.js';
import { showToast } from '../utils/toast.js';

const FIELDS = [
  { key: 'title', label: 'Song Title' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'albumArtist', label: 'Album Artist' },
  { key: 'genre', label: 'Genre' },
  { key: 'year', label: 'Year' },
  { key: 'trackNumber', label: 'Track Number' },
  { key: 'discNumber', label: 'Disc Number' },
  { key: 'composer', label: 'Composer' },
  { key: 'comment', label: 'Comment' },
];

export async function renderMetadataEditorScreen(params = {}) {
  const songId = params.songId;
  const fromRoute = params.from || 'music-hub';

  const el = document.createElement('div');
  el.className = 'screen metadata-editor-screen has-shell';

  let song = songId ? await getSong(songId).catch(() => null) : null;

  if (!song) {
    el.innerHTML = `
      <header class="screen-header"><button class="back-link" id="editor-back">‹ Back</button></header>
      <div class="empty-state"><p class="title">Song not found</p></div>
    `;
    el.querySelector('#editor-back').addEventListener('click', () => navigate(fromRoute));
    const unsub = attachShell(el, 'library');
    el._onLeave = unsub;
    return el;
  }

  el.innerHTML = `
    <header class="screen-header">
      <button class="back-link" id="editor-back">‹ Back</button>
      <h1>Edit Metadata</h1>
    </header>

    <div class="editor-art-wrap">
      <div class="editor-art" id="editor-art"></div>
      <div class="editor-art-actions">
        <button id="editor-replace-art" type="button">Replace Cover</button>
        <button id="editor-find-art" type="button">Find Online</button>
      </div>
      <input type="file" id="editor-art-input" accept="image/*" hidden />
    </div>

    <form class="editor-form" id="editor-form">
      ${FIELDS.map((f) => `
        <label class="editor-field">
          <span>${f.label}</span>
          <input type="text" name="${f.key}" value="${escapeAttr(song[f.key] || '')}" ${f.key === 'comment' ? '' : 'maxlength="200"'} />
        </label>
      `).join('')}

      <p class="editor-write-note" id="editor-write-note">
        ${canWriteToFile(song)
          ? 'Changes will be saved directly into this MP3\u2019s tags.'
          : 'This format can\u2019t be re-tagged on-device, so changes are saved as a local override in Melody only.'}
      </p>

      <div class="editor-actions">
        <button type="submit" class="btn-primary">Save Changes</button>
        <button type="button" id="editor-undo">Undo Changes</button>
        <button type="button" id="editor-reset">Reset to Original Metadata</button>
      </div>
    </form>
  `;

  el.querySelector('#editor-back').addEventListener('click', () => navigate(fromRoute, { songId: song.id }));

  const artEl = el.querySelector('#editor-art');
  async function refreshArtPreview() {
    const url = await getArtworkUrl(song);
    artEl.innerHTML = url && !url.startsWith('data:image/svg+xml')
      ? `<img src="${url}" alt="" />`
      : placeholderArtSvg();
  }
  refreshArtPreview();

  // ---------- Replace cover (upload + crop) ----------
  const fileInput = el.querySelector('#editor-art-input');
  el.querySelector('#editor-replace-art').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    openCropSheet(file, async (croppedBlob) => {
      await applyCoverArt(song, croppedBlob);
      await refreshArtPreview();
    });
  });

  // ---------- Find cover online ----------
  el.querySelector('#editor-find-art').addEventListener('click', () => {
    openCoverArtFinderSheet(song, async (blob) => {
      await applyCoverArt(song, blob);
      await refreshArtPreview();
    });
  });

  // ---------- Save ----------
  const form = el.querySelector('#editor-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const patch = {};
    FIELDS.forEach((f) => { patch[f.key] = (formData.get(f.key) || '').toString().trim(); });

    try {
      if (canWriteToFile(song)) {
        const coverArtBlob = song.coverArt || await getEmbeddedArtworkBlob(song);
        const newBlob = await writeId3Tags(song, { ...patch, coverArtBlob });
        if (newBlob) {
          song = { ...song, blob: newBlob, fileSize: newBlob.size };
          await addSong(song); // persist the rewritten blob before the metadata patch below
        }
      }
      song = await updateSongMetadata(song.id, patch);
      showToast('Metadata saved');
      navigate(fromRoute, { songId: song.id });
    } catch (err) {
      console.error('[Melody] Metadata save failed.', err);
      showToast('Could not save changes');
    }
  });

  // ---------- Undo ----------
  el.querySelector('#editor-undo').addEventListener('click', async () => {
    song = await undoSongMetadata(song.id);
    if (song) {
      FIELDS.forEach((f) => { form.elements[f.key].value = song[f.key] || ''; });
      showToast('Reverted last change');
    }
  });

  // ---------- Reset to original ----------
  el.querySelector('#editor-reset').addEventListener('click', async () => {
    song = await resetSongMetadata(song.id);
    if (song) {
      FIELDS.forEach((f) => { form.elements[f.key].value = song[f.key] || ''; });
      showToast('Metadata reset to original');
    }
  });

  const unsubscribeShell = attachShell(el, 'library');
  el._onLeave = unsubscribeShell;

  return el;
}

async function applyCoverArt(song, blob) {
  await updateSongCoverArt(song.id, blob);
  invalidateArtworkCache(song.id);
  song.coverArt = blob;
  showToast('Cover art updated');
}

/**
 * "Cover Art Finder" - a small sheet of online candidates for this song's
 * artist/album, tapping one downloads and applies it as the new cover.
 */
async function openCoverArtFinderSheet(song, onPick) {
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Find cover art">
      <div class="sheet-handle"></div>
      <h2>Find Cover Art</h2>
      <div class="coverart-grid" id="coverart-grid"><p class="sheet-empty">Searching…</p></div>
      <button class="sheet-close" id="coverart-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#coverart-cancel').addEventListener('click', () => overlay.remove());

  const grid = overlay.querySelector('#coverart-grid');
  const candidates = await findCoverArtCandidates({ artist: song.artist, album: song.album, title: song.title });

  if (candidates.length === 0) {
    grid.innerHTML = `<p class="sheet-empty">No online matches found for this song.</p>`;
    return;
  }

  grid.innerHTML = candidates.map((c, i) => `
    <button class="coverart-option" data-index="${i}">
      <img src="${c.artworkUrl}" alt="${escapeAttr(c.collectionName)}" loading="lazy" />
    </button>
  `).join('');

  grid.querySelectorAll('.coverart-option').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const candidate = candidates[Number(btn.dataset.index)];
      btn.disabled = true;
      const blob = await downloadCoverArt(candidate.artworkUrl);
      overlay.remove();
      if (blob) onPick(blob); else showToast('Could not download that cover');
    });
  });
}

/**
 * A minimal square crop tool: drag to pan, slider to zoom, confirm to
 * bake the visible window into a fixed-size square Blob.
 */
function openCropSheet(file, onConfirm) {
  const VIEWPORT = 280;
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet crop-sheet" role="dialog" aria-label="Crop cover art">
      <div class="sheet-handle"></div>
      <h2>Crop Cover Art</h2>
      <div class="crop-viewport" id="crop-viewport" style="width:${VIEWPORT}px;height:${VIEWPORT}px;">
        <img id="crop-image" alt="" draggable="false" />
      </div>
      <input type="range" id="crop-zoom" min="1" max="3" step="0.01" value="1" />
      <div class="editor-actions">
        <button type="button" class="btn-primary" id="crop-confirm">Use Photo</button>
        <button type="button" id="crop-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const img = overlay.querySelector('#crop-image');
  const viewport = overlay.querySelector('#crop-viewport');
  const zoomSlider = overlay.querySelector('#crop-zoom');
  const objectUrl = URL.createObjectURL(file);
  img.src = objectUrl;

  let baseScale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragging = false;
  let dragStart = { x: 0, y: 0, offsetX: 0, offsetY: 0 };

  function displayScale() {
    return baseScale * Number(zoomSlider.value);
  }

  function applyTransform() {
    const scale = displayScale();
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    // Clamp so the image always fully covers the viewport.
    offsetX = Math.min(0, Math.max(offsetX, VIEWPORT - w));
    offsetY = Math.min(0, Math.max(offsetY, VIEWPORT - h));
    img.style.width = `${w}px`;
    img.style.height = `${h}px`;
    img.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
  }

  img.addEventListener('load', () => {
    baseScale = VIEWPORT / Math.min(img.naturalWidth, img.naturalHeight);
    offsetX = (VIEWPORT - img.naturalWidth * baseScale) / 2;
    offsetY = (VIEWPORT - img.naturalHeight * baseScale) / 2;
    applyTransform();
  });

  function startDrag(x, y) {
    dragging = true;
    dragStart = { x, y, offsetX, offsetY };
  }
  function moveDrag(x, y) {
    if (!dragging) return;
    offsetX = dragStart.offsetX + (x - dragStart.x);
    offsetY = dragStart.offsetY + (y - dragStart.y);
    applyTransform();
  }
  function endDrag() { dragging = false; }

  viewport.addEventListener('pointerdown', (e) => { viewport.setPointerCapture(e.pointerId); startDrag(e.clientX, e.clientY); });
  viewport.addEventListener('pointermove', (e) => moveDrag(e.clientX, e.clientY));
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  zoomSlider.addEventListener('input', applyTransform);

  function cleanup() {
    URL.revokeObjectURL(objectUrl);
    overlay.remove();
  }

  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  overlay.querySelector('#crop-cancel').addEventListener('click', cleanup);

  overlay.querySelector('#crop-confirm').addEventListener('click', () => {
    const scale = displayScale();
    const sx = -offsetX / scale;
    const sy = -offsetY / scale;
    const sSize = VIEWPORT / scale;

    const canvas = document.createElement('canvas');
    const OUTPUT = 500;
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT, OUTPUT);

    canvas.toBlob((blob) => {
      cleanup();
      if (blob) onConfirm(blob);
    }, 'image/jpeg', 0.92);
  });
}

function placeholderArtSvg() {
  return `
    <svg viewBox="0 0 200 200" width="100%" height="100%" aria-hidden="true">
      <rect width="200" height="200" fill="#EAE3DB"/>
      <circle cx="100" cy="100" r="60" fill="#232323"/>
      <circle cx="100" cy="100" r="10" fill="#F5F1EC"/>
    </svg>
  `;
}

function escapeAttr(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML.replace(/"/g, '&quot;');
}
