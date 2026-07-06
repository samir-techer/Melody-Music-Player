/**
 * home-screen.js
 * Landing screen after onboarding. Currently renders the structural
 * shell (header, search, sections, bottom nav, mini player placeholder)
 * with empty states — the library service that populates these from
 * imported songs lands in the next build pass.
 */

import { getItem } from '../utils/storage.js';
import { getTimeOfDayLabel, getTimeOfDayEmoji } from '../utils/time-of-day.js';

const LIBRARY_LINKS = [
  { key: 'albums', label: 'Albums' },
  { key: 'artists', label: 'Artists' },
  { key: 'playlists', label: 'Playlists' },
  { key: 'folders', label: 'Folders' },
  { key: 'genres', label: 'Genres' },
  { key: 'favorites', label: 'Favorites ❤️' },
];

export async function renderHomeScreen() {
  const nickname = (await getItem('nickname')) || 'friend';
  const timeLabel = getTimeOfDayLabel();
  const emoji = getTimeOfDayEmoji();

  const el = document.createElement('div');
  el.className = 'screen home-screen';
  el.innerHTML = `
    <header class="home-header">
      <h1>Good ${timeLabel}, ${escapeHtml(nickname)} ${emoji}</h1>
      <p class="subline">Let's find your next favorite song.</p>
    </header>

    <div class="home-search" role="search">
      <span aria-hidden="true">⌕</span>
      <input type="search" placeholder="Search songs, artists, albums…" id="home-search-input" />
    </div>

    <section class="section" id="section-continue">
      <div class="section-heading">
        <h2>Continue Listening</h2>
      </div>
      <div class="empty-state">
        <p class="title">Nothing playing yet</p>
        <p>Import some music to pick up where you left off.</p>
      </div>
    </section>

    <section class="section" id="section-recent">
      <div class="section-heading">
        <h2>Recently Added</h2>
        <span class="see-all">See all</span>
      </div>
      <div class="card-row" id="recent-row">
        <!-- media-card items injected by library-service.js (next pass) -->
      </div>
    </section>

    <section class="section" id="section-library">
      <div class="section-heading">
        <h2>Your Library</h2>
      </div>
      <div class="grid-links">
        ${LIBRARY_LINKS.map((l) => `
          <button class="grid-link" data-key="${l.key}">
            <span class="icon" aria-hidden="true">●</span>
            <span>${l.label}</span>
          </button>
        `).join('')}
      </div>
    </section>

    <section class="section" id="section-import">
      <div class="empty-state">
        <p class="title">Your library is empty</p>
        <p>Tap below to import songs from your device.</p>
        <button class="btn-primary" id="import-btn" style="margin-top: 12px;">Import Music</button>
      </div>
    </section>

    <nav class="bottom-nav" aria-label="Primary">
      <button class="active" data-nav="home"><span class="icon" aria-hidden="true">⌂</span>Home</button>
      <button data-nav="search"><span class="icon" aria-hidden="true">⌕</span>Search</button>
      <button data-nav="library"><span class="icon" aria-hidden="true">▤</span>Library</button>
      <button data-nav="settings"><span class="icon" aria-hidden="true">⚙</span>Settings</button>
    </nav>

    <div class="mini-player" id="mini-player" hidden>
      <div class="art"><img src="" alt="" /></div>
      <div class="info">
        <div class="title">—</div>
        <div class="artist">—</div>
      </div>
      <div class="controls">
        <button class="icon" aria-label="Play or pause">▶</button>
      </div>
    </div>
  `;

  el.querySelector('#import-btn').addEventListener('click', () => {
    // Wired up to js/services/import-service.js in the next build pass.
    alert('Music import is coming in the next build pass — this button is a placeholder for now.');
  });

  return el;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
