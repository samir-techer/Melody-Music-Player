/**
 * search-screen.js
 * Live search across the whole library (title, artist, album). Filters
 * as-you-type with a small debounce; tapping a result plays it with the
 * full filtered result set as the queue.
 */

import { getAllSongs } from '../services/library-service.js';
import { loadQueue } from '../services/player-service.js';
import { navigate } from '../utils/router.js';
import { attachShell } from './shell.js';
import { renderSongListHtml, wireSongList } from './song-list.js';

export async function renderSearchScreen() {
  let allSongs = [];
  try {
    allSongs = await getAllSongs();
  } catch (err) {
    console.error('[Melody] Search: failed to load library.', err);
  }

  const el = document.createElement('div');
  el.className = 'screen search-screen has-shell';
  el.innerHTML = `
    <header class="screen-header">
      <h1>Search</h1>
    </header>

    <div class="home-search" role="search">
      <span aria-hidden="true">⌕</span>
      <input type="search" placeholder="Search songs, artists, albums…" id="search-input" autofocus />
    </div>

    <div id="search-results" class="section"></div>
  `;

  const input = el.querySelector('#search-input');
  const resultsEl = el.querySelector('#search-results');
  let unsubscribeList = null;

  function renderResults(query) {
    if (unsubscribeList) { unsubscribeList(); unsubscribeList = null; }

    const q = query.trim().toLowerCase();
    let matches;
    if (!q) {
      matches = [];
      resultsEl.innerHTML = `
        <div class="empty-state">
          <p class="title">Search your library</p>
          <p>Start typing a song, artist, or album name.</p>
        </div>
      `;
      return;
    }

    matches = allSongs.filter((s) =>
      (s.title || '').toLowerCase().includes(q) ||
      (s.artist || '').toLowerCase().includes(q) ||
      (s.album || '').toLowerCase().includes(q)
    );

    resultsEl.innerHTML = matches.length
      ? renderSongListHtml(matches)
      : `<div class="empty-state"><p class="title">No matches</p><p>Try a different search term.</p></div>`;

    unsubscribeList = wireSongList(resultsEl, matches, {
      onPlay: (songs, songIndex) => {
        loadQueue(songs, songIndex);
        navigate('player');
      },
    });
  }

  renderResults('');

  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderResults(input.value), 150);
  });

  const unsubscribeShell = attachShell(el, 'search');
  el._onLeave = () => {
    if (unsubscribeList) unsubscribeList();
    unsubscribeShell();
  };

  return el;
}
