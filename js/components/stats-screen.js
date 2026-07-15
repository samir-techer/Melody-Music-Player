/**
 * stats-screen.js
 * Elite — Advanced Listening Insights. Route-guarded to Elite in app.js
 * (same pattern as the Admin screen's live-checked guard), so this file
 * itself doesn't need to re-check the plan — if it's rendering, the
 * viewer is already confirmed Elite.
 */

import { getStatsSnapshot } from '../services/stats-service.js';
import { getAllSongs } from '../services/library-service.js';
import { attachShell } from './shell.js';
import { navigate } from '../utils/router.js';

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function renderStatsScreen() {
  const el = document.createElement('div');
  el.className = 'screen stats-screen has-shell';

  const stats = await getStatsSnapshot().catch(() => null);
  const mostPlayedSongs = (await getAllSongs().catch(() => []))
    .filter((s) => (s.playCount || 0) > 0)
    .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
    .slice(0, 5);

  if (!stats) {
    el.innerHTML = `
      <header class="screen-header"><h1>Listening Insights</h1></header>
      <div class="empty-state"><p class="title">No data yet</p><p>Play a few songs and check back.</p></div>
    `;
    const unsub = attachShell(el, 'settings');
    el._onLeave = unsub;
    return el;
  }

  const maxBar = Math.max(...stats.last7Days.map((d) => d.ms), 1);
  const barsHtml = stats.last7Days.map((d) => `
    <div class="bar-col">
      <div class="bar" style="height: ${Math.max(2, Math.round((d.ms / maxBar) * 100))}%" title="${formatDuration(d.ms)}"></div>
      <span class="bar-label">${escapeHtml(d.label)}</span>
    </div>
  `).join('');

  const artistRows = stats.topArtists.length
    ? stats.topArtists.map(([name, count], i) => `
        <div class="stats-list-row">
          <span class="stats-list-rank">${i + 1}</span>
          <span class="stats-list-name">${escapeHtml(name)}</span>
          <span class="stats-list-count">${count} plays</span>
        </div>
      `).join('')
    : '<p class="hint">Nothing yet — keep listening.</p>';

  const genreRows = stats.topGenres.length
    ? stats.topGenres.map(([name, count], i) => `
        <div class="stats-list-row">
          <span class="stats-list-rank">${i + 1}</span>
          <span class="stats-list-name">${escapeHtml(name)}</span>
          <span class="stats-list-count">${count} plays</span>
        </div>
      `).join('')
    : '<p class="hint">Nothing yet — keep listening.</p>';

  const songRows = mostPlayedSongs.length
    ? mostPlayedSongs.map((s, i) => `
        <div class="stats-list-row">
          <span class="stats-list-rank">${i + 1}</span>
          <span class="stats-list-name">${escapeHtml(s.title)} <span class="hint">— ${escapeHtml(s.artist)}</span></span>
          <span class="stats-list-count">${s.playCount} plays</span>
        </div>
      `).join('')
    : '<p class="hint">Nothing yet — keep listening.</p>';

  el.innerHTML = `
    <header class="screen-header">
      <button class="back-link" id="stats-back">‹ Back</button>
      <h1>👑 Listening Insights</h1>
    </header>

    ${stats.streak.current > 0 ? `
    <div class="stats-streak-banner">
      <span class="flame">🔥</span>
      <div>
        <strong>${stats.streak.current}-day streak</strong>
        <p class="hint">Longest: ${stats.streak.longest} day${stats.streak.longest === 1 ? '' : 's'}</p>
      </div>
    </div>` : ''}

    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.totalListeningMs)}</div><div class="stat-label">Total listening time</div></div>
      <div class="stat-card"><div class="stat-value">${stats.totalSongsPlayed}</div><div class="stat-label">Total songs played</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.todayMs)}</div><div class="stat-label">Today</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.weekMs)}</div><div class="stat-label">This week</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.monthMs)}</div><div class="stat-label">This month</div></div>
      <div class="stat-card"><div class="stat-value">${stats.totalSkips}</div><div class="stat-label">Total skips</div></div>
      <div class="stat-card"><div class="stat-value">${formatDuration(stats.avgSessionMs)}</div><div class="stat-label">Avg. session</div></div>
      <div class="stat-card"><div class="stat-value">${stats.sessionCount}</div><div class="stat-label">Listening sessions</div></div>
    </div>

    <section class="section">
      <div class="section-heading"><h2>Last 7 Days</h2></div>
      <div class="stats-chart">${barsHtml}</div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Most Played Songs</h2></div>
      <div class="settings-list">${songRows}</div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Top Artists</h2></div>
      <div class="settings-list">${artistRows}</div>
    </section>

    <section class="section">
      <div class="section-heading"><h2>Favorite Genres</h2></div>
      <div class="settings-list">${genreRows}</div>
    </section>
  `;

  el.querySelector('#stats-back').addEventListener('click', () => navigate('settings'));

  const unsub = attachShell(el, 'settings');
  el._onLeave = unsub;
  return el;
}
