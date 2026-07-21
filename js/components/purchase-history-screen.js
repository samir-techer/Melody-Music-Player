/**
 * purchase-history-screen.js
 * Every Premium purchase attempt for the signed-in account, newest
 * first — pending, verified, and rejected all shown (rejected ones make
 * it clear no coupon was consumed and nothing was charged/activated).
 */

import { getCurrentUser } from '../services/auth-service.js';
import { subscribeUserTransactions } from '../services/payment-service.js';
import { CURRENCY } from './premium-screen.js';
import { attachShell } from './shell.js';
import { navigate } from '../utils/router.js';

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatMoney(n) {
  return `${CURRENCY} ${Math.round(n || 0).toLocaleString('en-IN')}`;
}

function formatDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABEL = {
  pending: { text: 'Pending Verification', cls: 'pay-status-pending' },
  verified: { text: 'Verified', cls: 'pay-status-success' },
  rejected: { text: 'Failed', cls: 'pay-status-error' },
};

function renderTransactionRow(txn) {
  const status = STATUS_LABEL[txn.status] || STATUS_LABEL.pending;
  return `
    <div class="history-card">
      <div class="history-card-top">
        <span class="history-plan">${escapeHtml(txn.plan)} · ${txn.billing === 'yearly' ? 'Yearly' : 'Monthly'}</span>
        <span class="pay-status-pill ${status.cls}">${status.text}</span>
      </div>
      <div class="pay-summary-row"><span>Original Price</span><span>${formatMoney(txn.originalPrice)}</span></div>
      <div class="pay-summary-row"><span>Coupon Used</span><span>${txn.couponCode ? escapeHtml(txn.couponCode) : 'None'}</span></div>
      <div class="pay-summary-row"><span>Discount</span><span>${txn.discountPercent ? `${txn.discountPercent}% (-${formatMoney(txn.discountAmount)})` : formatMoney(0)}</span></div>
      <div class="pay-summary-row"><span>Final Price</span><span>${formatMoney(txn.finalAmount)}</span></div>
      <div class="pay-summary-row"><span>Payment Method</span><span>${escapeHtml(txn.providerId || 'eSewa')}</span></div>
      <div class="pay-summary-row"><span>Purchase Date</span><span>${formatDate(txn.createdAt)}</span></div>
      <div class="pay-summary-row"><span>Transaction ID</span><span class="history-txn-id">${escapeHtml(txn.melodyTransactionId || txn.id)}</span></div>
      ${txn.status === 'rejected' && txn.rejectionReason ? `<p class="hint">Reason: ${escapeHtml(txn.rejectionReason)}</p>` : ''}
    </div>
  `;
}

export async function renderPurchaseHistoryScreen() {
  const el = document.createElement('div');
  el.className = 'screen payment-screen has-shell';

  const content = document.createElement('div');
  content.className = 'screen-content';
  el.appendChild(content);

  const authUser = getCurrentUser();

  content.innerHTML = `
    <header class="screen-header">
      <button class="back-link" id="history-back">‹ Back</button>
      <h1>🧾 Purchase History</h1>
    </header>
    <div id="history-list"><p class="hint">Loading…</p></div>
  `;
  content.querySelector('#history-back').addEventListener('click', () => navigate('premium'));

  let unsubscribe = () => {};
  if (authUser) {
    unsubscribe = subscribeUserTransactions(authUser.uid, (transactions) => {
      const list = content.querySelector('#history-list');
      if (!transactions.length) {
        list.innerHTML = '<p class="hint">No purchases yet — your transactions will show up here.</p>';
        return;
      }
      list.innerHTML = transactions.map(renderTransactionRow).join('');
    });
  }

  const unsubscribeShell = attachShell(el, 'settings');
  el._onLeave = () => { unsubscribeShell(); unsubscribe(); };

  return el;
}
