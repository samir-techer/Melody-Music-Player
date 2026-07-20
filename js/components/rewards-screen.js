/**
 * rewards-screen.js
 * 🎁 Melody Points Rewards Store — redeem MP for Premium Themes (unlocked
 * independent of premiumPlan), the Gradient Collection, or auto-generated
 * Premium discount coupons.
 */

import { getAchievementsSnapshot, subscribeAchievements, recordThemeApplied } from '../services/achievements-service.js';
import {
  getRewardsSnapshot, subscribeRewards, redeemTheme, redeemDiscountCoupon,
} from '../services/rewards-service.js';
import { getSelectedPremiumTheme, setSelectedPremiumTheme } from '../services/theme-service.js';
import { getCurrentUser } from '../services/auth-service.js';
import { showRewardPopup } from '../utils/reward-popup.js';
import { showConfirmDialog } from '../utils/confirm-dialog.js';
import { showToast } from '../utils/toast.js';
import { playThemeSwitchFade } from '../utils/theme-fade.js';
import { spawnRipple } from '../utils/ripple.js';
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

function gradientCss(g) {
  if (!g) return 'transparent';
  return `linear-gradient(135deg, ${g.start}, ${g.mid || g.end}, ${g.end})`;
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

/** Gradient Collection card — live preview swatch, price/Elite badge, Owned/Apply/Applied states. */
function renderGradientCard(g, appliedThemeKey) {
  const isApplied = appliedThemeKey === g.key;
  const isOwned = g.eliteExclusive ? null : g.owned; // eliteExclusive themes don't use the "owned via MP" concept

  let badge = '';
  if (g.eliteExclusive) badge = '<span class="gradient-card-badge">Elite Exclusive</span>';
  else if (isOwned) badge = '<span class="gradient-card-badge">Owned</span>';

  let actionHtml;
  if (isApplied) {
    actionHtml = `<button class="btn-secondary reward-card-btn" type="button" disabled>✓ Applied</button>`;
  } else if (g.eliteExclusive) {
    // Access is plan-based, not MP — settings-screen.js's swatch grid is
    // the authority on whether the account actually has Elite; tapping
    // Apply here just attempts it, and setSelectedPremiumTheme() itself
    // safely no-ops back to Default if the account doesn't qualify.
    actionHtml = `<button class="btn-secondary reward-card-btn" type="button" data-apply-gradient="${g.key}">Apply</button>`;
  } else if (isOwned) {
    actionHtml = `<button class="btn-secondary reward-card-btn" type="button" data-apply-gradient="${g.key}">Apply</button>`;
  } else {
    actionHtml = `<button class="btn-secondary reward-card-btn" type="button" data-redeem-gradient="${g.key}">Unlock — ${g.price.toLocaleString()} MP</button>`;
  }

  return `
    <div class="gradient-card ${isApplied ? 'is-applied' : ''}">
      <div class="gradient-card-swatch" style="background:${gradientCss(g.gradient)}"></div>
      <div class="gradient-card-title">
        <span class="gradient-card-name">${escapeHtml(g.label)}</span>
        ${badge}
      </div>
      <span class="gradient-card-price">${g.eliteExclusive ? 'Included with Elite' : `${g.price.toLocaleString()} MP`}</span>
      ${actionHtml}
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

function renderContent(mp, rewards, appliedThemeKey) {
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
      <div class="section-heading"><h2>🌈 Gradient Collection</h2></div>
      <div class="reward-grid">${rewards.gradientThemes.map((g) => renderGradientCard(g, appliedThemeKey)).join('')}</div>
      <p class="hint" style="margin-top:8px;">Midnight Nebula ships free with Elite and isn't sold separately.</p>
    </section>

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

  const authUser = getCurrentUser();
  let latestMp = getAchievementsSnapshot().melodyPoints;
  let latestRewards = getRewardsSnapshot();
  let appliedThemeKey = authUser ? await getSelectedPremiumTheme(authUser.uid) : null;
  let lastPaint = 0;
  let pendingRepaint = false;

  function bindContentEvents() {
    content.querySelector('#rewards-back').addEventListener('click', () => navigate('achievements'));

    content.querySelectorAll('[data-redeem-theme]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        spawnRipple(btn, e);
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

    content.querySelectorAll('[data-redeem-gradient]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        spawnRipple(btn, e);
        const key = btn.dataset.redeemGradient;
        const gradient = latestRewards.gradientThemes.find((g) => g.key === key);
        if (!gradient) return;
        const ok = await showConfirmDialog({
          title: `Unlock ${gradient.label}?`,
          message: `This will spend ${gradient.price.toLocaleString()} MP.`,
          confirmLabel: 'Unlock',
        });
        if (!ok) return;
        const result = redeemTheme(key);
        if (result.success) {
          showRewardPopup({ icon: '🌈', label: gradient.label, mp: -gradient.price });
          showToast(`${gradient.label} unlocked!`);
        } else if (result.reason === 'insufficient-mp') {
          showToast('Not enough Melody Points for this yet — keep earning!');
        }
      });
    });

    content.querySelectorAll('[data-apply-gradient]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        spawnRipple(btn, e);
        if (!authUser) {
          showToast('You need to be signed in to change themes — try reloading.');
          return;
        }
        const key = btn.dataset.applyGradient;
        try {
          playThemeSwitchFade(async () => {
            await setSelectedPremiumTheme(authUser.uid, key);
          });
          appliedThemeKey = key;
          recordThemeApplied();
          paint(true);
        } catch (err) {
          console.error('[Melody] Gradient theme apply failed.', err);
          showToast(`Couldn't apply theme: ${err?.message || 'unknown error'}`);
        }
      });
    });

    content.querySelectorAll('[data-redeem-discount]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        spawnRipple(btn, e);
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
    content.innerHTML = renderContent(latestMp, latestRewards, appliedThemeKey);
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
