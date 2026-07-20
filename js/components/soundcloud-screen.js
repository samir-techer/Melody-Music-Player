/**
 * soundcloud-screen.js
 * The "SoundCloud" tab (admin-only — see app.js's route guard and
 * shell.js's conditional nav item). Trending tracks by genre, with a
 * dedicated search page one tap away. Uses only soundcloud-service.js
 * (official REST endpoints) and soundcloud-widget-player.js (official
 * Widget) — no scraping, nothing unofficial.
 */

import { getTrendingTracks, getWaveformPeaks, SoundCloudError } from '../services/soundcloud-service.js';
import { hasSoundCloudCredentials, SOUNDCLOUD_GENRES } from '../services/soundcloud-config.js';
import { playSoundCloudUrl, subscribeSoundCloudPlayer, toggleSoundCloudPlayback } from '../services/soundcloud-widget-player.js';
import {
  renderTrackGridCard, renderSkeletonRow, renderErrorRetry, lazyRenderWaveforms,
} from '../utils/soundcloud-track-card.js';
import { attachShell } from './shell.js';
import { navigate } from '../utils/router.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function renderSoundCloudScreen() {
  const el = document.createElement('div');
  el.className = 'screen soundcloud-screen has-shell';

  const content = document.createElement('div');
  content.className = 'screen-content';
  el.appendChild(content);

  let activeGenre = SOUNDCLOUD_GENRES[0];
  let scPlayerState = { isPlaying: false, currentTrackUrl: null };
  let nowPlayingTitle = '';

  function renderNowPlayingBar() {
    if (!scPlayerState.currentTrackUrl) return '';
    return `
      <div class="sc-now-playing">
        <span class="sc-now-playing-title">🔊 ${escapeHtml(nowPlayingTitle || 'SoundCloud')}</span>
        <button type="button" id="sc-now-playing-toggle" class="btn-secondary" style="width:auto;">
          ${scPlayerState.isPlaying ? 'Pause' : 'Play'}
        </button>
      </div>
    `;
  }

  function renderGenreChips() {
    return `
      <div class="sc-genre-chips" id="sc-genre-chips">
        ${SOUNDCLOUD_GENRES.map((g) => `
          <button type="button" class="sc-genre-chip ${g.key === activeGenre.key ? 'active' : ''}" data-genre-key="${g.key}">${escapeHtml(g.label)}</button>
        `).join('')}
      </div>
    `;
  }

  async function loadTrending() {
    const trendingEl = content.querySelector('#sc-trending-section');
    if (!trendingEl) return;
    trendingEl.innerHTML = `<div class="sc-grid">${renderSkeletonRow(6, 'grid')}</div>`;

    try {
      const tracks = await getTrendingTracks(activeGenre.tag, { limit: 20 });
      if (!tracks.length) {
        trendingEl.innerHTML = `<p class="hint">No trending tracks found for ${escapeHtml(activeGenre.label)} right now.</p>`;
        return;
      }
      trendingEl.innerHTML = `<div class="sc-grid">${tracks.map(renderTrackGridCard).join('')}</div>`;
      lazyRenderWaveforms(trendingEl, getWaveformPeaks);
      bindTrackClicks(trendingEl);
    } catch (err) {
      const message = err instanceof SoundCloudError ? err.message : 'Something went wrong loading trending tracks.';
      trendingEl.innerHTML = renderErrorRetry(message, 'sc-trending-retry');
      trendingEl.querySelector('#sc-trending-retry')?.addEventListener('click', loadTrending);
    }
  }

  function bindTrackClicks(scope) {
    scope.querySelectorAll('[data-sc-play-track]').forEach((card) => {
      card.addEventListener('click', () => {
        const url = card.dataset.scPlayTrack;
        nowPlayingTitle = card.dataset.scTitle || '';
        playSoundCloudUrl(url);
      });
    });
  }

  function paintShell() {
    content.innerHTML = `
      <header class="screen-header">
        <h1>☁️ SoundCloud</h1>
        <button type="button" id="sc-search-btn" class="icon" aria-label="Search SoundCloud">⌕</button>
      </header>
      ${renderNowPlayingBar()}
      ${!hasSoundCloudCredentials() ? renderErrorRetry(
        'SoundCloud isn\u2019t connected yet — add an approved API client_id in soundcloud-config.js to enable search and trending.',
        'sc-credentials-retry',
      ) : ''}
      ${hasSoundCloudCredentials() ? `
        ${renderGenreChips()}
        <section class="section" id="sc-trending-wrap">
          <div class="section-heading"><h2>Trending — ${escapeHtml(activeGenre.label)}</h2></div>
          <div id="sc-trending-section"><div class="sc-grid">${renderSkeletonRow(6, 'grid')}</div></div>
        </section>
      ` : ''}
    `;

    content.querySelector('#sc-search-btn').addEventListener('click', () => navigate('soundcloud-search'));
    content.querySelector('#sc-now-playing-toggle')?.addEventListener('click', toggleSoundCloudPlayback);
    content.querySelector('#sc-credentials-retry')?.addEventListener('click', () => paintShell());

    content.querySelectorAll('.sc-genre-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const key = chip.dataset.genreKey;
        activeGenre = SOUNDCLOUD_GENRES.find((g) => g.key === key) || activeGenre;
        content.querySelectorAll('.sc-genre-chip').forEach((c) => c.classList.toggle('active', c === chip));
        content.querySelector('.section-heading h2').textContent = `Trending — ${activeGenre.label}`;
        loadTrending();
      });
    });

    if (hasSoundCloudCredentials()) loadTrending();
  }

  paintShell();

  const unsubscribeScPlayer = subscribeSoundCloudPlayer((s) => {
    scPlayerState = s;
    const bar = content.querySelector('.sc-now-playing');
    if (bar) {
      bar.querySelector('#sc-now-playing-toggle').textContent = s.isPlaying ? 'Pause' : 'Play';
    } else if (s.currentTrackUrl) {
      paintShell(); // first time a track starts, (re)paint to insert the bar
    }
  });

  const unsubscribeShell = attachShell(el, 'soundcloud');
  el._onLeave = () => {
    unsubscribeShell();
    unsubscribeScPlayer();
  };

  return el;
}
