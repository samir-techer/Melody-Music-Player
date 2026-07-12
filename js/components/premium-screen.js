/**
 * premium-screen.js
 * Melody Premium — plans (each with its own Monthly/Yearly toggle),
 * comparison table, FAQ and the "coming soon" purchase modal. Rendered as
 * a normal router screen (no separate HTML file, no payments) and
 * reachable from Settings.
 *
 * Pricing rules:
 *  - Every paid plan has a base monthly price and a yearly discount %.
 *  - Basic, Plus and Elite each carry their OWN billing selection
 *    (`planBilling[key]`), defaulting to Monthly. Flipping one plan's
 *    toggle only re-renders that plan's price block.
 *  - Yearly price = 12 × monthly price, discounted by the plan's yearly
 *    discount %, shown as a real annual total (not a monthly rate).
 *  - The welcome banner's 20% first-purchase discount is presented as a
 *    banner only — it isn't folded into the per-plan prices below.
 */

import { navigate } from '../utils/router.js';
import { getPremiumState, subscribePremium, PLAN_ORDER, waitForPremiumReady } from '../services/premium-service.js';

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
    theme: 'crimson',
    price: 99,
    yearlyOff: 15,
    yearlyPrice: 1010, // रु99 × 12 = रु1,188 → 15% OFF = रु1,010
    cta: 'Upgrade to Basic',
    features: [
      'Everything in Free',
      'Ad-Free Listening',
      'Premium Themes',
      'Advanced Equalizer Presets',
      'Crossfade',
      'Cloud Backup & Sync',
      'Custom App Icons',
    ],
  },
  {
    key: 'plus',
    icon: '⭐',
    name: 'Plus',
    badge: 'Recommended',
    theme: 'navy',
    price: 249,
    yearlyOff: 20,
    yearlyPrice: 2390, // रु249 × 12 = रु2,988 → 20% OFF = रु2,390
    highlight: true,
    cta: 'Upgrade to Plus',
    features: [
      'Everything in Basic',
      'Royal Navy Theme',
      'Exclusive Plus Badge',
      'Multi-Device Sync',
      'Unlimited Queue Length',
      'Unlimited Nickname Changes',
      'Higher Audio Quality',
      'Experimental Features',
      'Priority Support',
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
    yearlyPrice: 3205, // रु399 × 12 = रु4,788 → 33% OFF = रु3,205
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
  { label: 'Sleep Timer', tiers: ['free', 'basic', 'plus', 'elite'] },
  { label: 'Ad-Free Listening', tiers: ['basic', 'plus', 'elite'] },
  { label: 'Premium Themes', tiers: ['basic', 'plus', 'elite'] },
  { label: 'Advanced Equalizer Presets', tiers: ['basic', 'plus', 'elite'] },
  { label: 'Crossfade', tiers: ['basic', 'plus', 'elite'] },
  { label: 'Cloud Backup & Sync', tiers: ['basic', 'plus', 'elite'] },
  { label: 'Exclusive Plus/Elite Badge', tiers: ['plus', 'elite'] },
  { label: 'Unlimited Queue Length', tiers: ['plus', 'elite'] },
  { label: 'Unlimited Nickname Changes', tiers: ['plus', 'elite'] },
  { label: 'Higher Audio Quality', tiers: ['plus', 'elite'] },
  { label: 'Experimental Features', tiers: ['plus', 'elite'] },
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
  // Avoid a flash of "Upgrade to X" for an account that's actually
  // already Plus/Elite, just because premium-service's first live
  // Firestore snapshot hadn't arrived yet at the exact moment this page
  // was requested.
  await waitForPremiumReady();

  const el = document.createElement('div');
  el.className = 'screen premium-screen';

  // Each paid plan remembers its own Monthly/Yearly selection, independent
  // of the others — switching Basic to Yearly never touches Plus or Elite.
  const planBilling = {};
  PLANS.forEach((plan) => {
    if (plan.price > 0) planBilling[plan.key] = 'monthly';
  });

  el.innerHTML = `
    <a href="#" class="premium-back" id="premium-back">&larr; Back</a>

    <header class="premium-header premium-fade">
      <h1>Melody Premium</h1>
      <p>Unlock more features and support Melody's development.</p>
    </header>

    <div id="premium-status-banner-slot"></div>

    <div class="welcome-banner premium-fade">
      <div class="emoji">🎉</div>
      <div class="copy">
        <strong>Extra ${FIRST_PURCHASE_OFF}% OFF your first purchase!</strong>
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
              <th class="col-crimson">Basic</th>
              <th class="col-navy">Plus</th>
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

  // ---------- Premium Status Banner + plan cards: both driven by the
  // SAME live, Firestore-verified premium state, re-rendered together
  // any time that state changes (renewal, expiry, an admin grant) — never
  // a page reload required. ----------
  const bannerSlot = el.querySelector('#premium-status-banner-slot');
  const plansGrid = el.querySelector('#plans-grid');

  function renderDynamicParts() {
    const state = getPremiumState();
    bannerSlot.innerHTML = renderStatusBanner(state);
    plansGrid.innerHTML = PLANS.map((plan) => renderPlanCard(plan, planBilling[plan.key] || 'monthly', state)).join('');
  }
  renderDynamicParts();

  const unsubscribePremium = subscribePremium((state) => {
    if (!state.ready) return;
    renderDynamicParts();
  });

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

  // ---------- Per-plan billing toggle + CTA (single delegated listener —
  // cards are never rebuilt, only each plan's price block is refreshed) ----------
  plansGrid.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.plan-billing-toggle button[data-billing]');
    if (toggleBtn) {
      const toggleWrap = toggleBtn.closest('.plan-billing-toggle');
      const key = toggleWrap.dataset.plan;
      const newBilling = toggleBtn.dataset.billing;
      if (planBilling[key] === newBilling) return;

      planBilling[key] = newBilling;
      toggleWrap.classList.toggle('is-yearly', newBilling === 'yearly');
      toggleWrap.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.billing === newBilling));

      updatePriceBlock(key, newBilling);
      return;
    }

    const ctaBtn = e.target.closest('.plan-cta:not([disabled])');
    if (ctaBtn) openComingSoonModal(el);
  });

  // Cross-fades a single plan's price block into its new Monthly/Yearly
  // value without touching the toggle, features, badge or any other card.
  function updatePriceBlock(key, newBilling) {
    const plan = PLANS.find((p) => p.key === key);
    const block = plansGrid.querySelector(`#price-block-${key}`);
    if (!plan || !block) return;

    block.classList.add('is-fading');
    setTimeout(() => {
      block.innerHTML = renderPriceBlock(plan, newBilling);
      block.classList.remove('is-fading');
    }, 160);
  }

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

  el._onLeave = () => {
    observer.disconnect();
    unsubscribePremium();
  };

  return el;
}

/**
 * Computes everything a plan's price block needs to show for ONE billing
 * mode. Monthly is just the flat monthly rate. Yearly returns both the
 * pre-discount annual total (12 × monthly, shown struck through) and the
 * plan's fixed discounted annual total, plus the exact rupee amount saved.
 */
function computePrice(plan, billing) {
  if (plan.price === 0) {
    return { isFree: true };
  }

  if (billing === 'yearly') {
    const yearlyOriginal = plan.price * 12;
    const yearlyFinal = plan.yearlyPrice;
    const savings = yearlyOriginal - yearlyFinal;
    return {
      original: yearlyOriginal,
      finalPrice: yearlyFinal,
      unit: '/year',
      offBadge: `${plan.yearlyOff}% OFF`,
      note: `You save ${CURRENCY} ${savings.toLocaleString('en-IN')}`,
    };
  }

  return {
    original: null,
    finalPrice: plan.price,
    unit: '/month',
    offBadge: null,
    note: null,
  };
}

/** The part of a plan card that changes when its toggle flips — original
 *  (struck-through) price, discounted price, OFF badge and savings note.
 *  Everything else in the card (toggle, features, badge, CTA) stays put. */
function renderPriceBlock(plan, billing) {
  const priced = computePrice(plan, billing);

  if (priced.isFree) {
    return `
      <div class="plan-price-row">
        <span class="plan-price-final plan-price-forever">Forever Free</span>
      </div>
      <div class="plan-price-note">No credit card needed \u2014 ever.</div>
    `;
  }

  const { original, finalPrice, unit, offBadge, note } = priced;

  return `
    <div class="plan-price-row">
      ${original ? `<span class="plan-price-original">${CURRENCY} ${original.toLocaleString('en-IN')}</span>` : ''}
      <span class="plan-price-final">${CURRENCY} ${finalPrice.toLocaleString('en-IN')}<span class="per">${unit}</span></span>
      ${offBadge ? `<span class="plan-off-badge">${offBadge}</span>` : ''}
    </div>
    <div class="plan-price-note">${note || ''}</div>
  `;
}

const PLAN_DISPLAY = {
  Free: { icon: '🆓', label: 'Free', cssKey: 'free' },
  Basic: { icon: '💿', label: 'Basic Member', cssKey: 'basic' },
  Plus: { icon: '⭐', label: 'Plus Member', cssKey: 'plus' },
  Elite: { icon: '👑', label: 'Elite Member', cssKey: 'elite' },
};

/**
 * Renders one plan card, comparing this card's plan against the
 * account's live EFFECTIVE plan (expiry already applied upstream by
 * premium-service — an expired Plus account is treated as Free here too,
 * exactly like everywhere else in the app):
 *  - same plan as the account -> "Current Plan" (disabled, styled distinctly)
 *  - ranked below the account's plan -> "Included in <Plan>" (disabled)
 *  - ranked above the account's plan -> normal, enabled "Upgrade to X"
 */
function renderPlanCard(plan, billing, state) {
  const isFree = plan.price === 0;
  const effectivePlan = state.effectivePlan;
  const planRank = PLAN_ORDER.indexOf(plan.name);
  const currentRank = PLAN_ORDER.indexOf(effectivePlan);

  let ctaLabel = plan.cta;
  let ctaClass = '';
  let disabled = false;
  let includedTag = '';
  let planNote = '';

  if (plan.name === effectivePlan) {
    disabled = true;
    if (plan.name === 'Elite') {
      ctaLabel = '👑 Current Plan';
      ctaClass = 'is-current-elite';
      planNote = 'You already own the highest plan.';
    } else if (plan.name === 'Free') {
      ctaLabel = 'Current Plan';
      ctaClass = 'is-current-plan';
    } else {
      ctaLabel = '✓ Current Plan';
      ctaClass = 'is-current-plan';
    }
  } else if (!isFree && planRank < currentRank) {
    // A paid plan ranked below the account's actual plan — already included.
    disabled = true;
    ctaClass = 'is-included';
    ctaLabel = `Included in ${escapeHtml(effectivePlan)}`;
    includedTag = '<span class="plan-included-tag">Included</span>';
  } else if (isFree && currentRank > 0) {
    // Free card, but the account already has a paid plan — nothing to buy here.
    disabled = true;
    ctaClass = 'is-included';
    ctaLabel = 'Included';
  }

  return `
    <div class="plan-card theme-${plan.theme} ${plan.highlight ? 'is-highlight' : ''}">
      <div class="plan-card-top">
        <span class="plan-name">${plan.icon} ${plan.name}${includedTag}</span>
        <span class="plan-badge">${plan.badge}</span>
      </div>

      ${isFree ? '' : `
      <div class="plan-billing-toggle ${billing === 'yearly' ? 'is-yearly' : ''}" data-plan="${plan.key}">
        <div class="toggle-thumb"></div>
        <button type="button" data-billing="monthly" class="${billing === 'monthly' ? 'active' : ''}">Monthly</button>
        <button type="button" data-billing="yearly" class="${billing === 'yearly' ? 'active' : ''}">Yearly</button>
      </div>
      `}

      <div class="plan-price-block" id="price-block-${plan.key}">
        ${renderPriceBlock(plan, billing)}
      </div>

      <ul class="plan-features">
        ${plan.features.map((f) => `<li><span class="tick">✓</span>${f}</li>`).join('')}
      </ul>

      <button type="button" class="plan-cta ${ctaClass}" data-plan-key="${plan.key}" ${disabled ? 'disabled' : ''}>${ctaLabel}</button>
      ${planNote ? `<p class="plan-note">${escapeHtml(planNote)}</p>` : ''}
    </div>
  `;
}

function formatExpiry(expiry) {
  if (!expiry) return null;
  const date = typeof expiry?.toDate === 'function' ? expiry.toDate() : new Date(expiry);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Reads ONLY premiumPlan/premiumExpiry (via premium-service, which itself
 * reads live Firestore) — never a cached/local flag. isExpired means the
 * raw plan is still e.g. "Plus" in Firestore but the expiry has passed;
 * per spec this is treated as Free everywhere EXCEPT this specific
 * "expired" messaging, and Firestore itself is never auto-modified.
 */
function renderStatusBanner(state) {
  const { rawPlan, effectivePlan, expiry, isExpired } = state;

  if (isExpired) {
    const display = PLAN_DISPLAY[rawPlan] || PLAN_DISPLAY.Free;
    return `
      <div class="premium-status-banner is-expired">
        <div>
          <div class="status-plan">${display.icon} ${escapeHtml(rawPlan)}</div>
          <div class="status-meta">Status: Expired</div>
        </div>
        <span class="status-badge">Expired</span>
        <p class="status-expired-note">Your Premium subscription has expired. Renew your subscription to continue enjoying Premium features.</p>
      </div>`;
  }

  const display = PLAN_DISPLAY[effectivePlan] || PLAN_DISPLAY.Free;
  const expiryLabel = formatExpiry(expiry);

  return `
    <div class="premium-status-banner plan-${display.cssKey}">
      <div>
        <div class="status-plan">${display.icon} ${escapeHtml(effectivePlan === 'Free' ? 'Free' : display.label)}</div>
        <div class="status-meta">
          ${effectivePlan === 'Free' ? 'No active subscription' : `Status: Active${expiryLabel ? ` · Expires: ${expiryLabel}` : ' · No expiry'}`}
        </div>
      </div>
      <span class="status-badge">${effectivePlan === 'Free' ? 'Free' : 'Active'}</span>
    </div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
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
