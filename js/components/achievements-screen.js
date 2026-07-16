/**
 * achievements-screen.js
 * 🏆 Achievements — Melody Points overview, per-category achievement
 * progress, streaks, and the once-a-day login reward. Free for every
 * account tier (no premium gating, no route guard in app.js).
 *
 * The bottom nav / mini player (attachShell) is mounted exactly once;
 * only the scrollable content above it re-renders when MP/progress
 * change, so a second-by-second listening-time tick never re-subscribes
 * the shell or interrupts the mini player.
 */

import {
  getAchievementsSnapshot, subscribeAchievements, claimDailyReward,
} from '../services/achievements-service.js';
import { showRewardPopup } from '../utils/reward-popup.js';
import { attachShell } from './shell.js';
import { navigate } from '../utils/router.js';

const REPAINT_MIN_INTERVAL_MS = 2000; // listenSeconds ticks ~once/sec; no need to redraw that often

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderProgressBar(percent) {
  return `
    <div class="achv-progress">
      <div class="achv-progress-track"><div class="achv-progress-fill" style="width:${percent}%"></div></div>
      <span class="achv-progress-label">${percent}%</span>
    </div>
  `;
}

function renderItem(item) {
  return `
    <div class="achv-item ${item.completed ? 'is-complete' : ''}">
      <div class="achv-item-top">
        <span class="achv-item-icon">${item.icon}</span>
        <div class="achv-item-text">
          <span class="achv-item-label">${escapeHtml(item.label)}</span>
          <span class="achv-item-mp">${item.completed ? '✓ Unlocked' : `+${item.mp} MP`}</span>
        </div>
      </div>
      ${item.completed ? '' : renderProgressBar(item.percent)}
    </div>
  `;
}

function renderCategory(key, label, items) {
  const rows = items.filter((i) => i.category === key).map(renderItem).join('');
  if (!rows) return '';
  return `
    <section class="section">
      <div class="section-heading"><h2>${label}</h2></div>
      <div class="achv-grid">${rows}</div>
    </section>
  `;
}

function renderContent(snap) {
  return `
    <header class="screen-header">
      <button class="back-link" id="achv-back">‹ Back</button>
      <h1>🏆 Achievements</h1>
    </header>

    <div class="achv-hero">
      <div class="achv-hero-mp">
        <span class="achv-hero-mp-value">${snap.melodyPoints.toLocaleString()}</span>
        <span class="achv-hero-mp-label">⭐ Melody Points</span>
      </div>
      <button class="btn-secondary" id="achv-store-btn" type="button" style="width:auto;">🎁 Rewards Store</button>
    </div>

    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${snap.completedCount} / ${snap.totalCount}</div><div class="stat-label">Completed Achievements</div></div>
      <div class="stat-card"><div class="stat-value">${snap.streak.current}</div><div class="stat-label">Current Streak</div></div>
      <div class="stat-card"><div class="stat-value">${snap.streak.longest}</div><div class="stat-label">Longest Streak</div></div>
      <div class="stat-card"><div class="stat-value">${Math.round((snap.completedCount / snap.totalCount) * 100)}%</div><div class="stat-label">Overall Progress</div></div>
    </div>

    ${snap.nextUp ? `
    <section class="section">
      <div class="section-heading"><h2>Next Reward</h2></div>
      <div class="achv-grid">${renderItem(snap.nextUp)}</div>
    </section>` : ''}

    <section class="section">
      <div class="section-heading"><h2>Daily Reward</h2></div>
      <div class="settings-list">
        <div class="settings-row-toggle">
          <div class="settings-row-label">
            <span>📅 Daily Login</span>
            <p class="settings-hint-inline">+5 MP once every day.</p>
          </div>
          <button class="btn-secondary" id="achv-claim-daily" type="button" style="width:auto;" ${snap.canClaimDaily ? '' : 'disabled'}>
            ${snap.canClaimDaily ? 'Claim' : 'Claimed ✓'}
          </button>
        </div>
      </div>
    </section>

    ${Object.entries(snap.categories).map(([key, label]) => renderCategory(key, label, snap.items)).join('')}

    ${snap.history.length ? `
    <section class="section">
      <div class="section-heading"><h2>Recent Activity</h2></div>
      <div class="settings-list">
        ${snap.history.slice(0, 8).map((h) => `
          <div class="stats-list-row">
            <span class="stats-list-name">${h.icon || '⭐'} ${escapeHtml(h.label)}</span>
            <span class="stats-list-count">+${h.mp} MP</span>
          </div>
        `).join('')}
      </div>
    </section>` : ''}
  `;
}

export async function renderAchievementsScreen() {
  const el = document.createElement('div');
  el.className = 'screen achievements-screen has-shell';

  const content = document.createElement('div');
  content.className = 'screen-content';
  el.appendChild(content);

  let lastPaint = 0;
  let pendingSnap = null;

  function bindContentEvents() {
    content.querySelector('#achv-back').addEventListener('click', () => navigate('settings'));
    content.querySelector('#achv-store-btn').addEventListener('click', () => navigate('rewards-store'));
    content.querySelector('#achv-claim-daily')?.addEventListener('click', () => {
      const result = claimDailyReward();
      if (result.claimed) showRewardPopup({ icon: '📅', label: 'Daily Login', mp: result.mp });
      paint(getAchievementsSnapshot(), true);
    });
  }

  function paint(snap, force = false) {
    const now = Date.now();
    if (!force && now - lastPaint < REPAINT_MIN_INTERVAL_MS) {
      pendingSnap = snap;
      return;
    }
    lastPaint = now;
    pendingSnap = null;
    content.innerHTML = renderContent(snap);
    bindContentEvents();
  }

  // Catch up on any snapshot that arrived while throttled.
  const flushTimer = setInterval(() => {
    if (pendingSnap) paint(pendingSnap, true);
  }, REPAINT_MIN_INTERVAL_MS);

  const unsubscribeAchv = subscribeAchievements((snap) => paint(snap));
  const unsubscribeShell = attachShell(el, 'settings');

  el._onLeave = () => {
    clearInterval(flushTimer);
    unsubscribeShell();
    unsubscribeAchv();
  };

  return el;
}
