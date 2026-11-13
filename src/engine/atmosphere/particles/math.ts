// Pure helpers for the particle system (CPU mirrors of the shader maths, kept testable).

/** Wrap v into [-size/2, size/2). Used for camera-centred box wrapping of particles. */
export function wrapCentered(v: number, size: number): number {
  if (size <= 0) return 0;
  return v - size * Math.floor(v / size + 0.5);
}

/** Wrap v into [0, size). Always non-negative (unlike %). */
export function wrapPositive(v: number, size: number): number {
  if (size <= 0) return 0;
  return v - size * Math.floor(v / size);
}

/** Number of particles to draw for a quality factor q in 0..1 (never exceeds count). */
export function visibleCount(count: number, q: number): number {
  if (!(count > 0)) return 0;
  const k = Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : 1;
  return Math.min(count, Math.floor(count * k));
}

/** Move `current` toward `target` taking `seconds` for a full 0..1 sweep. seconds <= 0 snaps. */
export function stepIntensity(
  current: number,
  target: number,
  dt: number,
  seconds: number,
): number {
  if (seconds <= 0 || dt <= 0) return seconds <= 0 ? target : current;
  const step = dt / seconds;
  if (target > current) return Math.min(target, current + step);
  return Math.max(target, current - step);
}

/** Screen-space point size in px for a world-space size at a view distance, clamped to [min, max]. */
export function pointSizePx(
  worldSize: number,
  projScaleY: number,
  viewHeightPx: number,
  dist: number,
  min: number,
  max: number,
): number {
  const raw = (worldSize * projScaleY * viewHeightPx * 0.5) / Math.max(dist, 1e-3);
  return Math.min(max, Math.max(min, raw));
}

/** Deterministic PRNG (mulberry32) so buffers are reproducible. */
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

/** Fill 4 random floats per particle in [0,1); w holds a stable per-particle id. */
export function makeSeeds(count: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    out[i * 4] = rnd();
    out[i * 4 + 1] = rnd();
    out[i * 4 + 2] = rnd();
    out[i * 4 + 3] = rnd();
  }
  return out;
}
