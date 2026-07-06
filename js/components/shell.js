/**
 * shell.js
 * The bottom navigation bar and mini player are shared chrome across every
 * top-level screen (Home, Search, Library, Settings). Previously this
 * markup/wiring only existed inline in home-screen.js, which meant the
 * nav buttons on every OTHER screen either didn't exist or did nothing —
 * this module is the fix for "Repair Settings/Library navigation": one
 * shared implementation, wired once, used everywhere.
 */

import { navigate, currentRoute } from '../utils/router.js';
import { subscribe, togglePlay } from '../services/player-service.js';

const NAV_ITEMS = [
  { key: 'home', label: 'Home', icon: '⌂' },
  { key: 'search', label: 'Search', icon: '⌕' },
  { key: 'library', label: 'Library', icon: '▤' },
  { key: 'settings', label: 'Settings', icon: '⚙' },
];

/**
 * Appends the bottom nav + mini player to `screenEl` and wires up all
 * behavior. Returns a cleanup function — merge it into the screen's
 * `_onLeave` (the router calls that on navigation away).
 */
export function attachShell(screenEl, activeKey) {
  const navHtml = `
    <nav class="bottom-nav" aria-label="Primary">
      ${NAV_ITEMS.map((item) => `
        <button class="${item.key === activeKey ? 'active' : ''}" data-nav="${item.key}">
          <span class="icon" aria-hidden="true">${item.icon}</span>${item.label}
        </button>
      `).join('')}
    </nav>

    <div class="mini-player" id="mini-player" hidden>
      <div class="art"><img src="" alt="" /></div>
      <div class="info">
        <div class="title">—</div>
        <div class="artist">—</div>
      </div>
      <div class="controls">
        <button class="icon play-pause-mini" aria-label="Play or pause">
          <span class="ppicon play-glyph">▶</span><span class="ppicon pause-glyph">⏸</span>
        </button>
      </div>
    </div>
  `;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = navHtml;
  const navEl = wrapper.querySelector('.bottom-nav');
  const miniPlayer = wrapper.querySelector('#mini-player');
  screenEl.appendChild(navEl);
  screenEl.appendChild(miniPlayer);

  // ---------- Bottom nav ----------
  navEl.querySelectorAll('button[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.nav;
      if (target === currentRoute()) return;
      navigate(target);
    });
  });

  // ---------- Mini player ----------
  const miniArtImg = miniPlayer.querySelector('.art img');
  const miniTitle = miniPlayer.querySelector('.info .title');
  const miniArtist = miniPlayer.querySelector('.info .artist');
  const miniPlayPauseBtn = miniPlayer.querySelector('.play-pause-mini');

  const unsubscribe = subscribe((state) => {
    if (!state.currentSong) {
      miniPlayer.hidden = true;
      return;
    }
    miniPlayer.hidden = false;
    miniArtImg.src = state.artUrl;
    miniTitle.textContent = state.currentSong.title;
    miniArtist.textContent = state.currentSong.artist;
    miniPlayPauseBtn.classList.toggle('is-playing', state.isPlaying);
    miniPlayPauseBtn.setAttribute('aria-label', state.isPlaying ? 'Pause' : 'Play');
  });

  miniPlayer.addEventListener('click', (e) => {
    if (e.target.closest('.play-pause-mini')) return;
    navigate('player');
  });
  miniPlayPauseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlay();
  });

  return unsubscribe;
}
