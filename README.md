# Melody 🎵

A beautiful, offline-first music player PWA. No accounts, no login — just your music, your device, your soundtrack.

This is **Build Pass 1** of an incremental build. It includes the project skeleton, the full design system, and the complete first-launch → greeting → home flow. It's meant to be opened, tested, and edited on mobile as the app grows screen by screen.

## What's working right now

- ✅ Full folder structure (`css/`, `js/components`, `js/utils`, `js/services`, `assets/`)
- ✅ Design system: colors, type scale, spacing, radius, shadow, motion — all as CSS custom properties in `css/tokens.css`
- ✅ First-launch nickname capture (no login, stored locally via IndexedDB)
- ✅ One-time full-screen greeting (never shown again after first "Start Listening")
- ✅ Home screen: dynamic time-of-day greeting, search bar, section layout, bottom nav, mini player placeholder
- ✅ **Music import** — tap "Import Music," pick one or more files (MP3/FLAC/M4A/AAC/WAV/OGG), and they're read, duration-checked, filename-cleaned into a Title/Artist guess, checked for likely duplicates (with a Replace/Keep Both prompt), and saved to the on-device library. Imported songs immediately appear under "Recently Added."
- ✅ **Dark / light mode** — tap the circle icon in the top-right of Home to cycle appearance. Defaults to following the system setting, remembers your choice across launches, and applies with no flash on load.
- ✅ PWA basics: manifest, service worker (app-shell caching), installable, offline app shell
- ✅ Logo processed into all required icon sizes (192, 512, maskable, favicon, apple-touch-icon)

## What's next (not built yet — coming screen by screen)

- Metadata engine (ID3 read/write, MusicBrainz/AcoustID lookups, cover art fetching) — the `metadata` field on each song record is already reserved for this
- Full player screen with vinyl animation, queue, lyrics, EQ
- Favorites, playlists, folders, search, and a proper Settings screen (the theme toggle will move there and gain an explicit Light/Dark/System picker)
- Media Session API integration for lock screen / Bluetooth controls

## How music import works today

1. Tap **Import Music** on Home (or **＋ Import More Music** once your library isn't empty).
2. Pick one or more audio files from your device's file picker.
3. Each file is checked for a supported format, its duration is read, and its filename is cleaned into a Title/Artist guess (e.g. `Bruno_Mars_-505-song.mp3` → "505 — Bruno Mars").
4. If something that looks like the same song is already in your library, you'll be asked whether to replace it or keep both.
5. The song is saved locally (IndexedDB) — no upload, nothing leaves your device — and shows up under "Recently Added" right away.

Real ID3 tag reading, MusicBrainz/cover-art lookups, and lyrics fetching are **not** in this pass yet — songs are catalogued using the cleaned filename only for now. That's the next build pass.

## How dark/light mode works today

- Tap the icon at the top-right of Home to cycle: System → Dark → Light → System.
- Your choice is saved locally and re-applied instantly on every future launch (no flash of the wrong theme).
- "System" mode watches your OS setting live — if you switch your phone's appearance while Melody is open, it updates automatically.
- All colors are token-driven (`css/tokens.css`), so every screen you add going forward gets dark mode for free as long as it uses the existing `--color-*` variables instead of hardcoded hex values.

## Folder structure

```
melody/
├── index.html              # App shell entry point
├── manifest.json           # PWA manifest
├── service-worker.js        # Offline app-shell caching
├── css/
│   ├── tokens.css           # Design tokens — colors, type, spacing, motion
│   ├── base.css             # Reset + shared base styles
│   ├── onboarding.css       # Nickname + greeting screens
│   └── home.css             # Home screen, nav, mini player
├── js/
│   ├── app.js                # Boot sequence + route registration
│   ├── components/           # One file per screen/UI component
│   ├── utils/                # Storage, router, time-of-day, filename cleaner
│   └── services/             # (empty — metadata/import/library services land here)
└── assets/
    ├── icons/                # Generated app icons (192, 512, maskable, favicon)
    └── images/                # logo-master.png (original artwork)
```

## Running it locally

Because this uses ES modules and a service worker, it needs to be served over `http://` or `https://` (not opened as a raw `file://`). Any static server works:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Then open the printed local URL on your phone or desktop browser.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. In the repo settings, enable **Pages** → source: `main` branch, root folder.
3. Your app will be live at `https://<username>.github.io/<repo-name>/`.

No build step is required — it's plain HTML/CSS/JS by design, so it can be edited directly from a phone.

## Design tokens reference

| Token | Value | Use |
|---|---|---|
| `--color-bg` | `#F5F1EC` | App background |
| `--color-bg-secondary` | `#EAE3DB` | Section backgrounds |
| `--color-card` | `#FFFFFF` | Cards, sheets |
| `--color-text-primary` | `#1F1F1F` | Headings, primary text |
| `--color-text-secondary` | `#7A7A7A` | Captions, meta |
| `--color-accent` | `#232323` | Buttons, active states, vinyl |

No neon, no heavy gradients, no glassmorphism — subtle shadows only, per the design brief.
