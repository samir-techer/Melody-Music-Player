/**
 * notifications-screen.js
 * The real notification center — reads from notification-service.js.
 * Swipe-to-dismiss was scoped down to an explicit ✕ button per row for
 * this pass: more reliable across browsers/input types than a hand-rolled
 * swipe gesture, and just as functional.
 */

import { navigate } from '../utils/router.js';
import { getCurrentUser } from '../services/auth-service.js';
import {
  CATEGORIES, getNotifications, markRead, markAllRead, deleteNotification,
} from '../services/notification-service.js';

export async function renderNotificationsScreen() {
  const user = getCurrentUser();
  const el = document.createElement('div');
  el.className = 'screen notifications-screen';

  let items = [];
  try {
    items = user ? await getNotifications(user.uid) : [];
  } catch (err) {
    console.error('[Melody] Notifications: failed to load.', err);
  }

  let activeFilter = 'all';

  el.innerHTML = `
    <header class="screen-header notif-header">
      <button class="profile-back" id="notif-back" aria-label="Back">‹</button>
      <h1>Notifications</h1>
      <button class="notif-mark-all" id="notif-mark-all">Mark all read</button>
    </header>

    <div class="tab-bar" id="notif-filter-bar" role="tablist">
      <button class="tab-btn active" data-filter="all">All</button>
      ${CATEGORIES.map((c) => `<button class="tab-btn" data-filter="${c.key}">${c.icon} ${c.label}</button>`).join('')}
    </div>

    <div id="notif-list" class="notif-list"></div>
  `;

  const listEl = el.querySelector('#notif-list');

  function renderList() {
    const visible = activeFilter === 'all' ? items : items.filter((n) => n.category === activeFilter);

    if (visible.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p class="title">${activeFilter === 'all' ? 'You\u2019re all caught up' : 'Nothing here yet'}</p>
          <p>${activeFilter === 'all' ? 'New notifications will show up here.' : 'Notifications in this category will show up here.'}</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = visible.map((n) => `
      <div class="notif-row ${n.read ? '' : 'unread'}" data-id="${n.id}">
        <span class="notif-icon" aria-hidden="true">${n.icon}</span>
        <div class="notif-body">
          <p class="notif-title">${escapeHtml(n.title)}</p>
          ${n.body ? `<p class="notif-text">${escapeHtml(n.body)}</p>` : ''}
          <p class="notif-time">${relativeTime(n.createdAt)}</p>
        </div>
        ${!n.read ? '<span class="notif-unread-dot" aria-hidden="true"></span>' : ''}
        <button class="notif-delete" data-id="${n.id}" aria-label="Delete notification">✕</button>
      </div>
    `).join('');

    listEl.querySelectorAll('.notif-row').forEach((row) => {
      row.addEventListener('click', async (e) => {
        if (e.target.closest('.notif-delete')) return;
        const id = row.dataset.id;
        const item = items.find((n) => n.id === id);
        if (item && !item.read && user) {
          item.read = true;
          row.classList.remove('unread');
          row.querySelector('.notif-unread-dot')?.remove();
          await markRead(user.uid, id);
        }
      });
    });

    listEl.querySelectorAll('.notif-delete').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!user) return;
        items = items.filter((n) => n.id !== id);
        await deleteNotification(user.uid, id);
        renderList();
      });
    });
  }

  renderList();

  el.querySelector('#notif-back').addEventListener('click', () => navigate('home'));

  el.querySelector('#notif-mark-all').addEventListener('click', async () => {
    if (!user) return;
    items.forEach((n) => { n.read = true; });
    await markAllRead(user.uid);
    renderList();
  });

  el.querySelector('#notif-filter-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    activeFilter = btn.dataset.filter;
    el.querySelectorAll('#notif-filter-bar .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderList();
  });

  return el;
}

function relativeTime(ts) {
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
