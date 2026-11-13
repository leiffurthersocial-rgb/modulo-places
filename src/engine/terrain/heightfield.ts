// Pure heightfield generation and sampling (no three.js) so it can run in tests and workers.
import { hashSeed, Noise2D, smoothstep } from '../core/random';
import { distToPolyline, smoothPolyline } from './polyline';
import type { TerrainDef } from '../types';

export interface Heightfield {
  size: number; // metres, square centred on origin
  res: number; // vertices per side
  heights: Float32Array; // row-major: index = iz * res + ix, x = -size/2 + ix * step
  step: number;
  minH: number;
  maxH: number;
}

export function generateHeightfield(def: TerrainDef, seed: number): Heightfield {
  const res = def.resolution;
  const size = def.size;
  const step = size / (res - 1);
  const heights = new Float32Array(res * res);
  const s = hashSeed(
    seed,
    'terrain',
    def.source.type === 'procedural' ? (def.source.seedOffset ?? 0) : 0,
  );
  const n = new Noise2D(s);
  const warpN = new Noise2D(s ^ 0x5bd1e995);
  const f = def.baseFrequency;
  let minH = Infinity;
  let maxH = -Infinity;
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      const x = -size / 2 + ix * step;
      const z = -size / 2 + iz * step;
      // Domain warp for organic, less grid-like landforms.
      const wx = x + def.warp * warpN.fbm(x * f * 0.7, z * f * 0.7, 3);
      const wz = z + def.warp * warpN.fbm(x * f * 0.7 + 31.7, z * f * 0.7 - 11.3, 3);
      const base = n.fbm(wx * f, wz * f, def.octaves);
      const ridge = n.ridged(wx * f * 0.5 + 100, wz * f * 0.5 - 50, 4);
      let h = def.height * (0.65 * base + 0.35 * (ridge - 0.45));
      // Fine detail that does not affect landforms.
      h += 0.35 * n.noise(x * 0.35, z * 0.35) + 0.08 * n.noise(x * 1.7, z * 1.7);
      // Rise toward the edges: a natural bowl so the soft boundary sits against slopes.
      const r = Math.hypot(x, z) / (size / 2);
      h += def.height * 0.9 * smoothstep(0.62, 1.0, r) ** 1.5;
      for (const fl of def.flatten ?? []) {
        const d = Math.hypot(x - fl.x, z - fl.z);
        const w = 1 - smoothstep(fl.radius * 0.5, fl.radius, d);
        if (w > 0) h = h * (1 - w) + (fl.height ?? h) * w;
      }
      heights[iz * res + ix] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  const hf: Heightfield = { size, res, heights, step, minH, maxH };
  carve(hf, def);
  return hf;
}

/**
 * Paths: blend toward a locally smoothed height across their width (walkable, slightly sunken).
 * Creek: a smooth channel whose floor follows a monotonically descending profile along its length.
 */
function carve(hf: Heightfield, def: TerrainDef): void {
  const { res, size, step, heights } = hf;
  const orig = heights.slice();
  const at = (x: number, z: number) => sampleHeight({ ...hf, heights: orig }, x, z);
  if (def.creek) {
    const pts = smoothPolyline(def.creek.points, 10);
    // Channel floor profile: sample terrain along the creek, then force it to descend.
    const prof = pts.map(([x, z]) => at(x, z));
    for (let i = 1; i < prof.length; i++) prof[i] = Math.min(prof[i]!, prof[i - 1]! - 0.01);
    const w = def.creek.width;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const x = -size / 2 + ix * step;
        const z = -size / 2 + iz * step;
        const { d, t } = distToPolyline(pts, x, z);
        const bank = w * 1.8;
        if (d > bank) continue;
        const k = Math.min(prof.length - 1, Math.round(t * (prof.length - 1)));
        const bed = prof[k]! - def.creek.depth;
        // Smooth U-shaped channel: full depth in the middle, blending out over the banks.
        const u = smoothstep(w * 0.25, bank, d);
        const i = iz * res + ix;
        heights[i] = Math.min(heights[i]!, bed * (1 - u) + heights[i]! * u);
      }
    }
  }
  for (const path of def.paths ?? []) {
    const pts = smoothPolyline(path.points, 8);
    const w = path.width;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const x = -size / 2 + ix * step;
        const z = -size / 2 + iz * step;
        const { d } = distToPolyline(pts, x, z);
        if (d > w * 1.5) continue;
        // Average height across the path → gentle cross-slope; sink by a few cm.
        const r = w * (path.smoothing ?? 1.2);
        const avg =
          (at(x - r, z) + at(x + r, z) + at(x, z - r) + at(x, z + r) + at(x, z) * 2) / 6 - 0.06;
        const k = 1 - smoothstep(w * 0.5, w * 1.5, d);
        const i = iz * res + ix;
        heights[i] = heights[i]! * (1 - k) + avg * k;
      }
    }
  }
  let minH = Infinity;
  let maxH = -Infinity;
  for (const h of heights) {
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  hf.minH = minH;
  hf.maxH = maxH;
}

/** Bilinear height at world (x, z); clamps outside the field. */
export function sampleHeight(hf: Heightfield, x: number, z: number): number {
  const fx = Math.min(hf.res - 1.0001, Math.max(0, (x + hf.size / 2) / hf.step));
  const fz = Math.min(hf.res - 1.0001, Math.max(0, (z + hf.size / 2) / hf.step));
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const r = hf.res;
  const h00 = hf.heights[iz * r + ix]!;
  const h10 = hf.heights[iz * r + ix + 1]!;
  const h01 = hf.heights[(iz + 1) * r + ix]!;
  const h11 = hf.heights[(iz + 1) * r + ix + 1]!;
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/** Unit normal at world (x, z) via central differences. Returns [nx, ny, nz]. */
export function sampleNormal(hf: Heightfield, x: number, z: number): [number, number, number] {
  const e = hf.step;
  const hl = sampleHeight(hf, x - e, z);
  const hr = sampleHeight(hf, x + e, z);
  const hd = sampleHeight(hf, x, z - e);
  const hu = sampleHeight(hf, x, z + e);
  const nx = hl - hr;
  const nz = hd - hu;
  const ny = 2 * e;
  const len = Math.hypot(nx, ny, nz);
  return [nx / len, ny / len, nz / len];
}

/** Slope in degrees at world (x, z). */
export function sampleSlope(hf: Heightfield, x: number, z: number): number {
  const n = sampleNormal(hf, x, z);
  return (Math.acos(Math.min(1, n[1])) * 180) / Math.PI;
}
