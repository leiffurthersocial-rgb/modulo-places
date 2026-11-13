# PLAN.md — Modulo: Places

Status: **awaiting your OK**. Nothing beyond the STEP 0 pipeline proof is built yet.

## 1. Milestones and review stops

| # | Milestone | Done when | Stop for review |
|---|---|---|---|
| M1 | **Engine greybox** (Phase 1) | Walk/crouch/sprint with Rapier capsule on a heightfield. Data-driven scene loader. Seeded scatter with ~100k placeholder instances. 3 lighting moods with cross-fade. Quality manager + presets. Photo mode (free-fly, focal length, focus picker, exposure, DOF on capture, PNG 1×/2×). F3 overlay. Touch controls. Menu. Enter/exit leak test. Benchmark route. Screenshots of each mood × {desktop, iPad}. | **Yes** |
| M2 | **Asset pipeline + Material/Asset Lab** (Phase 2) | `fetch-assets.ts` (Poly Haven, ambientCG v3, Quaternius, Kenney, Sketchfab CC0/CC-BY via token, Freesound; Pixabay audio via a manual list) with cache and license capture. `process-assets.ts` (KTX2 tiers, ORM packing, meshopt, LOD/impostor gen, audio Opus/Vorbis OGG + AAC fallback (Ogg only plays from Safari 18.4), size report). `LICENSES.json` + Credits. `/lab` with ≥ 8 candidates per key material per scene. | Yes, so you can pick materials in `/lab` |
| M3 | **Misty forest, full quality** (Phase 3) | 3 moods hand-tuned. 6 fixed cameras × 3 moods × 2 viewports reviewed against reference photos. SCENE_GUIDE.md written. | **Yes** |
| M4 | Japanese village | Per SCENE_GUIDE.md | **Yes** |
| M5 | Jungle ruin | Per SCENE_GUIDE.md | **Yes** |
| M6 | Snowy cabin | Per SCENE_GUIDE.md | **Yes** |
| M7 | Quality tiers + Battery Saver hardening (Phase 5) | Most of the tier system lands in M1. This is the tuning and measurement pass on real devices. | Yes |
| M8 | Polish (Phase 6) | Tutorial hint, accessibility, preview stills, final perf pass | Yes |

M2 can start in parallel with late M1 work because it is mostly scripts. I will still stop at M1 first, as you asked.

## 2. Architecture

```
src/
  engine/
    core/        app loop, clock, events, frame limiter (60/30 cap), visibility pause
    render/      renderer setup (WebGL2), quality manager, post chain (pmndrs/postprocessing),
                 material extensions (wind, splat/triplanar, wetness/snow, dither-fade) via onBeforeCompile
    assets/      loader (GLTF+meshopt, KTX2Loader, audio), cache, refcounting, dispose, memory estimator
    terrain/     heightfield gen/import, chunked mesh, splat rules, Rapier heightfield collider
    scatter/     seeded PRNG, Poisson/jitter, masks (slope/height/moisture/exclusion), cells, LOD, impostors
    atmosphere/  sky (analytic + HDRI), height fog, mist cards, light shafts, particles
    lighting/    moods (data), cross-fader, sun/shadows (CSM-lite), probes/env
    water/       stream/pond shader
    audio/       ambience layers, positional emitters, footsteps by surface, mood cross-fade
    input/       keyboard/mouse (Pointer Lock with fallback), touch joystick/look, remapping
    player/      Rapier capsule controller, head-bob, soft boundaries
    photo/       free camera, lens model, capture (tiled hi-res), film looks
    debug/       F3 overlay, seed override, benchmark camera paths
  scenes/<id>/   scene.json + overrides.ts (optional custom code per scene)
  ui/            menu, settings, credits, loading screen, photo-mode panel, touch HUD (plain DOM + CSS, no framework)
  data/          JSON schemas, quality presets, film-look LUT params
  config/        material/asset picks from /lab
scripts/         fetch-assets.ts, process-assets.ts, bake-impostors.ts, size-report.ts
tests/unit       Vitest   ·   tests/e2e  Playwright
```

- **Data-driven scenes**: `scene.json` holds terrain source and params, material layers + splat rules, scatter rules, hero props (transforms), collision proxies, spawn, bounds, ambience layers and moods. It is validated by a hand-written TypeScript schema validator (no runtime dependency) and tested in Vitest.
- **Rendering**: `WebGLRenderer` (WebGL2) → one `RenderPass` + one merged `EffectPass`: AO (N8AO), bloom, DOF (photo mode), LUT/grade, AgX tone map, vignette, grain, CA, SMAA. MeshStandardMaterial everywhere, extended via `onBeforeCompile` (no raw GL in scene code), to keep a later WebGPU/TSL port contained (D-006).
- **Vegetation**: InstancedMesh per species × LOD × 24 m cell. Wind in the vertex shader uses a GPU Gems 3 ch.16-style main bend + detail bend, with vertex-colour masks. Dither cross-fade between LODs. Baked billboard impostors far out.
- **Terrain**: CPU-generated heightfield (fBm + domain warp + erosion fake) in a Worker. Chunked mesh, 4-layer splat with height-based blending, biplanar on steep slopes only, hex/stochastic tiling + macro variation on High+.
- **Atmosphere**: analytic exponential height fog in the material fog chunk. Mist cards. Light shafts via a downsampled radial-blur pass (GPU Gems 3 ch.13 approach) on High+, god-ray cards on Medium. Sky = HDRI (≤ 2k on iPad) or analytic sky per mood, with PMREM IBL.
- **Seeded scatter**: `mulberry32`-style PRNG; one master seed per scene and per-rule sub-seeds. The debug menu can override the seed.
- **Leak checks**: everything allocated goes through the asset registry with refcounts. Scene exit disposes geometries, materials, textures, render targets and Rapier world. `renderer.info.memory` must return to the menu baseline after N enter/exit cycles (Playwright test).

## 3. Quality tiers (initial; tuned in M7 on real devices)

| Setting | Ultra | High | Medium (iPad default) | Low | Battery Saver |
|---|---|---|---|---|---|
| Render scale (× DPR, DPR capped 2) | 1.0 | 1.0 (DPR ≤ 1.5) | 0.85 | 0.75 | 0.7 (DPR 1) |
| FPS cap | 60 | 60 | 60 | 30 | 30 |
| Shadows | 2 cascades 2048, 80 m | 2 × 2048, 60 m | 1 × 2048, 40 m | 1 × 1024, 25 m | off (baked AO only) |
| AO | N8AO High | N8AO Medium | N8AO Performance, half-res | off | off |
| AA / foliage alpha | MSAA 4× + A2C + SMAA | MSAA 4× + A2C | SMAA, alpha test (A2C if test passes) | FXAA | none |
| Bloom / grade / grain / CA | all | all | bloom + grade | grade | tone map only |
| Light shafts | radial blur | radial blur | cards | cards | off |
| Texture tier | 2k (4k hero) | 2k | 1k (2k hero) | 1k | 512 / 1k |
| Veg density × / draw dist | 1.0 / 200 m | 0.85 / 160 m | 0.6 / 120 m | 0.4 / 90 m | 0.3 / 70 m |
| LOD bias | 1.25 | 1.0 | 0.8 | 0.6 | 0.5 |
| Water | refraction + SSR-lite | refraction + env reflection | env reflection | simple | simple |
| Particles | full | full | 50% | 25% | minimal |
| Live DOF | yes | yes (photo mode) | capture only | capture only | capture only |
| Anisotropy | 8 | 4 | 4 | 2 | 1 |

Battery Saver also pauses rendering when the tab is hidden or a menu is open, and applies heavy photo effects only on capture. An opt-in watchdog steps down one tier after ~5 s with p90 frame time over budget. Settings persist in localStorage, wrapped in try/catch.

## 4. iPad memory budget (conservative)

There is no published hard limit for a WebGL tab on iPad Safari; exceeding memory reloads the page. The budget is self-imposed:

| Bucket | Medium / iPad | Battery Saver |
|---|---|---|
| GPU textures (KTX2→ASTC/ETC2, incl. mips) | ≤ 256 MB | ≤ 128 MB |
| Geometry + instance buffers | ≤ 96 MB | ≤ 64 MB |
| Render targets (post, shadows) | ≤ 96 MB | ≤ 40 MB |
| JS heap (incl. Rapier WASM) | ≤ 200 MB | ≤ 160 MB |
| **Total target** | **≤ ~650 MB** | **≤ ~400 MB** |
| Download per scene (first visit) | ≤ 60 MB | ≤ 35 MB |

Rules: KTX2 everywhere; HDRIs ≤ 2k on iPad (1k on Saver); share materials; one scene in memory at a time; dispose on exit. Handle `webglcontextlost` by showing a "reload scene" prompt. The F3 overlay shows a running texture/geometry/RT memory estimate against these budgets.

## 5. Performance targets and how they are proven

- Targets: 60 FPS on desktop (High), ≥ 30 FPS on iPad (Medium), on the M1 greybox with ~100k scattered instances.
- **This container cannot measure them**: it has no GPU, and SwiftShader is CPU-only. The benchmark route (`/bench?scene=greybox&preset=medium`) runs a scripted camera path and prints avg/p95 frame time, draw calls and triangles. I will ask you to open it on your desktop and iPad at M1. Please tell me which iPad model you test on.

## 6. Working method

- Subagents (Sonnet/Haiku) handle research, verification and mechanical tasks in parallel, to save time and usage. I keep architecture, rendering and visual review.
- After every visual change: Playwright `?shot=N` screenshots per mood × {desktop 1920×1080, iPad 1180×820}, which I review critically. From M3 on, also against reference photos (cited only if opened).
- DECISIONS.md is updated with every non-trivial choice.
- Each review stop delivers: summary, mood screenshots, perf numbers (from your devices) and memory numbers (from the estimator), open issues, next-milestone proposal.

## 7. What I need from you

1. **OK on this plan** (or changes).
2. Vercel: import the repo in the Vercel dashboard (SETUP.md §4), or tell me to skip deploys until later.
3. Before M2, audio sources. The **Pixabay API serves only images and videos**, so Pixabay sounds can't be scripted; they'd be a manual download list with license notes. **Freesound** gives previews (lossy mp3/ogg) with a plain API token, but originals need an OAuth2 login. Options: (a) previews only, token via the secure form (good enough for ambience beds? probably not for close footsteps); (b) you run an OAuth2 download command on your machine, which I'll script; (c) CC0 packs from Kenney/Quaternius-style sources plus manual picks. I recommend (b) for originals plus (a) for quick auditioning.
4. Your test hardware: iPad model / iPadOS version, and whether you use a Magic Keyboard/trackpad.

## 8. Top risks (details in RESEARCH.md)

1. **No real-GPU measurement in the cloud**: perf claims depend on your device runs.
2. **iPad memory/fill rate**: dense alpha foliage + MSAA + post can exceed budget. Mitigation: tiered A2C/alpha test, half-res AO, render scale, overdraw debug view.
3. **Pointer Lock is not supported on iPadOS Safari** (caniuse, MDN BCD, WebKit prefs: disabled on iOS family). Mitigation: feature-detect. On iPad, trackpad/mouse uses press-and-drag to look (two-finger trackpad scroll also turns the view). Touch gets the joystick + look area. Desktop uses Pointer Lock.
4. **Asset quality vs size**: Poly Haven scans are heavy. Mitigation: meshopt simplify LOD chains, texture tiers, impostors, per-tier size report.
5. **Some sources still unreachable** (polyhaven.com web pages, Sketchfab web/CDN hosts, Freesound file CDN). I'll propose exact hosts as they come up, or give you local commands.
6. **Library lag**: postprocessing/N8AO are WebGL-only, and three moves fast. Mitigation: pinned versions; WebGPU path deferred.
