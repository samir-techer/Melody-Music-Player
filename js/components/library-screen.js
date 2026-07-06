/**
 * library-screen.js
 * The Library tab: Songs / Albums / Artists / Favorites / Recently Played.
 * Previously the Home screen's "Your Library" shortcuts just showed an
 * alert placeholder — this is the real screen those links now open into.
 */

import { getAllSongs } from '../services/library-service.js';
import { loadQueue } from '../services/player-service.js';
import { subscribeFavorites } from '../services/favorites-service.js';
import { getRecentlyPlayedEntries } from '../services/history-service.js';
import { navigate } from '../utils/router.js';
import { attachShell } from './shell.js';
import { renderSongListHtml, wireSongList } from './song-list.js';

const TABS = [
  { key: 'songs', label: 'Songs' },
  { key: 'albums', label: 'Albums' },
  { key: 'artists', label: 'Artists' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'recent', label: 'Recently Played' },
];

export async function renderLibraryScreen(params = {}) {
  let allSongs = [];
  try {
    allSongs = await getAllSongs();
  } catch (err) {
    console.error('[Melody] Library: failed to load songs.', err);
  }

  let activeTab = TABS.some((t) => t.key === params.tab) ? params.tab : 'songs';
  let drilldownGroup = null; // { kind: 'album'|'artist', name } when viewing one group's songs
  let unsubscribeList = null;
  let unsubscribeFavs = null;

  const el = document.createElement('div');
  el.className = 'screen library-screen has-shell';
  el.innerHTML = `
    <header class="screen-header">
      <h1>Library</h1>
    </header>
    <div class="tab-bar" id="tab-bar" role="tablist">
      ${TABS.map((t) => `<button class="tab-btn ${t.key === activeTab ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div id="library-content" class="section"></div>
  `;

  const contentEl = el.querySelector('#library-content');
  const tabBar = el.querySelector('#tab-bar');

  async function renderContent() {
    if (unsubscribeList) { unsubscribeList(); unsubscribeList = null; }

    if (drilldownGroup) {
      const groupSongs = allSongs.filter((s) =>
        drilldownGroup.kind === 'album' ? (s.album || 'Unknown Album') === drilldownGroup.name
                                          : (s.artist || 'Unknown Artist') === drilldownGroup.name
      );
      contentEl.innerHTML = `
        <button class="back-link" id="back-to-groups">‹ ${TABS.find((t) => t.key === activeTab).label}</button>
        <h2 class="group-title">${escapeHtml(drilldownGroup.name)}</h2>
        ${renderSongListHtml(groupSongs)}
      `;
      contentEl.querySelector('#back-to-groups').addEventListener('click', () => {
        drilldownGroup = null;
        renderContent();
      });
      unsubscribeList = wireSongList(contentEl, groupSongs, {
        onPlay: (songs, idx) => { loadQueue(songs, idx); navigate('player'); },
      });
      return;
    }

    if (activeTab === 'songs') {
      contentEl.innerHTML = renderSongListHtml(allSongs);
      unsubscribeList = wireSongList(contentEl, allSongs, {
        onPlay: (songs, idx) => { loadQueue(songs, idx); navigate('player'); },
      });
      return;
    }

    if (activeTab === 'albums' || activeTab === 'artists') {
      const key = activeTab === 'albums' ? 'album' : 'artist';
      const fallback = activeTab === 'albums' ? 'Unknown Album' : 'Unknown Artist';
      const groups = new Map();
      allSongs.forEach((s) => {
        const name = s[key] || fallback;
        if (!groups.has(name)) groups.set(name, 0);
        groups.set(name, groups.get(name) + 1);
      });

      if (groups.size === 0) {
        contentEl.innerHTML = `<div class="empty-state"><p class="title">Nothing here yet</p><p>Import some music to see ${activeTab}.</p></div>`;
        return;
      }

      contentEl.innerHTML = `
        <div class="grid-links">
          ${Array.from(groups.entries()).map(([name, count]) => `
            <button class="grid-link" data-group="${escapeHtml(name)}">
              <span class="icon" aria-hidden="true">●</span>
              <span>${escapeHtml(name)} <span class="count">(${count})</span></span>
            </button>
          `).join('')}
        </div>
      `;
      contentEl.querySelectorAll('.grid-link').forEach((btn) => {
        btn.addEventListener('click', () => {
          drilldownGroup = { kind: activeTab === 'albums' ? 'album' : 'artist', name: btn.dataset.group };
          renderContent();
        });
      });
      return;
    }

    if (activeTab === 'favorites') {
      unsubscribeFavs?.();
      unsubscribeFavs = subscribeFavorites((favSet) => {
        const favSongs = allSongs.filter((s) => favSet.has(s.id));
        contentEl.innerHTML = favSongs.length
          ? renderSongListHtml(favSongs)
          : `<div class="empty-state"><p class="title">No favorites yet</p><p>Tap the heart on any song to save it here.</p></div>`;
        if (unsubscribeList) unsubscribeList();
        unsubscribeList = wireSongList(contentEl, favSongs, {
          onPlay: (songs, idx) => { loadQueue(songs, idx); navigate('player'); },
        });
      });
      return;
    }

    if (activeTab === 'recent') {
      const entries = await getRecentlyPlayedEntries();
      const recentSongs = entries
        .map((entry) => allSongs.find((s) => s.id === entry.id))
        .filter(Boolean);

      contentEl.innerHTML = recentSongs.length
        ? renderSongListHtml(recentSongs)
        : `<div class="empty-state"><p class="title">Nothing played yet</p><p>Songs you play will show up here.</p></div>`;
      unsubscribeList = wireSongList(contentEl, recentSongs, {
        onPlay: (songs, idx) => { loadQueue(songs, idx); navigate('player'); },
      });
    }
  }

  tabBar.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === activeTab) return;
      activeTab = btn.dataset.tab;
      drilldownGroup = null;
      tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderContent();
    });
  });

  await renderContent();

  const unsubscribeShell = attachShell(el, 'library');
  el._onLeave = () => {
    if (unsubscribeList) unsubscribeList();
    if (unsubscribeFavs) unsubscribeFavs();
    unsubscribeShell();
  };

  return el;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
