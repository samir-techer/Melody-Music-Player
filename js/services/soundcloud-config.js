/**
 * soundcloud-config.js
 * The one place SoundCloud API credentials live. Everything else in the
 * SoundCloud feature (soundcloud-service.js, soundcloud-widget-player.js,
 * and the soundcloud-*-screen.js components) reads from here — nothing
 * else hardcodes a client_id.
 *
 * ============================================================
 * HOW TO GET A client_id (required for search/trending/genres/
 * artist profiles — everything except embedding a single known URL)
 * ============================================================
 * 1. Go to https://developers.soundcloud.com and register an app.
 *    Self-serve instant approval is no longer offered for most use
 *    cases — you'll go through SoundCloud's "Otto" review chatbot,
 *    which asks what your app does and grants (or denies) access.
 * 2. Once approved, your app's client_id appears in your developer
 *    dashboard. Paste it into SOUNDCLOUD_CLIENT_ID below.
 * 3. There is no bundler/env-var step in this project (plain ES
 *    modules, no build step) — this file IS the config. If you'd
 *    rather not commit a client_id to source control, leave this
 *    blank and set `window.__SOUNDCLOUD_CLIENT_ID` from a
 *    non-committed script tag before app.js loads instead; the
 *    fallback below picks that up automatically.
 *
 * ============================================================
 * IMPORTANT — read before enabling this for anyone but yourself
 * ============================================================
 * This SoundCloud section is wired up as an ADMIN-ONLY tool (see
 * app.js's 'soundcloud' route guard and shell.js's nav item). That's
 * deliberate: SoundCloud's API Terms of Use
 * (developers.soundcloud.com/docs/api/terms-of-use) explicitly
 * prohibit using the API to build "any service that aggregates and
 * streams User Content from multiple users into an on-demand
 * listening service" or "a page, profile, channel or other online
 * presence dedicated to one or more specific artists" — which is
 * exactly what a public-facing trending/genre/search/artist-profile
 * browsing tab would be. Keeping this behind the existing admin gate
 * (rather than shipping it to every Melody user) keeps it a personal
 * tool rather than a redistributed product feature. If you ever want
 * to open this up beyond admins, that's the point to go get
 * SoundCloud's explicit written sign-off first — this file isn't a
 * substitute for that conversation.
 *
 * Caching is intentionally session-only everywhere in this feature
 * (in-memory, cleared on reload) rather than using Melody's normal
 * persistent storage, per the Terms of Use's caching clause.
 */

export const SOUNDCLOUD_CLIENT_ID =
  (typeof window !== 'undefined' && window.__SOUNDCLOUD_CLIENT_ID) || '';

export function hasSoundCloudCredentials() {
  return Boolean(SOUNDCLOUD_CLIENT_ID);
}

/** Curated genre tags matching SoundCloud's own charts taxonomy (soundcloud:genres:*). */
export const SOUNDCLOUD_GENRES = [
  { key: 'all-music', label: 'All Music', tag: 'soundcloud:genres:all-music' },
  { key: 'hiphop', label: 'Hip-Hop & Rap', tag: 'soundcloud:genres:hiphoprap' },
  { key: 'electronic', label: 'Electronic', tag: 'soundcloud:genres:dance&electronic' },
  { key: 'pop', label: 'Pop', tag: 'soundcloud:genres:pop' },
  { key: 'rock', label: 'Rock', tag: 'soundcloud:genres:rock' },
  { key: 'indie', label: 'Indie', tag: 'soundcloud:genres:indie' },
  { key: 'rnb', label: 'R&B & Soul', tag: 'soundcloud:genres:rnbsoul' },
  { key: 'jazz', label: 'Jazz & Blues', tag: 'soundcloud:genres:jazzblues' },
  { key: 'ambient', label: 'Ambient', tag: 'soundcloud:genres:ambient' },
  { key: 'podcast', label: 'Podcasts', tag: 'soundcloud:genres:all-audio' },
];
