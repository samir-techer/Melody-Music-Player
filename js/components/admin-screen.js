/**
 * admin-screen.js
 * The Admin Dashboard. Only ever rendered after router.js's per-route
 * guard (see app.js's registerRoute('admin', ...)) has already verified,
 * live against Firestore, that the signed-in account's role is exactly
 * "admin" — this file itself does not re-implement that check, so no
 * admin data is fetched at all for anyone who fails it.
 *
 * All actual Firestore access lives in admin-service.js; this file is
 * just the UI wired to it.
 */

import { attachShell } from './shell.js';
import { getCurrentUser } from '../services/auth-service.js';
import {
  listUsers, getUser, setUserPremium, setUserRole, resetNicknameChanges,
  setAccountDisabled, deleteUserRecord, getOverviewStats, getCloudBackupUsageSample,
  getAdConfig, setAdConfig, listAdminLogs,
} from '../services/admin-service.js';
import { subscribePendingTransactions, approveTransaction, rejectTransaction } from '../services/payment-service.js';
import { getAdFiles, reloadAdManifest, previewAdClip } from '../services/ad-manager.js';
import { showToast } from '../utils/toast.js';
import { showConfirmDialog } from '../utils/confirm-dialog.js';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'users', label: 'Users' },
  { key: 'payments', label: 'Payments' },
  { key: 'ads', label: 'Advertisements' },
  { key: 'logs', label: 'Logs' },
];

export async function renderAdminScreen() {
  const el = document.createElement('div');
  el.className = 'screen admin-screen has-shell';
  el.innerHTML = `
    <header class="screen-header admin-header">
      <h1>⚙️ Admin Dashboard</h1>
      <p class="admin-subtitle">Internal tool — visible only to role: admin.</p>
    </header>

    <div class="admin-tabs" role="tablist">
      ${TABS.map((t, i) => `<button class="admin-tab ${i === 0 ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>

    <div class="admin-tab-content" id="admin-tab-content">
      <div class="admin-loading-skeleton"><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div></div>
    </div>
  `;

  const contentEl = el.querySelector('#admin-tab-content');
  const actor = getCurrentUser();
  let activeTab = 'overview';

  // Users tab state
  let userState = { pageSize: 20, cursorDoc: null, sortBy: 'newest', roleFilter: '', planFilter: '', searchQuery: '', users: [], hasMore: false };

  // Payments tab: a LIVE collectionGroup listener (not a one-shot fetch
  // like every other tab here) — new pending payments should appear
  // without switching tabs away and back. Torn down in renderTab()
  // whenever we navigate to a different tab, and again on unmount.
  let unsubscribePaymentsListener = null;

  async function renderTab() {
    if (activeTab !== 'payments' && unsubscribePaymentsListener) {
      unsubscribePaymentsListener();
      unsubscribePaymentsListener = null;
    }
    contentEl.innerHTML = `<div class="admin-loading-skeleton"><div class="skeleton-card"></div><div class="skeleton-card"></div></div>`;
    try {
      if (activeTab === 'overview') await renderOverviewTab();
      else if (activeTab === 'users') await renderUsersTab({ resetPaging: true });
      else if (activeTab === 'payments') await renderPaymentsTab();
      else if (activeTab === 'ads') await renderAdsTab();
      else if (activeTab === 'logs') await renderLogsTab();
    } catch (err) {
      console.error(`[Melody] Admin: failed to load "${activeTab}" tab.`, err);
      contentEl.innerHTML = `<div class="admin-error">Couldn't load this section — ${escapeHtml(err.message || 'unknown error')}. Check your connection and try again.</div>`;
    }
  }

  /* ================================================================ */
  /*  Overview                                                          */
  /* ================================================================ */
  async function renderOverviewTab() {
    const stats = await getOverviewStats();
    const files = getAdFiles();

    contentEl.innerHTML = `
      <div class="admin-cards-grid">
        ${adminCard('👥', 'Total Users', stats.totalUsers)}
        ${adminCard('💎', 'Premium Users', stats.premiumUsers)}
        ${adminCard('📢', 'Active Ads', `${stats.adsEnabled ? 'On' : 'Off'} · every ${stats.songsBetweenAds}`)}
        ${adminCard('🗂️', 'Ad Files Loaded', files.length)}
        ${adminCard('⭐', 'Admin Accounts', stats.adminAccounts)}
        ${adminCard('☁️', 'Cloud Backup Users', stats.cloudBackupUsers)}
        ${adminCard('⚙️', 'App Status', 'Operational')}
        ${adminCard('📊', 'Active Sessions', 'Not tracked', true)}
      </div>

      <div class="section-heading" style="margin-top: var(--space-5);"><h3>Plan Breakdown</h3></div>
      <div class="admin-cards-grid">
        ${adminCard('🆓', 'Free', stats.freeUsers)}
        ${adminCard('📀', 'Basic', stats.basicUsers)}
        ${adminCard('⭐', 'Plus', stats.plusUsers)}
        ${adminCard('💎', 'Elite', stats.eliteUsers)}
      </div>

      <div class="section-heading" style="margin-top: var(--space-5);"><h3>Cloud-Backup-Derived Usage</h3></div>
      <p class="admin-hint">Melody stores Favorites/Playlists/your Library on-device, not in Firestore, unless Cloud Backup is on — so these numbers only reflect the accounts that opted in, not every user.</p>
      <div class="admin-cards-grid" id="admin-cloud-sample-grid">
        <div class="admin-card skeleton-card"></div>
      </div>
    `;

    // Loaded separately (it reads actual documents, not just counts) so
    // the fast stats above render immediately.
    getCloudBackupUsageSample().then((sample) => {
      const grid = contentEl.querySelector('#admin-cloud-sample-grid');
      if (!grid) return;
      const topTheme = Object.entries(sample.themeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'default';
      grid.innerHTML = `
        ${adminCard('🎵', 'Playlists (sampled)', sample.playlists)}
        ${adminCard('❤️', 'Favorites (sampled)', sample.favorites)}
        ${adminCard('🎨', 'Most Used Theme', topTheme === 'default' ? 'Default' : topTheme)}
        ${adminCard('📦', `Sampled Accounts${sample.truncated ? ' (capped)' : ''}`, sample.sampledAccounts)}
      `;
    }).catch((err) => {
      console.error('[Melody] Admin: cloud backup usage sample failed.', err);
      const grid = contentEl.querySelector('#admin-cloud-sample-grid');
      if (grid) grid.innerHTML = `<div class="admin-error">Couldn't load usage sample.</div>`;
    });
  }

  function adminCard(icon, label, value, muted = false) {
    return `
      <div class="admin-card ${muted ? 'muted' : ''}">
        <div class="admin-card-icon">${icon}</div>
        <div class="admin-card-value">${escapeHtml(String(value))}</div>
        <div class="admin-card-label">${escapeHtml(label)}</div>
      </div>`;
  }

  /* ================================================================ */
  /*  Users                                                             */
  /* ================================================================ */
  async function renderUsersTab({ resetPaging = false } = {}) {
    if (resetPaging) { userState.cursorDoc = null; userState.users = []; }

    const result = await listUsers({
      pageSize: userState.pageSize,
      cursorDoc: userState.cursorDoc,
      sortBy: userState.sortBy,
      roleFilter: userState.roleFilter || null,
      planFilter: userState.planFilter || null,
      searchQuery: userState.searchQuery || null,
    });
    userState.users = resetPaging ? result.users : [...userState.users, ...result.users];
    userState.cursorDoc = result.lastDoc;
    userState.hasMore = result.hasMore;

    contentEl.innerHTML = `
      <div class="admin-users-toolbar">
        <input type="search" id="admin-user-search" placeholder="Search by username or email…" value="${escapeHtml(userState.searchQuery)}" />
        <select id="admin-role-filter">
          <option value="">All roles</option>
          <option value="User" ${userState.roleFilter === 'User' ? 'selected' : ''}>User</option>
          <option value="admin" ${userState.roleFilter === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
        <select id="admin-plan-filter">
          <option value="">All plans</option>
          ${['Free', 'Basic', 'Plus', 'Elite'].map((p) => `<option value="${p}" ${userState.planFilter === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
        <select id="admin-sort">
          <option value="newest" ${userState.sortBy === 'newest' ? 'selected' : ''}>Newest</option>
          <option value="oldest" ${userState.sortBy === 'oldest' ? 'selected' : ''}>Oldest</option>
          <option value="premiumExpiry" ${userState.sortBy === 'premiumExpiry' ? 'selected' : ''}>Premium Expiry</option>
          <option value="username" ${userState.sortBy === 'username' ? 'selected' : ''}>Username</option>
        </select>
      </div>

      <div class="admin-user-list" id="admin-user-list">
        ${userState.users.length ? userState.users.map(renderUserRow).join('') : `<div class="admin-empty">No users match these filters.</div>`}
      </div>

      ${userState.hasMore && !userState.searchQuery ? `<button class="btn-secondary" id="admin-load-more">Load more</button>` : ''}
    `;

    contentEl.querySelector('#admin-user-search').addEventListener('input', debounce((e) => {
      userState.searchQuery = e.target.value;
      renderUsersTab({ resetPaging: true });
    }, 400));
    contentEl.querySelector('#admin-role-filter').addEventListener('change', (e) => {
      userState.roleFilter = e.target.value;
      renderUsersTab({ resetPaging: true });
    });
    contentEl.querySelector('#admin-plan-filter').addEventListener('change', (e) => {
      userState.planFilter = e.target.value;
      renderUsersTab({ resetPaging: true });
    });
    contentEl.querySelector('#admin-sort').addEventListener('change', (e) => {
      userState.sortBy = e.target.value;
      renderUsersTab({ resetPaging: true });
    });
    contentEl.querySelector('#admin-load-more')?.addEventListener('click', () => renderUsersTab({ resetPaging: false }));

    contentEl.querySelectorAll('.admin-user-row').forEach((row) => {
      row.querySelector('.admin-user-manage-btn').addEventListener('click', () => openUserPanel(row.dataset.uid));
    });
  }

  function renderUserRow(user) {
    const joined = formatFirestoreDate(user.accountCreated);
    const expiry = formatFirestoreDate(user.premiumExpiry) || '—';
    const initial = (user.nickname || user.email || '?').trim().charAt(0).toUpperCase();
    const avatarHtml = user.profilePhoto
      ? `<img class="admin-user-avatar" src="${escapeAttr(user.profilePhoto)}" alt="" />`
      : `<div class="admin-user-avatar admin-user-avatar-fallback">${escapeHtml(initial)}</div>`;
    return `
      <div class="admin-user-row" data-uid="${user.uid}">
        ${avatarHtml}
        <div class="admin-user-info">
          <div class="admin-user-name">
            ${escapeHtml(user.nickname || '(no nickname)')}
            ${user.role === 'admin' ? '<span class="premium-badge">⭐ admin</span>' : ''}
            ${user.accountDisabled ? '<span class="admin-disabled-tag">Disabled</span>' : ''}
          </div>
          <div class="admin-user-meta">${escapeHtml(user.email || '—')} · ${escapeHtml(user.premiumPlan || 'Free')}${user.premiumPlan !== 'Free' ? ` (exp. ${expiry})` : ''} · ${escapeHtml(user.provider || '—')} · joined ${joined || '—'}</div>
        </div>
        <button class="btn-secondary admin-user-manage-btn" type="button" style="width:auto;">Manage</button>
      </div>`;
  }

  async function openUserPanel(uid) {
    const user = await getUser(uid);
    if (!user) { showToast('Could not load that user — they may have just been deleted.'); return; }

    const overlay = document.createElement('div');
    overlay.className = 'admin-panel-overlay';
    overlay.innerHTML = `
      <div class="admin-panel" role="dialog" aria-modal="true">
        <div class="admin-panel-header">
          <h2>${escapeHtml(user.nickname || user.email || uid)}</h2>
          <button type="button" class="admin-panel-close" aria-label="Close">✕</button>
        </div>

        <div class="admin-panel-section">
          <h3>Profile</h3>
          <dl class="admin-kv">
            <dt>Email</dt><dd>${escapeHtml(user.email || '—')}</dd>
            <dt>Role</dt><dd>${escapeHtml(user.role || '—')}</dd>
            <dt>Provider</dt><dd>${escapeHtml(user.provider || '—')}</dd>
            <dt>Joined</dt><dd>${formatFirestoreDate(user.accountCreated) || '—'}</dd>
            <dt>Last Login</dt><dd>${formatFirestoreDate(user.lastLogin) || '—'}</dd>
            <dt>UID</dt><dd class="admin-mono">${escapeHtml(uid)}</dd>
          </dl>
          <button type="button" class="btn-secondary" id="admin-view-doc" style="width:auto;">View Firestore Document (raw)</button>
          <pre class="admin-raw-doc" id="admin-raw-doc" hidden>${escapeHtml(JSON.stringify(user, jsonReplacer, 2))}</pre>
        </div>

        <div class="admin-panel-section">
          <h3>Premium Manager</h3>
          <div class="admin-inline-form">
            <select id="admin-plan-select">
              ${['Free', 'Basic', 'Plus', 'Elite'].map((p) => `<option value="${p}" ${user.premiumPlan === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>
            <select id="admin-expiry-select">
              <option value="monthly">+1 Month</option>
              <option value="yearly">+1 Year</option>
              <option value="custom">Custom date…</option>
              <option value="none">No expiry</option>
            </select>
            <input type="date" id="admin-custom-expiry" hidden />
            <button type="button" class="btn-secondary" id="admin-apply-plan" style="width:auto;">Apply</button>
          </div>
          <p class="admin-hint">Current: ${escapeHtml(user.premiumPlan || 'Free')}${user.premiumExpiry ? ` · expires ${formatFirestoreDate(user.premiumExpiry)}` : ''}</p>
        </div>

        <div class="admin-panel-section">
          <h3>Role Manager</h3>
          <div class="admin-inline-form">
            <select id="admin-role-select">
              <option value="User" ${user.role !== 'admin' ? 'selected' : ''}>User</option>
              <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>
            <button type="button" class="btn-secondary" id="admin-apply-role" style="width:auto;">Apply</button>
          </div>
        </div>

        <div class="admin-panel-section admin-panel-actions">
          <h3>Other Actions</h3>
          <button type="button" class="btn-secondary" id="admin-reset-nickname" style="width:auto;">Reset Nickname Changes</button>
          <button type="button" class="btn-secondary" id="admin-toggle-disable" style="width:auto;">${user.accountDisabled ? 'Enable Account' : 'Disable Account'}</button>
          <button type="button" class="btn-secondary danger" id="admin-delete-user" style="width:auto;">Delete User</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));

    function close() {
      overlay.classList.remove('open');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      setTimeout(() => overlay.remove(), 400); // fallback in case transitionend never fires — see upgrade-dialog.js for why this matters
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.admin-panel-close').addEventListener('click', close);

    overlay.querySelector('#admin-view-doc').addEventListener('click', () => {
      const pre = overlay.querySelector('#admin-raw-doc');
      pre.hidden = !pre.hidden;
    });

    overlay.querySelector('#admin-expiry-select').addEventListener('change', (e) => {
      overlay.querySelector('#admin-custom-expiry').hidden = e.target.value !== 'custom';
    });

    overlay.querySelector('#admin-apply-plan').addEventListener('click', async () => {
      const plan = overlay.querySelector('#admin-plan-select').value;
      const expiryChoice = overlay.querySelector('#admin-expiry-select').value;
      let expiry = null;
      if (expiryChoice === 'custom') {
        const raw = overlay.querySelector('#admin-custom-expiry').value;
        if (!raw) { showToast('Pick a custom expiry date first.'); return; }
        expiry = new Date(raw);
      } else if (expiryChoice !== 'none') {
        expiry = expiryChoice; // 'monthly' | 'yearly' — resolved server-side in admin-service
      }
      try {
        await setUserPremium(uid, { plan, expiry }, actor);
        showToast(`Premium plan updated to ${plan}.`);
        close();
        renderUsersTab({ resetPaging: true });
      } catch (err) {
        console.error('[Melody] Admin: setUserPremium failed.', err);
        showToast('Could not update premium plan — please try again.');
      }
    });

    overlay.querySelector('#admin-apply-role').addEventListener('click', async () => {
      const role = overlay.querySelector('#admin-role-select').value;
      if (!window.confirm(`Change this user's role to "${role}"? This affects what they can access.`)) return;
      try {
        await setUserRole(uid, role, actor);
        showToast(`Role updated to ${role}.`);
        close();
        renderUsersTab({ resetPaging: true });
      } catch (err) {
        console.error('[Melody] Admin: setUserRole failed.', err);
        showToast('Could not update role — please try again.');
      }
    });

    overlay.querySelector('#admin-reset-nickname').addEventListener('click', async () => {
      try {
        await resetNicknameChanges(uid, actor);
        showToast('Nickname change count reset.');
      } catch (err) {
        console.error('[Melody] Admin: resetNicknameChanges failed.', err);
        showToast('Could not reset nickname changes — please try again.');
      }
    });

    overlay.querySelector('#admin-toggle-disable').addEventListener('click', async () => {
      const nextDisabled = !user.accountDisabled;
      if (!window.confirm(nextDisabled ? 'Disable this account? They will be signed out and locked out until re-enabled.' : 'Re-enable this account?')) return;
      try {
        await setAccountDisabled(uid, nextDisabled, actor);
        showToast(nextDisabled ? 'Account disabled.' : 'Account re-enabled.');
        close();
        renderUsersTab({ resetPaging: true });
      } catch (err) {
        console.error('[Melody] Admin: setAccountDisabled failed.', err);
        showToast('Could not update account status — please try again.');
      }
    });

    overlay.querySelector('#admin-delete-user').addEventListener('click', async () => {
      if (!window.confirm(`Delete ${user.email || uid}'s profile? This cannot be undone. (Note: this removes their Firestore data only — their sign-in account itself would need a server-side deletion.)`)) return;
      try {
        await deleteUserRecord(uid, actor);
        showToast('User profile deleted.');
        close();
        renderUsersTab({ resetPaging: true });
      } catch (err) {
        console.error('[Melody] Admin: deleteUserRecord failed.', err);
        showToast('Could not delete user — please try again.');
      }
    });
  }

  /* ================================================================ */
  /*  Advertisements                                                     */
  /* ================================================================ */
  async function renderAdsTab() {
    const [config, files] = await Promise.all([getAdConfig(), Promise.resolve(getAdFiles())]);

    contentEl.innerHTML = `
      <div class="admin-cards-grid">
        ${adminCard('🗂️', 'Ad Files Loaded', files.length)}
        ${adminCard('📢', 'Status', config.adsEnabled !== false ? 'Enabled' : 'Disabled')}
        ${adminCard('🔁', 'Frequency', `Every ${config.songsBetweenAds || 6} songs`)}
      </div>

      <div class="admin-panel-section">
        <h3>Controls</h3>
        <div class="settings-row-toggle">
          <div class="settings-row-label"><span>Ads Enabled (global)</span></div>
          <label class="toggle-switch">
            <input type="checkbox" id="admin-ads-enabled" ${config.adsEnabled !== false ? 'checked' : ''} />
            <span class="toggle-track"><span class="toggle-thumb-switch"></span></span>
          </label>
        </div>
        <div class="admin-inline-form">
          <label for="admin-ads-frequency">Songs between ads</label>
          <input type="number" id="admin-ads-frequency" min="1" max="50" value="${config.songsBetweenAds || 6}" style="width:80px;" />
          <button type="button" class="btn-secondary" id="admin-save-ad-config" style="width:auto;">Save</button>
        </div>
        <button type="button" class="btn-secondary" id="admin-reload-manifest" style="width:auto;">Reload Advertisement Folder</button>
      </div>

      <div class="admin-panel-section">
        <h3>Advertisement Files</h3>
        ${files.length === 0 ? '<p class="admin-hint">No ad files found — ads are safely skipped for everyone until manifest.json lists at least one.</p>' : ''}
        <div class="admin-ad-file-list">
          ${files.map((url) => `
            <div class="admin-ad-file-row">
              <span class="admin-mono">${escapeHtml(url.split('/').pop())}</span>
              <button type="button" class="btn-secondary admin-ad-preview-btn" data-url="${escapeAttr(url)}" style="width:auto;">Preview</button>
            </div>`).join('')}
        </div>
      </div>
    `;

    contentEl.querySelector('#admin-save-ad-config').addEventListener('click', async () => {
      const adsEnabled = contentEl.querySelector('#admin-ads-enabled').checked;
      const songsBetweenAds = Number(contentEl.querySelector('#admin-ads-frequency').value) || 6;
      try {
        await setAdConfig({ adsEnabled, songsBetweenAds }, actor);
        showToast('Ad settings saved.');
      } catch (err) {
        console.error('[Melody] Admin: setAdConfig failed.', err);
        showToast('Could not save ad settings — please try again.');
      }
    });

    contentEl.querySelector('#admin-reload-manifest').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Reloading…';
      try {
        await reloadAdManifest();
        showToast(`Reloaded — ${getAdFiles().length} file(s) found.`);
        renderAdsTab();
      } catch (err) {
        console.error('[Melody] Admin: reloadAdManifest failed.', err);
        showToast('Could not reload the ad folder.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Reload Advertisement Folder';
      }
    });

    let currentPreview = null;
    contentEl.querySelectorAll('.admin-ad-preview-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (currentPreview) { currentPreview.pause(); currentPreview = null; }
        currentPreview = previewAdClip(btn.dataset.url);
        showToast('Playing preview…');
      });
    });
  }

  /* ================================================================ */
  /*  Payments — pending eSewa verification queue                      */
  /* ================================================================ */
  async function renderPaymentsTab() {
    contentEl.innerHTML = `<div class="admin-payments-list" id="admin-payments-list"><p class="hint">Loading pending payments…</p></div>`;
    const listEl = contentEl.querySelector('#admin-payments-list');

    if (unsubscribePaymentsListener) unsubscribePaymentsListener();
    unsubscribePaymentsListener = subscribePendingTransactions((pending) => {
      if (!pending.length) {
        listEl.innerHTML = '<div class="admin-empty">No pending payments — all caught up.</div>';
        return;
      }
      listEl.innerHTML = pending.map(renderPaymentRow).join('');
      bindPaymentRowEvents(listEl, pending);
    });
  }

  function renderPaymentRow(txn) {
    const submitted = txn.createdAt ? new Date(txn.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
    return `
      <div class="admin-payment-card" data-txn-path="${escapeAttr(txn.path)}">
        <div class="admin-payment-top">
          <span><strong>${escapeHtml(txn.plan)}</strong> (${txn.billing === 'yearly' ? 'Yearly' : 'Monthly'}) — रु${txn.finalAmount}</span>
          <span class="hint">Submitted ${submitted}</span>
        </div>
        <div class="admin-payment-detail">User: ${escapeHtml(txn.uid)}</div>
        <div class="admin-payment-detail">eSewa reference: <strong>${escapeHtml(txn.providerReferenceId)}</strong></div>
        <div class="admin-payment-detail">Melody Transaction ID: ${escapeHtml(txn.melodyTransactionId || txn.id)}</div>
        ${txn.couponCode ? `<div class="admin-payment-detail">Coupon: ${escapeHtml(txn.couponCode)} (${txn.discountPercent}% off, रु${txn.discountAmount})</div>` : ''}
        <div class="admin-payment-actions">
          <button type="button" class="btn-secondary admin-payment-approve">✅ Approve</button>
          <button type="button" class="btn-secondary admin-payment-reject">❌ Reject</button>
        </div>
      </div>
    `;
  }

  function bindPaymentRowEvents(listEl, pending) {
    listEl.querySelectorAll('.admin-payment-card').forEach((card) => {
      const txn = pending.find((t) => t.path === card.dataset.txnPath);
      if (!txn) return;

      card.querySelector('.admin-payment-approve').addEventListener('click', async () => {
        const ok = await showConfirmDialog({
          title: 'Approve this payment?',
          message: `This immediately activates ${txn.plan} on the user's account and marks their coupon (if any) as used.`,
          confirmLabel: 'Approve',
        });
        if (!ok) return;
        try {
          await approveTransaction(txn, actor);
          showToast('Payment approved — Premium is now active for this user.');
        } catch (err) {
          console.error('[Melody] Admin: approve payment failed.', err);
          showToast(`Couldn't approve: ${err?.message || 'unknown error'}`);
        }
      });

      card.querySelector('.admin-payment-reject').addEventListener('click', async () => {
        const ok = await showConfirmDialog({
          title: 'Reject this payment?',
          message: 'The user\u2019s coupon (if any) stays active and untouched. Nothing is activated.',
          confirmLabel: 'Reject',
        });
        if (!ok) return;
        try {
          await rejectTransaction(txn, null, actor);
          showToast('Payment rejected.');
        } catch (err) {
          console.error('[Melody] Admin: reject payment failed.', err);
          showToast(`Couldn't reject: ${err?.message || 'unknown error'}`);
        }
      });
    });
  }

  /* ================================================================ */
  /*  Logs                                                              */
  /* ================================================================ */
  let logsCursor = null;
  async function renderLogsTab() {
    logsCursor = null;
    const { logs, lastDoc, hasMore } = await listAdminLogs({ cursorDoc: null });
    logsCursor = lastDoc;
    contentEl.innerHTML = `
      <div class="admin-log-list" id="admin-log-list">${logs.map(renderLogRow).join('') || '<div class="admin-empty">No admin actions logged yet.</div>'}</div>
      ${hasMore ? '<button class="btn-secondary" id="admin-logs-more">Load more</button>' : ''}
    `;
    contentEl.querySelector('#admin-logs-more')?.addEventListener('click', async (e) => {
      const more = await listAdminLogs({ cursorDoc: logsCursor });
      logsCursor = more.lastDoc;
      const list = contentEl.querySelector('#admin-log-list');
      list.insertAdjacentHTML('beforeend', more.logs.map(renderLogRow).join(''));
      if (!more.hasMore) e.currentTarget.remove();
    });
  }

  function renderLogRow(log) {
    return `
      <div class="admin-log-row">
        <div class="admin-log-action">${escapeHtml(log.action || '—')}</div>
        <div class="admin-log-meta">${escapeHtml(log.adminEmail || 'unknown admin')} → ${escapeHtml(log.targetEmail || log.targetUid || 'app-wide')} · ${formatFirestoreDate(log.timestamp) || 'just now'}</div>
      </div>`;
  }

  /* ================================================================ */
  el.querySelectorAll('.admin-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === activeTab) return;
      activeTab = btn.dataset.tab;
      el.querySelectorAll('.admin-tab').forEach((b) => b.classList.toggle('active', b === btn));
      renderTab();
    });
  });

  await renderTab();

  const unsubscribeShell = attachShell(el, 'settings');
  el._onLeave = () => {
    unsubscribeShell();
    if (unsubscribePaymentsListener) unsubscribePaymentsListener();
  };

  return el;
}

/* ---------------------------------------------------------------- */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function formatFirestoreDate(value) {
  if (!value) return null;
  const date = typeof value?.toDate === 'function' ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function jsonReplacer(key, value) {
  if (value && typeof value === 'object' && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return value;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;');
}
