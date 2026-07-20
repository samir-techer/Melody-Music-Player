/**
 * soundcloud-playlist-screen.js
 * A single SoundCloud playlist/set: cover, title, creator, and its
 * tracks, with a "Play all" that starts from the first track.
 */

import { getPlaylist, SoundCloudError } from '../services/soundcloud-service.js';
import { playSoundCloudUrl } from '../services/soundcloud-widget-player.js';
import { renderTrackCard, renderSkeletonRow, renderErrorRetry } from '../utils/soundcloud-track-card.js';
import { attachShell } from './shell.js';
import { navigate } from '../utils/router.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function renderSoundCloudPlaylistScreen({ id } = {}) {
  const el = document.createElement('div');
  el.className = 'screen soundcloud-screen has-shell';

  const content = document.createElement('div');
  content.className = 'screen-content';
  el.appendChild(content);

  let playlistTracks = [];

  content.innerHTML = `
    <header class="screen-header">
      <button class="back-link" id="sc-playlist-back">‹ Back</button>
      <h1>Playlist</h1>
    </header>
    <div class="sc-playlist-hero">${renderSkeletonRow(1, 'row')}</div>
    <section class="section" id="sc-playlist-tracks">${renderSkeletonRow(6, 'row')}</section>
  `;
  content.querySelector('#sc-playlist-back').addEventListener('click', () => navigate('soundcloud'));

  function playAt(index) {
    if (index < 0 || index >= playlistTracks.length) return;
    playSoundCloudUrl(playlistTracks[index].permalinkUrl);
  }

  async function load() {
    try {
      const playlist = await getPlaylist(id);
      playlistTracks = playlist.tracks;

      content.querySelector('.sc-playlist-hero').outerHTML = `
        <div class="sc-playlist-hero">
          <img class="sc-playlist-hero-art" src="${playlist.artworkUrl || ''}" alt="" loading="lazy" />
          <div class="sc-playlist-hero-info">
            <h2>${escapeHtml(playlist.title)}</h2>
            <p class="hint">${escapeHtml(playlist.creator)} · ${playlist.trackCount} tracks</p>
            <button type="button" id="sc-playlist-play-all" class="btn-primary" style="width:auto;">▶ Play all</button>
          </div>
        </div>
      `;
      content.querySelector('#sc-playlist-play-all').addEventListener('click', () => playAt(0));

      const tracksSection = content.querySelector('#sc-playlist-tracks');
      if (!playlistTracks.length) {
        tracksSection.innerHTML = '<p class="hint">This playlist has no public tracks.</p>';
        return;
      }
      tracksSection.innerHTML = playlistTracks.map(renderTrackCard).join('');
      tracksSection.querySelectorAll('[data-sc-play-track]').forEach((card, i) => {
        card.addEventListener('click', () => playAt(i));
      });
    } catch (err) {
      const message = err instanceof SoundCloudError ? err.message : 'Something went wrong loading this playlist.';
      content.querySelector('.sc-playlist-hero').outerHTML = renderErrorRetry(message, 'sc-playlist-retry');
      content.querySelector('#sc-playlist-retry')?.addEventListener('click', load);
    }
  }

  load();

  const unsubscribeShell = attachShell(el, 'soundcloud');
  el._onLeave = unsubscribeShell;

  return el;
}
