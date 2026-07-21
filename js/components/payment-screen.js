/**
 * payment-screen.js
 * The real (manual-verification) Premium checkout flow: pick a plan +
 * billing (arrives via route params from premium-screen.js) -> optionally
 * apply one of the account's OWN active MP Store coupons -> see the
 * final price -> pay the displayed eSewa QR/number -> submit the eSewa
 * reference as proof -> wait for admin verification (up to 24h).
 *
 * IMPORTANT: nothing here ever writes premiumPlan/premiumExpiry, and no
 * coupon is ever marked redeemed here — both only happen in
 * payment-service.js's approveTransaction(), called by an admin from
 * admin-screen.js. See payment-service.js's top comment for why.
 */

import { getCurrentUser } from '../services/auth-service.js';
import { PLANS, computePrice, CURRENCY, openComingSoonModal } from './premium-screen.js';
import { getRewardsSnapshot, subscribeRewards } from '../services/rewards-service.js';
import { PAYMENT_PROVIDERS, submitPendingPayment, subscribeTransaction } from '../services/payment-service.js';
import { showToast } from '../utils/toast.js';
import { navigate } from '../utils/router.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatMoney(n) {
  return `${CURRENCY} ${Math.round(n).toLocaleString('en-IN')}`;
}

function formatCouponExpiry(ts) {
  const days = Math.max(0, Math.ceil((ts - Date.now()) / (24 * 60 * 60 * 1000)));
  return `${days} day${days === 1 ? '' : 's'} left`;
}

export async function renderPaymentScreen({ planKey, billing = 'monthly' } = {}) {
  const el = document.createElement('div');
  el.className = 'screen payment-screen';

  const plan = PLANS.find((p) => p.key === planKey);
  const authUser = getCurrentUser();

  if (!plan || plan.price === 0 || !authUser) {
    el.innerHTML = `
      <a href="#" class="premium-back" id="pay-back">&larr; Back</a>
      <div class="pay-error-state">
        <p>Something's not right with this checkout link.</p>
        <button type="button" class="btn-secondary" id="pay-back-2">Back to Premium</button>
      </div>
    `;
    el.querySelector('#pay-back').addEventListener('click', (e) => { e.preventDefault(); navigate('premium'); });
    el.querySelector('#pay-back-2').addEventListener('click', () => navigate('premium'));
    return el;
  }

  const priced = computePrice(plan, billing);
  const originalPrice = priced.original || priced.finalPrice;
  let selectedCoupon = null; // null = no coupon applied
  let availableCoupons = getRewardsSnapshot().activeCoupons;
  let submitting = false;

  function currentDiscount() {
    if (!selectedCoupon) return { percent: 0, amount: 0 };
    const percent = selectedCoupon.discountPercent;
    const amount = Math.round((originalPrice * percent) / 100);
    return { percent, amount };
  }

  function currentFinalPrice() {
    return Math.max(0, originalPrice - currentDiscount().amount);
  }

  function renderCouponOptions() {
    if (!availableCoupons.length) {
      return '<p class="hint">No active coupons — visit the Rewards Store to redeem Melody Points for one.</p>';
    }
    return `
      <label class="pay-coupon-option">
        <input type="radio" name="pay-coupon" value="" checked />
        <span>No coupon</span>
      </label>
      ${availableCoupons.map((c) => `
        <label class="pay-coupon-option">
          <input type="radio" name="pay-coupon" value="${escapeHtml(c.code)}" />
          <span>
            <strong>${c.discountPercent}% off</strong> — <code>${escapeHtml(c.code)}</code>
            <span class="hint"> · ${formatCouponExpiry(c.expiresAt)}</span>
          </span>
        </label>
      `).join('')}
    `;
  }

  function renderSummary() {
    const { percent, amount } = currentDiscount();
    const final = currentFinalPrice();
    return `
      <div class="pay-summary-row"><span>Premium Plan</span><span>${plan.icon} ${escapeHtml(plan.name)} (${billing === 'yearly' ? 'Yearly' : 'Monthly'})</span></div>
      <div class="pay-summary-row"><span>Original Price</span><span>${formatMoney(originalPrice)}</span></div>
      <div class="pay-summary-row"><span>Applied Coupon</span><span>${selectedCoupon ? escapeHtml(selectedCoupon.code) : 'None'}</span></div>
      <div class="pay-summary-row"><span>Discount</span><span>${percent ? `${percent}% (-${formatMoney(amount)})` : `${formatMoney(0)}`}</span></div>
      <div class="pay-summary-row pay-summary-final"><span>Final Price</span><span>${formatMoney(final)}</span></div>
    `;
  }

  const provider = PAYMENT_PROVIDERS.esewa;

  function renderProviderPicker() {
    return `
      <div class="pay-provider-list">
        ${Object.values(PAYMENT_PROVIDERS).map((p) => `
          <button type="button" class="pay-provider-chip ${p.id === 'esewa' ? 'active' : ''}" data-provider="${p.id}" ${p.comingSoon ? 'data-coming-soon="1"' : ''}>
            ${escapeHtml(p.label)}${p.comingSoon ? ' <span class="hint">(soon)</span>' : ''}
          </button>
        `).join('')}
      </div>
    `;
  }

  function renderCheckoutForm() {
    return `
      <a href="#" class="premium-back" id="pay-back">&larr; Back</a>
      <header class="pay-header">
        <h1>Checkout</h1>
        <p>Complete your ${escapeHtml(plan.name)} purchase.</p>
      </header>

      <section class="pay-card">
        <h2>Payment Method</h2>
        ${renderProviderPicker()}
      </section>

      <section class="pay-card">
        <h2>Apply a Coupon</h2>
        <div class="pay-coupon-list" id="pay-coupon-list">${renderCouponOptions()}</div>
      </section>

      <section class="pay-card" id="pay-summary-card">
        <h2>Order Summary</h2>
        <div id="pay-summary">${renderSummary()}</div>
      </section>

      <section class="pay-card">
        <h2>Pay with ${escapeHtml(provider.label)}</h2>
        <div class="pay-qr-wrap">
          <img src="${provider.qrAssetPath}" alt="eSewa QR code" class="pay-qr-img"
               onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'pay-qr-placeholder',textContent:'Add your official eSewa QR image at ${provider.qrAssetPath}'}))" />
        </div>
        <div class="pay-receiver-details">
          <div class="pay-summary-row"><span>Receiver Name</span><span>${escapeHtml(provider.receiverName)}</span></div>
          <div class="pay-summary-row"><span>Receiver Number</span><span>${escapeHtml(provider.receiverNumber)}</span></div>
          <div class="pay-summary-row"><span>Payment Method</span><span>${escapeHtml(provider.label)}</span></div>
          <div class="pay-summary-row"><span>Melody Transaction ID</span><span id="pay-melody-txn-preview">Generated on submit</span></div>
          <div class="pay-summary-row"><span>Current Status</span><span class="pay-status-pill pay-status-pending">Not submitted</span></div>
        </div>
        <p class="hint">Open your eSewa app, send ${formatMoney(currentFinalPrice())} to the number above, then enter the eSewa transaction/reference ID it gives you.</p>
        <label class="pay-input-label" for="pay-reference-input">${escapeHtml(provider.referenceLabel)}</label>
        <input type="text" id="pay-reference-input" class="pay-input" placeholder="e.g. 0A1B2C3D4E" autocomplete="off" />
        <button type="button" id="pay-submit-btn" class="btn-primary pay-submit-btn">I've Paid — Submit for Verification</button>
        <p class="hint pay-eta-note">⏳ Verification is manual and can take up to 24 hours. Your Premium will activate automatically the moment it's approved — no need to reopen the app.</p>
      </section>
    `;
  }

  function renderPendingState(txn) {
    return `
      <a href="#" class="premium-back" id="pay-back">&larr; Back</a>
      <div class="pay-status-hero pay-status-hero-pending">
        <div class="pay-status-spinner" aria-hidden="true"></div>
        <h2>Payment Submitted</h2>
        <p>We're verifying your ${escapeHtml(txn.plan)} payment (${formatMoney(txn.finalAmount)}).</p>
        <p class="hint">⏳ Verification is manual and can take up to 24 hours. This page will update automatically the moment it's reviewed — you don't need to keep it open.</p>
        <div class="pay-summary-row"><span>Melody Transaction ID</span><span>${escapeHtml(txn.melodyTransactionId)}</span></div>
        <button type="button" class="btn-secondary" id="pay-view-history">View Purchase History</button>
      </div>
    `;
  }

  function renderVerifiedState(txn) {
    return `
      <div class="pay-status-hero pay-status-hero-success">
        <div class="pay-status-icon">✅</div>
        <h2>Payment Verified!</h2>
        <p>${escapeHtml(txn.plan)} is now active on your account.</p>
        <button type="button" class="btn-primary" id="pay-done-btn">Back to Premium</button>
      </div>
    `;
  }

  function renderRejectedState(txn) {
    return `
      <div class="pay-status-hero pay-status-hero-error">
        <div class="pay-status-icon">❌</div>
        <h2>Payment Failed</h2>
        <p>Your Premium subscription has <strong>not</strong> been activated.</p>
        <p>No coupon has been consumed.</p>
        ${txn.rejectionReason ? `<p class="hint">Reason: ${escapeHtml(txn.rejectionReason)}</p>` : ''}
        <p>Please try again.</p>
        <button type="button" class="btn-primary" id="pay-retry-btn">Try Again</button>
      </div>
    `;
  }

  let unsubscribeTxn = null;

  function watchTransaction(txnId) {
    if (unsubscribeTxn) unsubscribeTxn();
    unsubscribeTxn = subscribeTransaction(authUser.uid, txnId, (txn) => {
      if (!txn) return;
      if (txn.status === 'pending') el.innerHTML = renderPendingState(txn);
      else if (txn.status === 'verified') el.innerHTML = renderVerifiedState(txn);
      else if (txn.status === 'rejected') el.innerHTML = renderRejectedState(txn);
      bindResultButtons();
    });
  }

  function bindResultButtons() {
    el.querySelector('#pay-back')?.addEventListener('click', (e) => { e.preventDefault(); navigate('premium'); });
    el.querySelector('#pay-view-history')?.addEventListener('click', () => navigate('purchase-history'));
    el.querySelector('#pay-done-btn')?.addEventListener('click', () => navigate('premium'));
    el.querySelector('#pay-retry-btn')?.addEventListener('click', () => navigate('payment', { planKey, billing }));
  }

  function paintForm() {
    el.innerHTML = renderCheckoutForm();

    el.querySelector('#pay-back').addEventListener('click', (e) => { e.preventDefault(); navigate('premium'); });

    el.querySelectorAll('.pay-provider-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        if (chip.dataset.comingSoon) openComingSoonModal(el);
        // Only eSewa is implemented today — clicking it again is a no-op.
      });
    });

    el.querySelector('#pay-coupon-list').addEventListener('change', (e) => {
      const code = e.target.value;
      selectedCoupon = availableCoupons.find((c) => c.code === code) || null;
      el.querySelector('#pay-summary').innerHTML = renderSummary();
    });

    el.querySelector('#pay-submit-btn').addEventListener('click', async () => {
      if (submitting) return;
      const referenceInput = el.querySelector('#pay-reference-input');
      const referenceId = referenceInput.value.trim();
      if (!referenceId) {
        showToast('Enter the eSewa transaction/reference ID you received after paying.');
        referenceInput.focus();
        return;
      }

      submitting = true;
      const btn = el.querySelector('#pay-submit-btn');
      btn.disabled = true;
      btn.textContent = 'Submitting…';

      try {
        const { txnId } = await submitPendingPayment({
          uid: authUser.uid,
          planKey: plan.key,
          planName: plan.name,
          billing,
          originalPrice,
          coupon: selectedCoupon,
          finalAmount: currentFinalPrice(),
          providerId: provider.id,
          providerReferenceId: referenceId,
        });
        watchTransaction(txnId);
      } catch (err) {
        console.error('[Melody] Payment submission failed.', err);
        showToast(`Couldn't submit your payment: ${err?.message || 'unknown error'}`);
        submitting = false;
        btn.disabled = false;
        btn.textContent = "I've Paid — Submit for Verification";
      }
    });
  }

  paintForm();

  const unsubscribeRewards = subscribeRewards((snap) => {
    availableCoupons = snap.activeCoupons;
    const list = el.querySelector('#pay-coupon-list');
    if (list) list.innerHTML = renderCouponOptions();
  });

  el._onLeave = () => {
    unsubscribeRewards();
    if (unsubscribeTxn) unsubscribeTxn();
  };

  return el;
}
