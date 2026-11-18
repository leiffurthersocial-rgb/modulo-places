# SETUP.md: Modulo: Classroom

Classroom shares its toolchain with Modulo: Places (same repo). The root `SETUP.md` covers prerequisites, Playwright and Vercel. This file lists what is specific to Classroom.

## Run it

```bash
git clone https://github.com/leiffurthersocial-rgb/modulo-places.git
```

```bash
cd modulo-places && git checkout claude/modest-mayer-c7ywum && npm ci
```

```bash
npm run dev
```

Then open http://localhost:5173/classroom.html. Useful URL parameters:

| Parameter                            | Meaning                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `?seed=42` or `?seed=monday`         | Simulation seed (integers are used as-is, words are hashed)                                   |
| `?shot=3`                            | Screenshot mode: fixed 1/20 s step, renders 3 frames, sets `window.__shotReady = true`, stops |
| `?cam=seat` / `overview` / `teacher` | Camera for screenshot mode                                                                    |

## Tests

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npx vitest run tests/unit/classroom-core.test.ts
```

```bash
npx playwright test tests/e2e/classroom.spec.ts --trace off
```

Screenshots go to `screenshots/latest/classroom-<cam>-<profile>.png` (gitignored). On your own machine, install the Playwright browser once:

```bash
npx playwright install chromium
```

## Architecture guard

`eslint.config.js` forbids imports of three/render/ui/audio/input and the use of `window`, `document`, `performance`, `Math.random` and `Date.now` inside `src/classroom/sim/**`. If lint fails there, move the code to `render/` or `ui/`, or use `sim/rng.ts` and `sim/clock.ts`.

## Room layout

Edit `src/classroom/data/layouts/classroom-a.json`. Its coordinate conventions are documented in its `$comment` and in `DECISIONS.md` C-015. The unit test `classroom layout › validates` catches duplicate ids, objects outside the room, openings wider than their wall and broken seat→table references.

## Deploy

The Vercel Git integration is already connected. Every push to `claude/modest-mayer-c7ywum` builds a Preview deployment; the page is at `/classroom` (rewrite) or `/classroom.html`. Production (`modulo-places.vercel.app`) follows the repo's default branch, which is currently the Places branch.

## Asset keys (Phase 4, not needed yet)

```bash
export PEXELS_API_KEY=...      # https://www.pexels.com/api/
```

```bash
export FREESOUND_API_KEY=...   # https://freesound.org/apiv2/apply
```

```bash
export PIXABAY_API_KEY=...     # https://pixabay.com/api/docs/
```

Kenney's website refuses scripted downloads from the cloud container (HTTP 403 from the site). Phase 4 will include a manual download list, or a command for your machine.

## Reference photos

Put your photos in `reference/`. They are gitignored because the repo is public (see `reference/README.md`).
