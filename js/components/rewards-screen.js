/**
 * rewards-screen.js
 * 🎁 Melody Points Rewards Store — redeem MP for Premium Themes (unlocked
 * independent of premiumPlan) or auto-generated Premium discount coupons.
 */

import { getAchievementsSnapshot, subscribeAchievements } from '../services/achievements-service.js';
import {
  getRewardsSnapshot, subscribeRewards, redeemTheme, redeemDiscountCoupon,
} from '../services/rewards-service.js';
import { showRewardPopup } from '../utils/reward-popup.js';
import { showConfirmDialog } from '../utils/confirm-dialog.js';
import { showToast } from '../utils/toast.js';
import { attachShell } from './shell.js';
import { navigate } from '../utils/router.js';

const REPAINT_MIN_INTERVAL_MS = 2000;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatExpiry(ts) {
  const days = Math.max(0, Math.ceil((ts - Date.now()) / (24 * 60 * 60 * 1000)));
  return days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

function renderThemeCard(t) {
  return `
    <div class="reward-card">
      <div class="reward-card-top">
        <span class="reward-card-title">${escapeHtml(t.label)}</span>
        <span class="reward-card-price">${t.price.toLocaleString()} MP</span>
      </div>
      <button class="btn-secondary reward-card-btn" type="button" data-redeem-theme="${t.key}" ${t.unlocked ? 'disabled' : ''}>
        ${t.unlocked ? '✓ Unlocked' : 'Unlock'}
      </button>
    </div>
  `;
}

function renderDiscountCard(d) {
  return `
    <div class="reward-card">
      <div class="reward-card-top">
        <span class="reward-card-title">${d.percent}% Off Premium</span>
        <span class="reward-card-price">${d.mp.toLocaleString()} MP</span>
      </div>
      <button class="btn-secondary reward-card-btn" type="button" data-redeem-discount="${d.percent}">Generate Coupon</button>
    </div>
  `;
}

function renderCoupon(c) {
  return `
    <div class="stats-list-row">
      <span class="stats-list-name">🏷️ ${c.discountPercent}% off — <code>${escapeHtml(c.code)}</code></span>
      <span class="stats-list-count">${formatExpiry(c.expiresAt)}</span>
    </div>
  `;
}

function renderContent(mp, rewards) {
  return `
    <header class="screen-header">
      <button class="back-link" id="rewards-back">‹ Back</button>
      <h1>🎁 Rewards Store</h1>
    </header>

    <div class="achv-hero">
      <div class="achv-hero-mp">
        <span class="achv-hero-mp-value">${mp.toLocaleString()}</span>
        <span class="achv-hero-mp-label">⭐ Melody Points</span>
      </div>
    </div>

    <section class="section">
      <div class="section-heading"><h2>🎨 Themes</h2></div>
      <div class="reward-grid">${rewards.themes.map(renderThemeCard).join('')}</div>
      <p class="hint" style="margin-top:8px;">Unlocking a theme here works even without a matching Premium plan.</p>
    </section>

    <section class="section">
      <div class="section-heading"><h2>🏷️ Premium Discounts</h2></div>
      <div class="reward-grid">${rewards.discountTiers.map(renderDiscountCard).join('')}</div>
      <p class="hint" style="margin-top:8px;">Coupons expire 30 days after they're generated.</p>
    </section>

    ${rewards.activeCoupons.length ? `
    <section class="section">
      <div class="section-heading"><h2>Your Coupons</h2></div>
      <div class="settings-list">${rewards.activeCoupons.map(renderCoupon).join('')}</div>
    </section>` : ''}

    ${rewards.history.length ? `
    <section class="section">
      <div class="section-heading"><h2>Redemption History</h2></div>
      <div class="settings-list">
        ${rewards.history.slice(0, 8).map((h) => `
          <div class="stats-list-row">
            <span class="stats-list-name">${h.type === 'theme' ? '🎨' : '🏷️'} ${escapeHtml(h.label)}</span>
            <span class="stats-list-count">-${h.mp} MP</span>
          </div>
        `).join('')}
      </div>
    </section>` : ''}
  `;
}

export async function renderRewardsScreen() {
  const el = document.createElement('div');
  el.className = 'screen rewards-screen has-shell';

  const content = document.createElement('div');
  content.className = 'screen-content';
  el.appendChild(content);

  let latestMp = getAchievementsSnapshot().melodyPoints;
  let latestRewards = getRewardsSnapshot();
  let lastPaint = 0;
  let pendingRepaint = false;

  function bindContentEvents() {
    content.querySelector('#rewards-back').addEventListener('click', () => navigate('achievements'));

    content.querySelectorAll('[data-redeem-theme]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.redeemTheme;
        const theme = latestRewards.themes.find((t) => t.key === key);
        if (!theme) return;
        const ok = await showConfirmDialog({
          title: `Unlock ${theme.label}?`,
          message: `This will spend ${theme.price.toLocaleString()} MP.`,
          confirmLabel: 'Unlock',
        });
        if (!ok) return;
        const result = redeemTheme(key);
        if (result.success) {
          showRewardPopup({ icon: '🎨', label: theme.label, mp: -theme.price });
          showToast(`${theme.label} unlocked! Apply it from Settings → Premium Themes.`);
        } else if (result.reason === 'insufficient-mp') {
          showToast('Not enough Melody Points for this yet — keep earning!');
        }
      });
    });

    content.querySelectorAll('[data-redeem-discount]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const percent = Number(btn.dataset.redeemDiscount);
        const tier = latestRewards.discountTiers.find((d) => d.percent === percent);
        if (!tier) return;
        const ok = await showConfirmDialog({
          title: `Generate a ${percent}% off coupon?`,
          message: `This will spend ${tier.mp.toLocaleString()} MP. The coupon expires in 30 days.`,
          confirmLabel: 'Generate',
        });
        if (!ok) return;
        const result = redeemDiscountCoupon(percent);
        if (result.success) {
          showToast(`Coupon generated: ${result.coupon.code} (${percent}% off, expires in 30 days).`);
        } else if (result.reason === 'insufficient-mp') {
          showToast('Not enough Melody Points for this yet — keep earning!');
        }
      });
    });
  }

  function paint(force = false) {
    const now = Date.now();
    if (!force && now - lastPaint < REPAINT_MIN_INTERVAL_MS) {
      pendingRepaint = true;
      return;
    }
    lastPaint = now;
    pendingRepaint = false;
    content.innerHTML = renderContent(latestMp, latestRewards);
    bindContentEvents();
  }

  const flushTimer = setInterval(() => {
    if (pendingRepaint) paint(true);
  }, REPAINT_MIN_INTERVAL_MS);

  const unsubscribeAchv = subscribeAchievements((snap) => { latestMp = snap.melodyPoints; paint(); });
  const unsubscribeRewards = subscribeRewards((snap) => { latestRewards = snap; paint(true); });
  const unsubscribeShell = attachShell(el, 'settings');

  el._onLeave = () => {
    clearInterval(flushTimer);
    unsubscribeShell();
    unsubscribeAchv();
    unsubscribeRewards();
  };

  return el;
}
