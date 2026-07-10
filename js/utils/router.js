/**
 * router.js
 * Minimal view controller for a single-page app shell.
 * Views are plain functions that return an HTMLElement. The router swaps
 * the contents of #app-root and manages a small fade transition so page
 * changes feel smooth instead of jarring.
 */

const routes = new Map();
const guardedRoutes = new Set();
let rootEl = null;
let currentName = null;
let authGuardFn = null; // () => boolean — returns true if the current session is authenticated

export function registerRoute(name, renderFn, { requiresAuth = false } = {}) {
  routes.set(name, renderFn);
  if (requiresAuth) guardedRoutes.add(name);
}

export function initRouter(root) {
  rootEl = root;
}

/**
 * Wires up the auth check used by guarded routes (see registerRoute's
 * `requiresAuth` option). Set once from app.js after Firebase auth is
 * ready. Kept generic/decoupled here so router.js has no direct
 * dependency on the auth service.
 */
export function setAuthGuard(fn) {
  authGuardFn = fn;
}

export async function navigate(name, params = {}) {
  if (!rootEl) throw new Error('Router not initialized — call initRouter(root) first.');

  if (guardedRoutes.has(name) && authGuardFn && !authGuardFn()) {
    console.warn(`[Melody] Blocked navigation to guarded route "${name}" — user is not authenticated.`);
    name = 'login';
  }

  const renderFn = routes.get(name);
  if (!renderFn) throw new Error(`No route registered for "${name}"`);

  // Entering/leaving the full player gets a fluid morph-style transition
  // (mini player <-> full player) via the View Transitions API when the
  // browser supports it; every other navigation keeps the plain fade.
  const isPlayerTransition = name === 'player' || currentName === 'player';
  const canUseViewTransition = isPlayerTransition && typeof document.startViewTransition === 'function';

  if (canUseViewTransition) {
    const outgoing = rootEl.firstElementChild;
    if (outgoing?._onLeave) {
      try { outgoing._onLeave(); } catch (err) { console.error('[Melody] Screen cleanup threw:', err); }
    }
    const transition = document.startViewTransition(async () => {
      rootEl.innerHTML = '';
      const view = await renderFn(params);
      rootEl.appendChild(view);
      currentName = name;
    });
    await transition.finished.catch(() => {});
    return;
  }

  // Give the outgoing screen a chance to clean up (e.g. unsubscribe from
  // player-service) before its DOM is discarded. A screen opts in by
  // setting `element._onLeave = fn` when it renders.
  const outgoing = rootEl.firstElementChild;
  if (outgoing?._onLeave) {
    try { outgoing._onLeave(); } catch (err) { console.error('[Melody] Screen cleanup threw:', err); }
  }

  // Fade out current screen
  if (outgoing) {
    outgoing.style.transition = 'opacity 180ms ease';
    outgoing.style.opacity = '0';
    await wait(160);
  }

  rootEl.innerHTML = '';
  const view = await renderFn(params);
  rootEl.appendChild(view);
  currentName = name;

  // Fade in new screen
  requestAnimationFrame(() => {
    view.style.opacity = '0';
    view.style.transition = 'opacity 220ms ease';
    requestAnimationFrame(() => { view.style.opacity = '1'; });
  });
}

export function currentRoute() {
  return currentName;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
