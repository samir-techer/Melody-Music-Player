/**
 * soundcloud-track-card.js
 * Shared render-helper functions (not a component) for the SoundCloud
 * screens: track cards, artist cards, playlist cards, skeleton
 * placeholders, and a lightweight canvas waveform renderer. Kept here so
 * soundcloud-screen.js / soundcloud-search-screen.js / soundcloud-artist-
 * screen.js / soundcloud-playlist-screen.js all render identically
 * instead of drifting apart.
 */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** A track row: artwork, title, artist, duration, play button. Lazy-loaded artwork. */
export function renderTrackCard(track) {
  return `
    <button class="sc-track-card" type="button" data-sc-play-track="${track.permalinkUrl}" data-sc-title="${escapeHtml(track.title)}">
      <img class="sc-track-art" src="${track.artworkUrl || ''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <span class="sc-track-info">
        <span class="sc-track-title">${escapeHtml(track.title)}</span>
        <span class="sc-track-artist">${escapeHtml(track.artist)}</span>
      </span>
      <span class="sc-track-duration">${track.durationLabel}</span>
      <span class="sc-track-play-icon" aria-hidden="true">▶</span>
    </button>
  `;
}

/** A larger grid card for trending/search track results, with a waveform strip placeholder. */
export function renderTrackGridCard(track) {
  return `
    <button class="sc-grid-card" type="button" data-sc-play-track="${track.permalinkUrl}" data-sc-title="${escapeHtml(track.title)}">
      <div class="sc-grid-art-wrap">
        <img class="sc-grid-art" src="${track.artworkUrl || ''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
        <span class="sc-grid-play-overlay" aria-hidden="true">▶</span>
      </div>
      <canvas class="sc-waveform" data-sc-waveform="${track.waveformUrl || ''}" width="200" height="28"></canvas>
      <span class="sc-grid-title">${escapeHtml(track.title)}</span>
      <span class="sc-grid-artist">${escapeHtml(track.artist)} · ${track.durationLabel}</span>
    </button>
  `;
}

export function renderArtistCard(artist) {
  return `
    <button class="sc-artist-card" type="button" data-sc-open-artist="${artist.id}">
      <img class="sc-artist-avatar" src="${artist.avatarUrl || ''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <span class="sc-artist-name">${escapeHtml(artist.name)}</span>
      <span class="sc-artist-meta">${artist.followers.toLocaleString()} followers</span>
    </button>
  `;
}

export function renderPlaylistCard(playlist) {
  return `
    <button class="sc-grid-card" type="button" data-sc-open-playlist="${playlist.id}">
      <div class="sc-grid-art-wrap">
        <img class="sc-grid-art" src="${playlist.artworkUrl || ''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
        <span class="sc-grid-play-overlay" aria-hidden="true">▶</span>
      </div>
      <span class="sc-grid-title">${escapeHtml(playlist.title)}</span>
      <span class="sc-grid-artist">${escapeHtml(playlist.creator)} · ${playlist.trackCount} tracks</span>
    </button>
  `;
}

/** Skeleton shimmer placeholders shown while a section is loading. */
export function renderSkeletonRow(count = 6, variant = 'grid') {
  const item = variant === 'grid'
    ? '<div class="sc-skel sc-skel-grid"></div>'
    : '<div class="sc-skel sc-skel-row"></div>';
  return Array(count).fill(item).join('');
}

/** An inline "couldn't load — Retry" banner. Pass the id of the retry button so the caller can wire it. */
export function renderErrorRetry(message, retryId) {
  return `
    <div class="sc-error">
      <span>${escapeHtml(message)}</span>
      <button type="button" id="${retryId}" class="btn-secondary">Retry</button>
    </div>
  `;
}

/** Draws a simple bar waveform from peaks (0..1) onto a canvas — cheap, no external chart lib. */
export function drawWaveform(canvas, peaks, progressRatio = 0) {
  if (!canvas || !peaks || !peaks.length) return;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const barWidth = width / peaks.length;
  const playedBars = Math.floor(peaks.length * progressRatio);

  const style = getComputedStyle(document.documentElement);
  const playedColor = style.getPropertyValue('--color-accent').trim() || '#999';
  const unplayedColor = style.getPropertyValue('--color-divider').trim() || '#555';

  peaks.forEach((p, i) => {
    const barHeight = Math.max(2, p * height);
    ctx.fillStyle = i < playedBars ? playedColor : unplayedColor;
    ctx.fillRect(i * barWidth, (height - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
  });
}

/**
 * Lazily draws each visible canvas[data-sc-waveform] once it scrolls into
 * view, fetching its peaks on demand — satisfies "lazy-load lists" for
 * the (potentially expensive) waveform fetches specifically.
 */
export function lazyRenderWaveforms(container, getWaveformPeaks) {
  const canvases = container.querySelectorAll('canvas[data-sc-waveform]');
  if (!canvases.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(async (entry) => {
      if (!entry.isIntersecting) return;
      const canvas = entry.target;
      observer.unobserve(canvas);
      const url = canvas.dataset.scWaveform;
      if (!url) return;
      const peaks = await getWaveformPeaks(url).catch(() => []);
      drawWaveform(canvas, peaks);
    });
  }, { rootMargin: '200px' });

  canvases.forEach((c) => { if (c.dataset.scWaveform) observer.observe(c); });
}
