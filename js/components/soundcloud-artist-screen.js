/**
 * soundcloud-artist-screen.js
 * A single artist's public profile: avatar, bio, follower count, and
 * their tracks. Reached from a search result or a track card — not a
 * standalone browsable directory.
 */

import { getArtist, getArtistTracks, getWaveformPeaks, SoundCloudError } from '../services/soundcloud-service.js';
import { playSoundCloudUrl } from '../services/soundcloud-widget-player.js';
import {
  renderTrackGridCard, renderSkeletonRow, renderErrorRetry, lazyRenderWaveforms,
} from '../utils/soundcloud-track-card.js';
import { attachShell } from './shell.js';
import { navigate } from '../utils/router.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function renderSoundCloudArtistScreen({ id } = {}) {
  const el = document.createElement('div');
  el.className = 'screen soundcloud-screen has-shell';

  const content = document.createElement('div');
  content.className = 'screen-content';
  el.appendChild(content);

  function bindTrackClicks(scope) {
    scope.querySelectorAll('[data-sc-play-track]').forEach((card) => {
      card.addEventListener('click', () => playSoundCloudUrl(card.dataset.scPlayTrack));
    });
  }

  content.innerHTML = `
    <header class="screen-header">
      <button class="back-link" id="sc-artist-back">‹ Back</button>
      <h1>Artist</h1>
    </header>
    <div class="sc-artist-hero">${renderSkeletonRow(1, 'row')}</div>
    <section class="section"><div class="sc-grid">${renderSkeletonRow(6, 'grid')}</div></section>
  `;
  content.querySelector('#sc-artist-back').addEventListener('click', () => navigate('soundcloud'));

  async function load() {
    try {
      const [artist, tracks] = await Promise.all([
        getArtist(id),
        getArtistTracks(id, { limit: 24 }),
      ]);

      content.querySelector('.sc-artist-hero').outerHTML = `
        <div class="sc-artist-hero">
          <img class="sc-artist-hero-avatar" src="${artist.avatarUrl || ''}" alt="" loading="lazy" />
          <div class="sc-artist-hero-info">
            <h2>${escapeHtml(artist.name)}</h2>
            <p class="hint">${artist.followers.toLocaleString()} followers · ${artist.trackCount} tracks</p>
            ${artist.bio ? `<p class="sc-artist-bio">${escapeHtml(artist.bio)}</p>` : ''}
          </div>
        </div>
      `;

      const trackSection = content.querySelector('.section .sc-grid').parentElement;
      if (!tracks.length) {
        trackSection.innerHTML = '<p class="hint">This artist hasn\u2019t published any public tracks.</p>';
        return;
      }
      trackSection.innerHTML = `<div class="sc-grid">${tracks.map(renderTrackGridCard).join('')}</div>`;
      lazyRenderWaveforms(trackSection, getWaveformPeaks);
      bindTrackClicks(trackSection);
    } catch (err) {
      const message = err instanceof SoundCloudError ? err.message : 'Something went wrong loading this artist.';
      content.querySelector('.sc-artist-hero').outerHTML = renderErrorRetry(message, 'sc-artist-retry');
      content.querySelector('#sc-artist-retry')?.addEventListener('click', load);
    }
  }

  load();

  const unsubscribeShell = attachShell(el, 'soundcloud');
  el._onLeave = unsubscribeShell;

  return el;
}
