/**
 * soundcloud-service.js
 * All SoundCloud REST API access lives here — official, documented
 * endpoints only (developers.soundcloud.com/docs/api), no scraping.
 * Every exported function returns a plain, already-normalized object (or
 * throws a SoundCloudError the UI can catch for its error+retry state) so
 * the components never touch raw API response shapes directly.
 *
 * Requires SOUNDCLOUD_CLIENT_ID (see soundcloud-config.js). Every
 * function below throws a clear error if it's missing, which the UI
 * surfaces as "Connect your SoundCloud API credentials" rather than a
 * confusing network failure.
 *
 * CACHING: intentionally an in-memory Map, not Melody's normal
 * persistent storage — this resets on every reload, satisfying
 * SoundCloud's Terms of Use requirement that cached content "must cease
 * to be available... at the end of that session." TTL is additionally
 * capped at 10 minutes so even within one session it stays reasonably
 * fresh (and "minimizes API requests" per the feature brief).
 */

import { SOUNDCLOUD_CLIENT_ID, hasSoundCloudCredentials } from './soundcloud-config.js';

const API_BASE = 'https://api.soundcloud.com';
const CACHE_TTL_MS = 10 * 60 * 1000;

export class SoundCloudError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'SoundCloudError';
    this.status = status;
    this.code = code; // 'no-credentials' | 'network' | 'http' | 'parse'
  }
}

const cache = new Map(); // key -> { at: number, value: any }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
}

/** Clears every cached response. Exposed for a manual "refresh" action if ever needed. */
export function clearSoundCloudCache() {
  cache.clear();
}

async function scFetch(path, params = {}, { cacheKey } = {}) {
  if (!hasSoundCloudCredentials()) {
    throw new SoundCloudError(
      'SoundCloud isn\u2019t connected yet — add your API client_id in soundcloud-config.js.',
      { code: 'no-credentials' },
    );
  }

  const effectiveCacheKey = cacheKey || `${path}?${JSON.stringify(params)}`;
  const cached = cacheGet(effectiveCacheKey);
  if (cached !== undefined) return cached;

  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set('client_id', SOUNDCLOUD_CLIENT_ID);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  let response;
  try {
    response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new SoundCloudError('Couldn\u2019t reach SoundCloud — check your connection.', { code: 'network' });
  }

  if (!response.ok) {
    throw new SoundCloudError(
      response.status === 401 || response.status === 403
        ? 'SoundCloud rejected these credentials — the client_id may be invalid or unapproved for this endpoint.'
        : `SoundCloud returned an error (${response.status}).`,
      { status: response.status, code: 'http' },
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new SoundCloudError('SoundCloud sent back something unexpected.', { code: 'parse' });
  }

  cacheSet(effectiveCacheKey, data);
  return data;
}

function msToClock(ms) {
  if (!Number.isFinite(ms)) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Normalizes a raw /tracks item into exactly what the UI needs. */
function normalizeTrack(t) {
  if (!t) return null;
  return {
    id: t.id,
    kind: 'track',
    title: t.title || 'Untitled',
    artist: t.user?.username || 'Unknown artist',
    artistId: t.user?.id,
    artworkUrl: (t.artwork_url || t.user?.avatar_url || '').replace('-large', '-t500x500'),
    durationMs: t.duration,
    durationLabel: msToClock(t.duration),
    permalinkUrl: t.permalink_url,
    waveformUrl: t.waveform_url || null,
    playCount: t.playback_count || 0,
    genre: t.genre || null,
  };
}

function normalizeUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    kind: 'artist',
    name: u.username || 'Unknown artist',
    avatarUrl: (u.avatar_url || '').replace('-large', '-t500x500'),
    followers: u.followers_count || 0,
    trackCount: u.track_count || 0,
    bio: u.description || '',
    permalinkUrl: u.permalink_url,
  };
}

function normalizePlaylist(p) {
  if (!p) return null;
  return {
    id: p.id,
    kind: 'playlist',
    title: p.title || 'Untitled playlist',
    creator: p.user?.username || 'Unknown',
    artworkUrl: (p.artwork_url || p.tracks?.[0]?.artwork_url || '').replace('-large', '-t500x500'),
    trackCount: p.track_count ?? p.tracks?.length ?? 0,
    permalinkUrl: p.permalink_url,
    tracks: Array.isArray(p.tracks) ? p.tracks.map(normalizeTrack).filter(Boolean) : [],
  };
}

/** Search tracks, artists, or playlists. kind: 'tracks' | 'users' | 'playlists' */
export async function searchSoundCloud(query, kind = 'tracks', { limit = 20 } = {}) {
  if (!query || !query.trim()) return [];
  const data = await scFetch(`/${kind}`, { q: query.trim(), limit });
  const list = Array.isArray(data) ? data : [];
  if (kind === 'tracks') return list.map(normalizeTrack).filter(Boolean);
  if (kind === 'users') return list.map(normalizeUser).filter(Boolean);
  return list.map(normalizePlaylist).filter(Boolean);
}

/** Trending tracks for a genre tag (see SOUNDCLOUD_GENRES in soundcloud-config.js). */
export async function getTrendingTracks(genreTag, { limit = 20 } = {}) {
  // Charts live on the newer api-v2 host; kept separate from API_BASE
  // since it's a distinct documented endpoint, not a v1 resource.
  const url = new URL('https://api-v2.soundcloud.com/charts');
  url.searchParams.set('kind', 'trending');
  url.searchParams.set('genre', genreTag);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('client_id', SOUNDCLOUD_CLIENT_ID);

  if (!hasSoundCloudCredentials()) {
    throw new SoundCloudError('SoundCloud isn\u2019t connected yet — add your API client_id in soundcloud-config.js.', { code: 'no-credentials' });
  }
  const cacheKey = url.toString();
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let response;
  try {
    response = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new SoundCloudError('Couldn\u2019t reach SoundCloud — check your connection.', { code: 'network' });
  }
  if (!response.ok) {
    throw new SoundCloudError(`SoundCloud returned an error (${response.status}).`, { status: response.status, code: 'http' });
  }
  const data = await response.json().catch(() => {
    throw new SoundCloudError('SoundCloud sent back something unexpected.', { code: 'parse' });
  });
  const tracks = (data?.collection || []).map((entry) => normalizeTrack(entry.track || entry)).filter(Boolean);
  cacheSet(cacheKey, tracks);
  return tracks;
}

export async function getArtist(userId) {
  const data = await scFetch(`/users/${userId}`, {});
  return normalizeUser(data);
}

export async function getArtistTracks(userId, { limit = 20 } = {}) {
  const data = await scFetch(`/users/${userId}/tracks`, { limit });
  return (Array.isArray(data) ? data : []).map(normalizeTrack).filter(Boolean);
}

export async function getPlaylist(playlistId) {
  const data = await scFetch(`/playlists/${playlistId}`, {});
  return normalizePlaylist(data);
}

/** Resolves any soundcloud.com URL (track, playlist, or user) to its API resource. */
export async function resolveSoundCloudUrl(url) {
  const data = await scFetch('/resolve', { url }, { cacheKey: `resolve:${url}` });
  if (data?.kind === 'track') return normalizeTrack(data);
  if (data?.kind === 'playlist') return normalizePlaylist(data);
  if (data?.kind === 'user') return normalizeUser(data);
  return data;
}

/** Fetches and normalizes a track's waveform peaks (0..1 range) for rendering. */
export async function getWaveformPeaks(waveformUrl, { targetPoints = 100 } = {}) {
  if (!waveformUrl) return [];
  const cacheKey = `waveform:${waveformUrl}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  let raw;
  try {
    const res = await fetch(waveformUrl);
    if (!res.ok) return [];
    raw = await res.json();
  } catch {
    return [];
  }
  const samples = raw?.samples || raw?.data || [];
  if (!samples.length) return [];

  // Downsample to targetPoints bars so rendering stays cheap regardless
  // of how many raw samples SoundCloud returns.
  const step = Math.max(1, Math.floor(samples.length / targetPoints));
  const max = Math.max(...samples, 1);
  const peaks = [];
  for (let i = 0; i < samples.length; i += step) {
    peaks.push(Math.min(1, samples[i] / max));
  }
  cacheSet(cacheKey, peaks);
  return peaks;
}
