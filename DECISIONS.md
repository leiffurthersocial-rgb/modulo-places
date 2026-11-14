# DECISIONS.md

Newest first. Each entry: decision · why · source (only pages actually opened; see RESEARCH.md).

## 2026-11-14 — Scenes 2–4 and foliage

### D-036 All foliage is procedural, textured from baked scan atlases
Following D-031, broadleaf trees (maple, deciduous, jungle giant and canopy) are generated from leaf-cluster atlases baked from Poly Haven `tree_small_02`, with a crimson palette mapping for maples. Tropical plants (monstera, banana, elephant-ear, palm, tree fern) use leaves baked from the calathea / anthurium / fern scans. Bamboo uses procedural leaf sprays. Scatter ids are `broadleaf:*`, `tropical:*`, `conifer:*` and `log:*`. All have 3 variants × 3 LODs plus a baked impostor for big trees. Every procedural geometry runs `repairNormals` (D-033).

### D-035 Card light shafts for Medium/iPad
Medium and iPad get instanced, sun-aligned, soft additive beams in one draw call, seeded on a world grid around the camera. They follow the mood's shaft strength and are brightest when looking toward the sun. They fade for low suns (the beams would be near-horizontal panels) and when viewed along their axis. High and Ultra add the radial blur pass on top.

### D-034 Snow cover and night lights are material options
`patchMaterial({ snow })` blends snow onto up-facing surfaces by `scene.snowCover`; it is on for conifers, logs, GLB rocks and triplanar materials in snowy scenes. `patchMaterial({ nightLight })` scales emissive output by the mood's `post.nightLights`, for lanterns, shoji and windows. The sky has mood-driven aurora curtains and stars.

### D-033 Greybox/procedural geometry is textured by a world-space triplanar library
Placeholder buildings, ruins and props have no UVs. `scene.json.materials` lists pack materials with scale, tint, brightness and roughness. `sceneMaterial(key, fallback)` returns a world-space triplanar PBR material (instancing-aware), which builders use per part. The library is owned by SceneRuntime and disposed on exit.

### D-032 HDRIs light every scene but are never the visible sky
Same reasoning as the forest: wrong scale and resolution as a backdrop. Visible skies are the analytic gradient, plus aurora and stars at night.

## 2026-11-14 — M3 forest

### D-031 Scanned conifers are not usable as-is; trees become procedural with baked branch cards
Poly Haven's fir/pine scans carry 400k–800k needle cards per tree (5–17 triangles each). Every real-time budget (≈15k triangles per tree) either turns them into slivers (edge collapse) or leaves 0.4% of cards (decimation). The result is bare poles. Plan, as studios do with scans: bake branch-card textures from patches of the real twig scans, and generate trunks (scanned bark) + branch cards procedurally (≈5–8k triangles at LOD0). This is in progress. Until it lands, trees use the processed scans.

### D-030 Foliage-aware LODs
Foliage primitives (alpha-masked or named leaves/twigs/fern/grass/…) are reduced by keeping a deterministic subset of whole cards, enlarged ≤ 2.2× around their centres. Solid primitives use meshoptimizer `simplify` with a sloppy fallback for scans with many UV seams. This applies to saplings, ferns, grass, shrubs, nettles and weeds. Some decimated models trip meshopt's vertex encoder; those ship uncompressed (≈1.8 MB each) until investigated.

### D-029 Tuning against measured reference photos
15 Commons photos (5 per mood; licences in scratch REFERENCES.md, to be moved into the repo with the M3 review) give numeric targets:

| Mood | Mean luminance | Fog / haze | Other |
|---|---|---|---|
| Midday | ≈75–90 | ≈15% at 40 m | p5 shadows ≈5–18 |
| Dawn mist | ≈105–115 | 50% at 15–20 m, 90% at 50–60 m | — |
| Dusk | ≈35–50 | — | strongest shafts |

The first midday render measured mean 145, p5 86 and green saturation 0.08, all far too washed out. The fix is per-mood IBL strength, less hemisphere fill, less midday fog, lower exposure, and a per-mood shaft strength (midday ≈ none).

### D-028 Per-instance LOD/culling instead of cell buckets
32/64 m cell buckets gave 1,120 draw calls and 5.9 M scatter triangles at the forest spawn. Coarse cells also made LOD selection coarse: a whole cell went LOD0. Instances are now re-batched on the CPU when the camera moves ≥ 0.75 m or turns ≥ 4°. Each gets distance culling, a test against a frustum widened by 35% (it also keeps all instances within 12 m for shadows behind the camera) and its own LOD. The result is 267 draws and 1.0 M triangles at the same spot. Draw calls are now parts × LODs × variants per rule.

## 2026-11-13 — M2 asset pipeline

### D-027 Half-resolution normals on the 2k tier
Measured on `forest_leaves_02`, 2k normal map: UASTC+zstd 5.5 MB; UASTC RDO level 4 5.0 MB; RDO level 8 4.6 MB (ktx2-encoder's RDO barely helps); ETC1S 1.15 MB, but blocky. Non-hero materials therefore ship 1k UASTC normals in the 2k tier (≈1.4 MB). At walking distance on rough natural surfaces the loss is minor. Hero materials keep full-res normals. Colour maps are flagged sRGB in the KTX2 (`isSetKTX2SRGBTransferFunc`) so three decodes them correctly.

### D-026 Shipped asset files are content-hashed under /pack
`process-assets.ts` writes `public/pack/<kind>/<key>/<name>.<sha256-8>.<ext>` plus `public/pack/manifest.json`. Hashed names make long-term immutable caching safe; `vercel.json` gives `/pack/*` the same immutable header as `/assets/*`. The manifest itself is not hashed and is revalidated.

### D-025 Lab previews: Poly Haven live from CDN, ambientCG as committed WebP
Poly Haven's CDN sends `Access-Control-Allow-Origin: *` and its API terms allow live use with credit. So `/lab` loads Poly Haven candidates directly (1k JPG) and credits them on the page. ambientCG only ships zips, so its candidates become 1k WebP previews in `public/lab/acg/` (≈0.6 MB each). To limit repo growth, previews are generated per scene when that scene is being worked on (`--scene forest` now).

### D-024 KTX2 encoding settings
Colour uses ETC1S (q230, sRGB). ARM uses ETC1S (q200, linear). Normals use UASTC + zstd, because ETC1S block artefacts are very visible in normals. Tiers are 512/1k/2k, plus 4k for hero picks. GPU memory is ≈1 byte/px after transcoding to ASTC 4×4/ETC2, so a 2k material (3 maps, mips) is ≈16 MB.

### D-023 Model LODs inside one GLB
`simplify` (meshoptimizer) builds LOD1/LOD2 at ratios 0.35/0.12 by default (overridable per pick). These are merged as `LOD0..2` nodes into one GLB sharing the same KTX2 textures, then meshopt-compressed. Impostors are baked at scene load in the engine (resolution per quality tier) instead of shipped, which saves download and memory. This is implemented with the real trees in M3.

### D-022 Node fetch through the session proxy
Node's built-in `fetch` ignores `HTTPS_PROXY`. The npm scripts set `NODE_USE_ENV_PROXY=1`; it is a no-op on machines without a proxy.

### D-021 ambientCG download host
ambientCG's `/get` endpoint redirects to `acg-download.struffelproductions.com`. That exact host was added to the `modulo-places` cloud environment.

## 2026-11-13 — M1 engine greybox

### D-020 N8AO 2.0.1 + one-line patch for three r187
N8AO's multi-render-target class overrides `.texture` to return an array. three r187's `setupRenderTarget` reads `texture.mipmaps` from it and crashes. N8AO itself only uses `.textures[i]`, so the getter is removed via `patches/n8ao+2.0.1.patch` (`patch-package` in `postinstall`). Re-check on every N8AO/three upgrade.

### D-019 Rapier loaded lazily in its own chunk
The menu loads only the 978 kB main bundle. Rapier (4.3 MB min / 1.6 MB gzip, inlined WASM) is fetched on first scene entry and warmed while the menu is open. This is still the largest download; the non-compat package with a separate cached `.wasm` stays on the list.

### D-018 One InstancedMesh per 32 m cell per rule; LOD = geometry swap
Instance data is shared across LOD levels: the cell's mesh swaps `geometry` by camera distance ÷ lodBias. Cells beyond the rule's cull distance (scaled by the preset's draw distance) are hidden. Measured on the greybox: 485 draws / 1.8 M triangles at Ultra (110k instances), 81 draws / 0.4 M at Battery Saver (34k).

### D-017 Height fog by replacing three's fog chunks
`fog_*` shader chunks are replaced globally with an analytic exponential-height-fog integral plus sun in-scattering tint, driven by shared uniforms. A `FogExp2` placeholder enables `USE_FOG`. Every scene material must go through `patchMaterial()`.

### D-016 Review cameras are terrain-relative
`scene.json` camera Y values are heights above the terrain, so cameras stay valid when terrain parameters or seeds change.

### D-015 Post chain structure vs values
The pmndrs chain is rebuilt only when its structure changes (AO on/off, AA type, DOF live, CA, grain, shafts). Mood and photo values are pushed as uniforms every frame. Order: AO → DOF → god rays → [linear grade, bloom, tone map, display grade, vignette, grain] → CA → SMAA/FXAA. Tiled capture renders tiles with a margin (no lens FX), then applies vignette and grain once on the whole image.

## 2026-11-13 — STEP 0 / STEP 1

### D-014 Audio formats: Ogg (Opus/Vorbis) + AAC fallback
Safari/iPadOS only plays Ogg Opus/Vorbis from 18.4 (webkit.org, caniuse, MDN). We encode both and pick with `canPlayType`.

### D-013 Look controls without Pointer Lock on iPad
Pointer Lock is unsupported on iOS/iPadOS Safari (caniuse, MDN BCD, WebKit UnifiedWebPreferences). Input is feature-detected: Pointer Lock on desktop; press-drag + trackpad scroll look on iPad with a trackpad; virtual joystick + look area on touch.

### D-012 Vercel via Git integration, not CLI
You declined to give the session a Vercel token. Deploys therefore use Vercel's dashboard Git integration on push, which also gives auto-deploy. `vercel.json` holds the build settings and headers. Steps are in SETUP.md.

### D-011 Dedicated cloud environment `modulo-places`
The Default environment blocked every asset host. You approved a personal environment with 20 exact hosts. WebFetch still bypasses the proxy, so research uses curl. Not reachable: polyhaven.com (web), docs.ambientcg.com, docs.sketchfab.com, sketchfab.com (web), medium.com, iquilezles.org, shaderbits.com, sebh.github.io; the Apple developer forums return a bot check.

### D-010 KTX2 encoding with `ktx2-encoder` (Basis WASM), not KTX-Software
KTX-Software release binaries are unreachable from this session (GitHub is repo-scoped), and gltf-transform's `uastc`/`etc1s` commands spawn the `ktx` binary (≥ 4.4.0). `ktx2-encoder` 0.6.0 is MIT, wraps BinomialLLC basis_universal, runs in Node and plugs into gltf-transform. Tested locally (ENVIRONMENT.md). A repackaged native `basisu` binary on npm (`basis_universal`) was rejected: third-party build of unclear provenance.

### D-009 Tone mapping inside the post chain
Use pmndrs/postprocessing with `ToneMappingEffect(AGX)` last in the chain, the renderer at `NoToneMapping`, and HalfFloat buffers. This is the library's documented setup. AgX is default; ACES and Neutral are available as film looks.

### D-008 MSAA vs alpha-to-coverage
three's `Material.alphaToCoverage` only works with MSAA. three's doc phrases this as "renderer created with antialias: true". When rendering through a composer, the scene is drawn into the composer's multisampled input target (pmndrs `multisampling` option). A2C is a GL rasterizer state that applies to any multisampled framebuffer, but this path is **not yet verified** and will be tested in M1. Plan: High/Ultra use 4× MSAA input + A2C on foliage. Medium/iPad decided by on-device test (A2C+MSAA vs alpha test + sharpened alpha + SMAA). Battery Saver uses alpha test + no AA or FXAA.

### D-007 Instancing strategy
InstancedMesh per species × LOD × grid cell (≈ 24 m cells), `computeBoundingSphere()` per cell so three's per-mesh frustum culling works per cell. CPU LOD selection per cell with hysteresis. BatchedMesh is optional and gated on device tests. Safari supports `WEBGL_multi_draw` since 15 (MDN BCD), and three falls back to one draw per range without it.

### D-006 Ship WebGL2; keep a WebGPU door open
WebGPU ships by default in Safari 26 on iOS/iPadOS (WebKit blog, caniuse; desktop Safari 26 is "partial": on by default only on macOS 26). But N8AO and pmndrs/postprocessing are WebGL-only, and iPadOS < 26 devices would need the fallback anyway. So we ship `WebGLRenderer`. Scene and material code avoid raw GL and keep shader customization in a small `engine/render/materials` layer, so a later `WebGPURenderer` + TSL port touches only renderer, post and material modules.

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
