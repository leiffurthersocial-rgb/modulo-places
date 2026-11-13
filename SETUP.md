# SETUP.md — reproduce the toolchain

## 1. Prerequisites (your machine)

- Node 22+ and npm 10+
- git
- Optional, for the asset pipeline (Phase 2):
  - ffmpeg with libvorbis/libopus (macOS: `brew install ffmpeg`; Ubuntu: `apt install ffmpeg`)
  - Blender 4.x (headless baking/cleanup; optional)
  - KTX-Software is **not** required: textures are encoded with `ktx2-encoder` (Basis Universal WASM) from npm.

## 2. Install and run

```bash
git clone https://github.com/leiffurthersocial-rgb/modulo-places.git
```

```bash
cd modulo-places && npm ci
```

```bash
npm run dev
```

Other scripts:

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint (typescript-eslint) |
| `npm test` | Vitest unit tests |
| `npm run build` | typecheck + Vite production build to `dist/` |
| `npm run e2e` | Playwright smoke + screenshots (builds, serves on :4173) |

## 3. Playwright

The repo pins `@playwright/test` 1.63.0. On your machine install its browser once:

```bash
npx playwright install chromium
```

Headless runs use SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader`) so they work on CI without a GPU. Visual tests load pages with `?shot=N` (render N fixed frames, then `window.__shotReady = true`). Screenshots land in `screenshots/latest/` (gitignored).

## 4. Vercel (auto-deploy via Git integration)

1. In the Vercel dashboard choose **Add New → Project** and import `leiffurthersocial-rgb/modulo-places`.
2. Framework preset: **Vite**. Build command `npm run build`, output `dist` (already set in `vercel.json`).
3. Deploy. Every push then builds a Preview deployment, and pushes to `main` build Production.
4. Check the headers on a deployed asset:

```bash
curl -sI https://<your-deployment>.vercel.app/assets/<some-file>.js | grep -i cache-control
```

`vercel.json` sets `Cache-Control: public, max-age=31536000, immutable` for `/assets/*` (Vite emits hashed filenames there), `Content-Type: image/ktx2` for `.ktx2`, and `application/wasm` for `.wasm`.

CLI alternative, if you prefer:

```bash
npx vercel@latest login
```

```bash
npx vercel@latest --prod
```

## 5. CI

`.github/workflows/ci.yml` runs `npm ci`, typecheck, lint, unit tests and build on every push and PR (Node 22, Ubuntu).

## 6. Asset fetching (Phase 2)

The fetch script will read API keys from environment variables. Never commit them; `.env*` is gitignored.

```bash
export FREESOUND_API_KEY=...   # https://freesound.org/apiv2/apply
export PIXABAY_API_KEY=...     # https://pixabay.com/api/docs/
npx tsx scripts/fetch-assets.ts --scene forest
```

Downloads are cached in `.asset-cache/` (gitignored).

## 7. Cloud session environment

The Claude Code cloud environment `modulo-places` allows these exact hosts: GitHub, Vercel, api.polyhaven.com, dl.polyhaven.org, ambientcg.com, quaternius.com, kenney.nl, api.sketchfab.com, freesound.org, pixabay.com, threejs.org, webkit.org, developer.mozilla.org, developer.nvidia.com, cdn.jsdelivr.net, caniuse.com and fonts.gstatic.com. Package registries are also allowed. See ENVIRONMENT.md for the audit.
