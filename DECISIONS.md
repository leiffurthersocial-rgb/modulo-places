# DECISIONS.md

Newest first. Each entry: decision · why · source (only pages actually opened; see RESEARCH.md).

## 2026-11-13 — STEP 0 / STEP 1

### D-014 Audio formats: Ogg (Opus/Vorbis) + AAC fallback
Safari/iPadOS only plays Ogg Opus/Vorbis from 18.4 (webkit.org, caniuse, MDN). We encode both and pick with `canPlayType`.

### D-013 Look controls without Pointer Lock on iPad
Pointer Lock is unsupported on iOS/iPadOS Safari (caniuse, MDN BCD, WebKit UnifiedWebPreferences). Input is feature-detected: Pointer Lock on desktop; press-drag + trackpad scroll look on iPad with a trackpad; virtual joystick + look area on touch.

### D-012 Vercel via Git integration, not CLI
You declined to give the session a Vercel token. Deploys therefore use Vercel's dashboard Git integration on push, which also gives auto-deploy. `vercel.json` holds the build settings and headers. Steps are in SETUP.md.

### D-011 Dedicated cloud environment `modulo-places`
The Default environment blocked every asset host. You approved a personal environment with 20 exact hosts. WebFetch still bypasses the proxy, so research uses curl. Not reachable: polyhaven.com (web), docs.ambientcg.com, docs.sketchfab.com, sketchfab.com (web), medium.com, iquilezles.org, shaderbits.com.

### D-010 KTX2 encoding with `ktx2-encoder` (Basis WASM), not KTX-Software
KTX-Software release binaries are unreachable from this session (GitHub is repo-scoped), and gltf-transform's `uastc`/`etc1s` commands spawn the `ktx` binary (≥ 4.4.0). `ktx2-encoder` 0.6.0 is MIT, wraps BinomialLLC basis_universal, runs in Node and plugs into gltf-transform. Tested locally (ENVIRONMENT.md). A repackaged native `basisu` binary on npm (`basis_universal`) was rejected: third-party build of unclear provenance.

### D-009 Tone mapping inside the post chain
Use pmndrs/postprocessing with `ToneMappingEffect(AGX)` last in the chain, the renderer at `NoToneMapping`, and HalfFloat buffers. This is the library's documented setup. AgX is default; ACES and Neutral are available as film looks.

### D-008 MSAA vs alpha-to-coverage
three's `Material.alphaToCoverage` only works with MSAA. When rendering through a composer, MSAA comes from the composer's multisampled input target, not `antialias: true`. Plan: High/Ultra use 4× MSAA input + A2C on foliage. Medium/iPad decided by on-device test (A2C+MSAA vs alpha test + sharpened alpha + SMAA). Battery Saver uses alpha test + no AA or FXAA.

### D-007 Instancing strategy
InstancedMesh per species × LOD × grid cell (≈ 24 m cells), `computeBoundingSphere()` per cell so three's per-mesh frustum culling works per cell. CPU LOD selection per cell with hysteresis. BatchedMesh is optional and gated on device tests. Safari supports `WEBGL_multi_draw` since 15 (MDN BCD), and three falls back to one draw per range without it.

### D-006 Ship WebGL2; keep a WebGPU door open
WebGPU ships by default in Safari 26 on iOS/iPadOS (WebKit blog, caniuse). But N8AO and pmndrs/postprocessing are WebGL-only, and iPadOS < 26 devices would need the fallback anyway. So we ship `WebGLRenderer`. Scene and material code avoid raw GL and keep shader customization in a small `engine/render/materials` layer, so a later `WebGPURenderer` + TSL port touches only renderer, post and material modules.

### D-005 Geometry compression: meshopt (not Draco) by default
meshopt decodes much faster than Draco, which favours compression ratio over decode speed. That matters on iPad load times. Draco is only used if a specific asset is much smaller with it.

### D-004 Deterministic screenshot mode for visual QA
Headless Chromium runs on SwiftShader (software). `?shot=N` renders N fixed frames with a fixed timestep, then signals `window.__shotReady`. Performance numbers come only from real hardware via the benchmark route.

### D-003 Toolchain pins
three 0.187.0, postprocessing 6.39.6, Rapier (compat) 0.21.0, Vite 7.3.8, TypeScript 5.9.3 strict (+ `noUncheckedIndexedAccess`), Vitest 5.1.0 (4.1.12 hit an npm resolver crash), @playwright/test 1.63.0 (must match the preinstalled browser build), ESLint 9 + typescript-eslint 8, Prettier 3.

### D-002 Rapier via `@dimforge/rapier3d-compat`
The compat build embeds the WASM (base64), so it needs no special Vite WASM plugin and works in Vitest under Node. Measured cost: the pipeline bundle is 5.0 MB minified / 1.86 MB gzip, mostly the base64-inlined WASM. Phase 1 action: load Rapier via dynamic `import()` in its own chunk, so the menu loads instantly, and evaluate the non-compat package that serves a separate `.wasm`, cached long-term by `vercel.json`.

### D-001 Seeded everything
All scatter uses one seeded PRNG stream per scene (sub-streams per rule), so layouts are reproducible and testable.
