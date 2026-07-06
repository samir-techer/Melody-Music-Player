# Melody 🎵

A beautiful, offline-first music player PWA. No accounts, no login — just your music, your device, your soundtrack.

This is **Build Pass 1** of an incremental build. It includes the project skeleton, the full design system, and the complete first-launch → greeting → home flow. It's meant to be opened, tested, and edited on mobile as the app grows screen by screen.

## What's working right now

- ✅ Full folder structure (`css/`, `js/components`, `js/utils`, `js/services`, `assets/`)
- ✅ Design system: colors, type scale, spacing, radius, shadow, motion — all as CSS custom properties in `css/tokens.css`
- ✅ First-launch nickname capture (no login, stored locally via IndexedDB)
- ✅ One-time full-screen greeting (never shown again after first "Start Listening")
- ✅ Home screen shell: dynamic time-of-day greeting, search bar, section layout, bottom nav, mini player placeholder
- ✅ PWA basics: manifest, service worker (app-shell caching), installable, offline app shell
- ✅ Logo processed into all required icon sizes (192, 512, maskable, favicon, apple-touch-icon)

## What's next (not built yet — coming screen by screen)

- Music import + filename cleaning pipeline (`js/utils/filename-cleaner.js` is stubbed and ready)
- Metadata engine (ID3 read/write, MusicBrainz/AcoustID lookups, cover art fetching)
- Full player screen with vinyl animation, queue, lyrics, EQ
- Favorites, playlists, folders, search, settings screens
- Media Session API integration for lock screen / Bluetooth controls

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
