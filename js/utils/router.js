/**
 * router.js
 * Minimal in-memory router for Melody's single-page shell. Screens are
 * plain functions that build and return a detached DOM element
 * (`async function renderXScreen(params) -> HTMLElement`); this module owns
 * mounting that element into #app-root, tearing down whatever was there
 * before (calling its `_onLeave` cleanup if one was attached), and gating
 * navigation behind auth/route guards.
 */

let rootEl = null;
let activeRoute = null;
let activeEl = null;
let authGuard = () => true;
const routes = new Map();

/** Called once at boot with the element routes render into. */
export function initRouter(root) {
  rootEl = root;
}

/**
 * Registers a route.
 * options:
 *   requiresAuth: boolean        — bounce to 'login' if the auth guard fails
 *   guard: async () => boolean   — extra check (e.g. admin-only); on failure
 *                                  the navigation is redirected to 'home'
 */
export function registerRoute(name, renderFn, options = {}) {
  routes.set(name, { renderFn, ...options });
}

/** Supplies the function used to answer "is someone signed in right now?". */
export function setAuthGuard(fn) {
  authGuard = fn;
}

/** The currently-mounted route's name, or null before the first navigate(). */
export function currentRoute() {
  return activeRoute;
}

/**
 * Navigates to `name`, running any auth/route guards first. Cleans up the
 * outgoing screen (via its `_onLeave`, if present) and mounts the new one.
 */
export async function navigate(name, params = {}) {
  const route = routes.get(name);
  if (!route) {
    console.error(`[Melody] Router: no route registered for "${name}".`);
    return;
  }

  if (route.requiresAuth && !authGuard()) {
    if (name !== 'login') {
      return navigate('login');
    }
  }

  if (route.guard) {
    let allowed = false;
    try {
      allowed = await route.guard();
    } catch (err) {
      console.error(`[Melody] Router: guard for "${name}" threw — denying access.`, err);
      allowed = false;
    }
    if (!allowed) {
      if (name !== 'home') {
        return navigate('home');
      }
      // Guard on 'home' itself failing would loop — fall through and
      // render it anyway rather than hang navigation entirely.
    }
  }

  const el = await route.renderFn(params);

  if (activeEl && typeof activeEl._onLeave === 'function') {
    try {
      activeEl._onLeave();
    } catch (err) {
      console.error(`[Melody] Router: _onLeave for "${activeRoute}" threw.`, err);
    }
  }

  if (rootEl) {
    rootEl.innerHTML = '';
    if (el) rootEl.appendChild(el);
  }

  activeRoute = name;
  activeEl = el || null;
}
