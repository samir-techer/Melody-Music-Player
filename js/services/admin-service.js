/**
 * admin-service.js
 * All Firestore access for the Admin Dashboard lives here, kept separate
 * from every other service. Every write here is a merge update and every
 * privileged action is logged to `admin_logs` for a real audit trail.
 *
 * Security note: the actual enforcement is in firestore.rules (isAdmin()
 * there, re-checked by Firestore itself on every request) — this file
 * assumes nothing about the caller's privileges and would simply get a
 * permission-denied error back if called by a non-admin. The UI-side
 * checks (admin-screen.js, settings-screen.js, the router guard) are
 * there for UX, not security.
 */

import {
  collection, doc, getDoc, getDocs, getCountFromServer,
  query, where, orderBy, limit, startAfter,
  setDoc, deleteDoc, addDoc, serverTimestamp, Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { db, auth } from './firebase-config.js';

const USERS = 'users';
const LOGS = 'admin_logs';
const CONFIG = 'app_config';
const AD_CONFIG_DOC = 'ads';

/* -------------------------------------------------------------------- */
/*  User listing — paginated, sorted, filtered, (prefix-)searchable      */
/* -------------------------------------------------------------------- */

const SORT_FIELDS = {
  newest: { field: 'accountCreated', direction: 'desc' },
  oldest: { field: 'accountCreated', direction: 'asc' },
  premiumExpiry: { field: 'premiumExpiry', direction: 'desc' },
  username: { field: 'nickname', direction: 'asc' },
};

/**
 * Paginated user listing. `cursorDoc` is the last DocumentSnapshot from
 * the previous page (pass null for page 1). Role/plan filters are exact
 * matches; a search query switches to a prefix match on nickname+email
 * instead of the normal sort (Firestore has no full-text search) and is
 * NOT paginated — it returns up to `pageSize` matches across both fields.
 */
export async function listUsers({
  pageSize = 20, cursorDoc = null, sortBy = 'newest', roleFilter = null, planFilter = null, searchQuery = null,
} = {}) {
  const usersRef = collection(db, USERS);

  if (searchQuery && searchQuery.trim()) {
    return searchUsers(searchQuery.trim(), { roleFilter, planFilter, pageSize });
  }

  const sort = SORT_FIELDS[sortBy] || SORT_FIELDS.newest;
  const clauses = [];
  if (roleFilter) clauses.push(where('role', '==', roleFilter));
  if (planFilter) clauses.push(where('premiumPlan', '==', planFilter));
  clauses.push(orderBy(sort.field, sort.direction));
  clauses.push(limit(pageSize));
  if (cursorDoc) clauses.push(startAfter(cursorDoc));

  const snap = await getDocs(query(usersRef, ...clauses));
  const users = snap.docs.map(docToUser);
  return {
    users,
    lastDoc: snap.docs[snap.docs.length - 1] || null,
    hasMore: snap.docs.length === pageSize,
  };
}

async function searchUsers(rawQuery, { roleFilter, planFilter, pageSize }) {
  const usersRef = collection(db, USERS);
  const upperBound = rawQuery + '\uf8ff';
  const baseClauses = [];
  if (roleFilter) baseClauses.push(where('role', '==', roleFilter));
  if (planFilter) baseClauses.push(where('premiumPlan', '==', planFilter));

  const [byNickname, byEmail] = await Promise.all([
    getDocs(query(usersRef, ...baseClauses, orderBy('nickname'), where('nickname', '>=', rawQuery), where('nickname', '<=', upperBound), limit(pageSize))).catch(() => ({ docs: [] })),
    getDocs(query(usersRef, ...baseClauses, orderBy('email'), where('email', '>=', rawQuery), where('email', '<=', upperBound), limit(pageSize))).catch(() => ({ docs: [] })),
  ]);

  const seen = new Map();
  [...byNickname.docs, ...byEmail.docs].forEach((d) => seen.set(d.id, docToUser(d)));
  return { users: Array.from(seen.values()).slice(0, pageSize), lastDoc: null, hasMore: false };
}

function docToUser(docSnap) {
  return { uid: docSnap.id, ...docSnap.data() };
}

export async function getUser(uid) {
  const snap = await getDoc(doc(db, USERS, uid));
  return snap.exists() ? docToUser(snap) : null;
}

/* -------------------------------------------------------------------- */
/*  Premium Manager                                                       */
/* -------------------------------------------------------------------- */

/**
 * `expiry` may be a Date (custom expiry), the string 'monthly'/'yearly'
 * (computed from now), or null (no expiry — e.g. plan set to Free, or an
 * admin-granted plan that never lapses).
 */
export async function setUserPremium(uid, { plan, expiry }, adminActor) {
  if (!['Free', 'Basic', 'Plus', 'Elite'].includes(plan)) throw new Error(`Invalid plan: ${plan}`);

  let expiryTimestamp = null;
  if (plan !== 'Free') {
    if (expiry === 'monthly') expiryTimestamp = Timestamp.fromDate(addMonths(new Date(), 1));
    else if (expiry === 'yearly') expiryTimestamp = Timestamp.fromDate(addMonths(new Date(), 12));
    else if (expiry instanceof Date) expiryTimestamp = Timestamp.fromDate(expiry);
  }

  await setDoc(doc(db, USERS, uid), { premiumPlan: plan, premiumExpiry: expiryTimestamp }, { merge: true });
  await logAdminAction(adminActor, `Set premium plan to ${plan}${expiryTimestamp ? ` (expires ${expiryTimestamp.toDate().toDateString()})` : ''}`, uid);
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/* -------------------------------------------------------------------- */
/*  Role Manager                                                         */
/* -------------------------------------------------------------------- */
// Melody's actual access-control model only ever checks role == "admin"
// (see premium-service.js / firestore.rules) — there's no existing
// "Owner"/"Moderator" tier anywhere in the app, so rather than inventing
// role values nothing else checks, this keeps to the two roles that are
// real: "User" and "admin".

export async function setUserRole(uid, role, adminActor) {
  if (!['User', 'admin'].includes(role)) throw new Error(`Invalid role: ${role}`);
  await setDoc(doc(db, USERS, uid), { role }, { merge: true });
  await logAdminAction(adminActor, `Changed role to "${role}"`, uid);
}

/* -------------------------------------------------------------------- */
/*  Other per-user admin actions                                         */
/* -------------------------------------------------------------------- */

export async function resetNicknameChanges(uid, adminActor) {
  await setDoc(doc(db, USERS, uid), { nicknameChanges: 0, nicknameResetDate: null }, { merge: true });
  await logAdminAction(adminActor, 'Reset nickname change count', uid);
}

export async function setAccountDisabled(uid, disabled, adminActor) {
  await setDoc(doc(db, USERS, uid), { accountDisabled: disabled }, { merge: true });
  await logAdminAction(adminActor, disabled ? 'Disabled account' : 'Re-enabled account', uid);
}

/**
 * Deletes the Firestore profile document. IMPORTANT: this does NOT and
 * cannot delete the underlying Firebase Authentication account — a
 * client app can never do that for another user's account; only the
 * Firebase Admin SDK (a server / Cloud Function) can. Combined with
 * setAccountDisabled(uid, true) first, the person is locked out of
 * anything Firestore-gated, but could still technically sign back in to
 * Firebase Auth and get a fresh (empty, Free-plan) profile document
 * created for them unless a Cloud Function is added to close that gap.
 */
export async function deleteUserRecord(uid, adminActor) {
  await deleteDoc(doc(db, USERS, uid));
  await logAdminAction(adminActor, 'Deleted Firestore profile (Auth account was NOT deleted — requires a Cloud Function)', uid);
}

/* -------------------------------------------------------------------- */
/*  Audit log                                                             */
/* -------------------------------------------------------------------- */

export async function logAdminAction(adminActor, action, targetUid, targetEmail = null) {
  try {
    await addDoc(collection(db, LOGS), {
      adminUid: adminActor?.uid || auth.currentUser?.uid || null,
      adminEmail: adminActor?.email || auth.currentUser?.email || null,
      action,
      targetUid: targetUid || null,
      targetEmail: targetEmail || null,
      device: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    // Logging failure should never block the actual admin action from
    // having already completed — just surface it to the console.
    console.error('[Melody] Admin: failed to write audit log entry (action already applied).', err);
  }
}

export async function listAdminLogs({ pageSize = 30, cursorDoc = null } = {}) {
  const clauses = [orderBy('timestamp', 'desc'), limit(pageSize)];
  if (cursorDoc) clauses.push(startAfter(cursorDoc));
  const snap = await getDocs(query(collection(db, LOGS), ...clauses));
  return {
    logs: snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs[snap.docs.length - 1] || null,
    hasMore: snap.docs.length === pageSize,
  };
}

/* -------------------------------------------------------------------- */
/*  Advertisement config (global kill-switch + frequency)                */
/* -------------------------------------------------------------------- */

export async function getAdConfig() {
  const snap = await getDoc(doc(db, CONFIG, AD_CONFIG_DOC));
  return snap.exists() ? snap.data() : { adsEnabled: true, songsBetweenAds: 6 };
}

export async function setAdConfig({ adsEnabled, songsBetweenAds }, adminActor) {
  const patch = {};
  if (typeof adsEnabled === 'boolean') patch.adsEnabled = adsEnabled;
  if (Number.isFinite(songsBetweenAds)) patch.songsBetweenAds = Math.max(1, Math.round(songsBetweenAds));
  await setDoc(doc(db, CONFIG, AD_CONFIG_DOC), patch, { merge: true });
  await logAdminAction(adminActor, `Updated ad config: ${JSON.stringify(patch)}`, null);
}

/* -------------------------------------------------------------------- */
/*  Analytics — uses Firestore's server-side count aggregation           */
/*  (getCountFromServer) so this never has to download every user        */
/*  document just to count them.                                         */
/*                                                                        */
/*  Important honesty note: Favorites/Playlists/Songs Imported are        */
/*  stored per-device in IndexedDB, NOT in Firestore, unless a user has   */
/*  opted into Cloud Backup — so there is no way for a backend-less      */
/*  static app to know true totals across every user's device. The       */
/*  numbers below reflect only what Cloud-Backup-enabled accounts have   */
/*  synced, and are labeled that way rather than presented as global      */
/*  totals.                                                               */
/* -------------------------------------------------------------------- */

async function countWhere(field, op, value) {
  const snap = await getCountFromServer(query(collection(db, USERS), where(field, op, value)));
  return snap.data().count;
}

export async function getOverviewStats() {
  const usersRef = collection(db, USERS);
  const [
    totalUsers, basicUsers, plusUsers, eliteUsers, adminAccounts, cloudBackupUsers,
  ] = await Promise.all([
    getCountFromServer(usersRef).then((s) => s.data().count),
    countWhere('premiumPlan', '==', 'Basic'),
    countWhere('premiumPlan', '==', 'Plus'),
    countWhere('premiumPlan', '==', 'Elite'),
    countWhere('role', '==', 'admin'),
    countWhere('cloudBackupEnabled', '==', true),
  ]);

  const adConfig = await getAdConfig();

  return {
    totalUsers,
    premiumUsers: basicUsers + plusUsers + eliteUsers,
    basicUsers,
    plusUsers,
    eliteUsers,
    freeUsers: totalUsers - (basicUsers + plusUsers + eliteUsers),
    adminAccounts,
    cloudBackupUsers,
    adsEnabled: adConfig.adsEnabled !== false,
    songsBetweenAds: adConfig.songsBetweenAds || 6,
  };
}

/**
 * Cloud-Backup-derived usage stats — explicitly scoped, per the honesty
 * note above, to accounts that opted into Cloud Backup. Reads those
 * documents directly (there's no way to aggregate array lengths via
 * count-only queries), capped so this can't balloon on a large user base.
 */
export async function getCloudBackupUsageSample({ sampleSize = 200 } = {}) {
  const snap = await getDocs(query(
    collection(db, USERS),
    where('cloudBackupEnabled', '==', true),
    limit(sampleSize),
  ));

  let favorites = 0;
  let playlists = 0;
  let queueSongs = 0;
  const themeCounts = { default: 0 };

  snap.docs.forEach((d) => {
    const data = d.data();
    const backup = data.cloudBackup || {};
    favorites += (backup.favoriteIds || []).length;
    playlists += (backup.playlists || []).length;
    queueSongs += (backup.queue?.songIds || []).length;

    const theme = data.selectedTheme || 'default';
    themeCounts[theme] = (themeCounts[theme] || 0) + 1;
  });

  return {
    sampledAccounts: snap.docs.length,
    favorites, playlists, queueSongs, themeCounts,
    truncated: snap.docs.length === sampleSize,
  };
}
