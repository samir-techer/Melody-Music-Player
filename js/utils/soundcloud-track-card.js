/**
 * soundcloud-track-card.js
 * HTML-string renderers for SoundCloud tracks/artists/playlists, consumed
 * by soundcloud-screen.js, soundcloud-search-screen.js,
 * soundcloud-artist-screen.js, and soundcloud-playlist-screen.js. Markup
 * matches the .sc-* classes already defined in css/soundcloud.css, and the
 * `data-sc-*` attributes those screens attach click delegation to.
 * Inputs are the normalized track/user/playlist objects produced by
 * soundcloud-service.js's normalizeTrack/normalizeUser/normalizePlaylist.
 */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

const PLAY_ICON = `<svg class="sc-track-play-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;

/** Compact list row — used in search results, artist tracks, playlist tracks. */
export function renderTrackCard(track) {
  if (!track) return '';
  const artwork = track.artworkUrl
    ? `<img class="sc-track-art" src="${escapeHtml(track.artworkUrl)}" alt="" loading="lazy">`
    : `<div class="sc-track-art"></div>`;

  return `
    <div class="sc-track-card" data-sc-play-track="${escapeHtml(track.permalinkUrl || '')}" data-sc-title="${escapeHtml(track.title)}" role="button" tabindex="0">
      ${artwork}
      <div class="sc-track-info">
        <div class="sc-track-title">${escapeHtml(track.title)}</div>
        <div class="sc-track-artist">${escapeHtml(track.artist)}</div>
      </div>
      <div class="sc-track-duration">${escapeHtml(track.durationLabel || '')}</div>
      ${PLAY_ICON}
    </div>
  `;
}

/** Grid card with artwork — used for trending/genre browsing and search "Tracks" tab. */
export function renderTrackGridCard(track) {
  if (!track) return '';
  const artwork = track.artworkUrl
    ? `<img class="sc-grid-art" src="${escapeHtml(track.artworkUrl)}" alt="" loading="lazy">`
    : '';
  const waveform = track.waveformUrl
    ? `<canvas class="sc-waveform" data-sc-waveform-url="${escapeHtml(track.waveformUrl)}"></canvas>`
    : '';

  return `
    <div class="sc-grid-card" data-sc-play-track="${escapeHtml(track.permalinkUrl || '')}" data-sc-title="${escapeHtml(track.title)}" role="button" tabindex="0">
      <div class="sc-grid-art-wrap">
        ${artwork}
        <div class="sc-grid-play-overlay">${PLAY_ICON}</div>
      </div>
      ${waveform}
      <div class="sc-grid-title">${escapeHtml(track.title)}</div>
      <div class="sc-grid-artist">${escapeHtml(track.artist)}</div>
    </div>
  `;
}

/** Round-avatar artist card — search "Artists" tab. */
export function renderArtistCard(artist) {
  if (!artist) return '';
  const avatar = artist.avatarUrl
    ? `<img class="sc-artist-avatar" src="${escapeHtml(artist.avatarUrl)}" alt="" loading="lazy">`
    : `<div class="sc-artist-avatar"></div>`;

  return `
    <div class="sc-artist-card" data-sc-open-artist="${escapeHtml(String(artist.id ?? ''))}" role="button" tabindex="0">
      ${avatar}
      <div class="sc-artist-name">${escapeHtml(artist.name)}</div>
      <div class="sc-artist-meta">${formatCount(artist.followers)} followers</div>
    </div>
  `;
}

/** Playlist card — search "Playlists" tab. */
export function renderPlaylistCard(playlist) {
  if (!playlist) return '';
  const artwork = playlist.artworkUrl
    ? `<img class="sc-grid-art" src="${escapeHtml(playlist.artworkUrl)}" alt="" loading="lazy">`
    : '';

  return `
    <div class="sc-grid-card" data-sc-open-playlist="${escapeHtml(String(playlist.id ?? ''))}" role="button" tabindex="0">
      <div class="sc-grid-art-wrap">${artwork}</div>
      <div class="sc-grid-title">${escapeHtml(playlist.title)}</div>
      <div class="sc-grid-artist">${escapeHtml(playlist.creator)} · ${playlist.trackCount ?? 0} tracks</div>
    </div>
  `;
}

/** Loading placeholders. mode: 'row' | 'grid'. */
export function renderSkeletonRow(count = 4, mode = 'row') {
  const cls = mode === 'grid' ? 'sc-skel sc-skel-grid' : 'sc-skel sc-skel-row';
  return Array.from({ length: count }, () => `<div class="${cls}"></div>`).join('');
}

/** Inline error state with a retry button (wired up by the caller via retryId). */
export function renderErrorRetry(message, retryId) {
  return `
    <div class="sc-error">
      <p>${escapeHtml(message || 'Something went wrong.')}</p>
      <button type="button" id="${escapeHtml(retryId)}">Try again</button>
    </div>
  `;
}

/**
 * Lazily draws any `canvas.sc-waveform[data-sc-waveform-url]` inside
 * `container` once it scrolls into view, using `getWaveformPeaks(url)` to
 * fetch peak data. Safe no-op if there are no waveform canvases present.
 */
export function lazyRenderWaveforms(container, getWaveformPeaks) {
  if (!container) return;
  const canvases = container.querySelectorAll('canvas.sc-waveform[data-sc-waveform-url]');
  if (!canvases.length) return;

  const draw = async (canvas) => {
    const url = canvas.dataset.scWaveformUrl;
    if (!url || canvas.dataset.scRendered) return;
    canvas.dataset.scRendered = 'true';
    try {
      const peaks = await getWaveformPeaks(url);
      drawPeaks(canvas, Array.isArray(peaks) ? peaks : []);
    } catch (err) {
      console.warn('[Melody] SoundCloud waveform failed to load.', err);
    }
  };

  if (typeof IntersectionObserver === 'undefined') {
    canvases.forEach(draw);
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        draw(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { root: null, rootMargin: '200px' });

  canvases.forEach((c) => observer.observe(c));
}

function drawPeaks(canvas, peaks) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 28;
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);

  const barCount = Math.max(1, Math.floor(width / 3));
  const step = Math.max(1, Math.floor(peaks.length / barCount));
  const max = Math.max(1, ...peaks);

  ctx.fillStyle = getComputedStyle(canvas).color || '#888';
  for (let i = 0; i < barCount; i++) {
    const peak = peaks[i * step] || 0;
    const barHeight = Math.max(1, (peak / max) * height);
    ctx.fillRect(i * 3, height - barHeight, 2, barHeight);
  }
}

function formatCount(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}
