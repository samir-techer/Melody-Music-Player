/**
 * playlist-sheet.js
 * A small bottom-sheet modal for "Add to Playlist" - lists existing
 * playlists to add song(s) to, plus a quick "create new playlist" row.
 * Used from the Library's multi-select bulk bar and from the Music Hub's
 * "Add to Playlist" button.
 */

import { getAllPlaylists, createPlaylist, addSongsToPlaylist } from '../services/playlist-service.js';
import { showToast } from '../utils/toast.js';

export async function openPlaylistSheet(songIds) {
  const ids = Array.isArray(songIds) ? songIds : [songIds];
  const playlists = await getAllPlaylists().catch(() => []);

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-label="Add to playlist">
      <div class="sheet-handle"></div>
      <h2>Add to Playlist</h2>
      <div class="sheet-playlist-list">
        ${playlists.length
          ? playlists.map((p) => `
            <button class="sheet-playlist-row" data-id="${p.id}">
              <span>${escapeHtml(p.name)}</span>
              <span class="count">${p.songIds.length} song${p.songIds.length === 1 ? '' : 's'}</span>
            </button>
          `).join('')
          : `<p class="sheet-empty">No playlists yet - create your first one below.</p>`
        }
      </div>
      <form class="sheet-new-playlist" id="new-playlist-form">
        <input type="text" placeholder="New playlist name" id="new-playlist-name" maxlength="80" />
        <button type="submit">Create</button>
      </form>
      <button class="sheet-close" id="sheet-close">Cancel</button>
    </div>
  `;
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('#sheet-close').addEventListener('click', close);

  overlay.querySelectorAll('.sheet-playlist-row').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await addSongsToPlaylist(btn.dataset.id, ids);
        showToast(`Added ${ids.length} song${ids.length === 1 ? '' : 's'} to playlist`);
      } catch (err) {
        console.error('[Melody] Failed to add to playlist.', err);
        showToast('Could not add to that playlist');
      }
      close();
    });
  });

  overlay.querySelector('#new-playlist-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = overlay.querySelector('#new-playlist-name');
    const name = input.value.trim();
    if (!name) return;
    try {
      await createPlaylist(name, ids);
      showToast(`Created "${name}" with ${ids.length} song${ids.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.error('[Melody] Failed to create playlist.', err);
      showToast('Could not create that playlist');
    }
    close();
  });

  return overlay;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
