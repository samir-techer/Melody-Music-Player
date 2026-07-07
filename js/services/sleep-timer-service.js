/**
 * sleep-timer-service.js
 * A minimal countdown that pauses playback once it elapses. Deliberately
 * independent of player-service's own queue/track state — it only needs
 * to know a deadline and call pause(), so it stays small and can't get
 * out of sync with anything else.
 */

import { pause } from './player-service.js';

const listeners = new Set();
let deadline = null; // epoch ms, or null when off
let tickId = null;

function currentState() {
  const remainingMs = deadline ? Math.max(0, deadline - Date.now()) : 0;
  return {
    active: Boolean(deadline),
    remainingSeconds: Math.round(remainingMs / 1000),
  };
}

function notify() {
  const state = currentState();
  listeners.forEach((fn) => {
    try { fn(state); } catch (err) { console.error('[Melody] Sleep timer subscriber threw:', err); }
  });
}

/** Subscribe to sleep-timer state changes. Immediately called with current state. */
export function subscribeSleepTimer(listener) {
  listeners.add(listener);
  listener(currentState());
  return () => listeners.delete(listener);
}

export function getSleepTimerState() {
  return currentState();
}

function clearTick() {
  if (tickId) { clearInterval(tickId); tickId = null; }
}

/** Start (or replace) a countdown of N minutes. */
export function startSleepTimer(minutes) {
  const ms = Math.max(1, Number(minutes) || 0) * 60 * 1000;
  clearTick();
  deadline = Date.now() + ms;
  tickId = setInterval(() => {
    if (!deadline) return;
    if (Date.now() >= deadline) {
      pause();
      cancelSleepTimer();
    } else {
      notify();
    }
  }, 1000);
  notify();
}

/** Cancel any active timer without affecting playback. */
export function cancelSleepTimer() {
  clearTick();
  deadline = null;
  notify();
}

export function isSleepTimerActive() {
  return Boolean(deadline);
}
