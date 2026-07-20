/**
 * soundcloud-widget-player.js
 * Playback for SoundCloud content uses SoundCloud's own official Widget
 * (an iframe pointed at w.soundcloud.com/player, controlled via their
 * postMessage-based Widget JS API — https://w.soundcloud.com/player/api.js,
 * loaded as a plain script tag in index.html, exposing a global `SC`).
 * This is SoundCloud's sanctioned method for third-party playback, so
 * nothing here touches raw stream URLs.
 *
 * IMPORTANT — this is deliberately NOT wired into player-service.js's
 * Web Audio graph. SoundCloud's audio plays inside a cross-origin
 * iframe; there is no technical way to route it through Melody's
 * AudioContext, which means:
 *   - Equalizer, Clean Bass, Acoustic Mode, and Crossfade only ever
 *     apply to local library playback — they cannot touch SoundCloud
 *     audio, full stop. This is a platform constraint of using the
 *     compliant embed method, not a missing feature.
 *   - Background/lock-screen playback reliability for the widget is
 *     whatever the device's browser gives an iframe playing audio,
 *     which is generally less consistent than the dedicated <audio>
 *     element + Media Session setup player-service.js uses — notably
 *     weaker on iOS Safari. Don't assume parity with local playback.
 *
 * To keep the "only one thing plays at a time" behavior Melody already
 * has for its own library, this module calls player-service.js's public
 * pause() when SoundCloud playback starts, and mirrors the reverse (local
 * playback starting pauses the widget) via player-service.js's subscribe().
 */

import { pause as pauseLocalPlayback, subscribe as subscribeLocalPlayer } from './player-service.js';

let iframe = null;
let widget = null;
let ready = false;
const listeners = new Set(); // fn({ isPlaying, currentTrackUrl, currentTimeMs, durationMs })

let state = { isPlaying: false, currentTrackUrl: null, currentTimeMs: 0, durationMs: 0 };

function notify() {
  listeners.forEach((fn) => {
    try { fn({ ...state }); } catch (err) { console.error('[Melody] SoundCloud widget subscriber threw:', err); }
  });
}

function ensureWidget() {
  if (widget) return widget;
  if (typeof window === 'undefined' || !window.SC || !window.SC.Widget) {
    throw new Error('SoundCloud Widget API script hasn\u2019t loaded yet (check index.html\u2019s <script src="https://w.soundcloud.com/player/api.js">).');
  }

  iframe = document.createElement('iframe');
  iframe.id = 'soundcloud-widget-frame';
  iframe.allow = 'autoplay';
  iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;right:0;';
  iframe.src = 'https://w.soundcloud.com/player/?url=&auto_play=false&visual=false';
  document.body.appendChild(iframe);

  widget = window.SC.Widget(iframe);

  widget.bind(window.SC.Widget.Events.READY, () => { ready = true; });
  widget.bind(window.SC.Widget.Events.PLAY, () => {
    state.isPlaying = true;
    pauseLocalPlayback(); // enforce single-source playback across the whole app
    notify();
  });
  widget.bind(window.SC.Widget.Events.PAUSE, () => { state.isPlaying = false; notify(); });
  widget.bind(window.SC.Widget.Events.FINISH, () => { state.isPlaying = false; notify(); });
  widget.bind(window.SC.Widget.Events.PLAY_PROGRESS, (e) => {
    state.currentTimeMs = e.currentPosition;
    notify();
  });

  return widget;
}

// Local library playback starting should pause any SoundCloud playback,
// mirroring the reverse (handled by the PLAY event binding above).
subscribeLocalPlayer((playerState) => {
  if (playerState.isPlaying && state.isPlaying) {
    try { widget?.pause(); } catch { /* widget not ready yet — nothing to pause */ }
  }
});

/** Loads and plays a SoundCloud track/playlist by its public permalink URL. */
export function playSoundCloudUrl(permalinkUrl) {
  const w = ensureWidget();
  state.currentTrackUrl = permalinkUrl;

  const load = () => {
    w.load(permalinkUrl, {
      auto_play: true,
      callback: () => {
        w.getDuration((ms) => { state.durationMs = ms; notify(); });
      },
    });
  };
  if (ready) load();
  else w.bind(window.SC.Widget.Events.READY, load);
}

export function pauseSoundCloud() {
  try { widget?.pause(); } catch { /* not initialized — nothing playing */ }
}

export function toggleSoundCloudPlayback() {
  if (!widget) return;
  if (state.isPlaying) widget.pause();
  else widget.play();
}

export function seekSoundCloud(ms) {
  try { widget?.seekTo(ms); } catch { /* not ready */ }
}

export function subscribeSoundCloudPlayer(listener) {
  listeners.add(listener);
  listener({ ...state });
  return () => listeners.delete(listener);
}

export function getSoundCloudPlayerState() {
  return { ...state };
}
