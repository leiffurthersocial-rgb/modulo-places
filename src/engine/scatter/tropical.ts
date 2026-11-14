// Procedural tropical plants: big-leaf plants (monstera, banana, elephant-ear), feather palms, tree
// ferns and bamboo clumps. Leaf cards come from two baked atlases (scripts/bake-tropical.ts):
//   "tropical"    — scanned calathea/anthurium/fern leaves flattened from their UV layout
//   "bamboo-leaf" — procedurally drawn bamboo leaf sprays and palm leaflet fans
// Trunks use the scanned 'jungle/bark-tropical' material; bamboo culms and banana pseudo-stems are
// vertex-coloured with a node-ring/stripe shader. Everything is deterministic per seed; every
// builder returns BuiltModel-like { parts, height, radius } for LOD 0..2 (repairNormals applied).
// Materials are plain MeshStandardMaterials: the engine runs patchMaterial (wind + fog) afterwards
// (tropicalSpecies does that for the scatter system).
import * as THREE from 'three';
import type { AssetLoader, PbrMaterialMaps, Tier } from '../assets/AssetLoader';
import { Rng } from '../core/random';
import { patchMaterial } from '../render/materials';
import { repairNormals, type BuiltModel } from './conifer';
import type { Species } from './species';

export type Rect = [number, number, number, number];
export type TropicalLod = 0 | 1 | 2;
export type BigLeafKind = 'monstera' | 'banana' | 'elephant-ear';

export interface FoliageAtlas {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  rects: Rect[];
  aspect: number[];
}

export interface TropicalMaterials {
  /** Big leaves + fern fronds ("tropical" atlas). */
  leaf: THREE.MeshStandardMaterial;
  /** Bamboo sprays + palm leaflet fans ("bamboo-leaf" atlas). */
  spray: THREE.MeshStandardMaterial;
  /** Scanned palm / tree-fern trunk bark (vertex colour darkens it). */
  bark: THREE.MeshStandardMaterial;
  /** Procedural culm / pseudo-stem: vertex colour + node rings. */
  culm: THREE.MeshStandardMaterial;
  /** tropical atlas rects: 0 heart, 1 monstera, 2/3 long anthurium, 4/5 fern strap. */
  rects: Rect[];
  aspect: number[];
  /** bamboo-leaf atlas rects: 0/1 bamboo sprays, 2/3 palm leaflet fans. */
  sprayRects: Rect[];
  sprayAspect: number[];
}

// ---- vector helpers -----------------------------------------------------------------------------

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
const lerp3 = (a: V3, b: V3, t: number): V3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const UP: V3 = [0, 1, 0];

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

// ---- geometry accumulator -----------------------------------------------------------------------

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

  vertex(p: V3, n: V3, u: number, v: number, c: V3): number {
    const i = this.verts;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
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

interface Part {
  buf: MeshBuf;
  material: THREE.Material;
}

const totalTris = (parts: Part[]): number => parts.reduce((a, p) => a + p.buf.tris, 0);

/** Largest density in [0.04, 1] whose build fits the triangle budget (deterministic bisect). */
function fit(budget: number, gen: (density: number) => Part[]): Part[] {
  const full = gen(1);
  if (totalTris(full) <= budget) return full;
  let lo = 0.04;
  let hi = 1;
  let best: Part[] | null = null;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    const b = gen(mid);
    if (totalTris(b) <= budget) {
      best = b;
      lo = mid;
    } else hi = mid;
  }
  return best ?? gen(0.04);
}

function finish(parts: Part[]): BuiltModel {
  let height = 0;
  let radius = 0;
  const out: BuiltModel['parts'] = [];
  for (const p of parts) {
    if (p.buf.tris === 0) continue;
    for (let i = 0; i < p.buf.pos.length; i += 3) {
      height = Math.max(height, p.buf.pos[i + 1]!);
      radius = Math.max(radius, Math.hypot(p.buf.pos[i]!, p.buf.pos[i + 2]!));
    }
    out.push({ geometry: repairNormals(p.buf.toGeometry()), material: p.material });
  }
  return { parts: out, height, radius };
}

// ---- primitives ---------------------------------------------------------------------------------

interface TubeOpts {
  segs: number;
  /** texture repeats around the tube (u runs 0..uTile) */
  uTile: number;
  /** v coordinate at distance `along` (m) from the start */
  vOf: (along: number) => number;
  colorOf: (i: number, n: number, along: number) => V3;
  /** extra normal tilt along the axis (cone slope), per ring */
  slope?: (i: number) => number;
}

/** Swept tube along `pts` (parallel-transport frames). Returns the start vertex of each ring. */
function addTube(m: MeshBuf, pts: V3[], radii: number[], o: TubeOpts): number[] {
  const n = pts.length;
  const rings: number[] = [];
  let ref: V3 =
    Math.abs(pts[1]![1] - pts[0]![1]) > 0.8 * Math.hypot(...sub(pts[1]!, pts[0]!)) ? [1, 0, 0] : UP;
  let along = 0;
  let prevT: V3 | null = null;
  let e1: V3 = [1, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(n - 1, i + 1)]!;
    const T = normalize(sub(b, a));
    if (prevT === null) {
      e1 = normalize(cross(T, ref));
      ref = e1;
    } else {
      // transport the previous frame onto the new tangent
      const k = cross(prevT, T);
      const kl = Math.hypot(...k);
      if (kl > 1e-6) e1 = rotate(e1, mul(k, 1 / kl), Math.asin(clamp(kl, -1, 1)));
      e1 = normalize(sub(e1, mul(T, dot(e1, T))));
    }
    prevT = T;
    const e2 = cross(T, e1);
    if (i > 0) along += Math.hypot(...sub(pts[i]!, pts[i - 1]!));
    const r = radii[i]!;
    const sl = o.slope ? o.slope(i) : 0;
    const c = o.colorOf(i, n, along);
    const ring = m.verts;
    rings.push(ring);
    for (let s = 0; s <= o.segs; s++) {
      const ang = (s / o.segs) * Math.PI * 2;
      const rad = add(mul(e1, Math.cos(ang)), mul(e2, Math.sin(ang)));
      const nn = normalize(add(rad, mul(T, sl)));
      m.vertex(add(pts[i]!, mul(rad, r)), nn, (s / o.segs) * o.uTile, o.vOf(along), c);
    }
    if (i > 0) {
      const pr = rings[i - 1]!;
      for (let s = 0; s < o.segs; s++) {
        const q = pr + s;
        const w = ring + s;
        m.tri(q, w, q + 1);
        m.tri(q + 1, w, w + 1);
      }
    }
  }
  return rings;
}

/** Points of an arc: heading pitch p0 -> p0 + bend over length `len` (bend^pow ramp), yaw fixed. */
function arc(
  origin: V3,
  yaw: number,
  p0: number,
  bend: number,
  len: number,
  n: number,
  pow = 1,
): V3[] {
  const pts: V3[] = [origin];
  let c = origin;
  for (let i = 1; i <= n; i++) {
    const tm = (i - 0.5) / n;
    const p = p0 + bend * Math.pow(tm, pow);
    const h: V3 = [Math.cos(yaw) * Math.cos(p), Math.sin(p), Math.sin(yaw) * Math.cos(p)];
    c = add(c, mul(h, len / n));
    pts.push(c);
  }
  return pts;
}

const headingAt = (yaw: number, p: number): V3 => [
  Math.cos(yaw) * Math.cos(p),
  Math.sin(p),
  Math.sin(yaw) * Math.cos(p),
];

interface CardOpts {
  origin: V3;
  axis: V3;
  side: V3;
  len: number;
  width: number;
  /** gravity sag: tip drops by droop * len (quadratic along the card) */
  droop: number;
  /** V cross-section: midrib lifted by fold * width * 0.5 */
  fold: number;
  /** side roll along the length (rad) */
  twist?: number;
  rect: Rect;
  /** sub-range of the rect across (0..1), for torn strips */
  uRange?: [number, number];
  flip?: boolean;
  rows: number;
  cols: number;
  col0: V3;
  col1: V3;
  /** blend of the shading normal toward the sky (0..1) */
  nUp?: number;
}

/** A curved textured card (leaf blade / frond / spray). v runs base -> tip. */
function addCard(m: MeshBuf, o: CardOpts): void {
  const [u0, v0, u1, v1] = o.rect;
  const [ua, ub] = o.uRange ?? [0, 1];
  const nUp = o.nUp ?? 0.3;
  const first = m.verts;
  const a0 = normalize(o.axis);
  for (let r = 0; r < o.rows; r++) {
    const t = r / (o.rows - 1);
    const sag = o.droop * o.len * t * t;
    const centre = add(add(o.origin, mul(a0, o.len * t)), [0, -sag, 0]);
    // tangent of the sagging curve
    const tan = normalize([a0[0] * o.len, a0[1] * o.len - 2 * o.droop * o.len * t, a0[2] * o.len]);
    let side = normalize(sub(o.side, mul(tan, dot(o.side, tan))));
    if (o.twist) side = rotate(side, tan, o.twist * t);
    let n0 = normalize(cross(side, tan));
    if (n0[1] < 0) n0 = mul(n0, -1);
    const c = lerp3(o.col0, o.col1, smoothstep(0, 0.75, t));
    for (let k = 0; k < o.cols; k++) {
      const f = k / (o.cols - 1);
      const x = f - 0.5;
      const lift = o.fold * o.width * (0.5 - Math.abs(x));
      const p = add(add(centre, mul(side, x * o.width)), mul(n0, lift));
      const tilt = mul(side, o.fold * Math.sign(x));
      const n = normalize(add(mul(normalize(add(n0, tilt)), 1 - nUp), mul(UP, nUp)));
      const uu = o.flip ? 1 - f : f;
      m.vertex(p, n, lerp(u0, u1, lerp(ua, ub, uu)), lerp(v1, v0, t), c);
    }
  }
  for (let r = 0; r < o.rows - 1; r++)
    for (let k = 0; k < o.cols - 1; k++) {
      const a = first + r * o.cols + k;
      const b = a + 1;
      const c = a + o.cols;
      const d = c + 1;
      m.tri(a, b, c);
      m.tri(b, d, c);
    }
}

// ---- shared tables ------------------------------------------------------------------------------

const LOD_ROWS = [5, 3, 3] as const;
const LOD_COLS = [3, 3, 3] as const;
const BUDGET = {
  bigleaf: [1500, 600, 225],
  banana: [1500, 600, 225],
  palm: [4000, 1600, 600],
  fern: [2500, 1000, 375],
  bamboo: [6000, 2400, 900],
} as const;

// linear-light vertex colours
const LEAF_BASE: V3 = [0.62, 0.66, 0.6];
const LEAF_TIP: V3 = [1.05, 1.05, 1.0];
/** Extra gain for the (dark) scanned big leaves and fern fronds. */
const SCAN_GAIN = 1.3;
const CULM_GREEN: V3 = [0.075, 0.2, 0.04];
const CULM_YELLOW: V3 = [0.3, 0.3, 0.05];

const BARK_TILE_V = 1.5;

// ---- big-leaf plants ----------------------------------------------------------------------------

export interface BigLeafParams {
  kind: BigLeafKind;
  height: number;
  seed: number;
  lod: TropicalLod;
}

function bigLeafParts(p: BigLeafParams, mats: TropicalMaterials, d: number): Part[] {
  const rng = new Rng(p.seed * 31 + (p.kind === 'banana' ? 5 : p.kind === 'monstera' ? 11 : 23));
  const H = p.height;
  const leafBuf = new MeshBuf();
  const stemBuf = new MeshBuf();
  const lod = p.lod;
  const rows = LOD_ROWS[lod];
  const cols = LOD_COLS[lod];
  const sd = Math.sqrt(d);
  const banana = p.kind === 'banana';
  const nBase = banana ? 11 : p.kind === 'monstera' ? 12 : 10;
  const n = Math.max(
    lod === 2 ? 4 : 5,
    Math.round(nBase * sd * (lod === 0 ? 1 : lod === 1 ? 0.75 : 0.5)),
  );
  const phi0 = rng.range(0, Math.PI * 2);
  const stemSegs = lod === 0 ? 5 : 4;

  // Banana: tall pseudo-stem the leaves fan out of.
  const stemTop = banana ? H * 0.5 : 0;
  if (banana) {
    const nr = lod === 0 ? 11 : lod === 1 ? 5 : 2;
    const lean: V3 = [rng.range(-0.04, 0.04) * H, 0, rng.range(-0.04, 0.04) * H];
    const pts: V3[] = [];
    const radii: number[] = [];
    for (let i = 0; i <= nr; i++) {
      const t = i / nr;
      pts.push([lean[0] * t * t, stemTop * t, lean[2] * t * t]);
      radii.push(lerp(0.07 * H, 0.045 * H, Math.pow(t, 0.8)) * (i === 0 ? 1.15 : 1));
    }
    const sheath: V3 = [0.16, 0.3, 0.07];
    const dead: V3 = [0.2, 0.13, 0.07];
    addTube(stemBuf, pts, radii, {
      segs: lod === 0 ? 9 : lod === 1 ? 6 : 5,
      uTile: 3,
      vOf: (a) => a / 0.7,
      colorOf: (_i, _n, a) =>
        lerp3(lerp3(dead, sheath, smoothstep(0.1, 0.9, a)), mul(sheath, 1.2), a / stemTop),
      slope: () => 0.05,
    });
  }
  const crown: V3 = banana ? [0, stemTop, 0] : [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const phi = phi0 + i * 2.39996 + rng.range(-0.15, 0.15);
    const young = i / n; // later = steeper + shorter
    const yaw = phi;
    const startR = banana ? 0.01 * H : 0.03 * H * rng.next();
    const o0 = add(crown, [Math.cos(phi) * startR, 0, Math.sin(phi) * startR]);
    let petLen: number;
    let leafLen: number;
    let pitch0: number;
    let pBend: number;
    let bladeDroop: number;
    let rectIdx: number;
    let leafWidthK = 1;
    if (p.kind === 'monstera') {
      petLen = H * rng.range(0.42, 0.72) * (1 - 0.3 * young);
      leafLen = H * rng.range(0.46, 0.6);
      pitch0 = rng.range(1.2, 1.45);
      pBend = -rng.range(0.35, 0.85);
      bladeDroop = rng.range(0.3, 0.6);
      rectIdx = 1;
    } else if (p.kind === 'elephant-ear') {
      petLen = H * rng.range(0.5, 0.8) * (1 - 0.3 * young);
      leafLen = H * rng.range(0.4, 0.52);
      pitch0 = rng.range(1.3, 1.5);
      pBend = -rng.range(0.25, 0.65);
      bladeDroop = rng.range(0.55, 0.95);
      rectIdx = 0;
    } else {
      petLen = H * rng.range(0.2, 0.32);
      leafLen = H * rng.range(0.62, 0.8) * (1 - 0.25 * young);
      pitch0 = rng.range(0.85, 1.25) + young * 0.2;
      pBend = -rng.range(0.1, 0.4);
      bladeDroop = rng.range(0.35, 0.75) * (1 - 0.5 * young);
      rectIdx = rng.next() < 0.5 ? 2 : 3;
      leafWidthK = 1.1;
    }
    const nPet = lod === 0 ? 4 : 3;
    const pts = arc(o0, yaw, pitch0, pBend, petLen, nPet, 1.2);
    const end = pts[pts.length - 1]!;
    const endPitch = pitch0 + pBend;
    if (lod < 2) {
      const rBase = (banana ? 0.012 : 0.0125) * H;
      addTube(
        stemBuf,
        pts,
        pts.map((_, k) => rBase * lerp(1, 0.55, k / (pts.length - 1))),
        {
          segs: stemSegs,
          uTile: 1,
          vOf: () => 0.5,
          colorOf: (_i, _nn, a) =>
            lerp3([0.1, 0.2, 0.05], [0.14, 0.26, 0.06], clamp(a / petLen, 0, 1)),
        },
      );
    }
    const axis = headingAt(yaw, endPitch + rng.range(-0.1, 0.1));
    const side0 = normalize(cross(axis, UP));
    const rect = mats.rects[rectIdx]!;
    const asp = mats.aspect[rectIdx] ?? 0.9;
    const aoBase = lerp(0.55, 0.8, young) + rng.range(-0.05, 0.05);
    const col0: V3 = mul(LEAF_BASE, (SCAN_GAIN * aoBase) / 0.62);
    const col1: V3 = mul(LEAF_TIP, SCAN_GAIN * rng.range(0.88, 1.04));
    const roll = rng.range(-0.35, 0.35);
    const side = rotate(side0, axis, roll);
    if (banana) {
      // Torn blade: three strips fanning slightly, outer ones sagging more.
      const fullW = leafLen * asp * leafWidthK;
      const strips = lod === 0 ? 3 : lod === 1 ? 2 : 1;
      const sw = fullW / strips;
      const flip = rng.next() < 0.5;
      for (let s = 0; s < strips; s++) {
        const k = s - (strips - 1) / 2;
        const sy = yaw + k * 0.045;
        const ax = headingAt(sy, endPitch + rng.range(-0.04, 0.04) - Math.abs(k) * 0.08);
        const sdv = rotate(normalize(cross(ax, UP)), ax, roll + k * 0.18);
        addCard(leafBuf, {
          origin: add(end, mul(sdv, k * sw * 0.98)),
          axis: ax,
          side: sdv,
          len: leafLen * (1 - Math.abs(k) * 0.05 * rng.next()),
          width: sw * 1.02,
          droop: bladeDroop * (1 + Math.abs(k) * 0.25),
          fold: 0.1,
          twist: k * 0.25,
          rect,
          uRange: strips === 1 ? [0, 1] : [s / strips, (s + 1) / strips],
          flip,
          rows: lod === 0 ? 7 : lod === 1 ? 4 : 3,
          cols: 2,
          col0,
          col1,
        });
      }
    } else {
      addCard(leafBuf, {
        origin: end,
        axis,
        side,
        len: leafLen,
        width: leafLen * asp * rng.range(0.95, 1.1),
        droop: bladeDroop,
        fold: rng.range(0.12, 0.28),
        twist: rng.range(-0.3, 0.3),
        rect,
        flip: rng.next() < 0.5,
        rows: rows + (lod === 0 ? 1 : 0),
        cols: cols + (lod === 0 ? 1 : 0),
        col0,
        col1,
      });
    }
  }
  return [
    { buf: stemBuf, material: mats.culm },
    { buf: leafBuf, material: mats.leaf },
  ];
}

export function buildBigLeafPlant(p: BigLeafParams, mats: TropicalMaterials): BuiltModel {
  const budget = (p.kind === 'banana' ? BUDGET.banana : BUDGET.bigleaf)[p.lod];
  return finish(fit(budget, (d) => bigLeafParts(p, mats, d)));
}

// ---- trunks -------------------------------------------------------------------------------------

function trunkPath(
  H: number,
  rng: Rng,
  lean: number,
  n: number,
): { pts: V3[]; at: (t: number) => V3 } {
  const ang = rng.range(0, Math.PI * 2);
  const ax = Math.cos(ang) * lean * H;
  const az = Math.sin(ang) * lean * H;
  const ph = rng.range(0, 6.28);
  const wob = rng.range(0.004, 0.012) * H;
  const at = (t: number): V3 => [
    ax * t * t + Math.sin(t * 4.2 + ph) * wob * t,
    H * t,
    az * t * t + Math.cos(t * 3.4 + ph) * wob * t,
  ];
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) pts.push(at(i / n));
  return { pts, at };
}

// ---- palm ---------------------------------------------------------------------------------------

export interface PalmParams {
  height: number;
  seed: number;
  lod: TropicalLod;
}

function palmParts(p: PalmParams, mats: TropicalMaterials, d: number): Part[] {
  const rng = new Rng(p.seed * 31 + 41);
  const H = p.height;
  const lod = p.lod;
  const trunkH = H * 0.8;
  const trunkBuf = new MeshBuf();
  const frondBuf = new MeshBuf();
  const rachisBuf = new MeshBuf();
  const sd = Math.sqrt(d);
  const { pts: _p, at } = trunkPath(trunkH, rng, rng.range(0.02, 0.06), 4);
  void _p;
  // Rings: bumps every `spacing` metres, sampled 3x per period at LOD0.
  const spacing = Math.max(0.35, H / 20);
  const step = lod === 0 ? spacing / 3 : lod === 1 ? Math.max(spacing, trunkH / 7) : trunkH / 2.5;
  const nr = Math.max(2, Math.round(trunkH / step));
  const r0 = 0.021 * H;
  const pts: V3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= nr; i++) {
    const t = i / nr;
    const y = t * trunkH;
    pts.push(at(t));
    const flare = 1 + 0.55 * Math.exp(-y / (0.12 * H));
    const base = r0 * flare * lerp(1, 0.78, t);
    const ph = (y / spacing) % 1;
    const bump = lod === 0 ? 1 + 0.07 * Math.exp(-Math.pow((ph < 0.5 ? ph : ph - 1) * 6, 2)) : 1;
    radii.push(base * bump);
  }
  const circ = 2 * Math.PI * r0;
  const tileU = Math.max(1, Math.round(circ / 1.0));
  const mPerU = circ / tileU;
  addTube(trunkBuf, pts, radii, {
    segs: lod === 0 ? 8 : lod === 1 ? 6 : 5,
    uTile: tileU,
    vOf: (a) => a / (mPerU * BARK_TILE_V),
    colorOf: (i, _n, a) => {
      const band = lod === 0 ? 0.85 + 0.15 * Math.cos(((a / spacing) % 1) * Math.PI * 2) : 1;
      const ao = a < 0.6 ? lerp(0.75, 1, a / 0.6) : 1;
      return mul([1.5, 1.4, 1.25], band * ao * (i % 2 === 0 ? 1 : 0.97));
    },
    slope: () => 0.04,
  });

  // Crown.
  const top = at(1);
  const nF = Math.max(
    lod === 2 ? 6 : 8,
    Math.round(rng.int(12, 15) * sd * (lod === 0 ? 1 : lod === 1 ? 0.8 : 0.6)),
  );
  const phi0 = rng.range(0, Math.PI * 2);
  const nRach = lod === 0 ? 7 : lod === 1 ? 4 : 2;
  const nCards = Math.max(lod === 2 ? 3 : 4, Math.round((lod === 0 ? 9 : lod === 1 ? 6 : 3) * sd));
  const L0 = H * 0.44;
  const rectIdx = [2, 3] as const;
  for (let f = 0; f < nF; f++) {
    const young = f / nF; // 0 = oldest/lowest (drooping), 1 = newest (upright)
    const yaw = phi0 + f * 2.39996 + rng.range(-0.12, 0.12);
    const pitch0 = lerp(0.15, 1.2, Math.pow(young, 0.9)) + rng.range(-0.1, 0.1);
    const bend = -lerp(1.7, 0.55, young) * rng.range(0.85, 1.1);
    const L = L0 * lerp(1.05, 0.7, young) * rng.range(0.9, 1.08);
    const o = add(top, [0, -0.02 * H * (1 - young), 0]);
    const rpts = arc(o, yaw, pitch0, bend, L, nRach, 1.4);
    if (lod < 2)
      addTube(
        rachisBuf,
        rpts,
        rpts.map((_, k) => 0.012 * H * lerp(1, 0.25, k / (rpts.length - 1))),
        { segs: 3, uTile: 1, vOf: () => 0.5, colorOf: () => [0.2, 0.26, 0.07] },
      );
    // leaflet cards along both sides
    const ri = rectIdx[f % 2]!;
    const rect = mats.sprayRects[ri]!;
    const asp = mats.sprayAspect[ri] ?? 1;
    for (let k = 0; k < nCards; k++) {
      const t = lerp(0.14, 0.97, (k + 0.5) / nCards);
      // point + tangent on the arc
      const pi = t * nRach;
      const i0 = Math.min(nRach - 1, Math.floor(pi));
      const a = rpts[i0]!;
      const b = rpts[i0 + 1]!;
      const frac = pi - i0;
      const pt = lerp3(a, b, frac);
      const T = normalize(sub(b, a));
      const S = normalize(cross(UP, T));
      const B = normalize(cross(T, S));
      const prof = Math.sin(Math.PI * Math.pow(clamp(t, 0.05, 1), 0.75));
      const len = L * 0.33 * (0.45 + 0.55 * prof) * rng.range(0.92, 1.08);
      const spacingAlong = (L * 0.86) / nCards;
      const width = Math.max(spacingAlong * 1.25, len * asp * 0.3);
      for (const side of [-1, 1]) {
        const theta = lerp(-0.85, 0.15, young) + rng.range(-0.15, 0.15);
        let ax = add(add(mul(S, side * Math.cos(theta)), mul(B, Math.sin(theta))), mul(T, 0.45));
        ax = normalize(ax);
        const sideV = normalize(sub(T, mul(ax, dot(T, ax))));
        const ao = lerp(0.62, 0.85, young);
        addCard(frondBuf, {
          origin: pt,
          axis: ax,
          side: sideV,
          len,
          width,
          droop: lerp(0.5, 0.2, young) * rng.range(0.8, 1.2),
          fold: 0.12,
          rect,
          flip: (k + (side > 0 ? 1 : 0)) % 2 === 0,
          rows: lod === 0 ? 4 : lod === 1 ? 3 : 2,
          cols: lod === 0 ? 3 : 2,
          col0: mul(LEAF_BASE, ao / 0.62),
          col1: mul(LEAF_TIP, rng.range(0.9, 1.05)),
          nUp: 0.4,
        });
      }
    }
  }
  return [
    { buf: trunkBuf, material: mats.bark },
    { buf: rachisBuf, material: mats.culm },
    { buf: frondBuf, material: mats.spray },
  ];
}

export function buildPalm(p: PalmParams, mats: TropicalMaterials): BuiltModel {
  return finish(fit(BUDGET.palm[p.lod], (d) => palmParts(p, mats, d)));
}

// ---- tree fern ----------------------------------------------------------------------------------

export interface TreeFernParams {
  height: number;
  seed: number;
  lod: TropicalLod;
}

function treeFernParts(p: TreeFernParams, mats: TropicalMaterials, d: number): Part[] {
  const rng = new Rng(p.seed * 31 + 59);
  const H = p.height;
  const lod = p.lod;
  const trunkH = H * 0.76;
  const trunkBuf = new MeshBuf();
  const frondBuf = new MeshBuf();
  const sd = Math.sqrt(d);
  const { pts: _p, at } = trunkPath(trunkH, rng, rng.range(0.02, 0.07), 4);
  void _p;
  const nr = lod === 0 ? 10 : lod === 1 ? 5 : 2;
  const r0 = 0.034 * H;
  const pts: V3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= nr; i++) {
    const t = i / nr;
    pts.push(at(t));
    radii.push(
      r0 *
        lerp(1.15, 0.85, t) *
        (1 + 0.5 * Math.exp(-t * trunkH * 4)) *
        (1 + 0.06 * Math.sin(i * 2.3)),
    );
  }
  const circ = 2 * Math.PI * r0;
  const tileU = Math.max(1, Math.round(circ / 0.8));
  const mPerU = circ / tileU;
  addTube(trunkBuf, pts, radii, {
    segs: lod === 0 ? 8 : lod === 1 ? 6 : 5,
    uTile: tileU,
    vOf: (a) => a / (mPerU * BARK_TILE_V),
    colorOf: (_i, _n, a) => mul([1.6, 1.3, 1.05], a < 0.4 ? lerp(0.7, 1, a / 0.4) : 1),
    slope: () => 0.05,
  });
  const top = at(1);
  const nF = Math.max(
    lod === 2 ? 6 : 8,
    Math.round(rng.int(14, 18) * sd * (lod === 0 ? 1 : lod === 1 ? 0.75 : 0.5)),
  );
  const phi0 = rng.range(0, Math.PI * 2);
  for (let f = 0; f < nF; f++) {
    const young = f / nF;
    const yaw = phi0 + f * 2.39996 + rng.range(-0.12, 0.12);
    const pitch0 = lerp(0.5, 1.35, Math.pow(young, 0.9)) + rng.range(-0.1, 0.1);
    const len = H * rng.range(0.5, 0.62) * lerp(1.05, 0.7, young);
    const axis = headingAt(yaw, pitch0);
    const side = rotate(normalize(cross(axis, UP)), axis, rng.range(-0.25, 0.25));
    const ri = rng.next() < 0.5 ? 4 : 5;
    const rect = mats.rects[ri]!;
    const asp = mats.aspect[ri] ?? 0.2;
    const width = len * asp * rng.range(2.0, 2.5);
    const ao = lerp(0.6, 0.85, young);
    const o = add(top, [Math.cos(yaw) * 0.05 * H, -0.01 * H, Math.sin(yaw) * 0.05 * H]);
    for (let c = 0; c < (lod === 2 ? 1 : 2); c++)
      addCard(frondBuf, {
        origin: o,
        axis,
        side: rotate(side, axis, c === 0 ? 0 : 1.15),
        len: len * (c === 0 ? 1 : 0.88),
        width: width * (c === 0 ? 1 : 0.8),
        droop: lerp(0.8, 0.35, young) * rng.range(0.85, 1.15),
        fold: 0.16,
        twist: rng.range(-0.3, 0.3),
        rect,
        flip: rng.next() < 0.5,
        rows: lod === 0 ? 7 : lod === 1 ? 4 : 3,
        cols: lod === 0 ? 3 : 2,
        col0: mul(LEAF_BASE, (SCAN_GAIN * ao) / 0.62),
        col1: mul(LEAF_TIP, SCAN_GAIN * rng.range(0.9, 1.05)),
        nUp: 0.4,
      });
  }
  return [
    { buf: trunkBuf, material: mats.bark },
    { buf: frondBuf, material: mats.leaf },
  ];
}

export function buildTreeFern(p: TreeFernParams, mats: TropicalMaterials): BuiltModel {
  return finish(fit(BUDGET.fern[p.lod], (d) => treeFernParts(p, mats, d)));
}

// ---- bamboo -------------------------------------------------------------------------------------

export interface BambooParams {
  height: number;
  seed: number;
  lod: TropicalLod;
  /** 6..20 */
  culms: number;
}

function bambooParts(p: BambooParams, mats: TropicalMaterials, d: number): Part[] {
  const rng = new Rng(p.seed * 31 + 71);
  const H = p.height;
  const lod = p.lod;
  const culmBuf = new MeshBuf();
  const leafBuf = new MeshBuf();
  const nC = clamp(Math.round(p.culms), 6, 20);
  const R = 0.3 + nC * 0.035;
  const segs = lod === 0 ? 6 : lod === 1 ? 5 : 4;
  const ringStep = lod === 0 ? 0.9 : lod === 1 ? 1.8 : 3.4;
  const sd = Math.sqrt(d);
  for (let c = 0; c < nC; c++) {
    const rad = R * Math.sqrt(rng.next());
    const a = c * 2.39996 + rng.range(-0.3, 0.3);
    const base: V3 = [Math.cos(a) * rad, -0.03, Math.sin(a) * rad];
    const hh = c === 0 ? H * 0.97 : H * rng.range(0.62, 1.0);
    // lean outward, with an arching top
    const out = rad / R;
    const leanAmt = rng.range(0.06, 0.15) * (0.5 + out) * hh;
    const lx = Math.cos(a + rng.range(-0.6, 0.6)) * leanAmt;
    const lz = Math.sin(a + rng.range(-0.6, 0.6)) * leanAmt;
    const wph = rng.range(0, 6.28);
    const posAt = (t: number): V3 => [
      base[0] + lx * Math.pow(t, 2.1) + Math.sin(t * 5 + wph) * 0.012 * hh * t,
      base[1] + hh * t * (1 - 0.02 * t * t),
      base[2] + lz * Math.pow(t, 2.1) + Math.cos(t * 4.3 + wph) * 0.012 * hh * t,
    ];
    const nr = Math.max(3, Math.ceil(hh / ringStep));
    const pts: V3[] = [];
    const radii: number[] = [];
    const r0 = 0.0042 * hh + 0.012;
    for (let i = 0; i <= nr; i++) {
      const t = i / nr;
      pts.push(posAt(t));
      radii.push(r0 * lerp(1, 0.36, Math.pow(t, 0.85)) * (i === nr ? 0.5 : 1));
    }
    const spacing = rng.range(0.27, 0.38) * (0.7 + 0.3 * (hh / 8));
    const phase = rng.range(0, 1);
    const age = rng.next();
    const ca = lerp3(CULM_GREEN, CULM_YELLOW, smoothstep(0.35, 1, age) * 0.85);
    addTube(culmBuf, pts, radii, {
      segs,
      uTile: 1,
      vOf: (al) => al / spacing + phase,
      colorOf: (_i, _n, al) => {
        const ao = al < 2.5 ? lerp(0.5 + 0.3 * (1 - out), 1, al / 2.5) : 1;
        const tt = al / hh;
        return mul(lerp3(ca, mul(ca, 1.25), tt), ao);
      },
      slope: () => 0.02,
    });
    // branches with leaf sprays in the upper half
    const nb = Math.round((5 + hh * 1.1) * sd);
    for (let b = 0; b < nb; b++) {
      const t = lerp(0.42, 0.985, (b + rng.next()) / Math.max(1, nb));
      const o = posAt(t);
      const yaw = rng.range(0, Math.PI * 2);
      const upper = (t - 0.4) / 0.6;
      const pitch = rng.range(0.25, 0.75) * (1 - 0.25 * upper);
      const ax = headingAt(yaw, pitch);
      const ri = rng.next() < 0.5 ? 0 : 1;
      const rect = mats.sprayRects[ri]!;
      const asp = mats.sprayAspect[ri] ?? 0.5;
      const len = (0.55 + 0.1 * hh) * rng.range(0.85, 1.15) * lerp(1.0, 0.8, upper);
      const sideA = normalize(cross(ax, UP));
      const cards = lod === 0 ? 2 : 1;
      const ao = lerp(0.55, 0.9, t) + rng.range(-0.05, 0.05);
      for (let k = 0; k < cards; k++)
        addCard(leafBuf, {
          origin: o,
          axis: ax,
          side: rotate(sideA, ax, k * 1.25 + rng.range(-0.3, 0.3)),
          len,
          width: len * asp * 1.25,
          droop: rng.range(0.35, 0.7),
          fold: 0.1,
          rect,
          flip: rng.next() < 0.5,
          rows: lod === 0 ? 4 : 3,
          cols: lod === 0 ? 3 : 2,
          col0: mul(LEAF_BASE, ao / 0.62),
          col1: mul(LEAF_TIP, rng.range(0.9, 1.05)),
          nUp: 0.35,
        });
    }
  }
  return [
    { buf: culmBuf, material: mats.culm },
    { buf: leafBuf, material: mats.spray },
  ];
}

export function buildBamboo(p: BambooParams, mats: TropicalMaterials): BuiltModel {
  return finish(fit(BUDGET.bamboo[p.lod], (d) => bambooParts(p, mats, d)));
}

// ---- materials ----------------------------------------------------------------------------------

/** Cards shade with one (sky-biased) normal on both faces so undersides do not go black. */
function twoSidedLeafMaterial(
  name: string,
  atlas: FoliageAtlas,
  alphaToCoverage: boolean,
  roughness: number,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name,
    map: atlas.albedo,
    normalMap: atlas.normal,
    normalScale: new THREE.Vector2(0.7, 0.7),
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    alphaToCoverage,
    roughness,
    metalness: 0,
    vertexColors: true,
  });
  mat.forceSinglePass = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace(
        'float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;',
        'float faceDirection = 1.0;',
      ),
    );
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|tropical-leaf-v1';
  return mat;
}

function culmMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: 'tropical-culm',
    roughness: 0.62,
    metalness: 0,
    vertexColors: true,
  });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCulmUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCulmUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCulmUv;')
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        {
          // v counts internodes: integers are nodes. Dark ring at the node, pale waxy band above
          // it, faint vertical streaks and slow mottling along the culm.
          float f = fract(vCulmUv.y);
          float dn = min(f, 1.0 - f);
          float ring = 1.0 - smoothstep(0.012, 0.055, dn);
          float wax = smoothstep(0.16, 0.02, f) * (1.0 - ring) * step(0.0, f);
          float streak = 0.5 + 0.5 * sin(vCulmUv.x * 6.2831 * 14.0 + sin(vCulmUv.y * 9.0) * 1.5);
          float mott = 0.5 + 0.5 * sin(vCulmUv.y * 1.7 + vCulmUv.x * 9.0) * sin(vCulmUv.y * 0.53 + 2.0);
          diffuseColor.rgb *= 1.0 - 0.07 * streak - 0.06 * mott;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.19, 0.15, 0.06), ring * 0.7);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7 + vec3(0.12, 0.13, 0.1), wax * 0.45);
        }`,
      );
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|tropical-culm-v1';
  return mat;
}

export interface TropicalMapSet {
  /** Scanned palm bark; a flat brown material is used when null. */
  bark: PbrMaterialMaps | null;
  tropical: FoliageAtlas;
  bambooLeaf: FoliageAtlas;
}

export function createTropicalMaterials(
  maps: TropicalMapSet,
  alphaToCoverage: boolean,
): TropicalMaterials {
  const bark = new THREE.MeshStandardMaterial(
    maps.bark
      ? {
          name: 'tropical-bark',
          map: maps.bark.map,
          normalMap: maps.bark.normalMap,
          aoMap: maps.bark.armMap,
          roughnessMap: maps.bark.armMap,
          roughness: 1,
          metalness: 0,
          vertexColors: true,
        }
      : {
          name: 'tropical-bark',
          color: 0x6b5a45,
          roughness: 0.95,
          metalness: 0,
          vertexColors: true,
        },
  );
  return {
    leaf: twoSidedLeafMaterial('tropical-leaf', maps.tropical, alphaToCoverage, 0.5),
    spray: twoSidedLeafMaterial('tropical-spray', maps.bambooLeaf, alphaToCoverage, 0.55),
    bark,
    culm: culmMaterial(),
    rects: maps.tropical.rects,
    aspect: maps.tropical.aspect,
    sprayRects: maps.bambooLeaf.rects,
    sprayAspect: maps.bambooLeaf.aspect,
  };
}

// ---- species ------------------------------------------------------------------------------------

export interface TropicalOptions {
  tier: Tier;
  anisotropy: number;
  alphaToCoverage: boolean;
  wind: number;
  flutter: number;
  /** Trunk bark material key (default 'jungle/bark-tropical'). */
  bark?: string;
}

type TropicalName = 'monstera' | 'banana' | 'elephant-ear' | 'palm' | 'tree-fern' | 'bamboo';

/** Variant heights (m) at instance scale 1. */
const HEIGHTS: Record<TropicalName, number[]> = {
  monstera: [1.3, 1.7, 2.1],
  banana: [3.4, 4.4, 5.4],
  'elephant-ear': [1.5, 2.0, 2.5],
  palm: [8, 11, 14],
  'tree-fern': [2.6, 3.6, 4.8],
  bamboo: [6, 9, 12],
};
const BAMBOO_CULMS = [8, 12, 16];

const isTropicalName = (n: string): n is TropicalName => n in HEIGHTS;

/** 'tropical:<name>' -> Species (3 variants x 3 LODs), or null when the id/atlases are unavailable. */
export async function tropicalSpecies(
  meshId: string,
  assets: AssetLoader,
  o: TropicalOptions,
): Promise<Species | null> {
  const [kind, name = ''] = meshId.split(':') as [string, string?];
  if (kind !== 'tropical' || !isTropicalName(name)) return null;
  const needsTropical = name !== 'palm' && name !== 'bamboo';
  const needsSpray = name === 'palm' || name === 'bamboo';
  const needsBark = name === 'palm' || name === 'tree-fern';
  const [tropical, bambooLeaf, bark] = await Promise.all([
    needsTropical ? assets.foliage('tropical', o.anisotropy) : Promise.resolve(null),
    needsSpray ? assets.foliage('bamboo-leaf', o.anisotropy) : Promise.resolve(null),
    needsBark
      ? assets.material(o.bark ?? 'jungle/bark-tropical', o.tier, o.anisotropy)
      : Promise.resolve(null),
  ]);
  if ((needsTropical && !tropical) || (needsSpray && !bambooLeaf)) return null;
  // The unused atlas slot is filled with the loaded one so the shared material set is complete.
  const fallback = (tropical ?? bambooLeaf)!;
  const mats = createTropicalMaterials(
    { bark, tropical: tropical ?? fallback, bambooLeaf: bambooLeaf ?? fallback },
    o.alphaToCoverage,
  );
  const heights = HEIGHTS[name];
  const windHeight = Math.max(...heights);
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [
    mats.leaf,
    mats.spray,
    mats.bark,
    mats.culm,
  ];
  const key = `tropical-${name}`;
  patchMaterial(mats.leaf, { wind: o.wind, windHeight, flutter: o.flutter, key: `${key}-leaf` });
  patchMaterial(mats.spray, { wind: o.wind, windHeight, flutter: o.flutter, key: `${key}-spray` });
  patchMaterial(mats.bark, { wind: o.wind, windHeight, key: `${key}-bark` });
  patchMaterial(mats.culm, {
    wind: o.wind,
    windHeight,
    flutter: o.flutter * 0.2,
    key: `${key}-culm`,
  });

  const variants: BuiltModel[][] = heights.map((h, v) =>
    ([0, 1, 2] as const).map((lod) => {
      const seed = 101 + v * 977;
      switch (name) {
        case 'palm':
          return buildPalm({ height: h, seed, lod }, mats);
        case 'tree-fern':
          return buildTreeFern({ height: h, seed, lod }, mats);
        case 'bamboo':
          return buildBamboo({ height: h, seed, lod, culms: BAMBOO_CULMS[v]! }, mats);
        default:
          return buildBigLeafPlant({ kind: name, height: h, seed, lod }, mats);
      }
    }),
  );
  let height = 0;
  let radius = 0;
  for (const lods of variants) {
    height = Math.max(height, lods[0]!.height);
    radius = Math.max(radius, lods[0]!.radius);
    for (const m of lods) for (const part of m.parts) owned.push(part.geometry);
  }
  return {
    variants: variants.map((lods) =>
      lods.map((m) =>
        m.parts.map((part) => ({
          geometry: part.geometry,
          material: part.material,
          castShadow: true,
        })),
      ),
    ),
    height,
    radius,
    owned,
  };
}
