# RESEARCH.md: Modulo: Places

## Method & source status

Research was done by four parallel subagents (A rendering, B vegetation/terrain, C atmosphere/lighting, D photo/assets/iPad). WebFetch was blocked by the sandbox, so pages were opened with curl through the session proxy; GitHub raw sources, threejs.org docs, MDN BCD, caniuse, webkit.org and developer.nvidia.com GPU Gems chapters were eventually reachable. Hosts that stayed unreachable: polyhaven.com (web pages; api.polyhaven.com works), docs.ambientcg.com, docs.sketchfab.com, sketchfab.com (web), medium.com, iquilezles.org, shaderbits.com, sebh.github.io, and the Apple developer forums (bot-check page). Only sources actually opened are cited with URLs. Anything else is marked "(unverified, source not opened)" and kept in an "Unverified practice notes" subsection. No performance number here was measured: this container has no GPU, so every cost claim needs a run on real desktop and iPad hardware (PLAN.md §5).

---

## 1. Three.js performance

- BatchedMesh supports per-instance frustum culling, sorting, per-instance matrix/colour/visibility, but has no per-instance LOD, takes a single material, and requires all geometries to share index usage and attribute layout (runtime-validated, throws). https://raw.githubusercontent.com/mrdoob/three.js/dev/src/objects/BatchedMesh.js
- Without `WEBGL_multi_draw`, BatchedMesh falls back to one draw call per range, so it works but loses the draw-call saving. https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/WebGLRenderer.js
- MDN browser-compat-data lists `WEBGL_multi_draw` in Safari 15, iOS mirrored. https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/WEBGL_multi_draw.json
- InstancedMesh culls as a whole: `boundingSphere` is null until `computeBoundingSphere()` and is a union over instances; `dispose()` frees instanceMatrix, instanceColor and morphTexture. https://raw.githubusercontent.com/mrdoob/three.js/dev/src/objects/InstancedMesh.js ; https://threejs.org/docs/pages/InstancedMesh.html
- `LOD.addLevel(object, distance, hysteresis)`: hysteresis is a fraction of distance that keeps the current level active slightly longer; `autoUpdate` is true by default. https://raw.githubusercontent.com/mrdoob/three.js/dev/src/objects/LOD.js
- `Material.alphaToCoverage` "can only be used with MSAA-enabled contexts (renderer created with antialias true)". `Material.forceSinglePass` avoids the two-draw-call path for double-sided transparent objects such as grass sprites. https://raw.githubusercontent.com/mrdoob/three.js/dev/src/materials/Material.js
- `WebGLCapabilities` reads `MAX_SAMPLES` and downgrades precision with a warning. https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgl/WebGLCapabilities.js
- No authoritative draw-call or triangle budget was found in any opened source; budgets in PLAN.md are project targets, not citations.

**Unverified practice notes (source not opened):** the three.js manual pages on cleanup/optimization/LOD returned 404. Standard advice, not verified here: call `dispose()` on geometry, materials, textures and render targets; MeshStandardMaterial is cheaper than Physical (clearcoat/transmission/sheen); verify leaks with `renderer.info`.

**What we decided because of it**
- InstancedMesh per species x LOD x ~24 m cell with `computeBoundingSphere()` per cell; BatchedMesh stays optional and gated on on-device tests (D-007).
- `forceSinglePass = true` on double-sided blended foliage; prefer alpha test (+A2C where MSAA is on) over blending (D-008).
- Disposal goes through the refcounted asset registry, verified by an `renderer.info.memory` enter/exit Playwright test (PLAN §2).

## 2. Asset pipeline

- gltf-transform CLI has `optimize`, `meshopt`, `draco`, `resize`, `webp`, `simplify`, and `uastc`/`etc1s` (KTX2 via Basis). `optimize --texture-compress ktx2` runs UASTC then ETC1S passes. https://github.com/donmccurdy/glTF-Transform ; https://raw.githubusercontent.com/donmccurdy/glTF-Transform/main/packages/cli/src/cli.ts
- Its texture step spawns the `ktx` binary (`ktx create`), requiring KTX-Software >= 4.4.0 on PATH (not `toktx` as older docs imply). https://raw.githubusercontent.com/donmccurdy/glTF-Transform/main/packages/cli/src/transforms/toktx.ts ; https://github.com/KhronosGroup/KTX-Software
- Basis Universal: ETC1S roughly 0.3-3 bpp, low-to-medium quality; UASTC LDR 4x4 is a fixed 8 bpp with higher quality; transcodes to ASTC, BC1-7, ETC1/2, PVRTC. https://github.com/BinomialLLC/basis_universal
- KTX2Loader needs `detectSupport(renderer)`, transcodes in a wasm worker pool (`setWorkerLimit`), and warns if several loaders exist. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/loaders/KTX2Loader.js
- iPad Safari exposes ASTC (Safari 12) and ETC2 (13.1) per MDN BCD, so UASTC/ETC1S can transcode there. https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/WEBGL_compressed_texture_astc.json ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/WEBGL_compressed_texture_etc.json
- meshoptimizer claims 3-6 GB/s vertex/index decode on modern desktop CPUs (the project's own claim, no iPad numbers) and describes Draco as maximizing ratio, possibly at decode-speed cost. https://github.com/zeux/meshoptimizer
- DRACOLoader: wasm decoder with JS fallback, worker pool default 4. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/loaders/DRACOLoader.js
- three-mesh-bvh claims 500 rays against an 80k-polygon model at 60 fps, `firstHitOnly` fast path, BatchedMesh support, async build and serialization; static hierarchy (no skinning/morph). https://github.com/gkjohnson/three-mesh-bvh
- Tiers: use UASTC for hero albedo/normal, ETC1S for foliage/ground/atlases (recommendation, quality trade-off not measured).

**Unverified practice notes:** gltfpack `-si` behaviour and the gltfpack npm package were not opened; `simplify` is not on the gltf-transform README but exists in CLI source.

**What we decided because of it**
- meshopt by default, Draco only if a specific asset is much smaller (D-005).
- KTX2 is encoded with `ktx2-encoder` (Basis WASM), not the KTX-Software binary, because release binaries were unreachable (D-010).
- three-mesh-bvh for focus picking (center ray, `firstHitOnly`) and ground snapping on static meshes only, built async.

## 3. Post-processing on iPad

- three's `examples/jsm/postprocessing` ships BokehPass, GTAOPass, SAOPass, SSAOPass, SMAAPass, FXAAPass, SSAARenderPass, TAARenderPass, UnrealBloomPass, OutputPass, LUTPass, EffectComposer. https://github.com/mrdoob/three.js/tree/dev/examples/jsm/postprocessing
- EffectComposer defaults to HalfFloatType targets with ping-pong between two targets, no MSAA parameter. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/postprocessing/EffectComposer.js
- GTAOPass needs depth, reconstructs normals, uses half-float targets and is documented as costlier than SSAOPass; no mobile notes. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/postprocessing/GTAOPass.js
- TAARenderPass is static-scene jitter accumulation, not reprojection TAA, so it is useless while walking. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/postprocessing/TAARenderPass.js
- The TSL/WebGPU path has TRAANode (needs depth + velocity, two half-float history targets; MSAA must be disabled), GTAONode, SSAONode, BloomNode, DepthOfFieldNode, SMAANode, SSGINode, SSRNode. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/tsl/display/TRAANode.js ; https://github.com/mrdoob/three.js/tree/dev/examples/jsm/tsl/display
- pmndrs/postprocessing: EffectPass merges effects into fewer passes, single-triangle fullscreen, HalfFloat recommended for HDR, no mobile guidance, no WebGPU. https://github.com/pmndrs/postprocessing
- N8AO: WebGL2 only; presets Performance (low-end/mobile) / Low (high-end mobile) / Medium+; `halfRes` gives a 2-4x speedup with ~1 ms depth-aware upsample; `N8AOPostPass` integrates with pmndrs; no WebGPU. https://github.com/N8python/n8ao
- Safari exposes `EXT_color_buffer_half_float` (14) and `EXT_color_buffer_float` (15) per BCD, which is API presence only. https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/EXT_color_buffer_half_float.json ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/EXT_color_buffer_float.json

**Unverified practice notes:** iPad half-float render quality/perf, MSAA and precision bugs; real cost of MSAA + HDR chain on iPad.

**What we decided because of it**
- One RenderPass + one merged pmndrs EffectPass: N8AO, bloom, DOF (photo mode), LUT, tone map, vignette, grain, CA, SMAA (PLAN §2).
- iPad Medium uses N8AO Performance at half-res, SMAA, light bloom; live DOF only at capture (PLAN §3). HalfFloat stays on only if the device test passes.
- Photo mode may use TAA-style accumulation because the camera is still (TAARenderPass concept).

## 4. WebGPU status

- WebKit: WebGPU "is now shipping in Safari 26 beta for macOS, iOS, iPadOS, and visionOS", with Three.js among engines that "work great". https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/ ; confirmed in the 26.0 release post https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- caniuse: Safari on iOS 26.0+ Supported, iOS 17.4-18.7 disabled by default; desktop Safari 26+ Partial (macOS 26 Tahoe or later only). https://caniuse.com/webgpu ; https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/webgpu.json
- GPUweb wiki agrees: enabled by default on macOS/iOS/iPadOS from version 26. https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- `WebGPURenderer` has `forceWebGL` and a WebGL2 fallback backend; the docs read recommend it mainly for TSL/compute and describe WebGLRenderer as maximum compatibility. https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/webgpu/WebGPURenderer.js ; https://raw.githubusercontent.com/mrdoob/three.js/dev/docs/llms-full.txt
- Sky, Water and CSM each have WebGPU variants (SkyMesh, WaterMesh, CSMShadowNode) per the three.js docs. https://threejs.org/docs/pages/Sky.html ; https://threejs.org/docs/pages/Water.html ; https://threejs.org/docs/pages/CSM.html
- N8AO and pmndrs/postprocessing do not support WebGPU (sources in §3).

**Unverified practice notes:** WebGPU feature gaps and WebGPURenderer performance on iPad.

**What we decided because of it**
- Ship WebGLRenderer (WebGL2); keep WebGPU/TSL migration contained to renderer, post and material modules (D-006).

## 5. Vegetation

- Crytek foliage (GPU Gems 3 ch.16): main bending (whole plant, wind computed on CPU per instance, scaled by height) plus detail bending (leaf edges and per-leaf, plus branch term). Vertex colour R = leaf-edge stiffness, G = per-leaf phase, B = overall stiffness; vertex ALPHA = precomputed ambient occlusion. Foliage is double-sided, leaves alpha-tested, grass blended, subsurface approximated with an artist texture. https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis
- GPU Gems ch.7 (Pelzer): avoid modelling individual blades; use billboard clusters in star-like configurations, animate only upper vertices, wind vector per cluster computed on CPU. https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-7-rendering-countless-blades-waving-grass
- Culling granularity and A2C/`forceSinglePass` constraints: see §1 sources.

**Unverified practice notes (source not opened):** Golus alpha-to-coverage sharpening (`(a - cutoff)/max(fwidth(a),0.0001) + 0.5`, per-mip coverage rescale); Wyman hashed alpha; octahedral impostors (Brucks/shaderbits); cross-card trees at mid-distance with an in-engine bake to an offscreen RT; dither crossfade by per-instance hash; Poisson-disc/jittered placement with density masks; blade grass only within ~10-20 m; spherical proxy normals and fake translucency `pow(saturate(dot(V,-L)),p)*thickness`; overdraw is the main iPad fillrate risk; heavy generation belongs in a Worker. All cell sizes, ranges and counts are heuristics to profile.

**What we decided because of it**
- Wind uses GPU Gems 3 ch.16-style main + detail bend with vertex-colour masks; dither cross-fade between LODs; baked impostors far out (PLAN §2).
- Cards, not blades, on iPad tiers; 4x MSAA + A2C on High/Ultra, Medium decided by device test (D-008).
- One seeded PRNG stream per scene with per-rule sub-streams (D-001).

## 6. Terrain

All terrain content in the notes is unverified (no terrain source was opened).

**Unverified practice notes (source not opened):**
- Heightmap from 5-6 octave fBm plus domain warp, fake erosion (ridged/billow mix, slope attenuation, thermal smoothing) or a one-off CPU hydraulic erosion on a 512^2 grid at load (fit to mobile load budget unconfirmed).
- Chunked grid with 2-3 LOD rings and skirts, or a single 256^2-512^2 patch for a 200 m scene.
- RGBA splat from slope/height/noise with height-based blending; triplanar only on steep slopes, biplanar variant on iPad; stochastic/hex tiling (Mikkelsen) plus a macro variation texture; parallax occlusion mapping too expensive on iPad.

**What we decided because of it**
- CPU heightfield in a Worker, chunked mesh, 4-layer splat with height blending, biplanar on steep slopes only, hex tiling and macro variation on High+ (PLAN §2); no POM on iPad.

## 7. Atmosphere & sky

- three's fog chunk has linear and `FOG_EXP2` (`1 - exp(-d^2 * depth^2)`) only, no height term; height fog therefore means patching the chunk or a depth post pass. https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/shaders/ShaderChunk/fog_fragment.glsl.js
- GPU Gems 3 ch.13: screen-space radial sampling toward the light; parameters exposure, weight, decay, density; occluders rendered black; sample at lower resolution to cut bandwidth, stochastic patterns reduce banding; works best when the emissive region is brighter than occluders. https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process
- three ships a god-rays example `webgl_postprocessing_godrays` (page lists the three-good-godrays extension); implementation and cost not read. https://threejs.org/examples/webgl_postprocessing_godrays.html ; https://threejs.org/examples/files.json
- `Sky` is the Preetham analytic model (WebGLRenderer only; `showSunDisc=false` advised when rendering an env map), with turbidity/rayleigh/mie/sunPosition uniforms and procedural cloud uniforms; it has no scene-depth input, so no aerial perspective on geometry. https://threejs.org/docs/pages/Sky.html ; https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/objects/Sky.js
- PMREMGenerator makes a GGX-prefiltered cube mip chain for IBL. https://threejs.org/docs/pages/PMREMGenerator.html

**Unverified practice notes (source not opened):** Inigo Quilez "Better Fog" analytic exponential-height integral (iquilezles.org unreachable; a forum report said ported code did not work as-is, so re-derive and test); Unreal exponential height fog; Hillaire 2020 LUT atmosphere (only a search snippet seen); layered mist cards/soft particles; quarter-res 32-64-tap shafts on iPad, with fade-out when the sun is off-screen; god-ray cards as the cheapest jungle option; HDRI for ambient IBL only with an analytic sun; star/aurora night sky.

**What we decided because of it**
- Analytic exponential height fog in the material fog chunk, plus mist cards (PLAN §2).
- Shafts: downsampled radial blur on High+, god-ray cards on Medium and below, with edge fade logic.
- Sky = HDRI (<= 2k on iPad) or analytic Preetham per mood with PMREM IBL; hide the sun disc when baking env maps.

## 8. Lighting & shadows

- LightProbeGenerator: `fromCubeTexture` (sync) and async `fromCubeRenderTarget` (cube RT must be RGBAFormat); several lightprobe examples exist, multi-probe blending is custom. https://threejs.org/docs/pages/LightProbeGenerator.html ; https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/lights/LightProbeGenerator.js ; https://threejs.org/examples/files.json
- CSM addon: WebGLRenderer only; defaults 3 cascades, shadowMapSize 2048, maxFar 100000, `fade` false; one DirectionalLight per cascade (about one shadow pass per cascade); call `csm.update()` each frame and `setupMaterial()` per material; cascade centre snapped to the texel grid. https://threejs.org/docs/pages/CSM.html ; https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/csm/CSM.js
- `LightShadow.autoUpdate` (default true) and `needsUpdate` allow cached shadow maps. https://threejs.org/docs/pages/LightShadow.html
- Examples exist for contact shadows (`webgl_shadow_contact`) and selective bloom (`webgl_postprocessing_unreal_bloom_selective`). https://threejs.org/examples/files.json

**Unverified practice notes:** Blender-baked lightmaps/AO on UV2 for static scenes; vertex AO for instanced vegetation; 2 real point lights near the player with emissive meshes and glow sprites for the rest; HDR threshold >1 so only lanterns bloom; iPad cascade sizes below 2048.

**What we decided because of it**
- Shadows per PLAN §3: 2 cascades on High/Ultra, 1 cascade on Medium, shadow map updated on change only (`needsUpdate`), Battery Saver off with baked AO.
- Single global SH probe from the sky; ~2-4 real point lights near the player.

## 9. Water, snow, rain, wet

- three `Water` (WebGLRenderer only): flat reflective plane, one extra scene render into a HalfFloatType target via a mirrored oblique-clip camera, texture size default 512 (higher is costlier), `distortionScale` default 20. https://threejs.org/docs/pages/Water.html ; https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/objects/Water.js
- `Water2` uses Reflector + Refractor (two extra renders) with optional flow map; no Water2 example in the current examples list, so treat it as legacy. https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/jsm/objects/Water2.js ; https://threejs.org/examples/files.json

**Unverified practice notes (all of snow, rain and wet are source-less):** half-res reflection with a low-poly layer; cubemap reflection + Fresnel + scrolling normals as the cheap path; depth-tinted transparency instead of refraction; snow by world-normal.y blend, hash glints, trail render-target footprints, wrap-around falling particles; rain as wrapped instanced streaks, albedo x0.6-0.7 and roughness near 0.05 for wet surfaces, ripple normals.

**What we decided because of it**
- Water tiers per PLAN §3: refraction + SSR-lite (Ultra), env reflection (Medium), simple (Low/Saver); planar reflection skipped on iPad.
- Wetness/snow are `onBeforeCompile` material extensions, not separate materials.

## 10. Photographic look & photo mode

- Renderer tone mappings: No, Linear, Reinhard, Cineon, ACESFilmic, Custom, AgX, Neutral; `toneMappingExposure` default 1. ACES includes a "subjective" 1/0.6 exposure scale; AgX works in Rec.2020 with log2 + sigmoid; Neutral does black-level offset and highlight compression. https://threejs.org/docs/pages/WebGLRenderer.html ; https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js ; https://github.com/mrdoob/three.js/blob/dev/src/constants.js
- pmndrs: renderer `NoToneMapping`, HalfFloatType buffers, `ToneMappingEffect` last. https://github.com/pmndrs/postprocessing
- `LUT3DEffect` supports 3D and horizontal-strip LUTs, optional tetrahedral interpolation (slower). https://raw.githubusercontent.com/pmndrs/postprocessing/main/src/effects/LUT3DEffect.js ; core example `webgl_postprocessing_3dlut` in https://threejs.org/examples/files.json
- Tiled capture: `PerspectiveCamera.setViewOffset(fullW, fullH, x, y, w, h)` with `clearViewOffset()`. https://threejs.org/docs/pages/PerspectiveCamera.html ; https://raw.githubusercontent.com/mrdoob/three.js/dev/src/cameras/PerspectiveCamera.js
- `preserveDrawingBuffer` defaults to false. https://threejs.org/docs/pages/WebGLRenderer.html

**Unverified practice notes:** subjective look of ACES (punchy) vs AgX (soft shoulder) vs Neutral; effect ordering (HDR: DoF, bloom, exposure; post-tonemap: LUT, vignette, CA, grain); EV100 exposure `1/(1.2*2^EV100)` with sunny-16 about 15, overcast about 12; typical photo-mode controls; `toBlob` immediately after render needing no `preserveDrawingBuffer`; screen-space seams in tiled capture (use overlap or one large RT, with a guessed <= 4096 limit on iPad); iPad max canvas area (a ~16.7M px figure is unverified).

**What we decided because of it**
- Tone mapping inside the post chain: renderer `NoToneMapping`, AgX last, ACES/Neutral as film looks, HalfFloat buffers (D-009).
- Photo mode: single large RT capture on iPad, tiled `setViewOffset` with overlap on desktop; EV-based exposure UI.

## 11. Photogrammetry assets

- Poly Haven API returns per-asset file maps: textures list 1k-16k resolutions and maps (Diffuse, nor_gl, Rough, AO, Displacement, arm); models list gltf (1k/2k/4k), fbx, blend, usd; `/assets?t=models` includes `polycount`, `max_resolution`, dimensions, categories; `/info/{id}` includes tags and `files_hash`. No LOD chain was seen in the responses. https://api.polyhaven.com/files/rock_boulder_dry ; https://api.polyhaven.com/files/ArmChair_01 ; https://api.polyhaven.com/assets?t=models ; https://api.polyhaven.com/info/rock_boulder_dry
- `meshopt_simplify(indices, positions, target_index_count, target_error)`: error relative to mesh extents (1e-2 about 1%), may stop early; flags LockBorder, Sparse, ErrorAbsolute, Prune, Permissive. https://github.com/zeux/meshoptimizer

**Unverified practice notes:** retopo/decimate chain at 100/50/25/10%, normal/AO bake, trim sheets and impostors for far; gltfpack as an alternative.

**What we decided because of it**
- `process-assets.ts` builds LOD chains with meshopt simplify, plus impostor bake and per-tier size report; pick by `polycount` and `max_resolution` from the API (PLAN M2).

## 12. Asset sources & licenses

- Poly Haven: API free for personal and commercial use; assets CC0, no credit required for CC0 assets, but a "Powered by Poly Haven" credit is requested/required when building on the live API (see their ToS); send a descriptive User-Agent (it worked in our requests; the requirement itself is not stated). https://github.com/Poly-Haven/Public-API ; https://raw.githubusercontent.com/Poly-Haven/Public-API/master/README.md
- ambientCG: the v3 endpoint works and is preferred for new code (totalResults 2936, paginated via `nextPageHttp`, `include=` supported); v2 `full_json` also still works. https://ambientcg.com/api/v3/assets?limit=1 ; https://ambientcg.com/api/v2/full_json?limit=1. CC0 licence: (unverified, source not opened; seen in a search snippet only).
- Freesound: token auth suffices for search/metadata and for previews; "Download Sound" (originals) and other write-type resources require OAuth2 (authorization-code flow; PKCE S256 required for apps registered from Nov 2026; access tokens last 24 h). Previews: preview-hq-mp3 (~128 kbps), preview-lq-mp3 (~64), preview-hq-ogg (~192), preview-lq-ogg (~80). Licence values: Attribution, Attribution NonCommercial, Creative Commons 0. https://raw.githubusercontent.com/MTG/freesound/master/_docs/api/source/authentication.rst ; https://raw.githubusercontent.com/MTG/freesound/master/_docs/api/source/resources.rst ; https://raw.githubusercontent.com/MTG/freesound/master/_docs/api/source/overview.rst. Whether previews may be bundled under a sound's licence: (unverified, check per sound).
- Pixabay: the API covers images and videos only, so there is no audio endpoint; Pixabay audio therefore needs manual download. Limits: 100 requests/60 s by default, responses cached 24 h, no permanent hotlinking, no systematic mass downloads. https://pixabay.com/api/docs/
- Quaternius: all models CC0, commercial use OK, attribution appreciated. https://quaternius.com/faq.html
- Kenney: game assets public domain CC0, commercial use OK; check the licence file in each pack. https://kenney.nl/support
- Sketchfab: the download endpoint returns 401 without credentials, so a token/OAuth is required. https://api.sketchfab.com/v3/models/{uid}/download (replace `{uid}`). Per-model licence filtering and auth scheme names: (unverified, docs.sketchfab.com unreachable). CC-BY needs attribution.
- Google Fonts: mostly SIL OFL 1.1, some Apache 2.0 / Ubuntu (unverified, source not opened).

**What we decided because of it**
- Prefer CC0 (Poly Haven, ambientCG v3, Quaternius, Kenney); `LICENSES.json` + a Credits screen regardless, including "Powered by Poly Haven" (PLAN M2).
- Freesound: CC0-filtered previews (ogg/mp3) with a token, no OAuth; originals only if we later implement OAuth2.
- Pixabay audio is manual download only; the Pixabay API is used for neither audio nor automated fetches of music/SFX.
- Sketchfab fetch needs a token; CC0/CC-BY only, with licence captured per model.

## 13. iPad Safari constraints

- Pointer Lock is not available on iPadOS Safari: caniuse "Not supported" for iOS 3.2 through 26.6 and 27.0-27.2; MDN BCD `safari_ios: false`; WebKit's `PointerLockEnabled` preference defaults to false on iOS family. https://caniuse.com/pointerlock ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Element.json ; https://raw.githubusercontent.com/WebKit/WebKit/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml
- Ogg Opus/Vorbis support arrived in Safari 18.4 (iOS/iPadOS 18.4 included); older iPads need an AAC/MP3 fallback. https://webkit.org/blog/16574/webkit-features-in-safari-18-4/ ; https://caniuse.com/ogg-vorbis ; https://caniuse.com/opus
- WASM SIMD: Safari/iOS 16.4+. https://caniuse.com/wasm-simd ; https://raw.githubusercontent.com/web-platform-dx/web-features/main/features/wasm-simd.yml.dist
- No Battery Status API in Safari or iOS Safari. https://caniuse.com/battery-status ; https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Navigator.json
- Fullscreen: `requestFullscreen` on iOS Safari from 16.4, iPad only, partial (non-removable overlay button, swipe down exits). https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/Element.json. The Safari 26 post says every site can be a web app on iOS/iPadOS. https://webkit.org/blog/17333/webkit-features-in-safari-26-0/

**Unverified practice notes (memory limits especially):** no official memory or canvas-size limit found, and the Apple forum page returned a bot check. Unconfirmed: process kill near ~1.25 GB on old iOS (search snippet), budget < ~1 GB, decoded texture size `w*h*4*1.33` with mips, 2048 texture cap, canvas-resize leak reports; Low Power Mode rAF cap and 120 Hz ProMotion; `webglcontextlost`/`restored` handling; viewport `viewport-fit=cover`, 100dvh, safe-area insets; AudioContext resume on first gesture.

**What we decided because of it**
- Feature-detect Pointer Lock; touch drag-to-look is the iPad path, pointer lock only a desktop enhancement.
- Ship OGG + AAC audio; unlock AudioContext on first tap.
- Battery Saver is a manual toggle plus frame-time watchdog (no Battery API); the memory budget in PLAN §4 is self-imposed and conservative, not sourced.
- Handle `webglcontextlost` with a reload-scene prompt.

## 14. Vercel headers

- `vercel.json` `headers` is an array of `{source, headers:[{key,value}]}` with optional `has`/`missing`; examples include `Cache-Control` and `X-Content-Type-Options`. https://vercel.com/docs/project-configuration/vercel-json

**Unverified practice notes:** the page has no `.ktx2`/`.wasm` Content-Type example; whether a Content-Type override works, and that `.wasm` defaults to `application/wasm`, is unconfirmed. Verify with `curl -I` after deploy. Candidate config: immutable `Cache-Control` for hashed `/assets/*`; explicit `image/ktx2` and `application/wasm` types.

**What we decided because of it**
- `vercel.json` holds long-lived immutable caching for hashed assets (including the separately served Rapier `.wasm`, D-002) and header checks after the first deploy (D-012).

---

## Recommended architecture (one page)

- **Renderer:** `WebGLRenderer` (WebGL2), three pinned (0.187.0, D-003), `NoToneMapping` on the renderer. Scene code uses MeshStandardMaterial extended through `onBeforeCompile` (wind, splat/biplanar, wetness/snow, dither fade, height fog), no raw GL, so a later WebGPURenderer/TSL port touches only renderer, post and material modules (D-006).
- **Post:** one RenderPass + one merged pmndrs EffectPass: N8AO (Performance/halfRes on iPad), bloom, DOF (capture/photo mode), LUT, AgX tone map last, vignette, grain, CA, SMAA; HalfFloat buffers subject to device test (D-009). Tiered MSAA + A2C vs alpha test + SMAA by device test (D-008).
- **Geometry/instancing:** InstancedMesh per species x LOD x ~24 m cell, bounding sphere per cell, CPU LOD with hysteresis, dither cross-fade, baked impostors far out; BatchedMesh optional behind on-device tests (D-007). Seeded PRNG everywhere (D-001).
- **Terrain:** Worker-generated heightfield, chunked mesh, 4-layer height-blended splat, biplanar on slopes, Rapier heightfield collider (Rapier compat in a lazy chunk, D-002).
- **Atmosphere/lighting:** analytic height fog in the fog chunk, mist cards, radial-blur shafts on High+ and cards below, HDRI/Preetham sky with PMREM IBL, 1-2 cascade CSM with cached shadow updates, one SH probe, a few real point lights, baked AO for static scenes.
- **Assets:** fetch scripts (Poly Haven, ambientCG v3, Quaternius, Kenney, Sketchfab, Freesound previews, Pixabay manual audio) -> gltf-transform + meshopt + `ktx2-encoder` KTX2 (D-005, D-010) -> tiered outputs, `LICENSES.json`, credits.
- **Input/platform:** touch-first with drag-to-look; Pointer Lock only on desktop; OGG + AAC audio; manual Battery Saver plus frame-time watchdog; context-loss recovery; self-imposed iPad budget (~650 MB Medium, ~400 MB Saver, PLAN §4).
- **Delivery:** Vercel Git integration with `vercel.json` headers (D-012); perf proven only on real devices via `/bench`.

## Risk list

1. **No GPU measurement in the cloud; all costs unverified.** Mitigation: `/bench` route, F3 overlay, user runs on desktop and iPad at M1; no perf claim before measured.
2. **iPad memory and fill rate (alpha foliage + MSAA + half-float post).** No official limit found. Mitigation: tiered A2C/alpha test, half-res AO, render scale, overdraw debug view, estimator in F3, conservative self-imposed budget.
3. **Pointer Lock absent on iPadOS.** Mitigation: feature detection, drag-to-look and touch joystick, optional keyboard/gamepad.
4. **MSAA/A2C through the composer and half-float on iPad Safari untested.** Mitigation: non-MSAA fallback (alpha test + sharpened alpha + SMAA), device test at M1.
5. **Asset size vs quality (Poly Haven scans, KTX2 transcode time/worker memory).** Mitigation: meshopt simplify LODs, texture tiers (UASTC hero, ETC1S bulk), impostors, per-tier size report, limited KTX2 workers.
6. **Asset-source access and licensing gaps** (Freesound originals need OAuth2, Pixabay has no audio API, Sketchfab needs a token, several hosts unreachable, ambientCG/Sketchfab licence pages unread). Mitigation: Freesound previews, manual Pixabay downloads, CC0 preference, licence captured per asset, exact hosts or local commands as needed.
7. **Library lag and no WebGPU path for N8AO/pmndrs.** Mitigation: pinned versions, contained module boundaries, WebGPU deferred.
8. **Safari audio fallback and older iPadOS (< 18.4).** Mitigation: ship AAC alongside OGG; test an older iPad if available.
9. **Atmosphere effects fail at edges** (radial-blur shafts with sun off-screen, HDRI sun double-lighting, unverified IQ fog formula). Mitigation: fade logic, hide sun disc for env maps, re-derive and test fog.
10. **Load-time generation stalls** (erosion, Poisson). Mitigation: Worker generation, progress UI.
11. **Vercel header behaviour unverified** (ktx2/wasm Content-Type). Mitigation: `curl -I` check after first deploy.
