/**
 * router.js
 * Minimal view controller for a single-page app shell.
 * Views are plain functions that return an HTMLElement. The router swaps
 * the contents of #app-root and manages a small fade transition so page
 * changes feel smooth instead of jarring.
 */

const routes = new Map();
let rootEl = null;
let currentName = null;

export function registerRoute(name, renderFn) {
  routes.set(name, renderFn);
}

export function initRouter(root) {
  rootEl = root;
}

export async function navigate(name, params = {}) {
  if (!rootEl) throw new Error('Router not initialized — call initRouter(root) first.');
  const renderFn = routes.get(name);
  if (!renderFn) throw new Error(`No route registered for "${name}"`);

  // Fade out current screen
  if (rootEl.firstElementChild) {
    rootEl.firstElementChild.style.transition = 'opacity 180ms ease';
    rootEl.firstElementChild.style.opacity = '0';
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
