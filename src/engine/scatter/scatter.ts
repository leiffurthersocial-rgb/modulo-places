// Seeded scatter: turns scene scatter rules + a heightfield into instance transforms.
// Pure (no three.js) so it is deterministic, testable and worker-friendly.
import { hash01, hashSeed, Noise2D, Rng, smoothstep } from '../core/random';
import { type Heightfield, sampleHeight, sampleNormal, sampleSlope } from '../terrain/heightfield';
import type { MaskDef, ScatterRuleDef } from '../types';

/** Floats per instance: x, y, z, yaw, scale, tiltX, tiltZ, variation. */
export const STRIDE = 8;

export interface ScatterResult {
  rule: ScatterRuleDef;
  count: number;
  data: Float32Array; // count * STRIDE
}

export interface ScatterOptions {
  seed: number;
  vegetationDensity: number; // 0..1, applies to rules with detail !== false
  /** Optional layer weight lookup for 'layer' masks. */
  layerWeight?: (layer: string, x: number, z: number) => number;
  /** Restrict placement to a disc (m) — defaults to the whole field minus a margin. */
  radius?: number;
}

function maskValue(
  m: MaskDef,
  x: number,
  z: number,
  hf: Heightfield,
  noise: Noise2D,
  opts: ScatterOptions,
): number {
  const soft = (m as { soft?: number }).soft ?? 0;
  const band = (v: number, lo?: number, hi?: number) => {
    let w = 1;
    if (lo !== undefined) w *= soft > 0 ? smoothstep(lo - soft, lo + soft, v) : v >= lo ? 1 : 0;
    if (hi !== undefined) w *= soft > 0 ? 1 - smoothstep(hi - soft, hi + soft, v) : v <= hi ? 1 : 0;
    return w;
  };
  switch (m.type) {
    case 'slope':
      return band(sampleSlope(hf, x, z), m.min, m.max);
    case 'height':
      return band(sampleHeight(hf, x, z), m.min, m.max);
    case 'noise': {
      const v =
        noise.fbm(x * m.frequency + (m.seedOffset ?? 0) * 13.1, z * m.frequency, 3) * 0.5 + 0.5;
      return soft > 0
        ? smoothstep(m.threshold - soft, m.threshold + soft, v)
        : v >= m.threshold
          ? 1
          : 0;
    }
    case 'exclude': {
      const d = Math.hypot(x - m.x, z - m.z);
      return soft > 0 ? smoothstep(m.radius, m.radius + soft, d) : d > m.radius ? 1 : 0;
    }
    case 'layer': {
      if (!opts.layerWeight) return 1;
      const w = opts.layerWeight(m.layer, x, z);
      return band(w, m.min, m.max);
    }
  }
}

/**
 * Jittered-grid candidates + per-rule min-distance rejection via a spatial hash. Jittered grids
 * give blue-noise-like spacing at a fraction of Bridson's cost, and the result depends only on
 * (seed, rule id, heightfield), never on iteration order of other rules.
 */
export function scatterRule(
  rule: ScatterRuleDef,
  hf: Heightfield,
  opts: ScatterOptions,
): ScatterResult {
  const ruleSeed = hashSeed(opts.seed, 'scatter', rule.id);
  const rng = new Rng(ruleSeed);
  const noise = new Noise2D(ruleSeed ^ 0xa511e9b3);
  const densityScale = rule.detail === false ? 1 : opts.vegetationDensity;
  const perM2 = (rule.density / 100) * densityScale;
  if (perM2 <= 0) return { rule, count: 0, data: new Float32Array(0) };

  const spacing = Math.max(rule.minDistance, Math.sqrt(1 / perM2));
  const radius = opts.radius ?? hf.size / 2 - 2;
  const n = Math.ceil((radius * 2) / spacing);
  const out: number[] = [];

  // Spatial hash for min-distance checks.
  const cell = Math.max(rule.minDistance, 0.05);
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
  const minD2 = rule.minDistance * rule.minDistance;

  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const jx = rng.next();
      const jz = rng.next();
      const pick = rng.next();
      const v1 = rng.next();
      const v2 = rng.next();
      const v3 = rng.next();
      const v4 = rng.next();
      const x = -radius + (gx + jx) * spacing;
      const z = -radius + (gz + jz) * spacing;
      if (x * x + z * z > radius * radius) continue;

      // Probability = density fraction * masks * clustering.
      let p = Math.min(1, perM2 * spacing * spacing);
      for (const m of rule.masks ?? []) {
        p *= maskValue(m, x, z, hf, noise, opts);
        if (p <= 0) break;
      }
      if (p > 0 && rule.cluster) {
        const c =
          noise.fbm(x * rule.cluster.frequency + 71.3, z * rule.cluster.frequency - 3.7, 3) * 0.5 +
          0.5;
        p *= 1 - rule.cluster.strength + rule.cluster.strength * smoothstep(0.35, 0.75, c) * 2;
      }
      if (pick >= p) continue;

      if (rule.minDistance > 0) {
        const cx = Math.floor(x / cell);
        const cz = Math.floor(z / cell);
        let ok = true;
        for (let dz = -1; dz <= 1 && ok; dz++) {
          for (let dx = -1; dx <= 1 && ok; dx++) {
            const list = grid.get(key(cx + dx, cz + dz));
            if (!list) continue;
            for (let i = 0; i < list.length; i += 2) {
              const ex = list[i]! - x;
              const ez = list[i + 1]! - z;
              if (ex * ex + ez * ez < minD2) {
                ok = false;
                break;
              }
            }
          }
        }
        if (!ok) continue;
        const k = key(cx, cz);
        const list = grid.get(k);
        if (list) list.push(x, z);
        else grid.set(k, [x, z]);
      }

      const y = sampleHeight(hf, x, z) - (rule.sink ?? 0);
      const scale = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * v1 * v1;
      const yaw = v2 * Math.PI * 2;
      const tiltMax = ((rule.tilt ?? 0) * Math.PI) / 180;
      let tiltX = (v3 * 2 - 1) * tiltMax;
      let tiltZ = (v4 * 2 - 1) * tiltMax;
      const align = rule.alignToNormal ?? 0;
      if (align > 0) {
        const nrm = sampleNormal(hf, x, z);
        tiltX += Math.atan2(nrm[2], nrm[1]) * align;
        tiltZ += -Math.atan2(nrm[0], nrm[1]) * align;
      }
      const variation = hash01(gx, gz, ruleSeed);
      out.push(x, y, z, yaw, scale, tiltX, tiltZ, variation);
    }
  }
  return { rule, count: out.length / STRIDE, data: new Float32Array(out) };
}

export function scatterAll(
  rules: ScatterRuleDef[],
  hf: Heightfield,
  opts: ScatterOptions,
): ScatterResult[] {
  return rules.map((r) => scatterRule(r, hf, opts));
}
