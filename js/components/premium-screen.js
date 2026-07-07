/**
 * premium-screen.js
 * Melody Premium — plans, billing toggle, comparison table, FAQ and the
 * "coming soon" purchase modal. Rendered as a normal router screen (no
 * separate HTML file, no payments) and reachable from Settings.
 *
 * Pricing rules:
 *  - Every paid plan has a base monthly price and a yearly discount %.
 *  - Switching the toggle to "Yearly" applies that plan's yearly discount
 *    to the monthly-equivalent price.
 *  - The welcome banner's extra 20% first-purchase discount always stacks
 *    on top of whatever billing price is currently shown.
 */

import { navigate } from '../utils/router.js';

const CURRENCY = 'रु';
const FIRST_PURCHASE_OFF = 20; // % — stacks with yearly

const PLANS = [
  {
    key: 'free',
    icon: '🆓',
    name: 'Free',
    badge: 'Get Started',
    theme: 'free',
    price: 0,
    yearlyOff: 0,
    isCurrent: true,
    cta: 'Current Plan',
    features: [
      'Offline Playback',
      'Unlimited Local Music',
      'Playlists',
      'Shuffle',
      'Repeat',
      'Favorites',
      'Lyrics',
      'Equalizer',
      'Sleep Timer',
      'Media Notifications',
    ],
  },
  {
    key: 'basic',
    icon: '📀',
    name: 'Basic',
    badge: 'For Casual Listeners',
    theme: 'pink',
    price: 99,
    yearlyOff: 15,
    cta: 'Upgrade to Basic',
    features: [
      'Everything in Free',
      'Ad-Free Listening',
      'Advanced Equalizer Presets',
      'Gapless Playback',
      'Custom App Icons',
    ],
  },
  {
    key: 'plus',
    icon: '⭐',
    name: 'Plus',
    badge: 'Recommended',
    theme: 'purple',
    price: 249,
    yearlyOff: 20,
    highlight: true,
    cta: 'Upgrade to Plus',
    features: [
      'Everything in Basic',
      'Cloud Backup & Sync',
      'Crossfade',
      'Priority Support',
      'Exclusive Plus Badge',
    ],
  },
  {
    key: 'elite',
    icon: '💎',
    name: 'Elite',
    badge: 'Ultimate Experience',
    theme: 'gold',
    price: 399,
    yearlyOff: 33,
    cta: 'Upgrade to Elite',
    features: [
      'Everything in Plus',
      'Unlimited Cloud Storage',
      'Early Access to New Features',
      'Custom Themes & Wallpapers',
      'VIP Support Priority',
    ],
  },
];

// Feature comparison matrix — rows shown in this order.
const COMPARE_ROWS = [
  { label: 'Offline Playback', tiers: ['free', 'basic', 'plus', 'elite'] },
  { label: 'Unlimited Local Music', tiers: ['free', 'basic', 'plus', 'elite'] },
  { label: 'Playlists, Shuffle & Repeat', tiers: ['free', 'basic', 'plus', 'elite'] },
  { label: 'Favorites & Lyrics', tiers: ['free', 'basic', 'plus', 'elite'] },
  { label: 'Equalizer & Sleep Timer', tiers: ['free', 'basic', 'plus', 'elite'] },
  { label: 'Ad-Free Listening', tiers: ['basic', 'plus', 'elite'] },
  { label: 'Gapless Playback', tiers: ['basic', 'plus', 'elite'] },
  { label: 'Cloud Backup & Sync', tiers: ['plus', 'elite'] },
  { label: 'Crossfade', tiers: ['plus', 'elite'] },
  { label: 'Priority Support', tiers: ['plus', 'elite'] },
  { label: 'Unlimited Cloud Storage', tiers: ['elite'] },
  { label: 'Early Access Features', tiers: ['elite'] },
  { label: 'Custom Themes & Wallpapers', tiers: ['elite'] },
];

const FAQS = [
  {
    q: 'When will Melody Premium be available?',
    a: 'We\u2019re still actively building it. This page is a preview so you can see what\u2019s coming \u2014 purchases aren\u2019t open yet.',
  },
  {
    q: 'Will my Free features still work?',
    a: 'Yes. Everything you use today \u2014 offline playback, playlists, favorites and more \u2014 stays free, forever.',
  },
  {
    q: 'Does the first-purchase discount really stack with yearly billing?',
    a: 'Yes. The extra 20% off applies on top of whatever yearly discount your plan already has, for your first billing cycle.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Once payments launch, you\u2019ll be able to cancel or switch plans at any time \u2014 no long-term lock-in.',
  },
  {
    q: 'Is my local music affected by a subscription?',
    a: 'Never. Your imported songs live on your device and always play, with or without Premium.',
  },
];

export async function renderPremiumScreen() {
  const el = document.createElement('div');
  el.className = 'screen premium-screen';
  let billing = 'monthly'; // 'monthly' | 'yearly'

  el.innerHTML = `
    <a href="#" class="premium-back" id="premium-back">&larr; Back</a>

    <header class="premium-header premium-fade">
      <h1>Melody Premium</h1>
      <p>Unlock more features and support Melody's development.</p>
    </header>

    <div class="billing-toggle-wrap premium-fade">
      <div class="billing-toggle" id="billing-toggle">
        <div class="toggle-thumb"></div>
        <button type="button" data-billing="monthly" class="active">Monthly</button>
        <button type="button" data-billing="yearly">Yearly</button>
      </div>
      <span class="billing-savings">Save up to 33% with yearly billing</span>
    </div>

    <div class="welcome-banner premium-fade">
      <div class="emoji">🎉</div>
      <div class="copy">
        <strong>Extra 20% OFF your first purchase!</strong>
        <span>Stacks with yearly billing \u2014 applied automatically at checkout.</span>
      </div>
    </div>

    <div class="plans-grid" id="plans-grid"></div>

    <section class="premium-section premium-fade">
      <h2 class="premium-section-title">Compare Plans</h2>
      <div class="compare-table-wrap">
        <table class="compare-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>Free</th>
              <th class="col-pink">Basic</th>
              <th class="col-purple">Plus</th>
              <th class="col-gold">Elite</th>
            </tr>
          </thead>
          <tbody id="compare-body"></tbody>
        </table>
      </div>
    </section>

    <section class="premium-section premium-fade">
      <h2 class="premium-section-title">Frequently Asked Questions</h2>
      <div class="faq-list" id="faq-list"></div>
    </section>

    <p class="premium-footnote premium-fade">Prices and features may change before the official release.</p>
  `;

  // ---------- Render plan cards ----------
  const plansGrid = el.querySelector('#plans-grid');
  plansGrid.innerHTML = PLANS.map((plan) => renderPlanCard(plan, billing)).join('');

  // ---------- Render comparison table ----------
  const compareBody = el.querySelector('#compare-body');
  compareBody.innerHTML = COMPARE_ROWS.map((row) => `
    <tr>
      <td>${row.label}</td>
      <td>${row.tiers.includes('free') ? '<span class="yes">✓</span>' : '<span class="no">—</span>'}</td>
      <td>${row.tiers.includes('basic') ? '<span class="yes">✓</span>' : '<span class="no">—</span>'}</td>
      <td>${row.tiers.includes('plus') ? '<span class="yes">✓</span>' : '<span class="no">—</span>'}</td>
      <td>${row.tiers.includes('elite') ? '<span class="yes">✓</span>' : '<span class="no">—</span>'}</td>
    </tr>
  `).join('');

  // ---------- Render FAQ ----------
  const faqList = el.querySelector('#faq-list');
  faqList.innerHTML = FAQS.map((faq, i) => `
    <div class="faq-item" data-faq="${i}">
      <button class="faq-question" type="button" aria-expanded="false">
        <span>${faq.q}</span>
        <span class="chev" aria-hidden="true">⌄</span>
      </button>
      <div class="faq-answer"><p>${faq.a}</p></div>
    </div>
  `).join('');

  // ---------- Back navigation ----------
  el.querySelector('#premium-back').addEventListener('click', (e) => {
    e.preventDefault();
    navigate('settings');
  });

  // ---------- Billing toggle ----------
  const toggleEl = el.querySelector('#billing-toggle');
  toggleEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-billing]');
    if (!btn) return;
    billing = btn.dataset.billing;
    toggleEl.classList.toggle('is-yearly', billing === 'yearly');
    toggleEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.billing === billing));
    plansGrid.innerHTML = PLANS.map((plan) => renderPlanCard(plan, billing)).join('');
    bindPlanButtons();
  });

  // ---------- Plan CTA buttons (delegated, rebound after each re-render) ----------
  function bindPlanButtons() {
    plansGrid.querySelectorAll('.plan-cta:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => openComingSoonModal(el));
    });
  }
  bindPlanButtons();

  // ---------- FAQ accordion ----------
  faqList.addEventListener('click', (e) => {
    const question = e.target.closest('.faq-question');
    if (!question) return;
    const item = question.closest('.faq-item');
    const answer = item.querySelector('.faq-answer');
    const isOpen = item.classList.contains('open');

    // Close any other open item for a cleaner single-open accordion feel.
    faqList.querySelectorAll('.faq-item.open').forEach((openItem) => {
      if (openItem !== item) {
        openItem.classList.remove('open');
        openItem.querySelector('.faq-question').setAttribute('aria-expanded', 'false');
        openItem.querySelector('.faq-answer').style.maxHeight = null;
      }
    });

    if (isOpen) {
      item.classList.remove('open');
      question.setAttribute('aria-expanded', 'false');
      answer.style.maxHeight = null;
    } else {
      item.classList.add('open');
      question.setAttribute('aria-expanded', 'true');
      answer.style.maxHeight = `${answer.scrollHeight}px`;
    }
  });

  // ---------- Scroll fade-in ----------
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  el.querySelectorAll('.premium-fade').forEach((node) => observer.observe(node));

  el._onLeave = () => observer.disconnect();

  return el;
}

/**
 * Computes the price to display for a plan under the current billing mode.
 * Returns { original, final, note } where `original` is only meaningful
 * (non-null) when a strikethrough should be shown.
 */
function computePrice(plan, billing) {
  if (plan.price === 0) {
    return { original: null, final: 0, note: 'Forever free' };
  }

  const base = plan.price;
  const yearlyPrice = billing === 'yearly' ? base * (1 - plan.yearlyOff / 100) : base;
  const finalPrice = yearlyPrice * (1 - FIRST_PURCHASE_OFF / 100);

  const note = billing === 'yearly'
    ? `Billed yearly \u2022 Save ${plan.yearlyOff}% + ${FIRST_PURCHASE_OFF}% first purchase`
    : `Save ${FIRST_PURCHASE_OFF}% on your first month`;

  return {
    original: Math.round(base),
    final: Math.round(finalPrice),
    note,
  };
}

function renderPlanCard(plan, billing) {
  const { original, final, note } = computePrice(plan, billing);
  const isFree = plan.price === 0;

  return `
    <div class="plan-card theme-${plan.theme} ${plan.highlight ? 'is-highlight' : ''}">
      <div class="plan-card-top">
        <span class="plan-name">${plan.icon} ${plan.name}</span>
        <span class="plan-badge">${plan.badge}</span>
      </div>

      <div class="plan-price-row">
        ${original && !isFree ? `<span class="plan-price-original">${CURRENCY} ${original}/mo</span>` : ''}
        <span class="plan-price-final">${CURRENCY} ${final}${isFree ? '' : '<span class="per">/mo</span>'}</span>
      </div>
      <div class="plan-price-note">${note}</div>

      <ul class="plan-features">
        ${plan.features.map((f) => `<li><span class="tick">✓</span>${f}</li>`).join('')}
      </ul>

      <button type="button" class="plan-cta" ${plan.isCurrent ? 'disabled' : ''}>${plan.cta}</button>
    </div>
  `;
}

function openComingSoonModal(screenEl) {
  const overlay = document.createElement('div');
  overlay.className = 'premium-modal-overlay';
  overlay.innerHTML = `
    <div class="premium-modal" role="dialog" aria-modal="true" aria-labelledby="premium-modal-title">
      <div class="modal-emoji">🚧</div>
      <h2 id="premium-modal-title">Premium Plans Coming Soon</h2>
      <p>
        Melody Premium is currently under active development. We're adding more valuable
        features, improving performance, and polishing the overall experience before launch.
        Payments are not available yet. Thank you for supporting Melody and for your
        patience \u2014 we're building something worth waiting for.
      </p>
      <div class="premium-modal-actions">
        <button type="button" class="btn-modal-primary" id="modal-got-it">Got it</button>
        <button type="button" class="btn-modal-secondary" id="modal-notify" disabled>Notify Me (Coming Soon)</button>
      </div>
    </div>
  `;

  screenEl.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('open'));

  function close() {
    overlay.classList.remove('open');
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  }

  overlay.querySelector('#modal-got-it').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
}
