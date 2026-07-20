/**
 * soundcloud-search-screen.js
 * Search page for the SoundCloud tab. SoundCloud's API doesn't expose a
 * dedicated autocomplete/suggest endpoint, so "instant search
 * suggestions" here means: debounced live search-as-you-type against
 * the real /tracks, /users, /playlists endpoints, re-run automatically
 * a few hundred ms after the person stops typing.
 */

import { searchSoundCloud, getWaveformPeaks, SoundCloudError } from '../services/soundcloud-service.js';
import { hasSoundCloudCredentials } from '../services/soundcloud-config.js';
import { playSoundCloudUrl } from '../services/soundcloud-widget-player.js';
import {
  renderTrackGridCard, renderArtistCard, renderPlaylistCard, renderSkeletonRow, renderErrorRetry, lazyRenderWaveforms,
} from '../utils/soundcloud-track-card.js';
import { attachShell } from './shell.js';
import { navigate } from '../utils/router.js';

const DEBOUNCE_MS = 350;
const TABS = [
  { key: 'tracks', label: 'Tracks' },
  { key: 'users', label: 'Artists' },
  { key: 'playlists', label: 'Playlists' },
];

export async function renderSoundCloudSearchScreen() {
  const el = document.createElement('div');
  el.className = 'screen soundcloud-screen has-shell';

  const content = document.createElement('div');
  content.className = 'screen-content';
  el.appendChild(content);

  let activeTab = 'tracks';
  let query = '';
  let debounceTimer = null;
  let requestToken = 0; // guards against a slow earlier request overwriting a faster later one

  function renderResultsFor(kind, items) {
    if (kind === 'tracks') return `<div class="sc-grid">${items.map(renderTrackGridCard).join('')}</div>`;
    if (kind === 'users') return `<div class="sc-artist-grid">${items.map(renderArtistCard).join('')}</div>`;
    return `<div class="sc-grid">${items.map(renderPlaylistCard).join('')}</div>`;
  }

  function bindResultClicks(scope) {
    scope.querySelectorAll('[data-sc-play-track]').forEach((card) => {
      card.addEventListener('click', () => playSoundCloudUrl(card.dataset.scPlayTrack));
    });
    scope.querySelectorAll('[data-sc-open-artist]').forEach((card) => {
      card.addEventListener('click', () => navigate('soundcloud-artist', { id: card.dataset.scOpenArtist }));
    });
    scope.querySelectorAll('[data-sc-open-playlist]').forEach((card) => {
      card.addEventListener('click', () => navigate('soundcloud-playlist', { id: card.dataset.scOpenPlaylist }));
    });
  }

  async function runSearch() {
    const resultsEl = content.querySelector('#sc-search-results');
    if (!resultsEl) return;

    if (!query.trim()) {
      resultsEl.innerHTML = '<p class="hint">Search for tracks, artists, or playlists on SoundCloud.</p>';
      return;
    }

    const myToken = ++requestToken;
    resultsEl.innerHTML = `<div class="sc-grid">${renderSkeletonRow(6, 'grid')}</div>`;

    try {
      const items = await searchSoundCloud(query, activeTab, { limit: 24 });
      if (myToken !== requestToken) return; // a newer keystroke's request already landed
      if (!items.length) {
        resultsEl.innerHTML = `<p class="hint">No ${TABS.find((t) => t.key === activeTab).label.toLowerCase()} found for "${query}".</p>`;
        return;
      }
      resultsEl.innerHTML = renderResultsFor(activeTab, items);
      if (activeTab === 'tracks') lazyRenderWaveforms(resultsEl, getWaveformPeaks);
      bindResultClicks(resultsEl);
    } catch (err) {
      if (myToken !== requestToken) return;
      const message = err instanceof SoundCloudError ? err.message : 'Something went wrong searching SoundCloud.';
      resultsEl.innerHTML = renderErrorRetry(message, 'sc-search-retry');
      resultsEl.querySelector('#sc-search-retry')?.addEventListener('click', runSearch);
    }
  }

  function paint() {
    content.innerHTML = `
      <header class="screen-header">
        <button class="back-link" id="sc-search-back">‹ Back</button>
        <h1>Search SoundCloud</h1>
      </header>

      ${!hasSoundCloudCredentials() ? renderErrorRetry(
        'SoundCloud isn\u2019t connected yet — add an approved API client_id in soundcloud-config.js.',
        'sc-search-credentials-retry',
      ) : `
        <div class="sc-search-bar">
          <span aria-hidden="true">⌕</span>
          <input type="search" id="sc-search-input" placeholder="Search tracks, artists, playlists…" autocomplete="off" value="${query.replace(/"/g, '&quot;')}" />
        </div>
        <div class="sc-search-tabs">
          ${TABS.map((t) => `<button type="button" class="sc-search-tab ${t.key === activeTab ? 'active' : ''}" data-tab-key="${t.key}">${t.label}</button>`).join('')}
        </div>
        <div id="sc-search-results"><p class="hint">Search for tracks, artists, or playlists on SoundCloud.</p></div>
      `}
    `;

    content.querySelector('#sc-search-back').addEventListener('click', () => navigate('soundcloud'));
    content.querySelector('#sc-search-credentials-retry')?.addEventListener('click', paint);

    const input = content.querySelector('#sc-search-input');
    input?.addEventListener('input', () => {
      query = input.value;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
    });
    input?.focus();

    content.querySelectorAll('.sc-search-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tabKey;
        content.querySelectorAll('.sc-search-tab').forEach((t) => t.classList.toggle('active', t === tab));
        runSearch();
      });
    });
  }

  paint();

  const unsubscribeShell = attachShell(el, 'soundcloud');
  el._onLeave = () => {
    clearTimeout(debounceTimer);
    unsubscribeShell();
  };

  return el;
}
