// Pure heightfield generation and sampling (no three.js) so it can run in tests and workers.
import { hashSeed, Noise2D, smoothstep } from '../core/random';
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
  const s = hashSeed(seed, 'terrain', def.source.type === 'procedural' ? (def.source.seedOffset ?? 0) : 0);
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
  return { size, res, heights, step, minH, maxH };
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
