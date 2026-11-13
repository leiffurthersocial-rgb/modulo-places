/** Pure helpers for the audio engine (no Web Audio dependency). */

export type Vec3 = { x: number; y: number; z: number };

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Nearest point on a polyline (array of [x,y,z]) to point p. Returns point and distance. */
export function nearestPointOnPolyline(
  points: ReadonlyArray<readonly [number, number, number]>,
  p: Vec3,
): { point: [number, number, number]; distance: number; segment: number } | null {
  const first = points[0];
  if (!first) return null;
  let best: [number, number, number] = [first[0], first[1], first[2]];
  let bestD2 = Infinity;
  let bestSeg = 0;
  if (points.length === 1) {
    const dx = first[0] - p.x,
      dy = first[1] - p.y,
      dz = first[2] - p.z;
    return { point: best, distance: Math.sqrt(dx * dx + dy * dy + dz * dz), segment: 0 };
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const abx = b[0] - a[0],
      aby = b[1] - a[1],
      abz = b[2] - a[2];
    const len2 = abx * abx + aby * aby + abz * abz;
    let t = 0;
    if (len2 > 1e-12) {
      t = ((p.x - a[0]) * abx + (p.y - a[1]) * aby + (p.z - a[2]) * abz) / len2;
      t = clamp(t, 0, 1);
    }
    const cx = a[0] + abx * t,
      cy = a[1] + aby * t,
      cz = a[2] + abz * t;
    const dx = cx - p.x,
      dy = cy - p.y,
      dz = cz - p.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = [cx, cy, cz];
      bestSeg = i;
    }
  }
  return { point: best, distance: Math.sqrt(bestD2), segment: bestSeg };
}

/** Inverse distance model gain as used by WebAudio (refDistance, rolloff). */
export function inverseDistanceGain(
  distance: number,
  refDistance = 3,
  rolloff = 1.2,
  maxDistance = 80,
): number {
  const d = clamp(distance, refDistance, maxDistance);
  return refDistance / (refDistance + rolloff * (d - refDistance));
}

/** Seedable PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponentially distributed interval (Poisson process) with given mean, clamped to [min, max]. */
export function poissonInterval(rand: () => number, mean: number, min = 0, max = Infinity): number {
  const u = Math.max(1e-6, rand());
  return clamp(-Math.log(u) * mean, min, max);
}

/** Mean interval between events given density 0..1; returns Infinity when density ~ 0. */
export function densityToMeanInterval(density: number, slowest: number, fastest: number): number {
  const d = clamp(density, 0, 1);
  if (d < 0.01) return Infinity;
  // geometric interpolation: density 1 -> fastest, 0.01 -> slowest
  return slowest * Math.pow(fastest / slowest, d);
}

/** Random walk step with mean reversion, result clamped to [lo, hi]. */
export function randomWalk(
  current: number,
  rand: () => number,
  step: number,
  lo: number,
  hi: number,
  home = (lo + hi) / 2,
  pull = 0.15,
): number {
  const next = current + (rand() - 0.5) * 2 * step + (home - current) * pull;
  return clamp(next, lo, hi);
}

export interface AmbienceMix {
  wind: number;
  windGust: number;
  birds: number;
  birdsDawnChorus: number;
  insects: number;
  creek: number;
  rain: number;
  night: number;
}

export const MIX_KEYS: ReadonlyArray<keyof AmbienceMix> = [
  'wind',
  'windGust',
  'birds',
  'birdsDawnChorus',
  'insects',
  'creek',
  'rain',
  'night',
];

export const SILENT_MIX: AmbienceMix = {
  wind: 0,
  windGust: 0,
  birds: 0,
  birdsDawnChorus: 0,
  insects: 0,
  creek: 0,
  rain: 0,
  night: 0,
};

/** Linear interpolation between two mixes (t clamped 0..1). */
export function lerpMix(a: AmbienceMix, b: AmbienceMix, t: number): AmbienceMix {
  const k = clamp(t, 0, 1);
  const out = { ...a };
  for (const key of MIX_KEYS) out[key] = lerp(a[key], b[key], k);
  return out;
}

/** Merge a partial mix over a base, clamping each level to 0..1. */
export function mergeMix(base: AmbienceMix, partial: Partial<AmbienceMix>): AmbienceMix {
  const out = { ...base };
  for (const key of MIX_KEYS) {
    const v = partial[key];
    if (v !== undefined && Number.isFinite(v)) out[key] = clamp(v, 0, 1);
  }
  return out;
}

/** Pan (-1..1) of a world point relative to listener position/forward (XZ plane, y-up, right-handed). */
export function relativePan(listener: Vec3, forward: Vec3, target: Vec3): number {
  const fl = Math.hypot(forward.x, forward.z);
  if (fl < 1e-6) return 0;
  const fx = forward.x / fl,
    fz = forward.z / fl;
  // right = forward x up = (-fz, 0, fx)... for y-up right-handed: right = (−fz, 0, fx)
  const rx = -fz,
    rz = fx;
  const dx = target.x - listener.x,
    dz = target.z - listener.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) return 0;
  return clamp((dx * rx + dz * rz) / d, -1, 1);
}
