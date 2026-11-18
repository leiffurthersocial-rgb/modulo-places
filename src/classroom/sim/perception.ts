// Perception: sample points on bodies, line of sight against 2.5D occluders, vision zones
// (inner cone, coffin-shaped mid zone, peripheral, near field) and hearing attenuation.
// Model after Splinter Cell Blacklist (Game AI Pro 2, ch. 28) and Mark of the Ninja (GAIP ch. 32).
import type { TeacherProfile } from './data';
import { type Box, type V2, type V3, segmentHitsBox, wrapAngle, yawDir, yawTo } from './geom';
import type { Agent, SamplePoint } from './types';

export const EYE_HEIGHT = { stand: 1.62, crouch: 1.0, sit: 1.15 } as const;
const TORSO = { stand: 1.2, crouch: 0.75, sit: 0.85 } as const;
const HAND = { stand: 1.0, crouch: 0.7, sit: 0.76 } as const;
/** People are boxes this wide for occlusion. */
const PERSON_HALF = 0.19;
/** Within this distance a standing observer looks over tables (sees laps and hands). */
export const NEAR_OVER_TABLE = 1.3;

export interface PointCtx {
  /** Laptop position on the table in front of the agent (if a laptop is open). */
  laptopAt?: V2;
}

/** World-space position of a sample point on an agent's body. */
export function samplePoint(a: Agent, p: SamplePoint, ctx: PointCtx = {}): V3 {
  const f = yawDir(a.yaw);
  const r = { x: -f.z, z: f.x };
  const s = a.stance;
  switch (p) {
    case 'head':
      return { x: a.pos.x, y: EYE_HEIGHT[s] + 0.05, z: a.pos.z };
    case 'torso':
      return { x: a.pos.x, y: TORSO[s], z: a.pos.z };
    case 'handL':
      return {
        x: a.pos.x + f.x * 0.25 - r.x * 0.18,
        y: HAND[s],
        z: a.pos.z + f.z * 0.25 - r.z * 0.18,
      };
    case 'handR':
      return {
        x: a.pos.x + f.x * 0.25 + r.x * 0.18,
        y: HAND[s],
        z: a.pos.z + f.z * 0.25 + r.z * 0.18,
      };
    case 'lap':
      return { x: a.pos.x + f.x * 0.16, y: s === 'sit' ? 0.6 : HAND[s], z: a.pos.z + f.z * 0.16 };
    case 'device':
      if (ctx.laptopAt) return { x: ctx.laptopAt.x, y: 0.86, z: ctx.laptopAt.z };
      // Phone: in the lap when seated (below the tabletop), chest height when standing.
      if (s === 'sit') return { x: a.pos.x + f.x * 0.2, y: 0.62, z: a.pos.z + f.z * 0.2 };
      return { x: a.pos.x + f.x * 0.3, y: s === 'crouch' ? 0.8 : 1.15, z: a.pos.z + f.z * 0.3 };
  }
}

export function personBox(a: Agent): Box {
  return {
    id: a.id,
    kind: 'person',
    cx: a.pos.x,
    cz: a.pos.z,
    hx: PERSON_HALF,
    hz: PERSON_HALF,
    yaw: 0,
    y0: 0,
    y1: EYE_HEIGHT[a.stance] + 0.12,
  };
}

/**
 * Line of sight from eye to point. `skip` ids are ignored (viewer and target). When `overTables`,
 * tables and desks do not block (the viewer is close enough to look over them).
 */
export function lineOfSight(
  eye: V3,
  pt: V3,
  occluders: readonly Box[],
  skip: readonly string[],
  overTables: boolean,
): boolean {
  for (const b of occluders) {
    if (skip.includes(b.id)) continue;
    if (overTables && (b.kind === 'table' || b.kind === 'desk')) continue;
    // Ignore hits right at the end point (the point sits on/in the box surface).
    const t = segmentHitsBox(eye, pt, b);
    if (t >= 0 && t < 0.985) return false;
  }
  return true;
}

export type ZoneName = 'inner' | 'mid' | 'peripheral' | 'near';

export interface ZoneHit {
  zone: ZoneName;
  /** Zone factor × distance falloff. */
  factor: number;
  dist: number;
  angle: number;
}

/** Which vision zone a point falls in for an observer looking along `headYaw`. */
export function visionZone(
  v: TeacherProfile['vision'],
  eye: V2,
  headYaw: number,
  pt: V2,
  scale = 1,
): ZoneHit | null {
  const dist = Math.hypot(pt.x - eye.x, pt.z - eye.z);
  const angle = Math.abs(wrapAngle(yawTo(eye, pt) - headYaw)) * (180 / Math.PI);
  const fall = (range: number) => Math.max(0.15, 1 - (dist / range) ** 2);
  const inR = v.innerRange * scale;
  const midR = v.midRange * scale;
  const perR = v.periphRange * scale;
  if (angle <= v.innerAngle / 2 && dist <= inR)
    return { zone: 'inner', factor: 1.0 * fall(inR + 1.5), dist, angle };
  // Coffin: like a cone, but lateral reach is capped so far-off-axis points are not seen.
  const lateral = dist * Math.sin((Math.min(angle, 89) * Math.PI) / 180);
  if (angle <= v.midAngle / 2 && dist <= midR && lateral <= 2.4 * scale)
    return { zone: 'mid', factor: 0.6 * fall(midR), dist, angle };
  if (angle <= v.periphAngle / 2 && dist <= perR)
    return { zone: 'peripheral', factor: 0.3 * fall(perR), dist, angle };
  // "Eyes in the back of the head" (Alien: Isolation): very close things are noticed anyway.
  if (dist <= 1.0) return { zone: 'near', factor: 0.45, dist, angle };
  return null;
}

/** Effective loudness at a listener: 1 at the source, 0 at the edge of the (scaled) radius. */
export function heardLoudness(src: V2, listener: V2, radius: number): number {
  const d = Math.hypot(src.x - listener.x, src.z - listener.z);
  if (d >= radius) return 0;
  return 1 - d / radius;
}

/** Is `target` inside a horizontal field of view from (pos, yaw)? Used for the off-screen fairness rule. */
export function inHorizontalView(pos: V2, yaw: number, target: V2, halfFovDeg = 55): boolean {
  const a = Math.abs(wrapAngle(yawTo(pos, target) - yaw)) * (180 / Math.PI);
  return a <= halfFovDeg;
}
