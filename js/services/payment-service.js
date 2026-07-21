/**
 * payment-service.js
 * Melody Premium purchases. This is a MANUAL-VERIFICATION payment flow,
 * not an automated gateway integration — see the note below before
 * changing anything here.
 *
 * ============================================================
 * WHY MANUAL VERIFICATION (read this before "fixing" it)
 * ============================================================
 * Real automated eSewa verification requires a registered eSewa
 * MERCHANT account (merchant code + secret key) and a backend server to
 * hold that secret and call eSewa's verify endpoint — a secret key can
 * never live in client-side JS, anyone could read it out of the bundle
 * and forge a "verified" response. Melody's current architecture is
 * client + Firestore only, with a personal eSewa name/number (not a
 * merchant account), so there is no API to verify against at all.
 *
 * So: the user pays the displayed QR/number directly, submits their
 * eSewa reference ID as proof, and it becomes a `pending` transaction.
 * An ADMIN manually reviews and approves or rejects it from the Admin
 * Dashboard (see admin-screen.js's "Payment Verifications" section).
 * Premium activates ONLY on that admin action. This is genuinely secure
 * — not just "trust the client" with extra steps — because
 * firestore.rules already locks premiumPlan/premiumExpiry to
 * admin-only writes; a user tampering with the client gains nothing,
 * since the client was never able to write those fields to begin with.
 *
 * ============================================================
 * MODULAR PROVIDER ARCHITECTURE (for adding Khalti/Fonepay/ConnectIPS/
 * Stripe later)
 * ============================================================
 * PAYMENT_PROVIDERS below is the extension point. Each provider
 * describes how to render its own payment instructions; the
 * transaction/verification/Firestore plumbing beneath it (this whole
 * file) is provider-agnostic. Adding real gateway automation later (for
 * a provider with an actual merchant API + backend) means adding a
 * `verify()` capability to a provider entry and branching in
 * approveTransaction — it does not mean rewriting this file.
 *
 * ============================================================
 * DATA MODEL
 * ============================================================
 * users/{uid}/transactions/{txnId}:
 *   uid, plan, billing ('monthly'|'yearly'), originalPrice, couponCode,
 *   discountPercent, discountAmount, finalAmount, providerId,
 *   providerReferenceId (what the user typed in as proof),
 *   melodyTransactionId (same as txnId, duplicated for display),
 *   status ('pending'|'verified'|'rejected'), createdAt,
 *   verifiedAt, verifiedBy, rejectionReason
 *
 * users/{uid} additionally gets, ONLY on verified approval:
 *   premiumPlan, premiumExpiry, purchaseDate, transactionId,
 *   paymentMethod, paymentStatus, couponUsed, discountReceived,
 *   finalAmountPaid
 */

import {
  collection, collectionGroup, doc, getDoc, setDoc,
  onSnapshot, query, where, orderBy,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { db } from './firebase-config.js';
import { setUserPremium, logAdminAction } from './admin-service.js';

export const PAYMENT_PROVIDERS = {
  esewa: {
    id: 'esewa',
    label: 'eSewa',
    receiverName: 'Basundhara Thapa',
    receiverNumber: '9821805256',
    // Drop your real eSewa QR image at this path to replace the
    // placeholder payment-screen.js renders when it's missing — no code
    // changes needed elsewhere.
    qrAssetPath: './assets/payments/esewa-qr.png',
    referenceLabel: 'eSewa Transaction/Reference ID',
    comingSoon: false,
  },
  khalti: { id: 'khalti', label: 'Khalti', comingSoon: true },
  fonepay: { id: 'fonepay', label: 'Fonepay', comingSoon: true },
  connectips: { id: 'connectips', label: 'ConnectIPS', comingSoon: true },
  stripe: { id: 'stripe', label: 'Stripe', comingSoon: true },
};

const VERIFICATION_ETA_NOTE = 'Verification is manual and can take up to 24 hours.';

function generateMelodyTransactionId() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `MELODY-${Date.now()}-${rand}`;
}

function addMonthsToDate(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

/**
 * Creates the pending transaction the moment the user submits their
 * eSewa reference — this is the ONLY thing that happens client-side.
 * No premium field is touched, no coupon is consumed.
 */
export async function submitPendingPayment({
  uid, planKey, planName, billing, originalPrice, coupon, finalAmount, providerId, providerReferenceId,
}) {
  const txnId = generateMelodyTransactionId();
  const discountPercent = coupon?.discountPercent || 0;
  const discountAmount = Math.round((originalPrice * discountPercent) / 100);

  await setDoc(doc(db, 'users', uid, 'transactions', txnId), {
    uid,
    plan: planName,
    planKey,
    billing,
    originalPrice,
    couponCode: coupon?.code || null,
    discountPercent,
    discountAmount,
    finalAmount,
    providerId,
    providerReferenceId,
    melodyTransactionId: txnId,
    status: 'pending',
    createdAt: Date.now(),
    verifiedAt: null,
    verifiedBy: null,
    rejectionReason: null,
  });

  return { txnId, etaNote: VERIFICATION_ETA_NOTE };
}

/** Live updates for one account's own purchase history (newest first). */
export function subscribeUserTransactions(uid, listener) {
  const q = query(collection(db, 'users', uid, 'transactions'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, (snap) => {
    listener(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (err) => console.error('[Melody] Payment: purchase history listener failed.', err));
}

/** Live updates for ONE transaction — used by payment-screen.js's "Verifying..." state. */
export function subscribeTransaction(uid, txnId, listener) {
  return onSnapshot(doc(db, 'users', uid, 'transactions', txnId), (snap) => {
    listener(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  }, (err) => console.error('[Melody] Payment: transaction listener failed.', err));
}

/** Admin Dashboard queue — every pending transaction across every account. */
export function subscribePendingTransactions(listener) {
  const q = query(collectionGroup(db, 'transactions'), where('status', '==', 'pending'));
  return onSnapshot(q, (snap) => {
    const items = snap.docs.map((d) => ({ id: d.id, path: d.ref.path, ...d.data() }));
    items.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // oldest first — first paid, first reviewed
    listener(items);
  }, (err) => console.error('[Melody] Payment: pending-verification queue failed.', err));
}

/** Marks one coupon (by code) as redeemed inside the account's discountCoupons array — approval-only, never before. */
async function markCouponRedeemed(uid, couponCode, { txnId }) {
  if (!couponCode) return;
  const userSnap = await getDoc(doc(db, 'users', uid));
  const coupons = Array.isArray(userSnap.data()?.discountCoupons) ? userSnap.data().discountCoupons : [];
  const updated = coupons.map((c) => (
    c.code === couponCode ? { ...c, redeemed: true, redeemedAt: Date.now(), transactionId: txnId } : c
  ));
  await setDoc(doc(db, 'users', uid), { discountCoupons: updated }, { merge: true });
}

/**
 * Approves a pending transaction: activates Premium, records every
 * transaction field on the profile, marks the coupon (if any) redeemed,
 * and logs the action — all only now, never earlier. Reuses
 * admin-service.js's setUserPremium()/logAdminAction() rather than
 * duplicating that logic.
 */
export async function approveTransaction(txn, adminActor) {
  if (txn.status !== 'pending') throw new Error('This transaction has already been reviewed.');

  // Renewing before expiry extends from the current expiry, not from
  // today — matches how the Premium screen's "Renew" button is framed.
  const currentUserSnap = await getDoc(doc(db, 'users', txn.uid));
  const currentExpiryRaw = currentUserSnap.data()?.premiumExpiry;
  const currentExpiryMs = typeof currentExpiryRaw?.toMillis === 'function' ? currentExpiryRaw.toMillis() : null;
  const base = currentExpiryMs && currentExpiryMs > Date.now() ? new Date(currentExpiryMs) : new Date();
  const monthsToAdd = txn.billing === 'yearly' ? 12 : 1;
  const newExpiry = addMonthsToDate(base, monthsToAdd);

  await setUserPremium(txn.uid, { plan: txn.plan, expiry: newExpiry }, adminActor);

  await setDoc(doc(db, 'users', txn.uid), {
    purchaseDate: Date.now(),
    transactionId: txn.melodyTransactionId || txn.id,
    paymentMethod: txn.providerId,
    paymentStatus: 'verified',
    couponUsed: txn.couponCode || null,
    discountReceived: txn.discountAmount || 0,
    finalAmountPaid: txn.finalAmount,
  }, { merge: true });

  if (txn.couponCode) await markCouponRedeemed(txn.uid, txn.couponCode, { txnId: txn.id });

  await setDoc(doc(db, 'users', txn.uid, 'transactions', txn.id), {
    status: 'verified',
    verifiedAt: Date.now(),
    verifiedBy: adminActor?.uid || null,
  }, { merge: true });

  await logAdminAction(
    adminActor,
    `Approved eSewa payment — ${txn.plan} (${txn.billing}), ${PAYMENT_PROVIDERS.esewa.label} ref ${txn.providerReferenceId}, रु${txn.finalAmount}`,
    txn.uid,
  );
}

/** Rejects a pending transaction. Coupon (if any) stays untouched/active — nothing was ever consumed. */
export async function rejectTransaction(txn, reason, adminActor) {
  if (txn.status !== 'pending') throw new Error('This transaction has already been reviewed.');

  await setDoc(doc(db, 'users', txn.uid, 'transactions', txn.id), {
    status: 'rejected',
    verifiedAt: Date.now(),
    verifiedBy: adminActor?.uid || null,
    rejectionReason: reason || null,
  }, { merge: true });

  await logAdminAction(
    adminActor,
    `Rejected eSewa payment — ${txn.plan} (${txn.billing}), ref ${txn.providerReferenceId}${reason ? `: ${reason}` : ''}`,
    txn.uid,
  );
}
