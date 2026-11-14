# SCENE_GUIDE.md: building a scene to full quality

The process the Misty Forest (M3) established. Village, jungle and cabin (M4–M6) follow it step by step.

## 1. Pick assets in the Lab
1. Curate candidates in `src/config/lab-candidates.json` (≥ 8 per key material; models; ≥ 6 HDRIs per mood).
2. Generate the scene's lab data:

   ```bash
   npm run assets:fetch -- --lab --scene <id>
   ```

3. Review in `/lab.html` (split compare, all moods, wetness/frost/moss), star picks and export them.
4. Merge the picks into `src/config/picks.json` under `<scene>/<key>`. Add models with a `maxTriangles` budget:

   | Asset | LOD0 budget |
   |---|---|
   | Hero trees | 40–60k |
   | Saplings | ~12k |
   | Rocks | 8–24k |
   | Plants | 4–9k |
   | Grass | ~2.5k |

5. Fetch and process (resumable; one failing model doesn't stop the rest):

   ```bash
   npm run assets:fetch -- --picks
   ```

   ```bash
   NODE_OPTIONS=--max-old-space-size=12000 npm run assets:process
   ```

   Check `reports/asset-sizes.md` against the budget in PLAN.md §4.

## 2. Layout in `src/scenes/<id>/scene.json`
- **Terrain:** size 200–250 m, resolution ≈ 1.3 vertices per metre. The edge of the bowl rises so the soft boundary sits against slopes.
- **Water and paths:**
  - `creek` (carved, monotonic bed, water ribbon, pebble bed);
  - `paths` (smoothed, slightly sunken, painted with the path layer);
  - `flatten` for clearings.
- **Layers:** at most 4 terrain layers (iPad texture-unit budget), in this order: base ground, secondary ground, path, rock (triplanar). Each layer has `scale` (metres per repeat) and `surface` (footsteps).
- **Scatter rules:** `model:<pack key>` species. Trees: `impostor: true`, `collision: cylinder`, `collisionRadius` ≈ trunk radius, `wind` 0.3–0.4, `lods` ≈ [22, 55, 130].
  - Keep paths clear with `{ "type": "layer", "layer": "path", "max": 0.35 }`.
  - Moisture-loving plants use `{ "type": "layer", "layer": "<bank layer>", "min": … }`.
  - Use `cluster` for natural clumping.
- **Moods:** each mood has an HDRI key; the panorama is auto-rotated so its sun matches `sun.azimuth`. Each also sets fog, post, `particles` (mist/pollen/dust/leaves/rain/snow) and an `audio` preset.
- **Cameras:** 6 review cameras, with heights relative to the terrain: spawn, water, open view, low ground detail, into the sun, path.

## 2b. Species and materials
- **Vegetation:** prefer procedural species: `conifer:{fir,pine,fir-sapling,pine-sapling}`, `broadleaf:{maple,deciduous,jungle-giant,jungle-canopy}`, `tropical:{monstera,banana,elephant-ear,palm,tree-fern,bamboo}`, `log:oak`. Scanned trees are not usable at real-time budgets (DECISIONS D-031). Big trees: `impostor: true`. Backdrop rings: `lods: [1,2,3]` (always impostor).
- **Architecture and props:** register placeholder species in `src/scenes/<id>/placeholders.ts` with one part per material.
  - **Textured parts:** use `sceneMaterial('<pack key>', fallback)`.
  - **Glowing parts:** use `patchMaterial(..., { nightLight: true })`.
  - **Pack keys:** list every key you use in `scene.json.materials` with scale, tint and brightness.
- **Props:** hand-placed with terrain-relative Y. Collision is a box or cylinder from the prop's bounds, so set `collision: 'none'` on trees and use invisible collider props for trunks.
- **Snowy scenes:** set `snowCover`.

## 3. Review loop (every visual change)
1. Render all moods × 6 cameras × {desktop High, iPad Medium}:

   ```bash
   npx playwright test --trace off
   ```

   For single shots: `/?shot=3&scene=<id>&mood=<m>&cam=<c>&preset=<p>`.
2. Compare against the reference photos in RESEARCH/references (Wikimedia Commons, cited). Check in this order:
   - exposure and black level;
   - fog distance falloff;
   - green saturation;
   - shadow colour and softness;
   - specular on wet surfaces;
   - scale cues (trunk diameter vs. eye height).
3. Fix the biggest difference first, re-render, repeat. Record non-obvious choices in DECISIONS.md.
4. Check the budgets on F3: draw calls, triangles, memory.
5. Run the benchmark on real hardware: `/?bench=20&scene=<id>&preset=medium`.

## 4. Done when
- All moods are tuned and reviewed from 6 cameras on desktop and iPad, with no console errors.
- Leak test passes (enter/exit ×4).
- Credits list every shipped asset (`src/data/asset-credits.json` is generated) and the licence test passes.
- iPad Medium stays within PLAN.md §4 memory and download budgets.
