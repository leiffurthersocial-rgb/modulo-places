// Pure movement math for the player controller (no three.js / rapier) so it is unit-testable.

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Frame-rate independent exponential approach of `current` toward `target` at `rate` per second. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export const BOUNDARY_SOFT_BAND = 6;
export const BOUNDARY_HARD_MARGIN = 3;
const INWARD_PUSH_GAIN = 1.2; // m/s per metre beyond walkRadius

/**
 * Shapes a desired horizontal velocity near the walkable boundary: the outward component fades to
 * zero between (walkRadius - 6) and walkRadius, and beyond walkRadius an inward push is added.
 */
export function shapeBoundaryVelocity(
  px: number,
  pz: number,
  vx: number,
  vz: number,
  walkRadius: number,
): [number, number] {
  const d = Math.hypot(px, pz);
  const start = walkRadius - BOUNDARY_SOFT_BAND;
  if (d <= start || d < 1e-6) return [vx, vz];
  const nx = px / d;
  const nz = pz / d;
  const outward = vx * nx + vz * nz;
  let ox = vx;
  let oz = vz;
  if (outward > 0) {
    const t = clamp((d - start) / BOUNDARY_SOFT_BAND, 0, 1);
    const keep = 1 - t * t * (3 - 2 * t);
    const removed = outward * (1 - keep);
    ox -= nx * removed;
    oz -= nz * removed;
  }
  if (d > walkRadius) {
    const push = (d - walkRadius) * INWARD_PUSH_GAIN;
    ox -= nx * push;
    oz -= nz * push;
  }
  return [ox, oz];
}

/** Hard safety clamp of a horizontal position to walkRadius + 3. */
export function clampToBoundary(px: number, pz: number, walkRadius: number): [number, number] {
  const max = walkRadius + BOUNDARY_HARD_MARGIN;
  const d = Math.hypot(px, pz);
  if (d <= max) return [px, pz];
  const s = max / d;
  return [px * s, pz * s];
}

export interface BobOffset {
  /** Vertical offset (m). */
  y: number;
  /** Lateral (camera-right) offset (m). */
  x: number;
}

export const BOB_WALK_SPEED = 1.7;
export const BOB_SPRINT_SPEED = 3.8;
/** Metres travelled per full bob cycle (two steps). */
export const BOB_STRIDE = 1.5;

/** Head-bob amplitude (m) for a horizontal speed: 0.035 at walk, 0.05 at sprint, fading out below ~0.5 m/s. */
export function bobAmplitude(speed: number): number {
  const fade = clamp(speed / 0.8, 0, 1);
  const t = clamp((speed - BOB_WALK_SPEED) / (BOB_SPRINT_SPEED - BOB_WALK_SPEED), 0, 1);
  return (0.035 + (0.05 - 0.035) * t) * fade * fade;
}

/** Bob offset for a phase measured in cycles*2π (advance by distance * 2π / BOB_STRIDE). */
export function headBobOffset(phase: number, speed: number): BobOffset {
  const a = bobAmplitude(speed);
  return { y: a * Math.sin(phase * 2), x: a * 0.4 * Math.sin(phase) };
}
