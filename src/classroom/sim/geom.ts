// Geometry for the sim: 2D floor math, oriented boxes (yaw only) with a vertical extent, and the
// static collider/occluder set derived from a RoomLayout. Pure TS.
import { type RoomLayout, wallFrame } from './layout';

export interface V2 {
  x: number;
  z: number;
}
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v2 = (x: number, z: number): V2 => ({ x, z });
export const dist2 = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Wrap an angle (radians) to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Yaw convention (radians): 0 looks toward -z; positive yaw turns toward -x (three.js rotation.y). */
export function yawDir(yaw: number): V2 {
  return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
export function yawTo(from: V2, to: V2): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}
/** Rotate `current` toward `target` by at most maxStep radians. */
export function turnToward(current: number, target: number, maxStep: number): number {
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= maxStep) return target;
  return wrapAngle(current + Math.sign(d) * maxStep);
}

export type BoxKind = 'wall' | 'table' | 'column' | 'desk' | 'prop' | 'person' | 'chair';

/** Oriented box: centre on the floor plane, half extents, yaw (radians), vertical range. */
export interface Box {
  id: string;
  kind: BoxKind;
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  yaw: number;
  y0: number;
  y1: number;
}

function toLocal(b: Box, x: number, z: number): [number, number] {
  const dx = x - b.cx;
  const dz = z - b.cz;
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  // inverse rotation about y (three.js convention: x' = x cos + z sin, z' = -x sin + z cos)
  return [dx * c - dz * s, dx * s + dz * c];
}

/**
 * Segment (3D) vs box test (slab method in the box's local frame). Returns the entry parameter
 * t in [0,1] or -1 when there is no hit. Used for line-of-sight.
 */
export function segmentHitsBox(a: V3, b: V3, box: Box): number {
  const [ax, az] = toLocal(box, a.x, a.z);
  const [bx, bz] = toLocal(box, b.x, b.z);
  const d = [bx - ax, b.y - a.y, bz - az];
  const o = [ax, a.y, az];
  const lo = [-box.hx, box.y0, -box.hz];
  const hi = [box.hx, box.y1, box.hz];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const di = d[i]!;
    const oi = o[i]!;
    if (Math.abs(di) < 1e-9) {
      if (oi < lo[i]! || oi > hi[i]!) return -1;
    } else {
      let ta = (lo[i]! - oi) / di;
      let tb = (hi[i]! - oi) / di;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return -1;
    }
  }
  return t0;
}

/** Push a circle (x,z,r) out of a box footprint. Returns the corrected position. */
export function resolveCircleBox(p: V2, r: number, b: Box): V2 {
  const [lx, lz] = toLocal(b, p.x, p.z);
  const qx = clamp(lx, -b.hx, b.hx);
  const qz = clamp(lz, -b.hz, b.hz);
  let dx = lx - qx;
  let dz = lz - qz;
  let d = Math.hypot(dx, dz);
  if (d >= r) return p;
  if (d < 1e-6) {
    // centre inside the box: push out along the shallowest axis
    const px = b.hx - Math.abs(lx);
    const pz = b.hz - Math.abs(lz);
    if (px < pz) {
      dx = Math.sign(lx) || 1;
      dz = 0;
      d = -px;
    } else {
      dz = Math.sign(lz) || 1;
      dx = 0;
      d = -pz;
    }
    const push = r - d;
    return fromLocalDelta(b, p, dx * push, dz * push);
  }
  const push = r - d;
  return fromLocalDelta(b, p, (dx / d) * push, (dz / d) * push);
}

function fromLocalDelta(b: Box, p: V2, lx: number, lz: number): V2 {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return { x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c };
}

export function pointInBox(b: Box, x: number, z: number, pad = 0): boolean {
  const [lx, lz] = toLocal(b, x, z);
  return Math.abs(lx) <= b.hx + pad && Math.abs(lz) <= b.hz + pad;
}

const deg = (d: number) => (d * Math.PI) / 180;

export interface StaticGeometry {
  /** Block movement (walls, tables, columns, desk, fixtures that stick out). */
  colliders: Box[];
  /** Block sight (subset + walls). People are added dynamically by the perception code. */
  occluders: Box[];
}

/** Builds colliders/occluders from the layout. Deterministic and cheap (≈40 boxes). */
export function buildStaticGeometry(layout: RoomLayout): StaticGeometry {
  const [W, H, D] = layout.room.size;
  const T = 0.3;
  const colliders: Box[] = [];
  const occluders: Box[] = [];
  const add = (b: Box, collide = true, occlude = true) => {
    if (collide) colliders.push(b);
    if (occlude) occluders.push(b);
  };
  add({
    id: 'wall-front',
    kind: 'wall',
    cx: W / 2,
    cz: -T / 2,
    hx: W / 2 + T,
    hz: T / 2,
    yaw: 0,
    y0: 0,
    y1: H,
  });
  add({
    id: 'wall-back',
    kind: 'wall',
    cx: W / 2,
    cz: D + T / 2,
    hx: W / 2 + T,
    hz: T / 2,
    yaw: 0,
    y0: 0,
    y1: H,
  });
  add({
    id: 'wall-left',
    kind: 'wall',
    cx: -T / 2,
    cz: D / 2,
    hx: T / 2,
    hz: D / 2 + T,
    yaw: 0,
    y0: 0,
    y1: H,
  });
  add({
    id: 'wall-right',
    kind: 'wall',
    cx: W + T / 2,
    cz: D / 2,
    hx: T / 2,
    hz: D / 2 + T,
    yaw: 0,
    y0: 0,
    y1: H,
  });
  for (const c of layout.columns) {
    add({
      id: c.id,
      kind: 'column',
      cx: c.center[0],
      cz: c.center[1],
      hx: c.size[0] / 2,
      hz: c.size[1] / 2,
      yaw: 0,
      y0: 0,
      y1: H,
    });
  }
  for (const t of layout.tables) {
    const [len, ht, dep] = t.size;
    // Tabletop occludes (thin slab); legs don't. The footprint collides.
    add({
      id: t.id,
      kind: 'table',
      cx: t.pos[0],
      cz: t.pos[1],
      hx: len / 2,
      hz: dep / 2,
      yaw: deg(t.rot),
      y0: ht - 0.06,
      y1: ht,
    });
  }
  for (const p of layout.props) {
    if (p.kind === 'standing-desk') {
      const [w, h, d] = p.size ?? [1.4, 1.05, 0.7];
      add({
        id: p.id,
        kind: 'desk',
        cx: p.pos[0],
        cz: p.pos[1],
        hx: w / 2,
        hz: d / 2,
        yaw: deg(p.rot),
        y0: h - 0.15,
        y1: h,
      });
    } else if (p.kind === 'bin') {
      add(
        {
          id: p.id,
          kind: 'prop',
          cx: p.pos[0],
          cz: p.pos[1],
          hx: 0.16,
          hz: 0.16,
          yaw: 0,
          y0: 0,
          y1: 0.4,
        },
        true,
        false,
      );
    }
  }
  for (const f of layout.fixtures) {
    const fr = wallFrame(f.wall, layout.room.size);
    const depth = f.kind === 'radiator' ? 0.16 : f.kind === 'sink' ? f.size[1] : 0;
    if (depth <= 0) continue;
    const along = f.center[0];
    const cx = fr.origin[0] + fr.dir[0] * along + fr.normal[0] * (depth / 2);
    const cz = fr.origin[1] + fr.dir[1] * along + fr.normal[1] * (depth / 2);
    const alongX = fr.dir[0] !== 0;
    const len = f.kind === 'sink' ? f.size[0] : f.size[0];
    add(
      {
        id: f.id,
        kind: 'prop',
        cx,
        cz,
        hx: alongX ? len / 2 : depth / 2,
        hz: alongX ? depth / 2 : len / 2,
        yaw: 0,
        y0: 0,
        y1: f.kind === 'sink' ? 0.95 : 0.75,
      },
      true,
      false,
    );
  }
  return { colliders, occluders };
}

/** Is the floor point on a hard (loud) surface? */
export function surfaceAt(layout: RoomLayout, p: V2): 'carpet' | 'hard' {
  for (const z of layout.zones ?? []) {
    if (
      z.kind === 'hard-floor' &&
      p.x >= z.min[0] &&
      p.x <= z.max[0] &&
      p.z >= z.min[1] &&
      p.z <= z.max[1]
    )
      return 'hard';
  }
  return 'carpet';
}
