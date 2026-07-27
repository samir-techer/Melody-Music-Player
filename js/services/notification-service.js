/**
 * notification-service.js
 * A real, working notification center — persisted per-user, with
 * read/unread state and a live subscription for the header bell badge.
 *
 * Deliberately does NOT ship with fake seeded marketing content ("50% off
 * Premium!", "Check out this new feature!") — every notification here is
 * created by an actual event elsewhere in the app calling addNotification()
 * (see: achievement unlocks in app.js, import completion in home-screen.js,
 * MP Store purchases in rewards-store-screen.js). The category list below
 * matches the original spec so the filter UI has somewhere for each type
 * to land, but a category with no real trigger wired up yet will just
 * stay empty rather than being filled with placeholder content.
 */

import { getUserItem, setUserItem } from '../utils/storage.js';

export const CATEGORIES = [
  { key: 'update', label: 'Melody Updates', icon: '🆕' },
  { key: 'feature', label: 'New Features', icon: '✨' },
  { key: 'premium', label: 'Premium Offers', icon: '⭐' },
  { key: 'discount', label: 'Discount Events', icon: '🏷️' },
  { key: 'achievement', label: 'Achievement Rewards', icon: '🏆' },
  { key: 'mp-store', label: 'MP Store Items', icon: '🛍️' },
  { key: 'tip', label: 'Music Tips', icon: '🎧' },
  { key: 'system', label: 'System Messages', icon: 'ℹ️' },
];

const MAX_STORED = 100;
const listeners = new Set();
let cache = { uid: null, items: [] };

function categoryMeta(key) {
  return CATEGORIES.find((c) => c.key === key) || CATEGORIES[CATEGORIES.length - 1];
}

async function load(uid) {
  if (cache.uid === uid) return cache.items;
  const stored = (await getUserItem(uid, 'notifications').catch(() => null)) || [];
  cache = { uid, items: Array.isArray(stored) ? stored : [] };
  return cache.items;
}

async function persist(uid) {
  await setUserItem(uid, 'notifications', cache.items.slice(0, MAX_STORED));
  notifyListeners();
}

function notifyListeners() {
  const unread = cache.items.filter((n) => !n.read).length;
  listeners.forEach((fn) => {
    try { fn({ items: cache.items, unreadCount: unread }); } catch (err) { console.error('[Melody] Notification listener threw:', err); }
  });
}

/** Live subscription — fires immediately with current state, then on every change. */
export function subscribeNotifications(uid, listener) {
  listeners.add(listener);
  load(uid).then(() => notifyListeners());
  return () => listeners.delete(listener);
}

export async function getNotifications(uid) {
  const items = await load(uid);
  return [...items].sort((a, b) => b.createdAt - a.createdAt);
}

export async function getUnreadCount(uid) {
  const items = await load(uid);
  return items.filter((n) => !n.read).length;
}

/**
 * Creates a real notification. Call this from an actual event — never to
 * pre-seed placeholder/marketing content.
 * @param {string} uid
 * @param {{ category: string, title: string, body?: string, icon?: string }} data
 */
export async function addNotification(uid, { category, title, body = '', icon = null }) {
  if (!uid || !title) return;
  const meta = categoryMeta(category);
  await load(uid);
  cache.items.unshift({
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    category: meta.key,
    icon: icon || meta.icon,
    title,
    body,
    createdAt: Date.now(),
    read: false,
  });
  await persist(uid);
}

export async function markRead(uid, id) {
  await load(uid);
  const item = cache.items.find((n) => n.id === id);
  if (item && !item.read) {
    item.read = true;
    await persist(uid);
  }
}

export async function markAllRead(uid) {
  await load(uid);
  let changed = false;
  cache.items.forEach((n) => { if (!n.read) { n.read = true; changed = true; } });
  if (changed) await persist(uid);
}

export async function deleteNotification(uid, id) {
  await load(uid);
  cache.items = cache.items.filter((n) => n.id !== id);
  await persist(uid);
}

export async function clearAll(uid) {
  cache = { uid, items: [] };
  await persist(uid);
}
