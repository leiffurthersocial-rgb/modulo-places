// Procedural broadleaf trees (Japanese maple / temperate deciduous / tropical giant / tropical
// canopy) built from a baked leaf-spray atlas (scripts/bake-foliage.ts "broadleaf" | "maple", from the
// Poly Haven tree_small_02 scan) plus the scanned bark material.
//
// A tree = tapered trunk (bark, UVs in metres) -> recursive limbs (2-3 levels) -> leaf-spray cards
// clustered along the terminal branches. Vertex colour = AO (darker toward the crown interior and
// underside); vertex normals are blended toward the crown ellipsoid proxy so the whole crown shades
// volumetrically. Pivot = trunk base. Deterministic per seed. Materials are plain
// MeshStandardMaterials; the engine runs patchMaterial (wind + fog) on them afterwards.
import * as THREE from 'three';
import type { PbrMaterialMaps } from '../assets/AssetLoader';
import { Rng } from '../core/random';
import { repairNormals, type BuiltModel } from './conifer';

export type BroadleafKind = 'maple' | 'deciduous' | 'jungle-giant' | 'jungle-canopy';

export interface BroadleafParams {
  kind: BroadleafKind;
  height: number;
  seed: number;
  lod: 0 | 1 | 2;
}

export interface BroadleafMaterials {
  bark: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  /** Atlas rects [u0, v0, u1, v1] (v from the TOP row, KTX2 flipY=false). */
  rects: [number, number, number, number][];
  /** width / height of each rect. */
  aspect: number[];
}

// ---- vector helpers ---------------------------------------------------------------------------

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function rotate(v: V3, k: V3, ang: number): V3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
}
const UP: V3 = [0, 1, 0];

// ---- geometry accumulator ---------------------------------------------------------------------

class MeshBuf {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  get tris(): number {
    return this.idx.length / 3;
  }
  get verts(): number {
    return this.pos.length / 3;
  }
  vertex(p: V3, n: V3, u: number, v: number, r: number, g = r, b = r): number {
    const i = this.verts;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    return i;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(
      this.verts > 65535
        ? new THREE.Uint32BufferAttribute(this.idx, 1)
        : new THREE.Uint16BufferAttribute(this.idx, 1),
    );
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

function bridge(m: MeshBuf, ringA: number, ringB: number, segs: number): void {
  for (let i = 0; i < segs; i++) {
    const a = ringA + i;
    const b = ringB + i;
    m.tri(a, b, a + 1);
    m.tri(a + 1, b, b + 1);
  }
}

// ---- kind configuration -----------------------------------------------------------------------

interface KindCfg {
  /** trunk top (m) as a fraction of H */
  trunkTop: number;
  /** trunk base radius as a fraction of H */
  r0: number;
  /** trunk top radius as a fraction of the base radius */
  topTaper: number;
  /** limbs leave the trunk between these heights (fractions of trunk top) */
  limbFrom: number;
  nLimbs: [number, number];
  /** limb pitch above horizontal (rad) */
  pitch: [number, number];
  /** crown horizontal radius (fraction of H) */
  crownR: number;
  /** limb length multiplier on crownR (path length) */
  limbLen: number;
  /** upward curvature of limbs per metre (phototropism) */
  curveUp: number;
  maxLevel: number;
  /** children per branch at level 1 / 2 / 3 */
  kids: [number, number, number];
  /** card length (m) at density 1 and cards per anchor */
  card: number;
  perAnchor: number;
  /** trunk lateral bend amplitude (fraction of H) */
  bend: number;
  /** 0 = a single crown ellipsoid; >0 = n additional canopy lobes (irregular crown) */
  lobes: number;
  /** crown ellipsoid semi-height as a fraction of crown height */
  buttress: boolean;
}

const CFG: Record<BroadleafKind, KindCfg> = {
  maple: {
    trunkTop: 0.3,
    r0: 0.026,
    topTaper: 0.55,
    limbFrom: 0.55,
    nLimbs: [5, 7],
    pitch: [0.2, 0.55],
    crownR: 0.46,
    limbLen: 1.05,
    curveUp: 0.02,
    maxLevel: 3,
    kids: [5, 4, 3],
    card: 1.05,
    perAnchor: 4,
    bend: 0.05,
    lobes: 0,
    buttress: false,
  },
  deciduous: {
    trunkTop: 0.42,
    r0: 0.026,
    topTaper: 0.5,
    limbFrom: 0.5,
    nLimbs: [7, 9],
    pitch: [0.55, 1.0],
    crownR: 0.3,
    limbLen: 1.0,
    curveUp: 0.05,
    maxLevel: 3,
    kids: [5, 4, 3],
    card: 1.7,
    perAnchor: 4,
    bend: 0.025,
    lobes: 0,
    buttress: false,
  },
  'jungle-giant': {
    trunkTop: 0.72,
    r0: 0.036,
    topTaper: 0.6,
    limbFrom: 0.92,
    nLimbs: [6, 8],
    pitch: [0.18, 0.5],
    crownR: 0.235,
    limbLen: 1.05,
    curveUp: 0.012,
    maxLevel: 3,
    kids: [5, 4, 3],
    card: 3.3,
    perAnchor: 5,
    bend: 0.012,
    lobes: 0,
    buttress: true,
  },
  'jungle-canopy': {
    trunkTop: 0.58,
    r0: 0.026,
    topTaper: 0.55,
    limbFrom: 0.62,
    nLimbs: [5, 7],
    pitch: [0.4, 0.95],
    crownR: 0.32,
    limbLen: 1.05,
    curveUp: 0.04,
    maxLevel: 3,
    kids: [5, 4, 3],
    card: 2.1,
    perAnchor: 4,
    bend: 0.045,
    lobes: 3,
    buttress: false,
  },
};

const BUDGET: Record<BroadleafKind, [number, number, number]> = {
  maple: [9000, 3500, 1200],
  deciduous: [9000, 3500, 1200],
  'jungle-giant': [12000, 3500, 1200],
  'jungle-canopy': [9000, 3500, 1200],
};

const RADIAL: Record<number, [number, number, number]> = {
  0: [10, 7, 5],
  1: [6, 5, 4],
  2: [4, 4, 3],
  3: [3, 3, 3],
};
const STEPS: Record<number, [number, number, number]> = {
  1: [4, 3, 2],
  2: [3, 2, 2],
  3: [2, 2, 2],
};
const BARK_TILE_U = 1.0;
const BARK_TILE_V = 1.5;

// ---- skeleton ---------------------------------------------------------------------------------

interface Blob {
  c: V3;
  a: number;
  b: number;
}

interface Anchor {
  p: V3;
  dir: V3;
  blob: number;
  /** relative size 0.7..1.2 */
  size: number;
}

function tube(
  m: MeshBuf,
  pts: V3[],
  radii: number[],
  segs: number,
  aoAt: (p: V3) => number,
  cumStart = 0,
): void {
  const circ0 = 2 * Math.PI * Math.max(0.01, radii[0]!);
  const tileU = Math.max(1, Math.round(circ0 / BARK_TILE_U));
  const mPerU = circ0 / tileU;
  let cum = cumStart;
  let prev = -1;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k]!;
    const t = normalize(sub(pts[Math.min(pts.length - 1, k + 1)]!, pts[Math.max(0, k - 1)]!));
    const ref: V3 = Math.abs(t[1]) > 0.9 ? [1, 0, 0] : UP;
    const e1 = normalize(cross(t, ref));
    const e2 = cross(e1, t);
    if (k > 0) cum += Math.hypot(...sub(p, pts[k - 1]!));
    const r = radii[k]!;
    const ao = aoAt(p);
    const ring = m.verts;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const rad = add(mul(e1, Math.cos(a)), mul(e2, Math.sin(a)));
      const vp = add(p, mul(rad, r));
      vp[1] = Math.max(0, vp[1]);
      m.vertex(vp, rad, (i / segs) * tileU, cum / (mPerU * BARK_TILE_V), ao);
    }
    if (prev >= 0) bridge(m, prev, ring, segs);
    prev = ring;
  }
}

interface Skeleton {
  wood: MeshBuf;
  anchors: Anchor[];
  blobs: Blob[];
  trunkTop: number;
  crownBase: number;
  crownTop: number;
  crownR: number;
}

function buildSkeleton(p: BroadleafParams): Skeleton {
  const cfg = CFG[p.kind];
  const rng = new Rng(p.seed * 53 + 17 + p.kind.length * 7);
  const H = p.height;
  const wood = new MeshBuf();
  const anchors: Anchor[] = [];
  const lod = p.lod;
  const maxLevel = Math.min(cfg.maxLevel, lod === 0 ? 3 : lod === 1 ? 2 : 1);

  const yTop = H * cfg.trunkTop;
  const r0 = Math.max(0.05, H * cfg.r0);
  const bendAng = rng.range(0, Math.PI * 2);
  const bendAmp = cfg.bend * H;
  const bx = Math.cos(bendAng) * bendAmp;
  const bz = Math.sin(bendAng) * bendAmp;
  const wob = rng.range(0, 6.28);
  const center = (y: number): V3 => {
    const t = y / Math.max(0.1, yTop);
    return [bx * t * t + 0.02 * H * cfg.bend * 8 * Math.sin(t * 4 + wob), y, bz * t * t];
  };
  const trunkR = (y: number): number => {
    const t = clamp(y / yTop, 0, 1);
    const flare = cfg.buttress ? 1 + 0.5 * Math.exp(-y / 1.4) : 1 + 0.55 * Math.exp(-y / 0.45);
    return Math.max(0.02, r0 * lerp(1, cfg.topTaper, Math.pow(t, 0.8)) * flare);
  };

  // Crown volume.
  const crownR = H * cfg.crownR;
  const limbY0 = yTop * cfg.limbFrom;
  const crownBase = p.kind === 'maple' ? yTop * 0.6 : limbY0;
  const crownTop = H;
  const blobs: Blob[] = [];
  const crownCy = (crownBase + crownTop) / 2;
  const crownB = (crownTop - crownBase) / 2;
  const topC = center(yTop);
  blobs.push({ c: [topC[0], crownCy, topC[2]], a: crownR * 1.05, b: crownB * 1.1 });

  // Trunk.
  const trunkPts: V3[] = [];
  const trunkRad: number[] = [];
  const nRings =
    lod === 0
      ? Math.max(6, Math.round(yTop / (cfg.buttress ? 2.2 : 0.9)))
      : lod === 1
        ? Math.max(4, Math.round(yTop / 3))
        : 3;
  const ys: number[] = [0, 0.1];
  for (let i = 1; i < nRings; i++) ys.push(0.1 + ((yTop - 0.1) * i) / nRings);
  ys.push(yTop);
  if (lod === 2) ys.splice(1, 1);
  for (const y of ys) {
    trunkPts.push(center(y));
    trunkRad.push(trunkR(y));
  }
  // Close the trunk with a tapered tip (no open flat end showing through the crown).
  const tipY = yTop + trunkR(yTop) * 1.2;
  trunkPts.push(center(tipY));
  trunkRad.push(trunkR(yTop) * 0.12);
  const ao0 = (p0: V3): number => (p0[1] < 0.6 ? lerp(0.78, 1, p0[1] / 0.6) : 1);
  tube(wood, trunkPts, trunkRad, RADIAL[0]![lod], ao0);

  // Buttress fins (jungle-giant): vertical plates flaring out of the lower trunk.
  if (cfg.buttress) buildButtress(wood, rng, center, trunkR, H, lod);

  // Limbs.
  const nLimbs = rng.int(cfg.nLimbs[0], cfg.nLimbs[1]) - (lod === 2 ? 1 : 0);
  const golden = 2.399963;
  const az0 = rng.range(0, Math.PI * 2);
  const lobeCenters: V3[] = [];

  const aoAt = (pt: V3): number => {
    // darker toward the crown interior / underside
    const b = blobs[0]!;
    const d = Math.hypot((pt[0] - b.c[0]) / b.a, (pt[1] - b.c[1]) / b.b, (pt[2] - b.c[2]) / b.a);
    return clamp(lerp(0.55, 1, smoothstep(0.1, 1, d)), 0.4, 1);
  };

  const grow = (
    start: V3,
    dir0: V3,
    length: number,
    rad0: number,
    level: number,
    blob: number,
    cum: number,
  ): void => {
    const steps = STEPS[level]![lod] + (level === 1 && length > crownR * 0.9 ? 1 : 0);
    const pts: V3[] = [start];
    let d = dir0;
    let q = start;
    const seg = length / steps;
    const jitter = level === 1 ? 0.18 : 0.3;
    for (let s = 0; s < steps; s++) {
      d = normalize([
        d[0] + rng.range(-jitter, jitter),
        d[1] + cfg.curveUp * seg * (level === 1 ? 1 : 0.5) + rng.range(-jitter, jitter) * 0.6,
        d[2] + rng.range(-jitter, jitter),
      ]);
      // maple twigs droop slightly, tropical ones don't
      if (p.kind === 'maple' && level >= 2) d = normalize([d[0], d[1] - 0.05 * seg, d[2]]);
      q = add(q, mul(d, seg));
      if (q[1] < 0.3) q = [q[0], 0.3, q[2]];
      pts.push(q);
    }
    const radii = pts.map((_, i) => Math.max(0.006, rad0 * lerp(1, 0.18, i / steps)));
    tube(wood, pts, radii, RADIAL[level]![lod], aoAt, cum);

    const terminal = level >= maxLevel;
    const blobIdx = blob;
    if (terminal) {
      // Leaf anchors along the terminal branch (tip + inner points).
      const marks = lod === 2 ? [0.5, 1] : [0.2, 0.4, 0.6, 0.8, 1];
      for (const mk of marks) {
        const k = mk * steps;
        const i0 = Math.min(steps - 1, Math.floor(k));
        const a = pts[i0]!;
        const b = pts[i0 + 1]!;
        const f = k - i0;
        anchors.push({
          p: add(mul(a, 1 - f), mul(b, f)),
          dir: normalize(sub(b, a)),
          blob: blobIdx,
          size: lerp(1.0, 0.8, 1 - mk) * rng.range(0.85, 1.15),
        });
      }
      return;
    }
    // Children.
    const nKids = Math.max(2, cfg.kids[level - 1]! - (lod === 2 ? 1 : 0));
    const phi0 = rng.range(0, Math.PI * 2);
    for (let c = 0; c < nKids; c++) {
      const f = lerp(0.3, 0.95, (c + rng.range(0.1, 0.9)) / nKids);
      const idx = f * steps;
      const i0 = Math.min(steps - 1, Math.floor(idx));
      const a = pts[i0]!;
      const b = pts[i0 + 1]!;
      const t = idx - i0;
      const origin = add(mul(a, 1 - t), mul(b, t));
      const par = normalize(sub(b, a));
      const side = normalize(cross(par, Math.abs(par[1]) > 0.9 ? [1, 0, 0] : UP));
      const kidDir0 = rotate(
        par,
        rotate(side, par, phi0 + c * golden + rng.range(-0.4, 0.4)),
        rng.range(0.5, 1.0),
      );
      // Keep sub-branches from drooping into the crown interior; push outward + up.
      const kd = normalize([kidDir0[0], kidDir0[1] * 0.8 + 0.35, kidDir0[2]]);
      const kLen = length * (1 - f * 0.5) * rng.range(0.5, 0.72);
      const kRad = radii[Math.min(pts.length - 1, Math.round(idx))]! * rng.range(0.5, 0.65);
      grow(origin, kd, kLen, kRad, level + 1, blobIdx, cum + length * f);
    }
    // Inner-crown anchors on non-terminal branches (fills the gaps between outer clumps).
    if (level >= 2 && lod < 2)
      for (const mk of [0.55, 0.8]) {
        const i0 = Math.min(steps - 1, Math.floor(mk * steps));
        anchors.push({
          p: pts[i0]!,
          dir: normalize(sub(pts[i0 + 1]!, pts[i0]!)),
          blob: blobIdx,
          size: rng.range(0.7, 0.95),
        });
      }
    // Continue straight to a tip anchor for the parent end.
    anchors.push({
      p: pts[pts.length - 1]!,
      dir: normalize(sub(pts[pts.length - 1]!, pts[pts.length - 2]!)),
      blob: blobIdx,
      size: rng.range(0.9, 1.1),
    });
  };

  if (cfg.lobes > 0) {
    for (let i = 0; i < cfg.lobes + (lod === 0 ? 1 : 0); i++) {
      const a = az0 + (i / (cfg.lobes + 1)) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const rr = crownR * rng.range(0.42, 0.7);
      lobeCenters.push([
        topC[0] + Math.cos(a) * rr,
        crownBase + crownB * rng.range(0.9, 1.5),
        topC[2] + Math.sin(a) * rr,
      ]);
    }
    for (const lc of lobeCenters)
      blobs.push({ c: lc, a: crownR * rng.range(0.5, 0.68), b: crownB * rng.range(0.55, 0.75) });
  }

  for (let i = 0; i < nLimbs; i++) {
    const f = i / Math.max(1, nLimbs - 1);
    const y = lerp(limbY0, yTop * 0.98, Math.pow(f, 0.9));
    const az = az0 + i * golden + rng.range(-0.25, 0.25);
    const pitch = lerp(cfg.pitch[1], cfg.pitch[0], 1 - f * 0.5) + rng.range(-0.1, 0.1);
    const dir = normalize([
      Math.cos(az) * Math.cos(pitch),
      Math.sin(pitch),
      Math.sin(az) * Math.cos(pitch),
    ]);
    const c = center(y);
    const rT = trunkR(y);
    const start = add(c, [Math.cos(az) * rT * 0.6, 0, Math.sin(az) * rT * 0.6]);
    // Lower limbs are shorter in the layered/rounded crowns.
    const lenScale =
      p.kind === 'deciduous' || p.kind === 'jungle-canopy'
        ? lerp(0.75, 1.1, f)
        : lerp(0.85, 1.05, f);
    let length =
      (crownR * cfg.limbLen * lenScale * rng.range(0.85, 1.1)) /
      Math.max(0.5, Math.cos(pitch) * 0.9 + 0.1);
    // Keep limbs inside the vertical extent: tall pitches must not overshoot the top.
    const room = H - y;
    length = Math.min(length, (room * 0.97) / Math.max(0.2, Math.sin(pitch) + 0.15));
    const rad = Math.max(0.03, rT * rng.range(0.34, 0.48) * (p.kind === 'jungle-giant' ? 0.75 : 1));
    // Lobes: assign this limb to the nearest lobe blob so normals/AO follow it.
    let blob = 0;
    if (lobeCenters.length) {
      let best = Infinity;
      const end = add(start, mul(dir, length));
      for (let k = 0; k < lobeCenters.length; k++) {
        const dd = Math.hypot(...sub(end, lobeCenters[k]!));
        if (dd < best) {
          best = dd;
          blob = k + 1;
        }
      }
    }
    grow(start, dir, length, rad, 1, blob, 0);
  }

  // Leader / crown filler near the trunk top so the centre is never see-through.
  const nLead = lod === 2 ? 2 : 5;
  for (let i = 0; i < nLead; i++) {
    const c = center(yTop);
    const a = rng.range(0, Math.PI * 2);
    const rr = rng.range(0.1, 0.35) * crownR;
    anchors.push({
      p: [
        c[0] + Math.cos(a) * rr,
        lerp(yTop, crownTop * 0.9, rng.range(0.1, 0.9)),
        c[2] + Math.sin(a) * rr,
      ],
      dir: normalize([Math.cos(a) * 0.4, 0.8, Math.sin(a) * 0.4]),
      blob: 0,
      size: rng.range(0.9, 1.2),
    });
  }

  return { wood, anchors, blobs, trunkTop: yTop, crownBase, crownTop, crownR };
}

function buildButtress(
  m: MeshBuf,
  rng: Rng,
  center: (y: number) => V3,
  trunkR: (y: number) => number,
  H: number,
  lod: 0 | 1 | 2,
): void {
  const n = rng.int(3, 5);
  const az0 = rng.range(0, Math.PI * 2);
  const N = lod === 0 ? 6 : lod === 1 ? 4 : 3;
  const at = (i: number): V3 => [m.pos[i * 3]!, m.pos[i * 3 + 1]!, m.pos[i * 3 + 2]!];
  /** Quad a-b-d-c with the winding that faces `want`. */
  const quad = (a: number, b: number, c: number, d: number, want: V3): void => {
    const nn = cross(sub(at(b), at(a)), sub(at(c), at(a)));
    if (dot(nn, want) >= 0) {
      m.tri(a, b, c);
      m.tri(b, d, c);
    } else {
      m.tri(a, c, b);
      m.tri(b, c, d);
    }
  };
  for (let f = 0; f < n; f++) {
    const az = az0 + (f / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const radial: V3 = [Math.cos(az), 0, Math.sin(az)];
    const tang: V3 = [-radial[2], 0, radial[0]];
    const hFin = H * rng.range(0.14, 0.2);
    const len = H * rng.range(0.075, 0.115);
    const thick = rng.range(0.14, 0.24) * (H / 30);
    const LT: number[] = [];
    const RT: number[] = [];
    const LB: number[] = [];
    const RB: number[] = [];
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const y = hFin * Math.pow(1 - s, 1.7);
      const dist = len * Math.pow(s, 0.8);
      const c = center(y);
      const base = add(c, mul(radial, trunkR(y) * 0.7 + dist));
      const tk = thick * lerp(1, 0.3, s) * (i === 0 ? 0.7 : 1);
      const ao = lerp(0.78, 0.95, 1 - s);
      const u = (dist + 0.3) / BARK_TILE_U;
      const ridgeN = normalize([radial[0] * 0.5 * (1 - s), 1, radial[2] * 0.5 * (1 - s)]);
      for (const side of [-1, 1] as const) {
        const off = mul(tang, side * tk);
        const top = m.vertex(
          [base[0] + off[0], y, base[2] + off[2]],
          normalize(add(ridgeN, mul(tang, side * 0.6))),
          u,
          y / BARK_TILE_V,
          ao,
        );
        const bot = m.vertex(
          [base[0] + off[0], 0, base[2] + off[2]],
          mul(tang, side),
          u,
          0,
          ao * 0.85,
        );
        if (side < 0) {
          LT.push(top);
          LB.push(bot);
        } else {
          RT.push(top);
          RB.push(bot);
        }
      }
    }
    for (let i = 0; i < N; i++) {
      quad(LT[i]!, LT[i + 1]!, RT[i]!, RT[i + 1]!, UP);
      quad(LT[i]!, LT[i + 1]!, LB[i]!, LB[i + 1]!, mul(tang, -1));
      quad(RT[i]!, RT[i + 1]!, RB[i]!, RB[i + 1]!, tang);
    }
  }
}

// ---- leaf cards -------------------------------------------------------------------------------

const LOD_ROWS = [2, 2, 2] as const;
const LOD_COLS = [2, 2, 2] as const;

function addCard(
  m: MeshBuf,
  o: {
    origin: V3;
    axis: V3;
    side: V3;
    len: number;
    width: number;
    fold: number;
    rect: [number, number, number, number];
    flip: boolean;
    rows: number;
    cols: number;
    blob: Blob;
    tint: number;
    yMin: number;
  },
): void {
  const n0 = normalize(cross(o.side, o.axis));
  const [u0, v0, u1, v1] = o.rect;
  const first = m.verts;
  for (let r = 0; r < o.rows; r++) {
    const t = r / (o.rows - 1);
    const along = add(o.origin, mul(o.axis, o.len * t));
    for (let c = 0; c < o.cols; c++) {
      const f = c / (o.cols - 1);
      const x = f - 0.5;
      const fold = o.fold * o.width * (1 - Math.abs(2 * x));
      let p = add(along, mul(o.side, x * o.width));
      p = add(p, mul(n0, fold));
      if (p[1] < o.yMin) p = [p[0], o.yMin, p[2]];
      // Proxy normal: crown ellipsoid gradient blended with the card normal.
      const b = o.blob;
      const d: V3 = [
        (p[0] - b.c[0]) / (b.a * b.a),
        (p[1] - b.c[1]) / (b.b * b.b),
        (p[2] - b.c[2]) / (b.a * b.a),
      ];
      const pn = normalize(d);
      const cn = dot(n0, pn) < 0 ? mul(n0, -1) : n0;
      const n = normalize(add(add(mul(pn, 0.55), mul(cn, 0.35)), [0, 0.3, 0]));
      // AO: darker toward crown interior and lower crown.
      const dist = Math.hypot((p[0] - b.c[0]) / b.a, (p[1] - b.c[1]) / b.b, (p[2] - b.c[2]) / b.a);
      const inner = smoothstep(0.15, 1.0, dist);
      const low = smoothstep(-1, 0.6, (p[1] - b.c[1]) / b.b);
      const ao = clamp(lerp(0.6, 1, inner) * lerp(0.85, 1, low), 0.4, 1);
      const uu = o.flip ? 1 - f : f;
      // Slight per-card warm/cool variation (stays <= 1).
      const g = ao * (1 - 0.05 * o.tint);
      const bl = ao * (1 - 0.1 * o.tint);
      m.vertex(p, n, lerp(u0, u1, uu), lerp(v1, v0, t), ao, g, bl);
    }
  }
  for (let r = 0; r < o.rows - 1; r++)
    for (let c = 0; c < o.cols - 1; c++) {
      const a = first + r * o.cols + c;
      const b = a + 1;
      const cI = a + o.cols;
      const d = cI + 1;
      m.tri(a, b, cI);
      m.tri(b, d, cI);
    }
}

function buildFoliage(
  p: BroadleafParams,
  sk: Skeleton,
  mats: BroadleafMaterials,
  dens: number,
): MeshBuf {
  const cfg = CFG[p.kind];
  const rng = new Rng(p.seed * 97 + 5 + p.kind.length * 13);
  const m = new MeshBuf();
  const sizeMul = (dens >= 1 ? 1 : Math.pow(dens, -0.42)) * [1, 1.25, 1.7][p.lod]!;
  const rows = LOD_ROWS[p.lod];
  const cols = LOD_COLS[p.lod];
  const nR = mats.rects.length;
  const perAnchor = cfg.perAnchor * dens;
  for (const an of sk.anchors) {
    const blob = sk.blobs[an.blob] ?? sk.blobs[0]!;
    let k = Math.floor(perAnchor);
    if (rng.next() < perAnchor - k) k++;
    for (let c = 0; c < k; c++) {
      const ri = rng.int(0, nR - 1);
      const rect = mats.rects[ri]!;
      const aspect = mats.aspect[ri] ?? 0.85;
      const out = normalize(sub(an.p, blob.c));
      const rnd: V3 = normalize([rng.range(-1, 1), rng.range(-0.5, 1), rng.range(-1, 1)]);
      let axis = normalize(add(add(mul(an.dir, 0.5), mul(rnd, 0.85)), mul(out, 0.55)));
      if (axis[1] < -0.35) axis = normalize([axis[0], -0.35 + 0.1, axis[2]]);
      const s0 = normalize(cross(axis, UP));
      // Sprays mostly lie flat (plane normal ~ up); some turn on edge for side coverage.
      const roll =
        rng.next() < 0.75
          ? rng.range(-0.5, 0.5)
          : rng.range(1.0, 2.1) * (rng.next() < 0.5 ? 1 : -1);
      const side = rotate(s0, axis, roll);
      const len = cfg.card * an.size * sizeMul * rng.range(0.8, 1.2);
      const width = len * aspect * rng.range(0.95, 1.2);
      // Centre the spray around the anchor (a little base-biased so stems start at the branch).
      const origin = sub(an.p, mul(axis, len * rng.range(0.15, 0.4)));
      addCard(m, {
        origin,
        axis,
        side,
        len,
        width,
        fold: rng.range(0.03, 0.09),
        rect,
        flip: rng.next() < 0.5,
        rows,
        cols,
        blob,
        tint: rng.next(),
        yMin: 0.25,
      });
    }
  }
  return m;
}

// ---- build ------------------------------------------------------------------------------------

export function buildBroadleaf(p: BroadleafParams, m: BroadleafMaterials): BuiltModel {
  const H = p.height;
  const sk = buildSkeleton(p);
  const budget = BUDGET[p.kind][p.lod];
  const woodTris = sk.wood.tris;
  const gen = (d: number): MeshBuf => buildFoliage(p, sk, m, d);
  const cap = [3, 4, 9][p.lod]!;
  let foliage = gen(cap);
  if (foliage.tris + woodTris > budget) {
    let lo = 0.02;
    let hi = cap;
    let best: MeshBuf | null = null;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) / 2;
      const f = gen(mid);
      if (f.tris + woodTris <= budget) {
        best = f;
        lo = mid;
      } else hi = mid;
    }
    foliage = best ?? gen(lo);
  }

  // Normalise so the tallest vertex is exactly the requested height.
  let top = 0;
  for (const buf of [sk.wood, foliage])
    for (let i = 1; i < buf.pos.length; i += 3) top = Math.max(top, buf.pos[i]!);
  if (top > 1e-3) {
    const k = H / top;
    for (const buf of [sk.wood, foliage])
      for (let i = 1; i < buf.pos.length; i += 3) buf.pos[i] = buf.pos[i]! * k;
  }
  let radius = 0;
  for (const buf of [sk.wood, foliage])
    for (let i = 0; i < buf.pos.length; i += 3)
      radius = Math.max(radius, Math.hypot(buf.pos[i]!, buf.pos[i + 2]!));

  return {
    parts: [
      { geometry: repairNormals(sk.wood.toGeometry()), material: m.bark },
      { geometry: repairNormals(foliage.toGeometry()), material: m.foliage },
    ],
    height: H,
    radius,
  };
}

// ---- materials --------------------------------------------------------------------------------

export function createBroadleafMaterials(
  maps: {
    bark: PbrMaterialMaps;
    albedo: THREE.Texture;
    normal: THREE.Texture;
    rects: [number, number, number, number][];
    aspect: number[];
  },
  alphaToCoverage: boolean,
): BroadleafMaterials {
  const bark = new THREE.MeshStandardMaterial({
    name: 'broadleaf-bark',
    map: maps.bark.map,
    normalMap: maps.bark.normalMap,
    aoMap: maps.bark.armMap,
    roughnessMap: maps.bark.armMap,
    roughness: 1,
    metalness: 0,
    vertexColors: true,
  });
  const foliage = new THREE.MeshStandardMaterial({
    name: 'broadleaf-foliage',
    map: maps.albedo,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.7, 0.7),
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    alphaToCoverage,
    roughness: 0.9,
    envMapIntensity: 0.7,
    metalness: 0,
    vertexColors: true,
  });
  foliage.forceSinglePass = true;
  // Both faces of a card shade with the same (proxy-blended) normal: undersides must not go black.
  const prev = foliage.onBeforeCompile;
  foliage.onBeforeCompile = (shader, renderer) => {
    prev.call(foliage, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace(
        'float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;',
        'float faceDirection = 1.0;',
      ),
    );
  };
  const prevKey = foliage.customProgramCacheKey.bind(foliage);
  foliage.customProgramCacheKey = () => prevKey() + '|broadleaf-foliage-v1';
  return { bark, foliage, rects: maps.rects, aspect: maps.aspect };
}
