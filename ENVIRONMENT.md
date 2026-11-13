# ENVIRONMENT.md — STEP 0 audit (2026-11-13)

Audited inside the Claude Code cloud session (ephemeral Linux container), not on your machine.

## System and tools

| Item | Result |
|---|---|
| OS | Ubuntu 24.04.5 LTS, x86_64, 4 vCPU, 15 GB RAM, no GPU |
| Disk | ~30 GB free of a per-session allowance |
| Node / npm | v22.23.4 / 10.9.9 |
| git | 2.43.0, push to `leiffurthersocial-rgb/modulo-places` works (session-scoped credentials) |
| GitHub CLI | gh 2.89.0 present, but `GH_TOKEN` is invalid for gh. GitHub operations go through the session's GitHub integration instead. Access is scoped to this repo only (e.g. `KhronosGroup/KTX-Software` releases → 403). |
| Vercel CLI | not installed, not authenticated. You declined a token in this session, so deploy is done via Vercel's Git integration (see SETUP.md). |
| Python | 3.13.18 |
| ffmpeg | 6.1.1 (apt) — libvorbis, libopus encoders present; AAC encoder `aac` (native) present |
| Blender | 4.0.2 (apt, headless `blender -b`) — installed |
| gltf-transform | @gltf-transform/cli 4.5.1 (devDependency) |
| KTX-Software (`ktx`/`toktx`) | **not installable** here (GitHub releases outside repo scope, no apt package). Replacement: `ktx2-encoder` 0.6.0 (Basis Universal compiled to WASM, MIT) runs in Node. Tested: 1024² RGBA → ETC1S in ~2.0 s, UASTC in ~0.2 s, valid KTX2 with full mip chain. gltf-transform's own `ktx2/etc1s/uastc` commands need the `ktx` binary (KTX-Software ≥ 4.4.0), so our pipeline uses `ktx2-encoder`'s gltf-transform transform instead. |
| sharp | installed (image decode/resize for the pipeline) |
| Playwright | 1.63.0 (pinned to the preinstalled Chromium 1243 build) |

## Headless WebGL2

- Chromium headless with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`:
  **WebGL2 = true**, renderer `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))`, `MAX_TEXTURE_SIZE` 8192.
- Three.js r187 + pmndrs/postprocessing 6.39.6 (Bloom, AgX tone mapping, Vignette, SMAA, half-float buffers) + Rapier 0.21 WASM: rendered and screenshotted on all three profiles with zero console errors (`tests/e2e/smoke.spec.ts`, 3 tests in ~11 s including build).
- Profiles: `desktop` 1920×1080, `ipad-keyboard` 1180×820 (no touch), `ipad-touch` 1180×820 (`hasTouch`, `isMobile`).
- Screenshot mode: `?shot=N` renders N fixed frames with a fixed delta, then sets `window.__shotReady = true` and stops the loop. SwiftShader is CPU rendering, so **performance numbers from this container are meaningless**; FPS targets must be measured on real hardware (benchmark route, Phase 1).

## Network

Started on your **Default** environment, which blocked almost every asset source. With your approval I created a personal environment **`modulo-places`** (20 exact hosts) and moved this session onto it.

| Host | Default env | `modulo-places` env |
|---|---|---|
| github.com, api.github.com, raw.githubusercontent.com | ok (repo-scoped) | ok (repo-scoped) |
| registry.npmjs.org, pypi.org, apt | ok | ok |
| api.polyhaven.com | blocked | **200** |
| dl.polyhaven.org | blocked | reachable (521 on bare root; file URLs to be tested in Phase 2) |
| ambientcg.com | blocked | **200** (API v2 JSON) |
| quaternius.com, kenney.nl | blocked | **200** |
| api.sketchfab.com | blocked | **200** |
| sketchfab.com (web) | blocked | **blocked** (not on list) |
| freesound.org | blocked | reachable; site/API answers 403 without a token (expected) |
| pixabay.com | blocked | reachable; API answers 405 without a key (expected) |
| fonts.googleapis.com | ok | ok; fonts.gstatic.com on list |
| threejs.org, webkit.org, developer.mozilla.org, developer.nvidia.com, caniuse.com, cdn.jsdelivr.net | blocked | **200** via curl |
| vercel.com, api.vercel.com | ok | ok |
| polyhaven.com, docs.ambientcg.com, docs.sketchfab.com, opengameart.org, iquilezles.org, medium.com, gltf-transform.dev | blocked | **blocked** (not on list) |

Notes:
- The **WebFetch tool bypasses the proxy** and still gets `ENOTFOUND` for the newly allowed hosts. Research uses `curl` through the proxy instead.
- Download CDNs used by Sketchfab and Freesound for actual files have not been tested yet. If Phase 2 hits a refused host, I will propose adding that exact host.
- Freesound needs an API token (`FREESOUND_API_KEY`) and Pixabay an API key (`PIXABAY_API_KEY`). Both are read from env vars and never committed.
