/**
 * library-screen.js
 * The Library tab: Songs / Albums / Artists / Genres / Folders / Favorites /
 * Recently Added / Recently Played - Phase 1's "Smart Library".
 *
 * Adds on top of the original screen:
 *  - Search-with-filter bar (title/artist/album/genre, live)
 *  - Sort control (Name, Artist, Album, Date Added, Duration, Most Played)
 *  - Multi-select mode with a bulk action bar (Delete, Share, Add to
 *    Playlist, Favorite)
 *  - Tapping a song opens the Music Hub (Phase 2); a small per-row play
 *    button still plays immediately
 */

import { getAllSongs, sortSongs, searchSongs, removeSongs } from '../services/library-service.js';
import { loadQueue } from '../services/player-service.js';
import { subscribeFavorites, setFavorite } from '../services/favorites-service.js';
import { getRecentlyPlayedEntries } from '../services/history-service.js';
import { navigate } from '../utils/router.js';
import { attachShell } from './shell.js';
import { renderSongListHtml, wireSongList } from './song-list.js';
import { openPlaylistSheet } from './playlist-sheet.js';
import { showToast } from '../utils/toast.js';

const TABS = [
  { key: 'songs', label: 'Songs' },
  { key: 'albums', label: 'Albums' },
  { key: 'artists', label: 'Artists' },
  { key: 'genres', label: 'Genres' },
  { key: 'folders', label: 'Folders' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'recentAdded', label: 'Recently Added' },
  { key: 'recent', label: 'Recently Played' },
];

const GROUP_TABS = {
  albums: { field: 'album', fallback: 'Unknown Album' },
  artists: { field: 'artist', fallback: 'Unknown Artist' },
  genres: { field: 'genre', fallback: 'Unknown Genre' },
  folders: { field: 'folderPath', fallback: 'On My Device' },
};

const SORT_OPTIONS = [
  { key: 'name', label: 'Name' },
  { key: 'artist', label: 'Artist' },
  { key: 'album', label: 'Album' },
  { key: 'dateAdded', label: 'Date Added' },
  { key: 'duration', label: 'Duration' },
  { key: 'mostPlayed', label: 'Most Played' },
];

export async function renderLibraryScreen(params = {}) {
  let allSongs = [];
  try {
    allSongs = await getAllSongs();
  } catch (err) {
    console.error('[Melody] Library: failed to load songs.', err);
  }

  let activeTab = TABS.some((t) => t.key === params.tab) ? params.tab : 'songs';
  let drilldownGroup = null; // { kind: field name, name } when viewing one group's songs
  let searchQuery = '';
  let sortKey = 'dateAdded';
  let selectMode = false;
  let selectedIds = new Set();
  let favSet = new Set();
  let unsubscribeList = null;
  let unsubscribeFavs = null;

  const el = document.createElement('div');
  el.className = 'screen library-screen has-shell';
  el.innerHTML = `
    <header class="screen-header library-header">
      <h1>Library</h1>
      <button class="select-toggle-btn" id="select-toggle">Select</button>
    </header>

    <div class="library-search-bar">
      <span aria-hidden="true">⌕</span>
      <input type="search" id="library-search-input" placeholder="Search songs, artists, albums, genres…" />
      <select id="library-sort-select" aria-label="Sort by">
        ${SORT_OPTIONS.map((o) => `<option value="${o.key}">${o.label}</option>`).join('')}
      </select>
    </div>

    <div class="tab-bar" id="tab-bar" role="tablist">
      ${TABS.map((t) => `<button class="tab-btn ${t.key === activeTab ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div id="library-content" class="section"></div>

    <div class="bulk-action-bar" id="bulk-bar" hidden>
      <span class="bulk-count" id="bulk-count">0 selected</span>
      <div class="bulk-actions">
        <button data-action="favorite" aria-label="Favorite selected">♥</button>
        <button data-action="playlist" aria-label="Add to playlist">＋▤</button>
        <button data-action="share" aria-label="Share selected">↗</button>
        <button data-action="delete" aria-label="Delete selected" class="danger">🗑</button>
      </div>
    </div>
  `;

  const contentEl = el.querySelector('#library-content');
  const tabBar = el.querySelector('#tab-bar');
  const searchInput = el.querySelector('#library-search-input');
  const sortSelect = el.querySelector('#library-sort-select');
  const selectToggleBtn = el.querySelector('#select-toggle');
  const bulkBar = el.querySelector('#bulk-bar');
  const bulkCount = el.querySelector('#bulk-count');

  sortSelect.value = sortKey;

  subscribeFavorites((set) => { favSet = set; });

  function currentTabSongs() {
    let songs = allSongs;
    if (searchQuery) songs = searchSongs(songs, searchQuery);
    return songs;
  }

  function updateBulkBar() {
    bulkBar.hidden = !selectMode || selectedIds.size === 0;
    bulkCount.textContent = `${selectedIds.size} selected`;
  }

  function toggleSelect(id) {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    updateBulkBar();
    renderContent();
  }

  async function renderContent() {
    if (unsubscribeList) { unsubscribeList(); unsubscribeList = null; }

    const openHub = (song) => navigate('music-hub', { songId: song.id, from: 'library' });
    const playNow = (songs, idx) => { loadQueue(songs, idx); navigate('player'); };

    // ---------- Drilldown into one album/artist/genre/folder group ----------
    if (drilldownGroup) {
      let groupSongs = allSongs.filter((s) => (s[drilldownGroup.field] || drilldownGroup.fallback) === drilldownGroup.name);
      groupSongs = searchQuery ? searchSongs(groupSongs, searchQuery) : groupSongs;
      groupSongs = sortSongs(groupSongs, sortKey);

      contentEl.innerHTML = `
        <button class="back-link" id="back-to-groups">‹ ${TABS.find((t) => t.key === activeTab).label}</button>
        <h2 class="group-title">${escapeHtml(drilldownGroup.name)}</h2>
        ${renderSongListHtml(groupSongs, { selectMode, selectedIds, showPlayCount: sortKey === 'mostPlayed' })}
      `;
      contentEl.querySelector('#back-to-groups').addEventListener('click', () => {
        drilldownGroup = null;
        renderContent();
      });
      unsubscribeList = wireSongList(contentEl, groupSongs, {
        onOpen: openHub, onPlay: playNow, selectMode, onToggleSelect: toggleSelect,
      });
      return;
    }

    // ---------- Songs ----------
    if (activeTab === 'songs') {
      const songs = sortSongs(currentTabSongs(), sortKey);
      contentEl.innerHTML = renderSongListHtml(songs, { selectMode, selectedIds, showPlayCount: sortKey === 'mostPlayed' });
      unsubscribeList = wireSongList(contentEl, songs, {
        onOpen: openHub, onPlay: playNow, selectMode, onToggleSelect: toggleSelect,
      });
      return;
    }

    // ---------- Grouped tabs: Albums / Artists / Genres / Folders ----------
    if (GROUP_TABS[activeTab]) {
      const { field, fallback } = GROUP_TABS[activeTab];
      const base = searchQuery ? searchSongs(allSongs, searchQuery) : allSongs;
      const groups = new Map();
      base.forEach((s) => {
        const name = s[field] || fallback;
        groups.set(name, (groups.get(name) || 0) + 1);
      });

      if (groups.size === 0) {
        contentEl.innerHTML = `<div class="empty-state"><p class="title">Nothing here yet</p><p>Import some music to see ${activeTab}.</p></div>`;
        return;
      }

      const sortedNames = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
      contentEl.innerHTML = `
        <div class="grid-links">
          ${sortedNames.map((name) => `
            <button class="grid-link" data-group="${escapeHtml(name)}">
              <span class="icon" aria-hidden="true">●</span>
              <span>${escapeHtml(name)} <span class="count">(${groups.get(name)})</span></span>
            </button>
          `).join('')}
        </div>
      `;
      contentEl.querySelectorAll('.grid-link').forEach((btn) => {
        btn.addEventListener('click', () => {
          drilldownGroup = { field, fallback, name: btn.dataset.group };
          renderContent();
        });
      });
      return;
    }

    // ---------- Favorites ----------
    if (activeTab === 'favorites') {
      unsubscribeFavs?.();
      unsubscribeFavs = subscribeFavorites((set) => {
        let favSongs = allSongs.filter((s) => set.has(s.id));
        favSongs = searchQuery ? searchSongs(favSongs, searchQuery) : favSongs;
        favSongs = sortSongs(favSongs, sortKey);
        contentEl.innerHTML = favSongs.length
          ? renderSongListHtml(favSongs, { selectMode, selectedIds, showPlayCount: sortKey === 'mostPlayed' })
          : `<div class="empty-state"><p class="title">No favorites yet</p><p>Tap the heart on any song to save it here.</p></div>`;
        if (unsubscribeList) unsubscribeList();
        unsubscribeList = wireSongList(contentEl, favSongs, {
          onOpen: openHub, onPlay: playNow, selectMode, onToggleSelect: toggleSelect,
        });
      });
      return;
    }

    // ---------- Recently Added ----------
    if (activeTab === 'recentAdded') {
      let songs = [...allSongs].sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
      songs = searchQuery ? searchSongs(songs, searchQuery) : songs;
      contentEl.innerHTML = songs.length
        ? renderSongListHtml(songs, { selectMode, selectedIds })
        : `<div class="empty-state"><p class="title">Nothing here yet</p><p>Imported songs show up here first.</p></div>`;
      unsubscribeList = wireSongList(contentEl, songs, {
        onOpen: openHub, onPlay: playNow, selectMode, onToggleSelect: toggleSelect,
      });
      return;
    }

    // ---------- Recently Played ----------
    if (activeTab === 'recent') {
      const entries = await getRecentlyPlayedEntries();
      let recentSongs = entries.map((entry) => allSongs.find((s) => s.id === entry.id)).filter(Boolean);
      recentSongs = searchQuery ? searchSongs(recentSongs, searchQuery) : recentSongs;

      contentEl.innerHTML = recentSongs.length
        ? renderSongListHtml(recentSongs, { selectMode, selectedIds })
        : `<div class="empty-state"><p class="title">Nothing played yet</p><p>Songs you play will show up here.</p></div>`;
      unsubscribeList = wireSongList(contentEl, recentSongs, {
        onOpen: openHub, onPlay: playNow, selectMode, onToggleSelect: toggleSelect,
      });
    }
  }

  // ---------- Tab switching ----------
  tabBar.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === activeTab) return;
      activeTab = btn.dataset.tab;
      drilldownGroup = null;
      selectMode = false;
      selectedIds = new Set();
      updateBulkBar();
      selectToggleBtn.textContent = 'Select';
      tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderContent();
    });
  });

  // ---------- Search ----------
  let debounceTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchQuery = searchInput.value;
      renderContent();
    }, 150);
  });

  // ---------- Sort ----------
  sortSelect.addEventListener('change', () => {
    sortKey = sortSelect.value;
    renderContent();
  });

  // ---------- Multi-select toggle ----------
  selectToggleBtn.addEventListener('click', () => {
    selectMode = !selectMode;
    selectedIds = new Set();
    selectToggleBtn.textContent = selectMode ? 'Done' : 'Select';
    selectToggleBtn.classList.toggle('active', selectMode);
    updateBulkBar();
    renderContent();
  });

  // ---------- Bulk actions ----------
  bulkBar.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;

      if (btn.dataset.action === 'favorite') {
        await Promise.all(ids.map((id) => setFavorite(id, true)));
        showToast(`Added ${ids.length} song${ids.length === 1 ? '' : 's'} to Favorites`);
      } else if (btn.dataset.action === 'playlist') {
        openPlaylistSheet(ids);
      } else if (btn.dataset.action === 'share') {
        await shareSongs(allSongs.filter((s) => ids.includes(s.id)));
      } else if (btn.dataset.action === 'delete') {
        await removeSongs(ids);
        allSongs = allSongs.filter((s) => !ids.includes(s.id));
        selectedIds = new Set();
        updateBulkBar();
        showToast(`Deleted ${ids.length} song${ids.length === 1 ? '' : 's'}`);
        renderContent();
      }
    });
  });

  await renderContent();
  updateBulkBar();

  const unsubscribeShell = attachShell(el, 'library');
  el._onLeave = () => {
    if (unsubscribeList) unsubscribeList();
    if (unsubscribeFavs) unsubscribeFavs();
    unsubscribeShell();
  };

  return el;
}

async function shareSongs(songs) {
  const text = songs.map((s) => `${s.title} — ${s.artist}`).join('\n');
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Melody', text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.warn('[Melody] Share failed, falling back to clipboard.', err);
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied song info to clipboard');
  } catch (err) {
    showToast('Sharing is not supported on this device');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
