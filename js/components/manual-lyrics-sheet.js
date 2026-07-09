/**
 * manual-lyrics-sheet.js
 * Phase 2 - Manual Lyrics Search. A bottom sheet (same visual language as
 * playlist-sheet.js / metadata-editor.js) that lets the person edit the
 * title/artist/album used for a lyrics search - without touching the
 * song's actual stored metadata - re-run the search, and pick the right
 * result when LRCLIB returns more than one plausible match.
 *
 * Opened from lyrics-screen.js's "Lyrics not available" empty state.
 * On a successful pick, calls the `onApply(result)` callback with the same
 * { found, plainLyrics, syncedLyrics } shape getLyricsForSong() returns, so
 * the caller can render it exactly like an automatic match.
 */

import { searchLyricsManually, applyManualLyricsSelection } from '../services/lyrics-service.js';
import { showToast } from '../utils/toast.js';

export function openManualLyricsSheet(song, onApply) {
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet manual-lyrics-sheet" role="dialog" aria-label="Search lyrics manually">
      <div class="sheet-handle"></div>
      <h2>Search Lyrics Manually</h2>
      <p class="manual-lyrics-hint">Fix the title, artist, or album just for this search - it won't change your song's tags.</p>

      <form id="manual-lyrics-form" class="manual-lyrics-form">
        <label class="manual-lyrics-field">
          <span>Song Title</span>
          <input type="text" id="manual-lyrics-title" required maxlength="200" />
        </label>
        <label class="manual-lyrics-field">
          <span>Artist</span>
          <input type="text" id="manual-lyrics-artist" maxlength="200" />
        </label>
        <label class="manual-lyrics-field">
          <span>Album <em>(optional)</em></span>
          <input type="text" id="manual-lyrics-album" maxlength="200" />
        </label>
        <button type="submit" id="manual-lyrics-search-btn">Search</button>
      </form>

      <div class="manual-lyrics-results" id="manual-lyrics-results"></div>

      <button class="sheet-close" id="manual-lyrics-close">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const titleInput = overlay.querySelector('#manual-lyrics-title');
  const artistInput = overlay.querySelector('#manual-lyrics-artist');
  const albumInput = overlay.querySelector('#manual-lyrics-album');
  const resultsEl = overlay.querySelector('#manual-lyrics-results');
  const form = overlay.querySelector('#manual-lyrics-form');
  const searchBtn = overlay.querySelector('#manual-lyrics-search-btn');

  titleInput.value = song.title || '';
  artistInput.value = song.artist || '';
  albumInput.value = song.album && song.album !== 'Unknown Album' ? song.album : '';

  function close() {
    overlay.remove();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('#manual-lyrics-close').addEventListener('click', close);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = {
      title: titleInput.value.trim(),
      artist: artistInput.value.trim(),
      album: albumInput.value.trim(),
    };
    if (!query.title) {
      titleInput.focus();
      return;
    }

    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching…';
    resultsEl.innerHTML = `
      <div class="manual-lyrics-loading">
        <div class="lyrics-spinner" aria-hidden="true"></div>
        <p>Searching LRCLIB…</p>
      </div>
    `;

    let matches = [];
    try {
      matches = await searchLyricsManually(query);
    } catch (err) {
      console.error('[Melody] Manual lyrics search failed.', err);
    }

    searchBtn.disabled = false;
    searchBtn.textContent = 'Search';
    renderResults(matches);
  });

  function renderResults(matches) {
    if (!matches.length) {
      resultsEl.innerHTML = `
        <p class="manual-lyrics-empty">No matches found. Try adjusting the title, artist, or leaving the album blank.</p>
      `;
      return;
    }

    resultsEl.innerHTML = `
      <p class="manual-lyrics-results-label">${matches.length} match${matches.length === 1 ? '' : 'es'} - pick the right one</p>
      <div class="manual-lyrics-list">
        ${matches.map((m, i) => `
          <button type="button" class="manual-lyrics-row" data-index="${i}">
            <div class="manual-lyrics-row-main">
              <span class="manual-lyrics-row-title">${escapeHtml(m.title || 'Untitled')}</span>
              <span class="manual-lyrics-row-artist">${escapeHtml(m.artist || 'Unknown Artist')}</span>
              ${m.album ? `<span class="manual-lyrics-row-album">${escapeHtml(m.album)}</span>` : ''}
            </div>
            <div class="manual-lyrics-row-meta">
              ${m.duration ? `<span class="manual-lyrics-row-duration">${formatDuration(m.duration)}</span>` : ''}
              <span class="manual-lyrics-row-badge ${m.hasSynced ? 'is-synced' : 'is-plain'}">
                ${m.hasSynced ? 'Synced' : 'Plain'}
              </span>
            </div>
          </button>
        `).join('')}
      </div>
    `;

    resultsEl.querySelectorAll('.manual-lyrics-row').forEach((row) => {
      row.addEventListener('click', async () => {
        const match = matches[Number(row.dataset.index)];
        row.disabled = true;
        row.classList.add('is-applying');
        try {
          const result = await applyManualLyricsSelection(song, match);
          close();
          onApply(result);
        } catch (err) {
          console.error('[Melody] Failed to apply manual lyrics selection.', err);
          showToast("Couldn't apply that result");
          row.disabled = false;
          row.classList.remove('is-applying');
        }
      });
    });
  }

  titleInput.focus();
  return overlay;
}

function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
