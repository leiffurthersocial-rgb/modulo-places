// Procedural conifers (fir / pine / saplings) and fallen logs built from baked "branch card"
// textures (scripts/bake-foliage.ts) plus the scanned bark material.
//
// A tree = tapered, slightly bent trunk (bark, UVs in metres) + whorls of branches. Each branch is
// 2-4 crossed/fanned arched cards textured with a random baked patch rect; tips droop. Vertex
// colour = AO-ish darkening (toward the trunk / lower crown), vertex normals are blended toward an
// ellipsoid proxy around the crown so the whole crown shades volumetrically. Pivot = trunk base.
// Everything is deterministic for a given seed. Materials are plain MeshStandardMaterials: the
// engine runs patchMaterial (wind + fog) on them afterwards.
import * as THREE from 'three';
import type { PbrMaterialMaps } from '../assets/AssetLoader';
import { Rng } from '../core/random';

export interface ConiferParams {
  kind: 'fir' | 'pine';
  height: number;
  seed: number;
  lod: 0 | 1 | 2;
  /** Young tree (short branches, foliage nearly to the ground). Derived from height < 4.5 m when omitted. */
  sapling?: boolean;
}

export interface ConiferMaterials {
  bark: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  /** Atlas rects [u0, v0, u1, v1] in texture space with v measured from the TOP row (KTX2, flipY=false). */
  rects: [number, number, number, number][];
  /** width / height of each rect (as baked, in metres: the patches share one texel density). */
  aspect: number[];
}

export interface BuiltPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface BuiltModel {
  parts: BuiltPart[];
  /** Total height (m) / horizontal footprint radius (m). */
  height: number;
  radius: number;
}

// ---- small vector helpers (plain tuples: this runs per tree build) ----------------------------

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Rodrigues rotation of v about unit axis k. */
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

// ---- geometry accumulator ---------------------------------------------------------------------

class MeshBuf {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  moss: number[] = [];
  idx: number[] = [];

  get tris(): number {
    return this.idx.length / 3;
  }
  get verts(): number {
    return this.pos.length / 3;
  }

  vertex(p: V3, n: V3, u: number, v: number, ao: number, moss = 0): number {
    const i = this.verts;
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.col.push(ao, ao, ao);
    this.moss.push(moss);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  toGeometry(withMoss = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (withMoss) g.setAttribute('aMoss', new THREE.Float32BufferAttribute(this.moss, 1));
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

/** Connect two consecutive rings of `segs + 1` vertices (seam duplicated). */
function bridge(m: MeshBuf, ringA: number, ringB: number, segs: number): void {
  for (let i = 0; i < segs; i++) {
    const a = ringA + i;
    const b = ringB + i;
    m.tri(a, b, a + 1);
    m.tri(a + 1, b, b + 1);
  }
}

// ---- trunk ------------------------------------------------------------------------------------

const BARK_TILE_U = 1.0; // metres around per texture repeat
const BARK_TILE_V = 1.5; // metres along per texture repeat
const RADIAL: [number, number, number] = [10, 7, 5];

function trunkRadius(y: number, H: number, r0: number): number {
  const t = clamp(y / H, 0, 1);
  const taper = 1 - 0.93 * Math.pow(t, 0.85);
  const flare = 1 + 0.6 * Math.exp(-y / (0.22 + 0.012 * H));
  return Math.max(0.012, r0 * taper * flare);
}

function buildTrunk(
  H: number,
  r0: number,
  bend: { ax: number; az: number; ay: number },
  lod: 0 | 1 | 2,
  sapling: boolean,
): { mesh: MeshBuf; center: (y: number) => V3 } {
  const m = new MeshBuf();
  const segs = RADIAL[lod];
  const center = (y: number): V3 => {
    const t = y / H;
    const k = t * t;
    return [bend.ax * k * H + bend.ay * Math.sin(t * 5.1) * 0.012 * H, y, bend.az * k * H];
  };
  const ys: number[] = [0, 0.12, 0.35];
  const dy = lod === 0 ? (sapling ? H / 5 : 1.1) : lod === 1 ? Math.max(2.5, H / 5) : H / 2;
  for (let y = 0.35 + dy; y < H - dy * 0.4; y += dy) ys.push(y);
  ys.push(H);
  if (lod === 2) ys.splice(1, 2); // no flare rings
  // Bark UV: one texture repeat spans tileU metres around; keep texel aspect square.
  const circ0 = 2 * Math.PI * r0;
  const tileU = Math.max(1, Math.round(circ0 / BARK_TILE_U));
  const mPerU = circ0 / tileU;
  let prev = -1;
  for (const y of ys) {
    const r = trunkRadius(y, H, r0);
    const c = center(y);
    const c2 = center(Math.min(H, y + 0.2));
    const axis = normalize([c2[0] - c[0], c2[1] - c[1], c2[2] - c[2]]);
    const e1: V3 = normalize(cross(axis, [0, 0, 1]));
    const e2: V3 = cross(e1, axis);
    const slope = (trunkRadius(y, H, r0) - trunkRadius(Math.min(H, y + 0.3), H, r0)) / 0.3;
    const ao = y < 0.5 ? lerp(0.75, 1, y / 0.5) : 1;
    const ring = m.verts;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const rad = add(mul(e1, Math.cos(a)), mul(e2, Math.sin(a)));
      const n = normalize(add(rad, mul(axis, slope)));
      const vp = add(c, mul(rad, r));
      vp[1] = Math.max(0, vp[1]);
      m.vertex(vp, n, (i / segs) * tileU, y / (mPerU * BARK_TILE_V), ao);
    }
    if (prev >= 0) bridge(m, prev, ring, segs);
    prev = ring;
  }
  return { mesh: m, center };
}

// ---- crown profiles ---------------------------------------------------------------------------

interface Style {
  sapling: boolean;
  /** height of the first whorl / of the crown base (m) */
  crownBase: number;
  rMax: number;
  spacing: number;
  branchesPerWhorl: number;
  cardsPerBranch: number;
  irregular: number;
  radiusAt: (hf: number) => number;
  /** branch pitch (rad) at crown fraction hf (negative = droop) */
  pitchAt: (hf: number) => number;
  /** tip droop as a fraction of card length */
  droopAt: (hf: number) => number;
}

function styleFor(p: ConiferParams, sapling: boolean): Style {
  const H = p.height;
  if (sapling) {
    const rMax = Math.max(0.25, H * 0.3);
    return {
      sapling,
      crownBase: Math.max(0.05, H * 0.05),
      rMax,
      spacing: Math.max(0.12, H * 0.065),
      branchesPerWhorl: 6,
      cardsPerBranch: 2,
      irregular: 0.3,
      radiusAt: (hf) => rMax * (0.12 + 0.88 * Math.pow(1 - hf, 0.85)),
      pitchAt: (hf) => lerp(-0.1, 0.55, hf * hf),
      droopAt: (hf) => lerp(0.25, 0.05, hf),
    };
  }
  if (p.kind === 'fir') {
    const rMax = H * 0.155;
    return {
      sapling,
      crownBase: H * 0.2,
      rMax,
      spacing: Math.max(0.3, H * 0.025),
      branchesPerWhorl: 7,
      cardsPerBranch: 3,
      irregular: 0.25,
      radiusAt: (hf) => rMax * (0.08 + 0.92 * Math.pow(1 - hf, 0.92)),
      pitchAt: (hf) => lerp(-0.3, 0.5, Math.pow(hf, 1.2)),
      droopAt: (hf) => lerp(0.3, 0.06, hf),
    };
  }
  const rMax = H * 0.17;
  return {
    sapling,
    crownBase: H * 0.5,
    rMax,
    spacing: Math.max(0.4, H * 0.027),
    branchesPerWhorl: 5,
    cardsPerBranch: 3,
    irregular: 0.85,
    radiusAt: (hf) => {
      const rise =
        hf < 0.35 ? 0.55 + 0.45 * (hf / 0.35) : 1 - 0.72 * Math.pow((hf - 0.35) / 0.65, 2.2);
      return rMax * rise;
    },
    pitchAt: (hf) => lerp(0.05, 0.5, hf),
    droopAt: (hf) => lerp(0.12, 0.04, hf),
  };
}

// ---- foliage ----------------------------------------------------------------------------------

interface CrownProxy {
  cx: (y: number) => V3;
  yc: number;
  a: number;
  b: number;
}

interface CardOpts {
  origin: V3;
  axis: V3;
  side: V3;
  len: number;
  width: number;
  droop: number;
  fold: number;
  rect: [number, number, number, number];
  flip: boolean;
  aoBase: number;
  aoTip: number;
  rows: number;
  cols: number;
}

function addCard(m: MeshBuf, o: CardOpts, proxy: CrownProxy): void {
  const n0 = normalize(cross(o.side, o.axis));
  const [u0, v0, u1, v1] = o.rect;
  const first = m.verts;
  for (let r = 0; r < o.rows; r++) {
    const t = r / (o.rows - 1);
    const along = add(o.origin, mul(o.axis, o.len * t));
    const droopY = -o.droop * o.len * t * t;
    for (let c = 0; c < o.cols; c++) {
      const f = c / (o.cols - 1);
      const x = f - 0.5;
      const fold = o.fold * o.width * (1 - Math.abs(2 * x));
      let p = add(along, mul(o.side, x * o.width));
      p = add(p, mul(n0, fold));
      p = [p[0], Math.max(0.03, p[1] + droopY), p[2]];
      // Normal: 0.6 crown ellipsoid proxy + 0.4 card normal (aligned to the proxy side).
      const cc = proxy.cx(p[1]);
      const d: V3 = [
        (p[0] - cc[0]) / (proxy.a * proxy.a),
        (p[1] - proxy.yc) / (proxy.b * proxy.b),
        (p[2] - cc[2]) / (proxy.a * proxy.a),
      ];
      const pn = normalize(d);
      const cn = dot(n0, pn) < 0 ? mul(n0, -1) : n0;
      const n = normalize(add(mul(pn, 0.6), mul(cn, 0.4)));
      const ao = lerp(o.aoBase, o.aoTip, smoothstep(0, 0.65, t));
      const uu = o.flip ? 1 - f : f;
      m.vertex(p, n, lerp(u0, u1, uu), lerp(v1, v0, t), ao);
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

const LOD_DENSITY = [1, 0.5, 0.22] as const;
const CARD_MAX_LEN = 1.7;
const LOD_ROWS = [3, 2, 2] as const;
const LOD_COLS = [3, 3, 2] as const;
const BUDGET = {
  fir: [8000, 3000, 1000],
  pine: [6000, 3000, 1000],
  sapling: [2500, 1200, 500],
} as const;

interface FoliageResult {
  mesh: MeshBuf;
}

function buildFoliage(
  p: ConiferParams,
  st: Style,
  mats: ConiferMaterials,
  center: (y: number) => V3,
  r0: number,
  dens: number,
): FoliageResult {
  const H = p.height;
  const rng = new Rng((p.seed ^ (p.kind === 'fir' ? 0x51ed : 0x9a71)) + 7919);
  const m = new MeshBuf();
  const crownH = H - st.crownBase;
  const proxy: CrownProxy = {
    cx: center,
    yc: st.crownBase + crownH * 0.5,
    a: st.rMax * 1.05,
    b: crownH * (p.kind === 'pine' && !st.sapling ? 0.55 : 0.75),
  };
  const sd = Math.sqrt(dens);
  const sizeMul = Math.pow(dens, -0.3);
  const rows = LOD_ROWS[p.lod];
  const cols = LOD_COLS[p.lod];
  const nR = mats.rects.length;
  const pickRect = (): { rect: [number, number, number, number]; aspect: number } => {
    const i = rng.int(0, nR - 1);
    return { rect: mats.rects[i]!, aspect: mats.aspect[i] ?? 0.8 };
  };
  const spacing = st.spacing / sd;
  const up: V3 = [0, 1, 0];
  const aoBoost = p.kind === 'pine' ? 1.25 : 1;
  const nb0 = Math.max(3, Math.round(st.branchesPerWhorl * sd));

  let y = st.crownBase + rng.range(0, spacing * 0.3);
  while (y < H - spacing * 0.45) {
    const hf = clamp((y - st.crownBase) / crownH, 0, 1);
    const R = st.radiusAt(hf);
    const nb = Math.max(3, nb0 + (st.irregular > 0.5 ? rng.int(-1, 1) : 0));
    const phi0 = rng.range(0, Math.PI * 2);
    for (let j = 0; j < nb; j++) {
      const phi = phi0 + (j / nb) * Math.PI * 2 + rng.range(-0.35, 0.35) * (0.5 + st.irregular);
      const by = y + rng.range(-0.5, 0.5) * spacing * (0.4 + st.irregular);
      const pitch0 = st.pitchAt(hf) + rng.range(-0.12, 0.12);
      const lenVar = 1 - st.irregular * 0.5 * rng.next();
      const Lb = Math.max(0.2, (R * lenVar * sizeMul) / Math.max(0.6, Math.cos(pitch0)));
      const trunkC = center(by);
      const trunkR = trunkRadius(by, H, r0);
      let k = st.cardsPerBranch + (Lb > 1.7 && p.kind === 'fir' ? 1 : 0);
      if (p.lod === 2) k = Math.min(k, 2);
      for (let c = 0; c < k; c++) {
        const yaw = phi + rng.range(-0.22, 0.22);
        const pitch = pitch0 + rng.range(-0.1, 0.1);
        const a: V3 = normalize([
          Math.cos(yaw) * Math.cos(pitch),
          Math.sin(pitch),
          Math.sin(yaw) * Math.cos(pitch),
        ]);
        const s0 = normalize(cross(a, up));
        const roll =
          (c === 0 ? 0 : c % 2 === 1 ? 1 : -1) * (c === 3 ? 1.4 : 0.75) + rng.range(-0.2, 0.2);
        const side = rotate(s0, a, c === 3 ? Math.PI / 2 + rng.range(-0.2, 0.2) : roll);
        const { rect, aspect } = pickRect();
        const len = Lb * rng.range(0.85, 1.1);
        const start = mul([a[0], 0, a[2]], trunkR * 0.55);
        const o0 = add(add(trunkC, [0, by - trunkC[1], 0]), start);
        const droop = st.droopAt(hf) * rng.range(0.7, 1.3);
        const width = len * aspect * rng.range(0.9, 1.15);
        const flip = rng.next() < 0.5;
        const aoBase = Math.min(
          1,
          clamp(0.55 + 0.25 * hf + rng.range(-0.05, 0.05), 0.4, 0.95) * lerp(0.82, 1, hf) * aoBoost,
        );
        const aoTip = clamp(
          (lerp(0.75, 1.0, hf) + rng.range(-0.06, 0.04)) * Math.min(1.1, aoBoost),
          0.5,
          1,
        );
        const fold = rng.range(0.03, 0.08);
        if (len > CARD_MAX_LEN && p.lod < 2) {
          // Long branch: two shorter cards chained (keeps texel density near native).
          const l1 = len * 0.56;
          const l2 = len * 0.62;
          addCard(
            m,
            {
              origin: o0,
              axis: a,
              side,
              len: l1,
              width: l1 * aspect * 1.05,
              droop: droop * 0.4,
              fold,
              rect,
              flip,
              aoBase,
              aoTip: lerp(aoBase, aoTip, 0.6),
              rows,
              cols,
            },
            proxy,
          );
          const t = 0.44;
          const o1: V3 = [
            o0[0] + a[0] * len * t,
            o0[1] + a[1] * len * t - droop * 0.4 * l1 * 0.9,
            o0[2] + a[2] * len * t,
          ];
          const a2 = normalize([a[0], a[1] - droop * 0.9 * t, a[2]]);
          const r2 = pickRect();
          addCard(
            m,
            {
              origin: o1,
              axis: a2,
              side,
              len: l2,
              width: l2 * r2.aspect * 1.05,
              droop: droop * 0.8,
              fold,
              rect: r2.rect,
              flip: !flip,
              aoBase: lerp(aoBase, aoTip, 0.5),
              aoTip,
              rows,
              cols,
            },
            proxy,
          );
        } else {
          addCard(
            m,
            {
              origin: o0,
              axis: a,
              side,
              len,
              width,
              droop,
              fold,
              rect,
              flip,
              aoBase,
              aoTip,
              rows,
              cols,
            },
            proxy,
          );
        }
      }
    }
    // Filler cards near the trunk so the crown is never see-through.
    const fillers = p.lod === 2 ? 1 : st.sapling ? 1 : 2;
    for (let f = 0; f < fillers; f++) {
      const yaw = rng.range(0, Math.PI * 2);
      const pitch = rng.range(-0.1, 0.9);
      const a: V3 = normalize([
        Math.cos(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.sin(yaw) * Math.cos(pitch),
      ]);
      const side = rotate(normalize(cross(a, up)), a, rng.range(-0.6, 0.6));
      const { rect, aspect } = pickRect();
      const len = Math.max(0.2, R * 0.6 * sizeMul * rng.range(0.8, 1.1));
      const c0 = center(y);
      addCard(
        m,
        {
          origin: [c0[0], y + rng.range(-0.2, 0.2) * spacing, c0[2]],
          axis: a,
          side,
          len,
          width: len * aspect * 1.35,
          droop: 0.1,
          fold: 0.05,
          rect,
          flip: rng.next() < 0.5,
          aoBase: 0.5,
          aoTip: 0.62 + 0.2 * hf,
          rows,
          cols,
        },
        proxy,
      );
    }
    y += spacing * (st.irregular > 0.5 ? rng.range(0.7, 1.35) : rng.range(0.9, 1.1));
  }

  // Leader: two crossed vertical cards ending exactly at the treetop.
  const leaderLen = Math.max(0.35, H * 0.07) * sizeMul;
  const topC = center(H - leaderLen * 0.9);
  for (let c = 0; c < 2; c++) {
    const { rect, aspect } = pickRect();
    const sideDir: V3 = c === 0 ? [1, 0, 0] : [0, 0, 1];
    const rot = rotate(sideDir, up, rng.range(0, Math.PI));
    addCard(
      m,
      {
        origin: topC,
        axis: [0, 1, 0],
        side: rot,
        len: leaderLen * 0.95,
        width: leaderLen * aspect * 1.1,
        droop: 0,
        fold: 0.03,
        rect,
        flip: rng.next() < 0.5,
        aoBase: 0.85,
        aoTip: 1,
        rows,
        cols,
      },
      proxy,
    );
  }
  return { mesh: m };
}

function maxCoord(m: MeshBuf, axis: 0 | 1 | 2): number {
  let mx = -Infinity;
  for (let i = axis; i < m.pos.length; i += 3) mx = Math.max(mx, m.pos[i]!);
  return mx;
}

export function buildConifer(p: ConiferParams, m: ConiferMaterials): BuiltModel {
  const H = p.height;
  const sapling = p.sapling ?? H < 4.5;
  const rng = new Rng(p.seed * 31 + (p.kind === 'fir' ? 11 : 23));
  const st = styleFor(p, sapling);
  const r0 = Math.max(0.03, H * (p.kind === 'pine' && !sapling ? 0.019 : 0.017));
  const bendAmp = (p.kind === 'pine' && !sapling ? 0.03 : 0.012) + (sapling ? 0.02 : 0);
  const ang = rng.range(0, Math.PI * 2);
  const bend = {
    ax: Math.cos(ang) * bendAmp * rng.range(0.5, 1),
    az: Math.sin(ang) * bendAmp * rng.range(0.5, 1),
    ay: rng.range(-1, 1),
  };
  const trunk = buildTrunk(H, r0, bend, p.lod, sapling);

  const budget = BUDGET[sapling ? 'sapling' : p.kind][p.lod];
  const trunkTris = trunk.mesh.tris;
  const cap = 1.25 * LOD_DENSITY[p.lod]!;
  const gen = (d: number): FoliageResult => buildFoliage(p, st, m, trunk.center, r0, d);
  let foliage = gen(cap);
  if (foliage.mesh.tris + trunkTris > budget) {
    let lo = 0.02;
    let hi = cap;
    let best: FoliageResult | null = null;
    for (let i = 0; i < 9; i++) {
      const mid = (lo + hi) / 2;
      const f = gen(mid);
      if (f.mesh.tris + trunkTris <= budget) {
        best = f;
        lo = mid;
      } else hi = mid;
    }
    foliage = best ?? gen(lo);
  }

  // Normalise so the tallest vertex is exactly the requested height.
  const top = Math.max(maxCoord(trunk.mesh, 1), maxCoord(foliage.mesh, 1));
  if (top > H) {
    const k = H / top;
    for (const buf of [trunk.mesh, foliage.mesh])
      for (let i = 1; i < buf.pos.length; i += 3) buf.pos[i] = buf.pos[i]! * k;
  }
  let radius = 0;
  for (let i = 0; i < foliage.mesh.pos.length; i += 3)
    radius = Math.max(radius, Math.hypot(foliage.mesh.pos[i]!, foliage.mesh.pos[i + 2]!));

  return {
    parts: [
      { geometry: trunk.mesh.toGeometry(), material: m.bark },
      { geometry: foliage.mesh.toGeometry(), material: m.foliage },
    ],
    height: H,
    radius,
  };
}

// ---- materials --------------------------------------------------------------------------------

export function createConiferMaterials(
  maps: {
    bark: PbrMaterialMaps;
    albedo: THREE.Texture;
    normal: THREE.Texture;
    rects: [number, number, number, number][];
    aspect: number[];
  },
  alphaToCoverage: boolean,
): ConiferMaterials {
  const bark = new THREE.MeshStandardMaterial({
    name: 'conifer-bark',
    map: maps.bark.map,
    normalMap: maps.bark.normalMap,
    aoMap: maps.bark.armMap,
    roughnessMap: maps.bark.armMap,
    roughness: 1,
    metalness: 0,
  });
  const foliage = new THREE.MeshStandardMaterial({
    name: 'conifer-foliage',
    map: maps.albedo,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(0.8, 0.8),
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    alphaToCoverage,
    roughness: 0.75,
    metalness: 0,
    vertexColors: true,
  });
  foliage.forceSinglePass = true;
  // Both faces of a card shade with the same (proxy-blended) normal: undersides must not flip to
  // an inward normal and go black.
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
  foliage.customProgramCacheKey = () => prevKey() + '|conifer-foliage-v1';
  return { bark, foliage, rects: maps.rects, aspect: maps.aspect };
}

// ---- fallen logs ------------------------------------------------------------------------------

export interface LogParams {
  length: number;
  radius: number;
  seed: number;
  lod: 0 | 1 | 2;
}

/**
 * A fallen, slightly irregular trunk lying along +X, centred on x = 0 (x in [-length/2, +length/2]),
 * resting on y = 0, with a jagged broken end at +X and a few stub branches. Bark UVs in metres.
 * Geometry attributes: `color` (AO: darker underside) and `aMoss` (0..1, up-facing top). With a
 * `moss` material the returned bark material is a clone of `bark` that blends `moss.map` over the
 * up-facing top in-shader; otherwise `bark` is returned as is. `height` = 2 * radius (diameter),
 * `radius` = half length (footprint).
 */
export function buildLog(
  p: LogParams,
  bark: THREE.MeshStandardMaterial,
  moss?: THREE.MeshStandardMaterial,
): BuiltModel {
  const rng = new Rng(p.seed * 17 + 5);
  const L = p.length;
  const r0 = p.radius;
  const segs = RADIAL[p.lod];
  const m = new MeshBuf();
  const sway = rng.range(0.01, 0.03) * L;
  const swayPh = rng.range(0, 6.28);
  const centerAt = (x: number): V3 => [
    x,
    r0 * 1.08 + 0.02 * Math.sin(x * 1.3),
    sway * Math.sin((x / L) * 3.1 + swayPh),
  ];
  const rAt = (x: number): number => r0 * lerp(1.05, 0.78, (x + L / 2) / L);
  const ph1 = rng.range(0, 6.28);
  const ph2 = rng.range(0, 6.28);
  const circ = 2 * Math.PI * r0;
  const tileU = Math.max(1, Math.round(circ / BARK_TILE_U));
  const mPerU = circ / tileU;
  const step = ([0.4, 0.9, 1.8] as const)[p.lod];
  const nRings = Math.max(4, Math.round(L / step));

  const mossAt = (ny: number): number => smoothstep(-0.15, 0.6, ny);
  const aoAt = (ny: number): number => lerp(0.55, 1, smoothstep(-0.8, 0.4, ny));

  // Main tube from butt (x=-L/2) to the break (x=+L/2); the last ring is jagged.
  let prev = -1;
  const ringVerts: number[] = [];
  const addRing = (x: number, jagged: boolean, rScale: number): number => {
    const c = centerAt(x);
    const ring = m.verts;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const wob =
        1 + 0.045 * Math.sin(3 * a + ph1 + x * 0.7) + 0.03 * Math.sin(5 * a + ph2 - x * 0.4);
      const rad: V3 = [0, Math.cos(a), Math.sin(a)];
      let px = x;
      let r = rAt(x) * wob * rScale;
      if (jagged) {
        const tooth = i % 2 === 0 ? 1 : 0.25;
        px += tooth * r0 * rng.range(0.25, 0.9);
        r *= rng.range(0.7, 0.95);
      }
      const n = normalize([0, rad[1], rad[2]]);
      m.vertex(
        [px, c[1] + rad[1] * r, c[2] + rad[2] * r],
        n,
        (i / segs) * tileU,
        (x + L / 2) / (mPerU * BARK_TILE_V),
        aoAt(n[1]),
        mossAt(n[1]),
      );
    }
    ringVerts.push(ring);
    return ring;
  };
  for (let i = 0; i <= nRings; i++) {
    const x = -L / 2 + (L * i) / nRings;
    const ring = addRing(x, false, 1);
    if (prev >= 0) bridge(m, prev, ring, segs);
    prev = ring;
  }
  // Broken tip: one ragged ring beyond the end.
  const brk = addRing(L / 2 + r0 * 0.15, true, 0.85);
  bridge(m, prev, brk, segs);
  // End caps: fans to a centre vertex (butt flat, break ragged).
  const cap = (ring: number, x: number, sign: number, ao: number): void => {
    const c = centerAt(x);
    const ci = m.vertex([x + sign * r0 * 0.12, c[1], c[2]], [sign, 0, 0], c[2], c[1], ao, 0);
    const first = m.verts;
    for (let i = 0; i <= segs; i++) {
      const sp: V3 = [
        m.pos[(ring + i) * 3]!,
        m.pos[(ring + i) * 3 + 1]!,
        m.pos[(ring + i) * 3 + 2]!,
      ];
      m.vertex(sp, [sign, 0, 0], sp[2], sp[1], ao, 0);
    }
    for (let i = 0; i < segs; i++) {
      if (sign > 0) m.tri(ci, first + i + 1, first + i);
      else m.tri(ci, first + i, first + i + 1);
    }
  };
  cap(ringVerts[0]!, -L / 2, -1, 0.85);
  cap(brk, L / 2 + r0 * 0.15, 1, 0.9);

  // Stub branches.
  const nStubs = p.lod === 2 ? 1 : 2 + (p.lod === 0 && rng.next() < 0.5 ? 1 : 0);
  const sSegs = p.lod === 0 ? 5 : 4;
  for (let s = 0; s < nStubs; s++) {
    const x = rng.range(-0.3, 0.35) * L;
    const a = rng.range(-1.1, 1.1) + (rng.next() < 0.3 ? Math.PI * 0.5 : 0); // around the log (0 = up)
    const upDir: V3 = [0, Math.cos(a), Math.sin(a)];
    const sd = normalize(add(mul(upDir, 1), [rng.range(-0.5, 0.5), 0, 0]));
    const sl = rng.range(0.25, 0.5) * Math.min(1, r0 * 5);
    const sr = Math.max(0.025, r0 * rng.range(0.1, 0.17));
    const c = centerAt(x);
    const o = add(c, mul(upDir, rAt(x) * 0.85));
    const e1 = normalize(cross(sd, [1, 0.01, 0.02]));
    const e2 = cross(e1, sd);
    const rings = p.lod === 0 ? 3 : 2;
    let sp = -1;
    for (let r = 0; r < rings; r++) {
      const t = r / (rings - 1);
      const rr = sr * lerp(1.25, r === rings - 1 ? 0.55 : 0.8, t);
      const ring = m.verts;
      for (let i = 0; i <= sSegs; i++) {
        const ang = (i / sSegs) * Math.PI * 2;
        const rad = add(mul(e1, Math.cos(ang)), mul(e2, Math.sin(ang)));
        const jag = r === rings - 1 && i % 2 === 0 ? 0.12 * sl : 0;
        const pos = add(add(o, mul(sd, sl * t + jag)), mul(rad, rr));
        const nn = normalize(add(rad, mul(sd, 0.3)));
        m.vertex(
          pos,
          nn,
          (i / sSegs) * 0.5,
          (sl * t) / BARK_TILE_V,
          lerp(0.8, 1, nn[1] * 0.5 + 0.5),
          mossAt(nn[1]) * 0.5,
        );
      }
      if (sp >= 0) bridge(m, sp, ring, sSegs);
      sp = ring;
    }
    // Flat-ish tip cap.
    const tipC = add(o, mul(sd, sl * 1.02));
    const ci = m.vertex(tipC, sd, 0.5, 0.5, 0.9, 0);
    for (let i = 0; i < sSegs; i++) m.tri(ci, sp + i + 1, sp + i);
  }

  let mat: THREE.Material = bark;
  if (moss) mat = mossBlendMaterial(bark, moss);
  let radius = 0;
  let hmax = 0;
  for (let i = 0; i < m.pos.length; i += 3) {
    radius = Math.max(radius, Math.abs(m.pos[i]!));
    hmax = Math.max(hmax, m.pos[i + 1]!);
  }
  return { parts: [{ geometry: m.toGeometry(true), material: mat }], height: hmax, radius };
}

function mossBlendMaterial(
  bark: THREE.MeshStandardMaterial,
  moss: THREE.MeshStandardMaterial,
): THREE.MeshStandardMaterial {
  const mat = bark.clone();
  mat.name = 'log-bark-moss';
  mat.vertexColors = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.uniforms.mossMap = { value: moss.map };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aMoss;\nvarying float vMoss;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMoss = aMoss;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D mossMap;\nvarying float vMoss;',
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec2 mossUv = vMapUv * 1.3;
          vec4 mc = texture2D(mossMap, mossUv);
          float breakup = texture2D(mossMap, mossUv * 0.37).g - 0.5;
          float mw = smoothstep(0.4, 0.7, vMoss + breakup * 0.5) * 0.92;
          diffuseColor.rgb = mix(diffuseColor.rgb, mc.rgb, mw);
        }`,
      );
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|log-moss-v1';
  return mat;
}
