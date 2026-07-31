

<div align="center">

<img src="public/pwa-icon.svg" alt="Meliora" width="100" height="100" />

# Meliora

**Immersive Web Music Player with Audio-Visual Integration**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=flat-square)](LICENSE)
[![Vue 3](https://img.shields.io/badge/Vue-3.5-42b883?style=flat-square&logo=vue.js&logoColor=white)](https://vuejs.org/)
[![Vite](https://img.shields.io/badge/Vite-8-646cff?style=flat-square&logo=vite&logoColor=white)](https://vite.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PWA](https://img.shields.io/badge/PWA-Ready-5a0fc8?style=flat-square&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

[Features](#-features) · [Quick Start](#-quick-start) · [Admin Dashboard](#-admin-dashboard) · [Shortcuts](#-shortcuts) · [Deployment](#-deployment) · [Development](#-development) · [Roadmap](ROADMAP.md)

[Live Demo](https://music.abloom.site) · [Report Issues](https://github.com/abloom25/Meliora/issues) · [Contributing Guide](CONTRIBUTING.md)

</div>

---

## ✨ Features

### Audio-Visual Integration

- 🎨 **Real-time Beat Analysis**: Web Audio API spectrum sampling drives background breathing effects, while album cover color extraction drives global theme transitions
- 🌈 **Dynamic Background**: Blurred album cover rendering + adjustable blur/saturation/rhythm brightness, supports disabling
- 🎵 **Zero-Lag Track Switching**: Triple Audio pool + preloading slots + smooth track crossfading

### Lyrics Experience

- 📜 **LRC Lyrics Sync**: FLIP-driven scrolling + line-by-line highlighting + adjustable font size
- 🪟 **Lyrics Pop-out Window**: Document Picture-in-Picture independent floating window, supports viewing lyrics while using external applications

### Playback Control

- 🎚️ **Built-in Equalizer**: 10-band gain adjustment + preset profiles
- ⏰ **Timer Shutdown**: Automatically stops playback after countdown
- 🔀 **Playback Modes**: Sequential / Shuffle / Single Loop
- ⏭️ **Auto-Skip**: Automatically skips to next track on load failure

### Immersive Mode

- 📱 **Fullscreen Mode**: One-click to occupy the entire screen
- 👻 **Auto-Hide**: Retains only song content after 30 seconds of mouse inactivity
- 📳 **Haptic Feedback**: Subtle vibrations on mobile for track switching/operations

### Platform Integration

- 📲 **PWA Installation**: Add to desktop, supports offline launch
- 🔒 **MediaSession**: Lock screen / Control Center playback controls
- 🔗 **Track Sharing**: Share current track via Web Share API

### Library Management

- 🌐 **Remote Playlists**: NetEase Cloud Music / QQ Music playlists, parsed via Meting API
- 💾 **Local Music**: Upload audio/covers/lyrics, automatic merge and deduplication
- ⚙️ **Visual Management**: Full-featured web admin dashboard, no code editing required

### Accessibility

- ♿ Supports `prefers-reduced-motion`
- ⌨️ Full keyboard shortcuts + focus trap
- 🎨 Dual status indicators with colors + icons

---

## 🚀 Quick Start

```powershell
pnpm install
pnpm dev          # Frontend only (5175)
pnpm dev:full     # Frontend + Backend simulation (5175 + 8788)
```

Requires Node 22+ and pnpm 11.5.3+.

- `pnpm dev`: Starts only the Vite frontend dev server, default port 5175, suitable for pure UI development
- `pnpm dev:full`: Starts Vite + Wrangler Pages Functions local simulation simultaneously, proxies `/api/*` requests to port 8788, allowing full testing of the admin dashboard (including the `/setup` initialization flow). Wrangler uses the `.wrangler/pages-dev-static` temporary static directory to launch local Functions; static pages are still served by Vite, independent of whether `dist` exists or is up-to-date.

The local backend can use development mode (`DEVELOPMENT=true` in `.dev.vars`), where configuration and passwords are not persisted and reset on restart. Copy [.dev.vars.example](.dev.vars.example) to `.dev.vars`, fill in a real GitHub Token, and disable `DEVELOPMENT` to test the full workflow.

---

## ⚙️ Admin Dashboard

Visit `https://your-domain/admin` to access the admin dashboard.

### First-Time Use

The first visit to `/admin` after deployment redirects to the `/setup` page, where you only need to set an admin password. The password is stored as a PBKDF2 hash and can later be changed on the "Security" page in the dashboard.

### Dashboard Features

| Page         | Function                                         |
| ------------ | ------------------------------------------------ |
| **Site**     | Site name, icon, Meting API endpoint, API Token  |
| **Playlists**| Add/Remove/Enable NetEase Cloud & QQ Music playlists |
| **Local Music**| Upload audio/covers/lyrics, edit track info    |
| **Analytics**| Umami / Google Analytics configuration           |
| **Advanced** | GitHub proxy, pre-release updates, custom CSS / JS |
| **Security** | Change admin password                            |
| **About**    | Version info, check updates, sync upstream code  |

When uploading a site icon or local music assets, the dashboard first creates staging Git Blobs not attached to any branch; only upon clicking save are the encrypted `public/config.json`, all staged files, and old assets no longer referenced in the config atomically written to the target branch via a single Git Tree / Commit. Cancelling or a save conflict will not prematurely overwrite or delete online files. A successful commit triggers the deployment platform's automatic rebuild; public player config is baked into the frontend bundle at build time, so the first screen no longer requests the admin API, while remote playlists still fetch Meting API in real-time based on `apiEndpoint` and playlist ID.

### Update Notes

The one-click update on the admin dashboard's "About" page syncs the official upstream version, suitable for deployments that haven't modified the source code and only maintain config/library via the dashboard.

Users only need to click "Update" once. The dashboard triggers a GitHub Action, which syncs upstream code in a `meliora-update/*` temporary branch, runs dependency installation, tests, type checking, linting, formatting checks, and building; upon passing verification, it merges the latest commit of the target branch, performs critical checks, and auto-merges & pushes back to the target branch only if there are no conflicts.

If it fails, conflicts, or gets rejected, the target branch remains unchanged. The dashboard displays the run status, failure reason, and GitHub Actions log link, requiring no manual merge from the user. The workflow preserves deployment data like `public/config.json`, `public/admin.json`, `public/music/`, `.github/workflows/`, `.prettierignore`, `.env`, `.env.local`, `.dev.vars`, and build artifacts; template files like `.env.example` and `.dev.vars.example` update with the upstream.

The new update protocol treats the workflow as a fixed launcher for the deployment repo itself: routine code, UI, backend, and dependency upgrades do not rewrite `.github/workflows/`, so only the auto-provided `GITHUB_TOKEN` by Actions is needed to push verified business code, eliminating the need for separate high-privilege PAT configuration for Actions. If the workflow itself needs upgrading, it must be synced manually; this does not block routine version updates.

> **Not Backward Compatible:** Legacy deployments require manual sync or redeployment once to adopt the new update protocol. Once migrated, routine upstream upgrades are handled via the dashboard's one-click update.

If the repository has branch protection enabled and forbids `github-actions[bot]` from pushing, the auto-merge will fail. You must allow GitHub Actions to write to the target branch, or switch to PR auto-merge mode later. If you have modified the source code, styles, workflows, or deployment config, do not use the one-click update. Instead, manually merge upstream code via Git and resolve conflicts.

---

## ⌨️ Shortcuts

| Shortcut        | Action             |
| ------------- | ---------------- |
| `Space`       | Play / Pause      |
| `←` / `→`     | Rewind / Fast-forward 5s |
| `Shift + ←/→` | Previous / Next Track  |
| `L`           | Toggle Lyrics Panel     |
| `S`           | Open Settings Drawer     |
| `F`           | Toggle Fullscreen         |
| `M`           | Toggle Mute         |
| `Esc`         | Close Drawer / Modal  |

Shortcuts are automatically disabled inside input fields.

---

## 🌍 Deployment

One-click deploy to the following platforms (click the icon, builds automatically after forking):

| Platform                 | One-Click Deploy                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vercel**           | [![Deploy](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fabloom25%2FMeliora)                                                                                                |
| **Netlify**          | [![Deploy](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/abloom25/Meliora)                                                                                  |
| **Cloudflare Pages** | [![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://deploy.workers.cloudflare.com/?url=https://github.com/abloom25/Meliora) |

### Environment Variables

Configure environment variables in Settings → Environment Variables on the platform Dashboard after deployment:

| Variable                    | Required | Description                                                                                                                                                                                        |
| ----------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GH_TOKEN`              | ✅   | GitHub Personal Access Token used during deployment runtime. Fine-grained tokens require `Contents: Read and write` + `Actions: Write`; classic tokens can use `repo` scope. No need to duplicate into GitHub Actions Secrets |
| `GH_REPO`               | Conditional | Repository identifier in `owner/repo` format. Automatically derived from `VERCEL_GIT_REPO_OWNER` / `VERCEL_GIT_REPO_SLUG` on Vercel with System Environment Variables enabled; must be filled for other platforms                                        |
| `CONFIG_ENCRYPTION_KEY` | ✅   | Configuration encryption key, a random string of 32+ characters. Required for config encryption, cookie signing, and generating public config at build time. Allows `GH_TOKEN` to be rotated independently without affecting encrypted configs                                                                   |
| `GH_BRANCH`             | ❌   | Target branch. Explicit value takes precedence; Vercel auto-derives from `VERCEL_GIT_COMMIT_REF`; defaults to `main` otherwise                                                                                                   |
| `GITHUB_PROXY`          | ❌   | GitHub proxy, must be a public HTTPS URL. Used for checking updates and pulling upstream code within workflows; triggering workflows and querying Actions status still require the deployment environment to access `api.github.com`                                               |
| `ADMIN_DISABLED`        | ❌   | Set to `true`/`1`/`yes`/`on` (case-insensitive) to disable the admin dashboard. `/admin` shows "Disabled", and all `/api/*` except the status probe return 403                                                                             |
| `DEVELOPMENT`           | ❌   | Set to `true`/`1`/`yes`/`on` (case-insensitive) to enter development mode: config and passwords are not persisted, encryption falls back to plaintext                                                                                                   |

> Generate `CONFIG_ENCRYPTION_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

> `CONFIG_ENCRYPTION_KEY` must be provided to both the platform's build environment and Functions/runtime environment. It decrypts `public/config.json` at build time to generate the frontend public config; if ciphertext config exists in the repo but this variable is missing during build, the build fails to prevent the site from silently running with an empty config.

> GitHub Actions verification strictly reads `.github/ci-public-config.json` and does not decrypt production configs, so `CONFIG_ENCRYPTION_KEY` does not need to be copied to GitHub Secrets. Production platform builds still strictly require the real key.

> ### 🎉 Zero-Configuration Password
>
> Visiting `/admin` after initial deployment automatically redirects to the `/setup` page to set the admin password—**no need to pre-configure any password in environment variables**.
>
> - **Password**: Set via the `/setup` page, hashed with PBKDF2 (100k iterations), and stored in the repo's `public/admin.json`. Can be changed later in the dashboard
> - **Cookie Signing Key**: Derived at runtime from `CONFIG_ENCRYPTION_KEY` (`HMAC-SHA256(key, "meliora-cookie-signing")`). **Never written to disk, and does not appear in any files/responses/logs**
> - **Key Strength Validation**: If `CONFIG_ENCRYPTION_KEY` is unset or too weak (< 32 chars / common weak keys) during initialization, the `/setup` page shows a warning and rejects initialization, prompting the user to configure it on the deployment platform first
> - **First-come, first-served**: Whoever visits `/setup` first sets the password. Once set, `/setup` automatically closes

> ### 🔒 Config File Encryption
>
> All configurations saved in the admin dashboard (site info, API Tokens, playlists, Umami / GA IDs, etc.) are **fully encrypted with AES-GCM 256** when written to the GitHub repository, storing only base64 ciphertext. Public player config is generated from it at build time, but `apiToken` never enters the frontend bundle; Meting API calls requiring a token should be supported via a dedicated backend proxy.
>
> - **Encryption Key**: Derived from `CONFIG_ENCRYPTION_KEY` using PBKDF2 (100k iterations). The key itself **is never written to disk or appears in any file**
> - **Key Decoupling**: `CONFIG_ENCRYPTION_KEY` is strictly for encryption/signing, while `GH_TOKEN` is only for GitHub API read/write. They are independent—`GH_TOKEN` can be rotated at any time without affecting encrypted configs
> - **Encryption Scope**: Both `public/config.json` (site config) and `public/admin.json` (password hash) are stored as ciphertext
> - **Build-time Public Config**: Build scripts decrypt and sanitize public site config before baking it into the frontend bundle; directly accessing repo files or `/admin.json` only reveals ciphertext
> - **Local Development**: When `DEVELOPMENT=true`, encryption is disabled; configs are stored in plaintext in memory for easier debugging

### Platform Instructions

<details>
<summary><strong>Vercel</strong></summary>

Includes `vercel.json`, auto-deploys after importing the repository.

- Framework: Vite (auto-detected)
- Build Command: `pnpm build`
- Output Directory: `dist`
- Install Command: `pnpm install --frozen-lockfile` (specified in config)
- Security headers (CSP / X-Content-Type-Options / X-Frame-Options / Referrer-Policy / Permissions-Policy), Service Worker caching strategy, static asset immutable caching, and SPA fallback are all configured in [vercel.json](vercel.json)

</details>

<details>
<summary><strong>Netlify</strong></summary>

Includes [netlify.toml](netlify.toml), auto-detected after connecting the repository.

- Build Command: `pnpm build` (specified in config)
- Publish Directory: `dist` (specified in config)
- Runtime: Node 22 + pnpm 11.5.3 (specified in config)
- Security headers, Service Worker caching strategy, static asset immutable caching, and SPA fallback are all configured

</details>

<details>
<summary><strong>Cloudflare Pages</strong></summary>

Includes [wrangler.toml](wrangler.toml), can be imported via console or deployed with `wrangler pages deploy dist`.

- Build Command: `pnpm build`
- Output Directory: `dist`
- `wrangler.toml` sets `pages_build_output_dir = "dist"`
- Security headers, Service Worker caching strategy, static asset immutable caching, and SPA fallback are configured via [public/\_headers](public/_headers) and [public/\_redirects](public/_redirects), copied to `dist` during build

</details>

All platform configurations are unified: build command `pnpm build`, output directory `dist`, with consistent security headers and caching strategies. Node version follows the `engines` requirement in `package.json`, with Netlify additionally locking the build environment version in `netlify.toml`.

---

## 🛠️ Development

```powershell
pnpm dev          # Dev server (frontend)
pnpm dev:full     # Dev server (frontend + backend simulation)
pnpm test         # Unit tests
pnpm type-check   # Type checking
pnpm lint         # ESLint
pnpm format       # Prettier
pnpm build        # Production build
```

### Local Config Sync

When `DEVELOPMENT=true`, admin dashboard config and passwords are still handled by the local backend in memory mode and reset on restart. To keep the main page reading "build-time public config" consistently with production, the Vite dev server syncs the config to `.meliora/config.local.json` and regenerates `src/generated/public-config.ts` after a successful dashboard save.

- `.meliora/` is in `.gitignore` and is for local debugging only.
- The main page does not request runtime config endpoints; it only reads the generated public config.
- When re-running `pnpm generate:public-config:dev`, if `.meliora/config.local.json` exists, it takes priority for generating the local public config.
- To test the real production pipeline, disable `DEVELOPMENT`, configure real `GH_TOKEN` / `GH_REPO` / `CONFIG_ENCRYPTION_KEY`, let the dashboard write to the repo, then build.

### Project Structure

```
src/
├── components/      Shared UI components (ConfirmModal / ToggleSwitch / Toast, etc.)
├── composables/     Business hooks (useAudioPlayer / useBeatAnalyser, etc.)
├── stores/          Pinia state management
├── services/        Remote IO abstractions (Meting API / Lyrics)
├── utils/           Pure function utilities (side-effect free, no DOM dependency)
├── workers/         Web Worker (theme color extraction)
├── admin/           Admin dashboard (standalone sub-app)
│   ├── components/  Dashboard UI components
│   ├── views/       Dashboard pages (Setup / Login / Dashboard / About)
│   └── services/    Dashboard API services
└── styles/          Global styles

server/              Edge Functions backend
├── core/            Core logic (routing / auth / config / upload)
└── tests/           Backend tests

api/                 Vercel Edge Function entry
functions/           Cloudflare Pages Function entry
netlify/             Netlify Function entry
```

Husky automatically runs `lint-staged` and `commitlint` on commit. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

---

## 🤝 Contributing

Contributions of all kinds are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for details; code style and design specs are in [agent.md](agent.md).

---

## 📄 License

[GNU Affero General Public License v3.0 or later](LICENSE) © abloom25

> AGPL-3.0 requires any derivative version **modified and deployed to the public** to provide the complete source code to users. For closed-source commercial use, please contact the author to negotiate a license.

---

<div align="center">

If this project helps you, feel free to give it a ⭐ Star

Made with ❤️ by [abloom25](https://github.com/abloom25) and OpenAI Codex

</div>
