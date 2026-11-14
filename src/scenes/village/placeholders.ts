// Greybox species for the Japanese Village scene (registered before the scene loads).
// Everything is procedural: merged geometries with per-vertex colours, a few LODs, and a separate
// emissive material (lanterns, shoji screens) that only glows when the mood's nightLights > 0.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Noise2D } from '../../engine/core/random';
import { patchMaterial } from '../../engine/render/materials';
import { sceneMaterial } from '../../engine/render/sceneMaterials';
import { registerPlaceholder, type Species, type SpeciesPart } from '../../engine/scatter/species';

// ---------------------------------------------------------------------------------------------
// Tiny vector + colour helpers
// ---------------------------------------------------------------------------------------------

type V3 = [number, number, number];
type RGB = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const tmpColor = new THREE.Color();
function rgb(hex: string): RGB {
  tmpColor.set(hex);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const mixc = (a: RGB, b: RGB, t: number): RGB => lerp3(a, b, t);
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function prng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Palette (sRGB hex; converted to linear on use).
const P = {
  stone: rgb('#8e8b82'),
  stoneDark: rgb('#6a675f'),
  stoneLight: rgb('#a9a69b'),
  moss: rgb('#4f6e34'),
  timber: rgb('#6a4b35'),
  timberDark: rgb('#3a2b21'),
  timberLight: rgb('#a07c54'),
  charred: rgb('#2a201a'),
  plaster: rgb('#d8cdb4'),
  plasterWarm: rgb('#d3c19c'),
  plasterWhite: rgb('#e4dece'),
  tile: rgb('#484c55'),
  tileLight: rgb('#5a5f68'),
  tileEdge: rgb('#8b8a86'),
  thatch: rgb('#8c7648'),
  thatchLight: rgb('#a68f58'),
  paper: rgb('#eadcb6'),
  vermilion: rgb('#b03a22'),
  black: rgb('#1f1b19'),
  red: rgb('#b42b22'),
  soil: rgb('#6a5a3d'),
  grassTop: rgb('#6f8a43'),
  indigo: rgb('#2a3c5e'),
};

// ---------------------------------------------------------------------------------------------
// Mesh builder: positions + normals + vertex colours + indices
// ---------------------------------------------------------------------------------------------

/** Surface material class of a triangle (library PBR materials, or `main` = vertex-coloured fallback). */
type Tag = 'main' | 'plaster' | 'wood' | 'roof' | 'stone' | 'rock' | 'gravel';

class MB {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  i: number[] = [];
  /** Material tag per triangle (parallel to `i`). */
  tg: Tag[] = [];
  /** Tag applied to triangles emitted from now on. */
  tag: Tag = 'main';
  rnd: () => number;
  constructor(seed = 1) {
    this.rnd = prng(seed * 7919 + 13);
  }
  get tris(): number {
    return this.i.length / 3;
  }
  get empty(): boolean {
    return this.i.length === 0;
  }
  private pushTris(...idx: number[]): void {
    for (const k of idx) this.i.push(k);
    for (let t = 0; t < idx.length; t += 3) this.tg.push(this.tag);
  }
  v(p: V3, n: V3, c: RGB): number {
    const k = this.p.length / 3;
    this.p.push(p[0], p[1], p[2]);
    this.n.push(n[0], n[1], n[2]);
    this.c.push(c[0], c[1], c[2]);
    return k;
  }
  /** Flat-shaded quad a,b,c,d (CCW seen from the front). `hint` flips winding to face that way. */
  quad(a: V3, b: V3, c: V3, d: V3, col: RGB | [RGB, RGB, RGB, RGB], hint?: V3): void {
    let n = cross(sub(c, a), sub(d, b));
    const l = len(n);
    if (l < 1e-12) return;
    n = mul(n, 1 / l);
    let q: [V3, V3, V3, V3] = [a, b, c, d];
    let cols: RGB[] = Array.isArray(col[0])
      ? (col as RGB[])
      : [col as RGB, col as RGB, col as RGB, col as RGB];
    if (hint && dot(n, hint) < 0) {
      n = mul(n, -1);
      q = [a, d, c, b];
      cols = [cols[0]!, cols[3]!, cols[2]!, cols[1]!];
    }
    const k = this.v(q[0], n, cols[0]!);
    this.v(q[1], n, cols[1]!);
    this.v(q[2], n, cols[2]!);
    this.v(q[3], n, cols[3]!);
    this.pushTris(k, k + 1, k + 2, k, k + 2, k + 3);
  }
  tri(a: V3, b: V3, c: V3, col: RGB, hint?: V3): void {
    let n = cross(sub(b, a), sub(c, a));
    const l = len(n);
    if (l < 1e-12) return;
    n = mul(n, 1 / l);
    let q: [V3, V3, V3] = [a, b, c];
    if (hint && dot(n, hint) < 0) {
      n = mul(n, -1);
      q = [a, c, b];
    }
    const k = this.v(q[0], n, col);
    this.v(q[1], n, col);
    this.v(q[2], n, col);
    this.pushTris(k, k + 1, k + 2);
  }
  /** Smooth-shaded quad with explicit per-vertex normals (winding follows the average normal). */
  sq(ps: [V3, V3, V3, V3], ns: [V3, V3, V3, V3], cols: [RGB, RGB, RGB, RGB]): void {
    const n = cross(sub(ps[2], ps[0]), sub(ps[3], ps[1]));
    if (len(n) < 1e-12) return;
    const navg = add(add(ns[0], ns[1]), add(ns[2], ns[3]));
    const order = dot(n, navg) >= 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
    const k = this.p.length / 3;
    for (const o of order) this.v(ps[o]!, ns[o]!, cols[o]!);
    this.pushTris(k, k + 1, k + 2, k, k + 2, k + 3);
  }
  /** Axis-aligned box. `skip` bits: 1 +x, 2 -x, 4 +y, 8 -y, 16 +z, 32 -z. */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    col: RGB,
    jit = 0.05,
    skip = 0,
  ): void {
    const k = 1 + jit * (this.rnd() * 2 - 1);
    const c = shade(col, k);
    const side = shade(c, 0.93);
    const bot = shade(c, 0.7);
    if (!(skip & 1)) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side);
    if (!(skip & 2)) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side);
    if (!(skip & 4)) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], c);
    if (!(skip & 8)) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], bot);
    if (!(skip & 16))
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], shade(c, 0.97));
    if (!(skip & 32))
      this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], shade(c, 0.97));
  }
  /** Tapered tube between two points (smooth normals). */
  tube(
    p0: V3,
    p1: V3,
    r0: number,
    r1: number,
    seg: number,
    col: RGB,
    o: { caps?: boolean; jit?: number; top?: RGB; rot?: number } = {},
  ): void {
    const axis = sub(p1, p0);
    const h = len(axis);
    if (h < 1e-6) return;
    const ax = mul(axis, 1 / h);
    const ref: V3 = Math.abs(ax[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(ref, ax));
    const w = cross(ax, u);
    const k = 1 + (o.jit ?? 0.04) * (this.rnd() * 2 - 1);
    const c0 = shade(col, k);
    const c1 = shade(o.top ?? col, k);
    const slope = (r0 - r1) / h;
    const dirs: V3[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2 + (o.rot ?? 0);
      dirs.push(add(mul(u, Math.cos(a)), mul(w, Math.sin(a))));
    }
    for (let i = 0; i < seg; i++) {
      const d0 = dirs[i]!;
      const d1 = dirs[i + 1]!;
      const n0 = norm(add(d0, mul(ax, slope)));
      const n1 = norm(add(d1, mul(ax, slope)));
      this.sq(
        [add(p0, mul(d0, r0)), add(p0, mul(d1, r0)), add(p1, mul(d1, r1)), add(p1, mul(d0, r1))],
        [n0, n1, n1, n0],
        [c0, c0, c1, c1],
      );
      if (o.caps) {
        if (r1 > 0) this.tri(p1, add(p1, mul(d0, r1)), add(p1, mul(d1, r1)), shade(c1, 1.05), ax);
        if (r0 > 0)
          this.tri(p0, add(p0, mul(d0, r0)), add(p0, mul(d1, r0)), shade(c0, 0.8), mul(ax, -1));
      }
    }
  }
  /** Upright cylinder helper. */
  cyl(
    cx: number,
    y0: number,
    cz: number,
    r0: number,
    r1: number,
    h: number,
    seg: number,
    col: RGB,
    caps = true,
    top?: RGB,
  ): void {
    this.tube([cx, y0, cz], [cx, y0 + h, cz], r0, r1, seg, col, { caps, top });
  }
  /** Ellipsoid (smooth). */
  ell(
    cx: number,
    cy: number,
    cz: number,
    rx: number,
    ry: number,
    rz: number,
    ws: number,
    hs: number,
    col: RGB,
    colTop?: RGB,
  ): void {
    const pt = (i: number, j: number): { p: V3; n: V3; c: RGB } => {
      const th = (j / hs) * Math.PI;
      const ph = (i / ws) * Math.PI * 2;
      const nx = Math.sin(th) * Math.cos(ph);
      const ny = Math.cos(th);
      const nz = Math.sin(th) * Math.sin(ph);
      return {
        p: [cx + nx * rx, cy + ny * ry, cz + nz * rz],
        n: norm([nx / rx, ny / ry, nz / rz]),
        c: colTop ? mixc(col, colTop, ny * 0.5 + 0.5) : col,
      };
    };
    for (let j = 0; j < hs; j++) {
      for (let i = 0; i < ws; i++) {
        const a = pt(i, j);
        const b = pt(i + 1, j);
        const c = pt(i + 1, j + 1);
        const d = pt(i, j + 1);
        this.sq([a.p, b.p, c.p, d.p], [a.n, b.n, c.n, d.n], [a.c, b.c, c.c, d.c]);
      }
    }
  }
  /** Displaced icosphere blob with smooth normals; colour from fn(normalisedHeight, noise). */
  blob(
    cx: number,
    cy: number,
    cz: number,
    rx: number,
    ry: number,
    rz: number,
    detail: number,
    seed: number,
    amount: number,
    colFn: (y01: number, n: number, nx: number, nz: number) => RGB,
  ): void {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g, 1e-4);
    const noise = new Noise2D(seed);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nv = pos.count;
    const nvals: number[] = [];
    for (let i = 0; i < nv; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const nn = noise.fbm(x * 1.6 + y * 0.9 + 3.1, z * 1.6 - y * 0.7, 3);
      nvals.push(nn);
      const s = 1 + nn * amount;
      pos.setXYZ(i, x * s, y * s, z * s);
    }
    g.computeVertexNormals();
    const nor = g.attributes.normal as THREE.BufferAttribute;
    const idx = g.index!;
    const base = this.p.length / 3;
    for (let i = 0; i < nv; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const c = colFn(y * 0.5 + 0.5, nvals[i]!, x, z);
      this.v(
        [cx + x * rx, cy + y * ry, cz + z * rz],
        norm([nor.getX(i) / rx, nor.getY(i) / ry, nor.getZ(i) / rz]),
        c,
      );
    }
    for (let i = 0; i < idx.count; i += 3)
      this.pushTris(base + idx.getX(i), base + idx.getX(i + 1), base + idx.getX(i + 2));
    g.dispose();
  }
  geo(): THREE.BufferGeometry {
    return this.build(this.i);
  }
  /** One geometry per material tag (vertices compacted per group). Untagged builders yield `main` only. */
  split(): Map<Tag, THREE.BufferGeometry> {
    const out = new Map<Tag, THREE.BufferGeometry>();
    if (this.tg.length * 3 !== this.i.length) {
      if (!this.empty) out.set('main', this.build(this.i));
      return out;
    }
    const groups = new Map<Tag, number[]>();
    for (let t = 0; t < this.tg.length; t++) {
      const tag = this.tg[t]!;
      let arr = groups.get(tag);
      if (!arr) groups.set(tag, (arr = []));
      arr.push(this.i[t * 3]!, this.i[t * 3 + 1]!, this.i[t * 3 + 2]!);
    }
    for (const [tag, idx] of groups) out.set(tag, this.build(idx));
    return out;
  }
  private build(idx: number[]): THREE.BufferGeometry {
    const remap = new Map<number, number>();
    const p: number[] = [];
    const n: number[] = [];
    const c: number[] = [];
    const ii: number[] = [];
    for (const o of idx) {
      let k = remap.get(o);
      if (k === undefined) {
        k = p.length / 3;
        remap.set(o, k);
        p.push(this.p[o * 3]!, this.p[o * 3 + 1]!, this.p[o * 3 + 2]!);
        n.push(this.n[o * 3]!, this.n[o * 3 + 1]!, this.n[o * 3 + 2]!);
        c.push(this.c[o * 3]!, this.c[o * 3 + 1]!, this.c[o * 3 + 2]!);
      }
      ii.push(k);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    g.setIndex(
      p.length / 3 > 65535
        ? new THREE.Uint32BufferAttribute(ii, 1)
        : new THREE.Uint16BufferAttribute(ii, 1),
    );
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------
// Species assembly: materials + parts
// ---------------------------------------------------------------------------------------------

type Mat = 'main' | 'glow' | 'water' | 'leaf';
const LIB_KEY: Record<Exclude<Tag, 'main'>, string> = {
  plaster: 'village/plaster',
  wood: 'village/wood-planks',
  roof: 'village/roof-tiles',
  stone: 'village/stone-paving',
  rock: 'forest/rock',
  gravel: 'village/gravel-path',
};
interface Built {
  mb: MB;
  mat: Mat;
  shadow?: boolean;
}
interface Cfg {
  rough?: number;
  wind?: number;
  windHeight?: number;
  flutter?: number;
  glow?: string;
  glowIntensity?: number;
  height: number;
  radius: number;
}

function finish(key: string, cfg: Cfg, variants: Built[][][]): Species {
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];
  const mats = new Map<Mat, THREE.Material>();
  const matFor = (m: Mat): THREE.Material => {
    let mat = mats.get(m);
    if (mat) return mat;
    const wind = {
      wind: cfg.wind ?? 0,
      windHeight: cfg.windHeight ?? 1,
      flutter: cfg.flutter ?? 0,
    };
    if (m === 'glow') {
      mat = patchMaterial(
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.85,
          metalness: 0,
          emissive: new THREE.Color(cfg.glow ?? '#ffa24a'),
          emissiveIntensity: cfg.glowIntensity ?? 4.5,
        }),
        { key: `village-${key}-glow`, nightLight: true },
      );
    } else if (m === 'water') {
      mat = patchMaterial(
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.04, metalness: 0 }),
        { key: `village-${key}-water` },
      );
    } else if (m === 'leaf') {
      mat = patchMaterial(
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.8,
          metalness: 0,
          side: THREE.DoubleSide,
        }),
        { key: `village-${key}-leaf`, ...wind },
      );
    } else {
      mat = patchMaterial(
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: cfg.rough ?? 0.88,
          metalness: 0,
        }),
        { key: `village-${key}`, ...wind },
      );
    }
    mats.set(m, mat);
    owned.push(mat);
    return mat;
  };
  // Library (triplanar PBR) materials are owned by the scene runtime: never added to `owned`.
  const tagMat = (t: Tag): THREE.Material =>
    t === 'main' ? matFor('main') : sceneMaterial(LIB_KEY[t], matFor('main'));
  const out: SpeciesPart[][][] = variants.map((lods) =>
    lods.map((parts) =>
      parts
        .filter((b) => !b.mb.empty)
        .flatMap((b): SpeciesPart[] => {
          const castShadow = b.shadow ?? (b.mat !== 'glow' && b.mat !== 'water');
          if (b.mat !== 'main') {
            const geometry = b.mb.geo();
            owned.push(geometry);
            return [{ geometry, material: matFor(b.mat), castShadow }];
          }
          const res: SpeciesPart[] = [];
          for (const [tag, geometry] of b.mb.split()) {
            owned.push(geometry);
            res.push({ geometry, material: tagMat(tag), castShadow });
          }
          return res;
        }),
    ),
  );
  return { variants: out, height: cfg.height, radius: cfg.radius, owned };
}

// ---------------------------------------------------------------------------------------------
// Roofs (height-field shells with a gentle concave sweep and upturned corners)
// ---------------------------------------------------------------------------------------------

interface RoofP {
  Lh: number; // half length incl. overhang
  Wh: number; // half depth incl. overhang
  yR: number; // ridge height
  H: number; // ridge-to-eave drop
  hip: boolean;
  rh: number; // half ridge length (hip)
  t: number; // slab thickness
  up: number; // corner lift
  cell: number;
  cA: RGB;
  cB: RGB;
  jit: number;
  edge: RGB;
  under: RGB;
  thatch?: boolean;
}

const sweep = (e: number): number => (e * (1 - 0.3 * e)) / 0.7;

function roofY(r: RoofP, x: number, z: number): number {
  const ez = Math.abs(z) / r.Wh;
  const ex = r.hip ? Math.max(0, (Math.abs(x) - r.rh) / (r.Lh - r.rh)) : 0;
  const e = Math.min(1, Math.max(ez, ex));
  const ax = Math.abs(x) / r.Lh;
  const lift = r.up * ax ** 3 * ez ** 2 + r.up * 0.25 * e ** 6;
  return r.yR - r.H * sweep(e) + lift;
}

function addRoof(mb: MB, r: RoofP, detail: number): void {
  const nx = Math.max(2, Math.round((2 * r.Lh) / r.cell));
  const nz = Math.max(2, Math.round(r.Wh / (r.cell * 1.5)));
  const d = 0.04;
  const normalAt = (x: number, z: number, side: number): V3 => {
    const zq = side * Math.max(Math.abs(z), d);
    const dx = (roofY(r, x + d, zq) - roofY(r, x - d, zq)) / (2 * d);
    const dz = (roofY(r, x, zq + d) - roofY(r, x, zq - d)) / (2 * d);
    return norm([-dx, 1, -dz]);
  };
  const rt: Tag = r.thatch ? 'main' : 'roof';
  mb.tag = rt;
  for (const side of [-1, 1]) {
    for (let j = 0; j < nz; j++) {
      const z0 = side * r.Wh * (j / nz);
      const z1 = side * r.Wh * ((j + 1) / nz);
      for (let i = 0; i < nx; i++) {
        const x0 = -r.Lh + (2 * r.Lh * i) / nx;
        const x1 = -r.Lh + (2 * r.Lh * (i + 1)) / nx;
        const base = i % 2 === 0 ? r.cA : r.cB;
        let col = shade(base, 1 + r.jit * (mb.rnd() * 2 - 1));
        if (!r.thatch) col = shade(col, j % 2 === 0 ? 1.04 : 0.96);
        else col = shade(col, 1 - 0.08 * (j / nz));
        const pts: V3[] = [
          [x0, roofY(r, x0, z0), z0],
          [x1, roofY(r, x1, z0), z0],
          [x1, roofY(r, x1, z1), z1],
          [x0, roofY(r, x0, z1), z1],
        ];
        const ns: [V3, V3, V3, V3] = [
          normalAt(x0, z0, side),
          normalAt(x1, z0, side),
          normalAt(x1, z1, side),
          normalAt(x0, z1, side),
        ];
        mb.sq(pts as [V3, V3, V3, V3], ns, [col, col, col, col]);
      }
    }
  }
  mb.tag = r.thatch ? 'main' : 'wood';
  // Underside (coarse) + perimeter skirt.
  const ux = Math.max(2, Math.round((2 * r.Lh) / 1.6));
  const uz = Math.max(2, Math.round((2 * r.Wh) / 1.6));
  for (let j = 0; j < uz; j++) {
    for (let i = 0; i < ux; i++) {
      const x0 = -r.Lh + (2 * r.Lh * i) / ux;
      const x1 = -r.Lh + (2 * r.Lh * (i + 1)) / ux;
      const z0 = -r.Wh + (2 * r.Wh * j) / uz;
      const z1 = -r.Wh + (2 * r.Wh * (j + 1)) / uz;
      mb.quad(
        [x0, roofY(r, x0, z0) - r.t, z0],
        [x1, roofY(r, x1, z0) - r.t, z0],
        [x1, roofY(r, x1, z1) - r.t, z1],
        [x0, roofY(r, x0, z1) - r.t, z1],
        r.under,
        [0, -1, 0],
      );
    }
  }
  mb.tag = rt;
  const sk = Math.max(r.cell, 0.4);
  const nxs = Math.max(2, Math.round((2 * r.Lh) / sk));
  const nzs = Math.max(2, Math.round((2 * r.Wh) / sk));
  for (const zs of [-1, 1]) {
    const z = zs * r.Wh;
    for (let i = 0; i < nxs; i++) {
      const x0 = -r.Lh + (2 * r.Lh * i) / nxs;
      const x1 = -r.Lh + (2 * r.Lh * (i + 1)) / nxs;
      const y0 = roofY(r, x0, z);
      const y1 = roofY(r, x1, z);
      mb.quad([x0, y0, z], [x1, y1, z], [x1, y1 - r.t, z], [x0, y0 - r.t, z], r.edge, [0, 0, zs]);
    }
  }
  for (const xs of [-1, 1]) {
    const x = xs * r.Lh;
    for (let j = 0; j < nzs; j++) {
      const z0 = -r.Wh + (2 * r.Wh * j) / nzs;
      const z1 = -r.Wh + (2 * r.Wh * (j + 1)) / nzs;
      const y0 = roofY(r, x, z0);
      const y1 = roofY(r, x, z1);
      mb.quad([x, y0, z0], [x, y1, z1], [x, y1 - r.t, z1], [x, y0 - r.t, z0], r.edge, [xs, 0, 0]);
    }
  }
  // Ridge caps + ornaments.
  const capR = r.thatch ? 0.26 : 0.15;
  const capCol = r.thatch ? P.thatchLight : P.tileEdge;
  const seg = detail > 1 ? 6 : 4;
  if (r.hip) {
    const a: V3 = [-r.rh, roofY(r, -r.rh, 0) + 0.05, 0];
    const b: V3 = [r.rh, roofY(r, r.rh, 0) + 0.05, 0];
    mb.tube(a, b, capR, capR, seg, capCol, { caps: true });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        let prev: V3 = [sx * r.rh, roofY(r, sx * r.rh, 0) + 0.05, 0];
        for (let s = 1; s <= 6; s++) {
          const t = s / 6;
          const x = sx * (r.rh + (r.Lh - r.rh) * t);
          const z = sz * r.Wh * t;
          const q: V3 = [x, roofY(r, x, z) + 0.04, z];
          mb.tube(prev, q, capR * 0.85, capR * 0.85, seg, capCol);
          prev = q;
        }
      }
    }
    if (detail > 0 && !r.thatch) {
      for (const sx of [-1, 1])
        mb.box(
          sx * r.rh - 0.18,
          roofY(r, sx * r.rh, 0) + 0.05,
          -0.2,
          sx * r.rh + 0.18,
          roofY(r, sx * r.rh, 0) + 0.5,
          0.2,
          P.tile,
        );
    }
  } else {
    const xA = r.Lh - 0.05;
    const a: V3 = [-xA, roofY(r, -xA, 0) + 0.05, 0];
    const b: V3 = [xA, roofY(r, xA, 0) + 0.05, 0];
    mb.tube(a, b, capR, capR, seg, capCol, { caps: true });
    if (detail > 0 && !r.thatch) {
      for (const sx of [-1, 1])
        mb.box(sx * xA - 0.17, a[1], -0.17, sx * xA + 0.17, a[1] + 0.42, 0.17, P.tile);
    }
  }
  if (r.thatch && detail > 0) {
    // Crossed finials (chigi) at the ridge ends.
    const ends = r.hip ? [-r.rh, r.rh] : [-r.Lh + 0.3, r.Lh - 0.3];
    for (const x of ends) {
      const y = roofY(r, x, 0) + 0.2;
      mb.tube([x - 0.12, y, -0.35], [x + 0.12, y + 0.9, 0.35], 0.035, 0.035, 4, P.timberLight);
      mb.tube([x + 0.12, y, -0.35], [x - 0.12, y + 0.9, 0.35], 0.035, 0.035, 4, P.timberLight);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------------------------

interface HouseP {
  L: number;
  D: number;
  wallH: number;
  roof: 'hip' | 'gable' | 'thatch';
  H: number;
  ov: number;
  ovX: number;
  veranda: boolean;
  door: number; // bay index of the door (-1 none)
  fy: number; // floor height
  platform?: boolean; // stone base box instead of rubble plinth
  wall: RGB;
  post: RGB;
  dado: RGB;
  roofA: RGB;
  roofB: RGB;
  lanterns: number;
  seed: number;
  shoji: boolean;
  steps: boolean;
  /** Material of the wall volume (plaster houses, timber storehouse/shrine). */
  wallMat: Tag;
  /** Painted (vermilion) posts keep the vertex-coloured material. */
  painted?: boolean;
}

function buildHouse(p: HouseP, lod: 0 | 1 | 2): { main: MB; glow: MB } {
  const mb = new MB(p.seed);
  const gl = new MB(p.seed + 100);
  const { L, D, fy } = p;
  const wt = fy + p.wallH;
  const detail = 2 - lod;
  const nb = Math.max(2, Math.round(L / 1.85));
  const bw = L / nb;
  const ovF = p.ov;
  const deckD = p.veranda ? ovF - 0.15 : 0;
  const postTag: Tag = p.painted ? 'main' : 'wood';

  mb.tag = 'stone';
  // Foundation.
  if (p.platform) {
    mb.box(
      -L / 2 - 0.5,
      -0.9,
      -D / 2 - 0.5,
      L / 2 + 0.5,
      fy - 0.12,
      D / 2 + 0.5 + deckD,
      P.stone,
      0.06,
    );
    mb.box(
      -L / 2 - 0.55,
      fy - 0.2,
      -D / 2 - 0.55,
      L / 2 + 0.55,
      fy - 0.08,
      D / 2 + 0.55 + deckD,
      P.stoneLight,
      0.04,
    );
  } else if (lod === 0) {
    const blocks = (
      x0: number,
      z0: number,
      x1: number,
      z1: number,
      step: number,
      alongX: boolean,
    ): void => {
      const n = Math.max(1, Math.round((alongX ? x1 - x0 : z1 - z0) / step));
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const c = mixc(P.stone, P.stoneDark, mb.rnd() * 0.8);
        const hgt = fy - 0.04 - mb.rnd() * 0.05;
        if (alongX)
          mb.box(
            x0 + (x1 - x0) * t0,
            -0.9,
            z0,
            x0 + (x1 - x0) * t1 - 0.03,
            hgt,
            z1,
            mixc(c, P.moss, 0.12),
            0.08,
          );
        else
          mb.box(
            x0,
            -0.9,
            z0 + (z1 - z0) * t0,
            x1,
            hgt,
            z0 + (z1 - z0) * t1 - 0.03,
            mixc(c, P.moss, 0.12),
            0.08,
          );
      }
    };
    blocks(-L / 2 - 0.12, -D / 2 - 0.12, L / 2 + 0.12, -D / 2 + 0.2, 0.8, true);
    blocks(-L / 2 - 0.12, D / 2 - 0.2, L / 2 + 0.12, D / 2 + 0.12, 0.8, true);
    blocks(-L / 2 - 0.12, -D / 2 + 0.2, -L / 2 + 0.2, D / 2 - 0.2, 0.8, false);
    blocks(L / 2 - 0.2, -D / 2 + 0.2, L / 2 + 0.12, D / 2 - 0.2, 0.8, false);
  } else {
    mb.box(
      -L / 2 - 0.12,
      -0.9,
      -D / 2 - 0.12,
      L / 2 + 0.12,
      fy - 0.04,
      D / 2 + 0.12,
      P.stone,
      0.05,
    );
  }

  // Core volume (plaster) with charred dado and timber frame.
  mb.tag = p.wallMat;
  mb.box(-L / 2, fy - 0.05, -D / 2, L / 2, wt, D / 2, p.wall, 0.03, 8);
  mb.tag = 'main';
  if (lod < 2) {
    const dh = fy + 0.95;
    mb.box(
      -L / 2 - 0.03,
      fy - 0.05,
      -D / 2 - 0.03,
      L / 2 + 0.03,
      dh,
      -D / 2 + 0.0,
      p.dado,
      0.1,
      8 | 4 | 16,
    );
    mb.box(
      -L / 2 - 0.03,
      fy - 0.05,
      -D / 2 - 0.03,
      -L / 2,
      dh,
      D / 2 + 0.03,
      p.dado,
      0.1,
      8 | 4 | 1,
    );
    mb.box(L / 2, fy - 0.05, -D / 2 - 0.03, L / 2 + 0.03, dh, D / 2 + 0.03, p.dado, 0.1, 8 | 4 | 2);
    mb.tag = postTag;
    // Top plate (nuki) all round.
    mb.box(
      -L / 2 - 0.06,
      wt - 0.34,
      -D / 2 - 0.06,
      L / 2 + 0.06,
      wt - 0.12,
      D / 2 + 0.06,
      p.post,
      0.06,
      8,
    );
    // Posts on the back and sides.
    const post = (x: number, z: number, sx: number, sz: number): void => {
      mb.box(x - sx, fy - 0.05, z - sz, x + sx, wt - 0.12, z + sz, p.post, 0.08, 8);
    };
    for (let k = 0; k <= nb; k++) post(-L / 2 + k * bw, -D / 2 - 0.035, 0.07, 0.05);
    const nd = Math.max(2, Math.round(D / 1.85));
    for (let k = 0; k <= nd; k++) {
      post(-L / 2 - 0.035, -D / 2 + (k * D) / nd, 0.05, 0.07);
      post(L / 2 + 0.035, -D / 2 + (k * D) / nd, 0.05, 0.07);
    }
    // Mid rail on plaster walls.
    mb.box(
      -L / 2 - 0.04,
      fy + 1.55,
      -D / 2 - 0.04,
      L / 2 + 0.04,
      fy + 1.65,
      -D / 2 + 0.0,
      p.post,
      0.06,
      8 | 16 | 4,
    );
  }

  // Front facade.
  const zf = D / 2;
  const bayX = (k: number): number => -L / 2 + (k + 0.5) * bw;
  mb.tag = postTag;
  for (let k = 0; k <= nb && lod < 2; k++) {
    mb.box(
      -L / 2 + k * bw - 0.07,
      fy - 0.05,
      zf - 0.02,
      -L / 2 + k * bw + 0.07,
      wt - 0.12,
      zf + 0.07,
      p.post,
      0.08,
      8,
    );
  }
  if (lod < 2)
    mb.box(
      -L / 2 - 0.06,
      wt - 0.34,
      zf - 0.02,
      L / 2 + 0.06,
      wt - 0.12,
      zf + 0.09,
      p.post,
      0.06,
      8,
    );
  for (let k = 0; k < nb; k++) {
    const cx = bayX(k);
    mb.tag = 'wood';

    const x0 = cx - bw / 2 + 0.07;
    const x1 = cx + bw / 2 - 0.07;
    const solid = k === nb - 1 && p.shoji;
    const isDoor = k === p.door;
    if (!p.shoji && !isDoor) continue;
    if (isDoor) {
      const dw = Math.min(bw - 0.3, 1.15);
      mb.tag = 'wood';
      mb.box(
        cx - dw / 2,
        fy,
        zf + 0.0,
        cx + dw / 2,
        fy + 1.9,
        zf + 0.06,
        mixc(P.timberDark, P.timber, 0.35),
        0.08,
        8,
      );
      mb.tag = 'main';
      if (lod === 0) {
        for (let s = 0; s < 5; s++) {
          const xa = cx - dw / 2 + (dw * s) / 5;
          mb.quad(
            [xa, fy + 0.02, zf + 0.062],
            [xa + 0.012, fy + 0.02, zf + 0.062],
            [xa + 0.012, fy + 1.88, zf + 0.062],
            [xa, fy + 1.88, zf + 0.062],
            P.charred,
            [0, 0, 1],
          );
        }
        // Noren curtain
        for (let s = 0; s < 3; s++) {
          const xa = cx - 0.45 + s * 0.31;
          mb.box(
            xa,
            fy + 1.15,
            zf + 0.08,
            xa + 0.28,
            fy + 1.9,
            zf + 0.1,
            P.indigo,
            0.12,
            8 | 4 | 32,
          );
        }
      }
      continue;
    }
    if (solid) {
      // Plaster bay with a small glowing lattice window.
      if (lod === 0) {
        mb.box(
          cx - 0.4,
          fy + 1.15,
          zf - 0.01,
          cx + 0.4,
          fy + 1.75,
          zf + 0.04,
          P.timberDark,
          0.05,
          8,
        );
        gl.quad(
          [cx - 0.33, fy + 1.22, zf + 0.045],
          [cx + 0.33, fy + 1.22, zf + 0.045],
          [cx + 0.33, fy + 1.68, zf + 0.045],
          [cx - 0.33, fy + 1.68, zf + 0.045],
          P.paper,
          [0, 0, 1],
        );
        mb.tag = 'main';
        for (let s = 1; s < 4; s++) {
          const xa = cx - 0.33 + (0.66 * s) / 4;
          mb.quad(
            [xa - 0.012, fy + 1.22, zf + 0.05],
            [xa + 0.012, fy + 1.22, zf + 0.05],
            [xa + 0.012, fy + 1.68, zf + 0.05],
            [xa - 0.012, fy + 1.68, zf + 0.05],
            P.timberDark,
            [0, 0, 1],
          );
        }
      } else if (lod === 1) {
        gl.quad(
          [cx - 0.33, fy + 1.22, zf + 0.045],
          [cx + 0.33, fy + 1.22, zf + 0.045],
          [cx + 0.33, fy + 1.68, zf + 0.045],
          [cx - 0.33, fy + 1.68, zf + 0.045],
          P.paper,
          [0, 0, 1],
        );
      }
      continue;
    }
    // Shoji bay: dark recess, kick boards, two overlapping paper panels with a lattice.
    mb.box(x0, fy + 0.02, zf - 0.01, x1, wt - 0.34, zf + 0.03, P.timberDark, 0.05, 8);
    const pw = (x1 - x0) / 2 + 0.03;
    for (let s = 0; s < 2; s++) {
      const xa = s === 0 ? x0 : x1 - pw;
      const zz = zf + 0.035 + s * 0.028;
      const yb = fy + 0.5;
      const yt = fy + 1.95;
      mb.tag = 'wood';
      mb.box(xa, fy + 0.1, zz - 0.01, xa + pw, yb, zz + 0.012, P.timber, 0.08, 8 | 4);
      gl.quad(
        [xa, yb, zz + 0.012],
        [xa + pw, yb, zz + 0.012],
        [xa + pw, yt, zz + 0.012],
        [xa, yt, zz + 0.012],
        P.paper,
        [0, 0, 1],
      );
      mb.tag = 'main';
      if (lod === 0) {
        const bar = (a0: number, b0: number, a1: number, b1: number): void =>
          mb.quad(
            [a0, b0, zz + 0.016],
            [a1, b0, zz + 0.016],
            [a1, b1, zz + 0.016],
            [a0, b1, zz + 0.016],
            P.timberDark,
            [0, 0, 1],
          );
        const t = 0.022;
        bar(xa, yb, xa + t, yt);
        bar(xa + pw - t, yb, xa + pw, yt);
        bar(xa, yt - t, xa + pw, yt);
        bar(xa, yb, xa + pw, yb + t);
        for (let q = 1; q < 3; q++)
          bar(xa + (pw * q) / 3 - t / 2, yb, xa + (pw * q) / 3 + t / 2, yt);
        for (let q = 1; q < 4; q++)
          bar(xa, yb + ((yt - yb) * q) / 4 - t / 2, xa + pw, yb + ((yt - yb) * q) / 4 + t / 2);
      }
    }
    mb.tag = postTag;
    // Lintel
    mb.box(x0 - 0.02, fy + 1.97, zf - 0.01, x1 + 0.02, fy + 2.12, zf + 0.09, p.post, 0.06, 8);
  }

  // Side-wall lattice windows (mushiko-mado).
  if (lod < 2 && p.shoji) {
    for (const sx of [-1, 1]) {
      mb.tag = 'wood';
      const x = sx * (L / 2);
      mb.box(
        sx > 0 ? x : x - 0.05,
        fy + 1.3,
        -0.5,
        sx > 0 ? x + 0.05 : x,
        fy + 1.85,
        0.5,
        P.timberDark,
        0.05,
        8,
      );
      gl.quad(
        [x + sx * 0.052, fy + 1.37, -0.42],
        [x + sx * 0.052, fy + 1.37, 0.42],
        [x + sx * 0.052, fy + 1.78, 0.42],
        [x + sx * 0.052, fy + 1.78, -0.42],
        P.paper,
        [sx, 0, 0],
      );
      mb.tag = 'main';
      if (lod === 0)
        for (let s = 1; s < 6; s++) {
          const z = -0.42 + (0.84 * s) / 6;
          mb.quad(
            [x + sx * 0.056, fy + 1.37, z - 0.01],
            [x + sx * 0.056, fy + 1.37, z + 0.01],
            [x + sx * 0.056, fy + 1.78, z + 0.01],
            [x + sx * 0.056, fy + 1.78, z - 0.01],
            P.timberDark,
            [sx, 0, 0],
          );
        }
    }
  }

  // Veranda (engawa)
  if (p.veranda) {
    const zD = zf + deckD;
    mb.tag = 'wood';
    mb.box(-L / 2 - 0.1, fy - 0.16, zf, L / 2 + 0.1, fy, zD, P.timberLight, 0.08, 8);
    mb.tag = 'main';
    if (lod === 0) {
      for (let s = 1; s < 8; s++) {
        const z = zf + (deckD * s) / 8;
        mb.quad(
          [-L / 2 - 0.1, fy + 0.002, z - 0.008],
          [L / 2 + 0.1, fy + 0.002, z - 0.008],
          [L / 2 + 0.1, fy + 0.002, z + 0.008],
          [-L / 2 - 0.1, fy + 0.002, z + 0.008],
          shade(P.timberDark, 1.4),
          [0, 1, 0],
        );
      }
      mb.tag = 'stone';
      // Stone feet
      for (let k = 0; k <= nb; k++)
        mb.box(
          -L / 2 + k * bw - 0.17,
          -0.9,
          zD - 0.3 - 0.17,
          -L / 2 + k * bw + 0.17,
          fy - 0.16,
          zD - 0.3 + 0.17,
          mixc(P.stoneDark, P.moss, 0.15),
          0.1,
        );
    } else {
      mb.tag = 'stone';
      mb.box(-L / 2, -0.9, zD - 0.3, L / 2, fy - 0.16, zD - 0.1, P.stoneDark, 0.05);
    }
    mb.tag = postTag;
    // Outer posts + eave girder.
    if (lod < 2) {
      for (let k = 0; k <= nb; k++)
        mb.box(
          -L / 2 + k * bw - 0.07,
          fy,
          zD - 0.37,
          -L / 2 + k * bw + 0.07,
          wt - 0.12,
          zD - 0.23,
          p.post,
          0.08,
          8,
        );
      mb.box(-L / 2 - 0.1, wt - 0.34, zD - 0.42, L / 2 + 0.1, wt - 0.1, zD - 0.18, p.post, 0.05, 8);
    }
  }
  mb.tag = 'stone';
  if (p.steps && lod < 2) {
    const dz = p.veranda ? zf + deckD : zf;
    const sx = p.door >= 0 ? bayX(p.door) : 0;
    mb.box(sx - 0.8, -0.9, dz, sx + 0.8, fy * 0.5, dz + 0.5, P.stoneLight, 0.06);
    mb.box(sx - 0.65, -0.9, dz + 0.5, sx + 0.65, fy * 0.2, dz + 0.95, P.stone, 0.06);
  }

  // Gable infill + barge boards.
  const Wh = D / 2 + ovF;
  const Lh = p.roof === 'gable' ? L / 2 + p.ovX : L / 2 + ovF;
  // Roof.
  const wallZ = D / 2 / Wh;
  const t = p.roof === 'thatch' ? 0.45 : 0.24;
  const yRoofAtWall = wt + 0.02 + t;
  const hip = p.roof !== 'gable';
  const roof: RoofP = {
    Lh,
    Wh,
    yR: 0,
    H: p.H,
    hip,
    rh: Math.max(0.4, Lh - Wh),
    t,
    up: p.roof === 'thatch' ? 0.18 : 0.34,
    cell: lod === 0 ? 0.3 : lod === 1 ? 0.6 : 1.2,
    cA: p.roofA,
    cB: p.roofB,
    jit: p.roof === 'thatch' ? 0.16 : 0.06,
    edge: p.roof === 'thatch' ? P.thatchLight : P.tileEdge,
    under: P.timberDark,
    thatch: p.roof === 'thatch',
  };
  if (p.roof === 'thatch') roof.cell = lod === 0 ? 0.4 : lod === 1 ? 0.8 : 1.4;
  // Solve ridge height so the underside sits just above the wall plane at the front/back walls.
  roof.yR = yRoofAtWall + roof.H * sweep(wallZ);
  addRoof(mb, roof, detail);

  if (p.roof === 'gable') {
    const nzI = 10;
    for (const sx of [-1, 1]) {
      const x = sx * (L / 2);
      mb.tag = p.wallMat;
      for (let j = 0; j < nzI; j++) {
        const z0 = -D / 2 + (D * j) / nzI;
        const z1 = -D / 2 + (D * (j + 1)) / nzI;
        const y0 = roofY(roof, x, z0) - t;
        const y1 = roofY(roof, x, z1) - t;
        mb.quad(
          [x, wt - 0.12, z0],
          [x, wt - 0.12, z1],
          [x, y1 + 0.02, z1],
          [x, y0 + 0.02, z0],
          p.wall,
          [sx, 0, 0],
        );
      }
      if (lod < 2) {
        mb.tag = postTag;
        // Timber frame in the gable: king post + collar beam.
        const yr = roofY(roof, x, 0) - t;
        mb.box(
          sx > 0 ? x : x - 0.06,
          wt - 0.12,
          -0.07,
          sx > 0 ? x + 0.06 : x,
          yr,
          0.07,
          p.post,
          0.06,
          8,
        );
        const yc = wt + (yr - wt) * 0.45;
        mb.box(
          sx > 0 ? x : x - 0.06,
          yc - 0.05,
          -D * 0.28,
          sx > 0 ? x + 0.06 : x,
          yc + 0.05,
          D * 0.28,
          p.post,
          0.06,
          8,
        );
      }
    }
  }

  // Hanging paper lanterns under the front eave.
  if (p.lanterns > 0 && p.veranda && lod < 2) {
    mb.tag = 'main';
    const zD = zf + deckD - 0.3;
    for (let k = 0; k < p.lanterns; k++) {
      const x = k === 0 ? -L / 2 + 0.55 : L / 2 - 0.55;
      const yTop = wt - 0.34;
      mb.tube([x, yTop, zD], [x, yTop - 0.3, zD], 0.012, 0.012, 3, P.black);
      mb.cyl(x, yTop - 0.33, zD, 0.1, 0.1, 0.035, 8, P.black);
      gl.ell(x, yTop - 0.56, zD, 0.19, 0.24, 0.19, 10, 6, shade(P.red, 1.15), P.paper);
      mb.cyl(x, yTop - 0.84, zD, 0.1, 0.1, 0.035, 8, P.black);
    }
  }
  return { main: mb, glow: gl };
}

// ---------------------------------------------------------------------------------------------
// Other structures
// ---------------------------------------------------------------------------------------------

function buildTorii(lod: 0 | 1 | 2): MB {
  const mb = new MB(5);
  const sp = 2.35; // half spacing of pillars
  const hP = 4.3;
  const seg = lod === 0 ? 12 : lod === 1 ? 8 : 6;
  for (const s of [-1, 1]) {
    mb.cyl(s * sp, 0, 0, 0.3, 0.26, hP, seg, P.vermilion, true);
    mb.cyl(s * sp, 0, 0, 0.37, 0.35, 0.55, seg, P.black, true);
  }
  // Lower beam (nuki)
  mb.box(-sp - 0.42, 3.3, -0.12, sp + 0.42, 3.62, 0.12, P.vermilion, 0.03);
  // Plaque
  mb.box(-0.32, 3.62, -0.07, 0.32, 4.2, 0.07, P.black, 0.02);
  // Upper beam (shimaki) + cap beam (kasagi) with swept ends.
  mb.box(-sp - 0.6, hP - 0.05, -0.2, sp + 0.6, hP + 0.28, 0.2, P.vermilion, 0.03);
  const parts = 6;
  for (let i = 0; i < parts; i++) {
    const t0 = i / parts;
    const t1 = (i + 1) / parts;
    const xa = sp + 0.6 + 0.9 * t0;
    const xb = sp + 0.6 + 0.9 * t1;
    const lift0 = 0.32 * t0 ** 2;
    const lift1 = 0.32 * t1 ** 2;
    for (const s of [-1, 1]) {
      mb.box(
        Math.min(s * xa, s * xb),
        hP + 0.28 + lift0,
        -0.25,
        Math.max(s * xa, s * xb),
        hP + 0.5 + lift1,
        0.25,
        P.black,
        0.02,
        8,
      );
    }
  }
  mb.box(-sp - 0.62, hP + 0.28, -0.25, sp + 0.62, hP + 0.5, 0.25, P.black, 0.02);
  return mb;
}

function buildStairs(lod: 0 | 1 | 2, steps = 10, rise = 0.16, run = 0.42, w = 3.0): MB {
  const mb = new MB(21);
  mb.tag = 'stone';
  const cheek = 0.42;
  for (let k = 0; k < steps; k++) {
    const z0 = -(k + 1) * run;
    const z1 = -k * run;
    const top = (k + 1) * rise;
    const col = mixc(P.stoneLight, P.stoneDark, mb.rnd() * 0.55);
    const c2 = mb.rnd() < 0.25 ? mixc(col, P.moss, 0.3) : col;
    mb.box(-w / 2, -1.1, z0, w / 2, top, z1 + 0.02, c2, 0.07, 8 | 32);
    // Slightly proud tread lip
    if (lod === 0)
      mb.box(
        -w / 2,
        top - 0.035,
        z1 - 0.0,
        w / 2,
        top,
        z1 + 0.035,
        shade(c2, 1.08),
        0.03,
        8 | 32 | 1 | 2,
      );
    // Cheek walls
    const cc = mixc(P.stone, P.stoneDark, mb.rnd() * 0.5);
    mb.box(-w / 2 - cheek, -1.1, z0, -w / 2, top + 0.34, z1 + 0.02, cc, 0.08, 8 | 32);
    mb.box(w / 2, -1.1, z0, w / 2 + cheek, top + 0.34, z1 + 0.02, cc, 0.08, 8 | 32);
  }
  return mb;
}

function buildStoneLantern(variant: 0 | 1, lod: 0 | 1 | 2): { stone: MB; glow: MB } {
  const mb = new MB(31 + variant);
  mb.tag = 'stone';
  const gl = new MB(131 + variant);
  const seg = lod === 0 ? 8 : 6;
  const sc = variant === 0 ? 1 : 0.8;
  const postH = variant === 0 ? 0.85 : 0.22;
  const baseCol = mixc(P.stone, P.moss, 0.22);
  let y = 0;
  mb.cyl(0, y, 0, 0.36 * sc, 0.3 * sc, 0.14, seg, baseCol);
  y += 0.14;
  mb.cyl(0, y, 0, 0.14 * sc, 0.12 * sc, postH, seg, P.stone);
  y += postH;
  mb.cyl(0, y, 0, 0.27 * sc, 0.3 * sc, 0.1, seg, P.stoneLight);
  y += 0.1;
  const fb = 0.2 * sc;
  mb.box(-fb, y, -fb, fb, y + 0.4 * sc + 0.02, fb, P.stone, 0.04);
  const wy0 = y + 0.08 * sc;
  const wy1 = y + 0.34 * sc;
  const ww = 0.12 * sc;
  for (const [nx, nz] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    const px = nx * (fb + 0.004);
    const pz = nz * (fb + 0.004);
    const tx = nz !== 0 ? 1 : 0;
    const tz = nx !== 0 ? 1 : 0;
    gl.quad(
      [px - tx * ww, wy0, pz - tz * ww],
      [px + tx * ww, wy0, pz + tz * ww],
      [px + tx * ww, wy1, pz + tz * ww],
      [px - tx * ww, wy1, pz - tz * ww],
      P.paper,
      [nx, 0, nz],
    );
  }
  y += 0.4 * sc + 0.02;
  mb.cyl(0, y, 0, 0.62 * sc, 0.3 * sc, 0.2 * sc, 8, P.stone, true, P.stoneLight);
  mb.cyl(0, y + 0.2 * sc, 0, 0.3 * sc, 0.1 * sc, 0.16 * sc, 8, P.stoneLight, true);
  mb.ell(0, y + 0.4 * sc, 0, 0.07 * sc, 0.1 * sc, 0.07 * sc, 6, 4, P.stoneLight);
  return { stone: mb, glow: gl };
}

function buildLanternPost(variant: 0 | 1, lod: 0 | 1 | 2): { mb: MB; gl: MB } {
  const mb = new MB(41 + variant);
  mb.tag = 'stone';
  const gl = new MB(141 + variant);
  const seg = lod === 0 ? 7 : 5;
  mb.box(-0.2, -0.3, -0.2, 0.2, 0.18, 0.2, P.stone, 0.08);
  mb.tag = 'wood';
  mb.tube([0, 0.1, 0], [0, 2.95, 0], 0.075, 0.06, seg, P.timber, { caps: true });
  mb.box(-0.06, 2.55, -0.06, 0.78, 2.66, 0.06, P.timber, 0.05);
  mb.box(-0.14, 2.93, -0.14, 0.14, 3.0, 0.14, P.timberDark, 0.05);
  mb.tag = 'main';
  const x = 0.7;
  mb.tube([x, 2.55, 0], [x, 2.38, 0], 0.01, 0.01, 3, P.black);
  mb.cyl(x, 2.34, 0, 0.1, 0.1, 0.04, 8, P.black);
  gl.ell(x, 2.1, 0, 0.19, 0.25, 0.19, 10, 6, shade(P.red, 1.1), P.paper);
  mb.cyl(x, 1.82, 0, 0.1, 0.1, 0.04, 8, P.black);
  if (variant === 1) {
    mb.tag = 'wood';
    mb.box(-0.78, 2.55, -0.06, 0.06, 2.66, 0.06, P.timber, 0.05);
    mb.tag = 'main';
    mb.tube([-0.7, 2.55, 0], [-0.7, 2.38, 0], 0.01, 0.01, 3, P.black);
    mb.cyl(-0.7, 2.34, 0, 0.1, 0.1, 0.04, 8, P.black);
    gl.ell(-0.7, 2.1, 0, 0.19, 0.25, 0.19, 10, 6, shade(P.red, 1.1), P.paper);
    mb.cyl(-0.7, 1.82, 0, 0.1, 0.1, 0.04, 8, P.black);
  }
  return { mb, gl };
}

function buildLanternString(lod: 0 | 1 | 2): { mb: MB; gl: MB } {
  const mb = new MB(51);
  const gl = new MB(151);
  const half = 5.6;
  for (const s of [-1, 1]) {
    mb.tag = 'wood';
    mb.tube([s * half, -0.2, 0], [s * half, 3.5, 0], 0.09, 0.07, lod === 0 ? 7 : 5, P.timber, {
      caps: true,
    });
    mb.tag = 'stone';
    mb.box(s * half - 0.35, -0.35, -0.35, s * half + 0.35, 0.15, 0.35, P.stone, 0.08);
  }
  mb.tag = 'main';
  const sag = 0.55;
  const top = 3.35;
  const pts: V3[] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([-half + 2 * half * t, top - sag * (1 - (2 * t - 1) ** 2), 0]);
  }
  for (let i = 0; i < n; i++) mb.tube(pts[i]!, pts[i + 1]!, 0.012, 0.012, 3, P.black);
  const count = 7;
  for (let k = 0; k < count; k++) {
    const t = (k + 0.5) / count;
    const x = -half + 2 * half * t;
    const y = top - sag * (1 - (2 * t - 1) ** 2);
    mb.tube([x, y, 0], [x, y - 0.18, 0], 0.01, 0.01, 3, P.black);
    mb.cyl(x, y - 0.22, 0, 0.085, 0.085, 0.035, 8, P.black);
    gl.ell(x, y - 0.46, 0, 0.17, 0.22, 0.17, 10, 6, k % 2 ? shade(P.red, 1.1) : P.paper, P.paper);
    mb.cyl(x, y - 0.72, 0, 0.085, 0.085, 0.035, 8, P.black);
  }
  return { mb, gl };
}

function buildWell(lod: 0 | 1 | 2): MB {
  const mb = new MB(61);
  mb.tag = 'stone';
  const seg = lod === 0 ? 12 : 8;
  mb.cyl(0, -0.3, 0, 0.78, 0.74, 1.12, seg, mixc(P.stone, P.moss, 0.15), true, P.stoneDark);
  mb.tag = 'main';
  mb.cyl(0, 0.72, 0, 0.62, 0.62, 0.05, seg, P.black, true);
  mb.tag = 'wood';
  for (const s of [-1, 1])
    mb.box(s * 0.74 - 0.07, 0.7, -0.07, s * 0.74 + 0.07, 2.35, 0.07, P.timber, 0.08);
  mb.box(-0.86, 2.2, -0.08, 0.86, 2.36, 0.08, P.timberDark, 0.05);
  // Small tiled roof.
  const r: RoofP = {
    Lh: 1.15,
    Wh: 0.95,
    yR: 3.05,
    H: 0.58,
    hip: false,
    rh: 0,
    t: 0.1,
    up: 0.1,
    cell: lod === 0 ? 0.25 : 0.5,
    cA: P.tile,
    cB: P.tileLight,
    jit: 0.05,
    edge: P.tileEdge,
    under: P.timberDark,
  };
  addRoof(mb, r, 0);
  mb.tag = 'wood';
  mb.box(-0.8, 2.36, -0.04, 0.8, 2.5, 0.04, P.timberDark, 0.05);
  // Bucket + rope
  mb.tube([0, 2.3, 0], [0, 1.55, 0], 0.012, 0.012, 3, P.timberLight);
  mb.cyl(0, 1.2, 0, 0.14, 0.17, 0.3, 8, P.timber, true);
  return mb;
}

function buildFirewood(lod: 0 | 1 | 2): MB {
  const mb = new MB(71);
  const rows = 6;
  const logLen = 1.0;
  const seg = lod === 0 ? 6 : 4;
  for (let r = 0; r < rows; r++) {
    const n = 14 - r;
    for (let k = 0; k < n; k++) {
      const x = -1.5 + k * 0.215 + r * 0.105 + (mb.rnd() - 0.5) * 0.02;
      const y = 0.1 + r * 0.19;
      const rad = 0.075 + mb.rnd() * 0.02;
      const col = mixc(rgb('#5a4130'), rgb('#7b5b3f'), mb.rnd());
      mb.tag = 'wood';
      mb.tube([x, y, -logLen / 2], [x, y, logLen / 2], rad, rad, seg, col, { caps: false });
      mb.tag = 'main';
      const endC = mixc(rgb('#c9a36b'), rgb('#a98450'), mb.rnd());
      const disc = (z: number, flip: number): void => {
        mb.tri([x, y, z], [x + rad, y, z], [x, y + rad, z], endC, [0, 0, flip]);
        mb.tri([x, y, z], [x, y + rad, z], [x - rad, y, z], endC, [0, 0, flip]);
        mb.tri([x, y, z], [x - rad, y, z], [x, y - rad, z], endC, [0, 0, flip]);
        mb.tri([x, y, z], [x, y - rad, z], [x + rad, y, z], endC, [0, 0, flip]);
      };
      disc(logLen / 2 + 0.003, 1);
      disc(-logLen / 2 - 0.003, -1);
    }
  }
  mb.tag = 'wood';
  for (const s of [-1, 1]) {
    mb.box(s * 1.65 - 0.06, 0, -0.55, s * 1.65 + 0.06, 1.45, -0.43, P.timber, 0.08);
    mb.box(s * 1.65 - 0.06, 0, 0.43, s * 1.65 + 0.06, 1.45, 0.55, P.timber, 0.08);
  }
  // Lean-to cover
  mb.tag = 'roof';
  mb.quad(
    [-1.85, 1.5, -0.7],
    [1.85, 1.5, -0.7],
    [1.85, 1.2, 0.75],
    [-1.85, 1.2, 0.75],
    P.tile,
    [0, 1, 0],
  );
  mb.tag = 'wood';
  mb.quad(
    [-1.85, 1.46, -0.7],
    [1.85, 1.46, -0.7],
    [1.85, 1.16, 0.75],
    [-1.85, 1.16, 0.75],
    P.timberDark,
    [0, -1, 0],
  );
  mb.tag = 'roof';
  mb.quad(
    [-1.85, 1.5, 0.75],
    [1.85, 1.5, 0.75],
    [1.85, 1.16, 0.75],
    [-1.85, 1.16, 0.75],
    P.tileEdge,
    [0, 0, 1],
  );
  return mb;
}

function buildBridge(lod: 0 | 1 | 2): MB {
  const mb = new MB(81);
  mb.tag = 'wood';
  const Lb = 5.6;
  const w = 1.7;
  const n = lod === 0 ? 16 : 8;
  const arch = (x: number): number => 0.3 * (1 - (x / (Lb / 2)) ** 2);
  for (let i = 0; i < n; i++) {
    const x0 = -Lb / 2 + (Lb * i) / n;
    const x1 = -Lb / 2 + (Lb * (i + 1)) / n;
    mb.box(
      x0 + 0.01,
      arch((x0 + x1) / 2) - 0.1,
      -w / 2,
      x1 - 0.01,
      arch((x0 + x1) / 2),
      w / 2,
      mixc(P.timberLight, P.timber, mb.rnd()),
      0.08,
    );
  }
  for (const s of [-1, 1]) {
    const pts: V3[] = [];
    for (let i = 0; i <= 8; i++) {
      const x = -Lb / 2 + (Lb * i) / 8;
      pts.push([x, arch(x) - 0.1, s * (w / 2 - 0.1)]);
    }
    for (let i = 0; i < 8; i++) mb.tube(pts[i]!, pts[i + 1]!, 0.1, 0.1, 5, P.timberDark);
    // Rope rail + posts
    for (let i = 0; i <= 4; i++) {
      const x = -Lb / 2 + 0.3 + ((Lb - 0.6) * i) / 4;
      mb.tube(
        [x, arch(x), s * (w / 2 - 0.05)],
        [x, arch(x) + 0.95, s * (w / 2 - 0.05)],
        0.05,
        0.045,
        5,
        P.timber,
        { caps: true },
      );
    }
    const rail: V3[] = [];
    for (let i = 0; i <= 8; i++) {
      const x = -Lb / 2 + 0.3 + ((Lb - 0.6) * i) / 8;
      rail.push([x, arch(x) + 0.88, s * (w / 2 - 0.05)]);
    }
    for (let i = 0; i < 8; i++) mb.tube(rail[i]!, rail[i + 1]!, 0.025, 0.025, 4, P.timberLight);
  }
  mb.tag = 'stone';
  mb.box(-Lb / 2 - 0.2, -0.5, -w / 2 - 0.1, -Lb / 2 + 0.2, 0.0, w / 2 + 0.1, P.stone, 0.08);
  mb.box(Lb / 2 - 0.2, -0.5, -w / 2 - 0.1, Lb / 2 + 0.2, 0.0, w / 2 + 0.1, P.stone, 0.08);
  return mb;
}

function buildShrineExtras(mb: MB, gl: MB, p: HouseP, lod: 0 | 1 | 2): void {
  const zD = p.D / 2 + p.ov - 0.15;
  const fy = p.fy;
  // Front steps.
  mb.tag = 'stone';
  for (let s = 0; s < 4; s++) {
    mb.box(
      -1.4,
      -0.9,
      p.D / 2 + p.ov + 0.2 + s * 0.4 - 0.4 * 0,
      1.4,
      fy - 0.2 - (s * (fy - 0.2)) / 4 - 0.0,
      p.D / 2 + p.ov + 0.2 + (s + 1) * 0.4 + 0.2,
      mixc(P.stoneLight, P.stoneDark, 0.1 * s),
      0.05,
      0,
    );
  }
  mb.tag = 'main';
  // Rope with bell, offering box.
  const zr = zD + 0.12;
  mb.tube([0.0, fy + 2.55, zr], [0.0, fy + 1.35, zr + 0.1], 0.03, 0.04, 5, P.red);
  mb.tube([0.12, fy + 2.55, zr], [0.12, fy + 1.35, zr + 0.1], 0.03, 0.04, 5, P.plasterWhite);
  mb.ell(0.06, fy + 2.62, zr, 0.15, 0.13, 0.15, 8, 6, rgb('#b89a3a'));
  if (lod < 2) {
    mb.tag = 'wood';
    mb.box(-0.9, fy - 0.3, zD + 0.55, 0.9, fy + 0.5, zD + 1.1, P.timber, 0.06, 8);
    mb.tag = 'main';
    for (let s = 0; s < 8; s++) {
      const xa = -0.9 + (1.8 * s) / 8;
      mb.quad(
        [xa + 0.01, fy + 0.5, zD + 0.8],
        [xa + 0.2, fy + 0.5, zD + 0.8],
        [xa + 0.2, fy + 0.5, zD + 1.1],
        [xa + 0.01, fy + 0.5, zD + 1.1],
        P.black,
        [0, 1, 0],
      );
    }
  }
  // Shimenawa rope across the front with paper streamers.
  const zs = zD - 0.45;
  const pts: V3[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    pts.push([-p.L / 2 + p.L * t, fy + 2.28 - 0.18 * (1 - (2 * t - 1) ** 2), zs]);
  }
  for (let i = 0; i < 10; i++) mb.tube(pts[i]!, pts[i + 1]!, 0.07, 0.07, 5, rgb('#d8c690'));
  if (lod < 2) {
    for (let i = 1; i < 10; i += 2) {
      const [x, y] = [pts[i]![0], pts[i]![1]];
      for (let k = 0; k < 3; k++) {
        const yy = y - 0.1 - k * 0.17;
        const dx = k % 2 === 0 ? 0.07 : -0.07;
        mb.quad(
          [x + dx, yy, zs],
          [x + dx + 0.12, yy, zs],
          [x + 0.12 - dx, yy - 0.18, zs],
          [x - dx, yy - 0.18, zs],
          P.plasterWhite,
          [0, 0, 1],
        );
      }
    }
  }
  // Corner lanterns glow
  for (const s of [-1, 1]) {
    const x = s * (p.L / 2 - 0.2);
    mb.tube([x, fy + 2.5, zD - 0.3], [x, fy + 2.15, zD - 0.3], 0.01, 0.01, 3, P.black);
    gl.ell(x, fy + 1.95, zD - 0.3, 0.17, 0.21, 0.17, 10, 6, shade(P.red, 1.1), P.paper);
  }
}

// ---------------------------------------------------------------------------------------------
// Fields, pond, garden
// ---------------------------------------------------------------------------------------------

function buildPaddy(rice: boolean, lod: 0 | 1 | 2): { mb: MB; water: MB; leaf: MB } {
  const mb = new MB(91);
  const water = new MB(92);
  const leaf = new MB(93);
  const W = 9;
  const Lz = 30;
  const hx = W / 2;
  const hz = Lz / 2;
  const wc = rgb('#1a252b');
  // Water sheet (slightly vertex-varied for a hint of reflection variety).
  const nxw = 4;
  const nzw = 12;
  for (let j = 0; j < nzw; j++) {
    for (let i = 0; i < nxw; i++) {
      const x0 = -hx + (W * i) / nxw;
      const x1 = -hx + (W * (i + 1)) / nxw;
      const z0 = -hz + (Lz * j) / nzw;
      const z1 = -hz + (Lz * (j + 1)) / nzw;
      const c = shade(wc, 0.9 + 0.2 * mb.rnd());
      water.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], c, [0, 1, 0]);
    }
  }
  // Bunds: soil body with a grassy top, and a stone retaining face on the downhill (west) side.
  const bt = 0.5;
  const bh = 0.34;
  mb.box(-hx - bt, -1.3, -hz - bt, hx + bt, bh, -hz + 0.02, P.soil, 0.1, 8);
  mb.box(-hx - bt, -1.3, hz - 0.02, hx + bt, bh, hz + bt, P.soil, 0.1, 8);
  mb.box(-hx - bt, -2.4, -hz, -hx + 0.02, bh, hz, P.soil, 0.1, 8 | 2);
  mb.box(hx - 0.02, -1.3, -hz, hx + bt, bh, hz, P.soil, 0.1, 8);
  mb.tag = 'stone';
  mb.box(
    -hx - bt - 0.04,
    -2.4,
    -hz - bt,
    -hx - bt,
    -0.05,
    hz + bt,
    P.stone,
    0.12,
    8 | 4 | 1 | 16 | 32,
  );
  mb.tag = 'main';
  for (const [x0, z0, x1, z1] of [
    [-hx - bt, -hz - bt, hx + bt, -hz + 0.02],
    [-hx - bt, hz - 0.02, hx + bt, hz + bt],
    [-hx - bt, -hz, -hx + 0.02, hz],
    [hx - 0.02, -hz, hx + bt, hz],
  ] as const)
    mb.quad(
      [x0, bh + 0.004, z0],
      [x1, bh + 0.004, z0],
      [x1, bh + 0.004, z1],
      [x0, bh + 0.004, z1],
      P.grassTop,
      [0, 1, 0],
    );
  if (lod > 0) return { mb, water, leaf };
  if (rice) {
    const step = 0.5;
    const nx = Math.floor((W - 0.9) / step);
    const nz = Math.floor((Lz - 0.9) / step);
    const c0 = rgb('#4f8a2e');
    const c1 = rgb('#9cc650');
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const cx = -((nx - 1) * step) / 2 + i * step + (leaf.rnd() - 0.5) * 0.1;
        const cz = -((nz - 1) * step) / 2 + j * step + (leaf.rnd() - 0.5) * 0.1;
        const hgt = 0.38 + leaf.rnd() * 0.14;
        for (let b = 0; b < 3; b++) {
          const a = leaf.rnd() * Math.PI * 2 + b * 2.1;
          const lx = Math.cos(a) * 0.1;
          const lz = Math.sin(a) * 0.1;
          const wx = -Math.sin(a) * 0.022;
          const wz = Math.cos(a) * 0.022;
          const k = leaf.v([cx - wx, 0.02, cz - wz], [0, 1, 0], c0);
          leaf.v([cx + wx, 0.02, cz + wz], [0, 1, 0], c0);
          leaf.v([cx + lx, hgt, cz + lz], [lx, 1, lz], c1);
          leaf.i.push(k, k + 1, k + 2);
        }
      }
    }
  }
  return { mb, water, leaf };
}

function buildPond(lod: 0 | 1 | 2): { mb: MB; water: MB } {
  const mb = new MB(101);
  const water = new MB(102);
  const noise = new Noise2D(7);
  const rx = 3.7;
  const rz = 2.5;
  const seg = lod === 0 ? 28 : 16;
  const rad = (a: number): number =>
    1 + 0.16 * noise.fbm(Math.cos(a) * 1.3 + 2, Math.sin(a) * 1.3, 2);
  const wc = rgb('#17242a');
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    water.tri(
      [0, 0, 0],
      [Math.cos(a1) * rx * rad(a1) * 0.99, 0, Math.sin(a1) * rz * rad(a1) * 0.99],
      [Math.cos(a0) * rx * rad(a0) * 0.99, 0, Math.sin(a0) * rz * rad(a0) * 0.99],
      shade(wc, 0.9 + 0.2 * water.rnd()),
      [0, 1, 0],
    );
  }
  mb.tag = 'rock';
  // Rim stones.
  const nst = lod === 0 ? 22 : 12;
  for (let i = 0; i < nst; i++) {
    const a = (i / nst) * Math.PI * 2 + mb.rnd() * 0.12;
    const r = rad(a);
    const s = 0.28 + mb.rnd() * 0.3;
    const col = mixc(P.stone, P.stoneDark, mb.rnd());
    mb.blob(
      Math.cos(a) * rx * r * 1.02,
      0.02 + s * 0.18,
      Math.sin(a) * rz * r * 1.02,
      s * 1.2,
      s * 0.65,
      s,
      lod === 0 ? 1 : 0,
      200 + i,
      0.25,
      (y, n) => mixc(shade(col, 0.85 + y * 0.3 + n * 0.2), P.moss, y > 0.7 ? 0.3 : 0),
    );
  }
  mb.tag = 'main';
  // Lily pads.
  if (lod === 0) {
    for (let i = 0; i < 6; i++) {
      const x = (mb.rnd() - 0.5) * rx * 1.1;
      const z = (mb.rnd() - 0.5) * rz * 1.1;
      const r = 0.2 + mb.rnd() * 0.14;
      for (let s = 0; s < 8; s++) {
        const a0 = (s / 8) * Math.PI * 2;
        const a1 = ((s + 0.85) / 8) * Math.PI * 2;
        mb.tri(
          [x, 0.012, z],
          [x + Math.cos(a0) * r, 0.012, z + Math.sin(a0) * r],
          [x + Math.cos(a1) * r, 0.012, z + Math.sin(a1) * r],
          rgb('#4d7a2e'),
          [0, 1, 0],
        );
      }
    }
  }
  return { mb, water };
}

function buildGravel(lod: 0 | 1 | 2): MB {
  const mb = new MB(111);
  const W = 8;
  const D = 5.5;
  const base = rgb('#bab3a1');
  const cell = lod === 0 ? 0.16 : 0.5;
  const nx = Math.round(W / 0.5);
  const nz = Math.round(D / cell);
  const h = (z: number): number => (lod === 0 ? 0.022 * Math.sin((z / 0.17) * Math.PI) : 0);
  // Edge curb stones.
  mb.tag = 'stone';
  mb.box(-W / 2 - 0.2, -0.3, -D / 2 - 0.2, W / 2 + 0.2, 0.06, -D / 2, P.stoneDark, 0.1, 8);
  mb.box(-W / 2 - 0.2, -0.3, D / 2, W / 2 + 0.2, 0.06, D / 2 + 0.2, P.stoneDark, 0.1, 8);
  mb.box(-W / 2 - 0.2, -0.3, -D / 2, -W / 2, 0.06, D / 2, P.stoneDark, 0.1, 8);
  mb.box(W / 2, -0.3, -D / 2, W / 2 + 0.2, 0.06, D / 2, P.stoneDark, 0.1, 8);
  mb.tag = 'gravel';
  for (let j = 0; j < nz; j++) {
    const z0 = -D / 2 + (D * j) / nz;
    const z1 = -D / 2 + (D * (j + 1)) / nz;
    const ridge = Math.sin((z0 / 0.17) * Math.PI) > 0;
    const col = shade(base, ridge ? 1.07 : 0.92);
    for (let i = 0; i < nx; i++) {
      const x0 = -W / 2 + (W * i) / nx;
      const x1 = -W / 2 + (W * (i + 1)) / nx;
      mb.sq(
        [
          [x0, 0.03 + h(z0), z0],
          [x1, 0.03 + h(z0), z0],
          [x1, 0.03 + h(z1), z1],
          [x0, 0.03 + h(z1), z1],
        ],
        [
          norm([0, 1, -h(z0) * 6]),
          norm([0, 1, -h(z0) * 6]),
          norm([0, 1, -h(z1) * 6]),
          norm([0, 1, -h(z1) * 6]),
        ],
        [col, col, col, col],
      );
    }
  }
  return mb;
}

function buildGardenRock(variant: number, lod: 0 | 1 | 2): MB {
  const mb = new MB(121 + variant);
  mb.tag = 'rock';
  const sizes: [number, number, number][] = [
    [0.85, 0.7, 0.7],
    [0.6, 0.45, 0.5],
    [1.15, 0.6, 0.8],
  ];
  const [rx, ry, rz] = sizes[variant % 3]!;
  const base = mixc(P.stone, rgb('#7a7d72'), 0.5);
  mb.blob(
    0,
    ry * 0.55,
    0,
    rx,
    ry,
    rz,
    lod === 0 ? 2 : lod === 1 ? 1 : 0,
    300 + variant,
    0.3,
    (y, n) => {
      const c = shade(base, 0.7 + y * 0.45 + n * 0.25);
      return mixc(c, P.moss, smooth(0.62, 0.9, y + n * 0.2) * 0.55);
    },
  );
  return mb;
}

function buildSteppingStones(lod: 0 | 1 | 2): MB {
  const mb = new MB(131);
  mb.tag = 'stone';
  const pts: [number, number, number][] = [
    [-3.0, 0.1, 0.35],
    [-2.0, -0.3, 0.3],
    [-1.0, -0.55, 0.38],
    [0.05, -0.4, 0.3],
    [1.05, 0.0, 0.36],
    [2.0, 0.45, 0.3],
    [3.0, 0.6, 0.34],
  ];
  for (const [x, z, r] of pts) {
    const c = mixc(P.stoneLight, P.stoneDark, mb.rnd() * 0.6);
    mb.tube(
      [x, -0.12, z],
      [x, 0.11, z],
      r * 1.05,
      r * 0.92,
      lod === 0 ? 9 : 6,
      mixc(c, P.moss, 0.15),
      { caps: true, jit: 0.1, rot: mb.rnd() },
    );
  }
  return mb;
}

function buildFence(variant: number, lod: 0 | 1 | 2): MB {
  const mb = new MB(141 + variant);
  const Lf = 3.0;
  if (variant === 0) {
    // Bamboo lattice fence (yotsume-gaki).
    const bam = rgb('#a9a768');
    const seg = lod === 0 ? 5 : 4;
    for (let k = 0; k <= 2; k++)
      mb.tube(
        [-Lf / 2 + (Lf * k) / 2, -0.15, 0],
        [-Lf / 2 + (Lf * k) / 2, 1.2, 0],
        0.045,
        0.04,
        seg,
        bam,
        { caps: true },
      );
    for (const y of [0.3, 0.7, 1.1])
      mb.tube([-Lf / 2, y, 0.05], [Lf / 2, y, 0.05], 0.025, 0.025, 4, shade(bam, 0.9));
    const n = lod === 0 ? 14 : 7;
    for (let k = 0; k < n; k++) {
      const x = -Lf / 2 + 0.15 + ((Lf - 0.3) * k) / (n - 1);
      mb.tube([x, 0.0, -0.04], [x, 1.1, -0.04], 0.02, 0.018, 4, shade(bam, 0.95 + mb.rnd() * 0.1));
    }
  } else {
    // Low wooden rail fence.
    mb.tag = 'wood';
    for (let k = 0; k <= 2; k++)
      mb.box(
        -Lf / 2 + (Lf * k) / 2 - 0.06,
        -0.2,
        -0.06,
        -Lf / 2 + (Lf * k) / 2 + 0.06,
        1.0,
        0.06,
        P.timber,
        0.1,
      );
    for (const y of [0.35, 0.75])
      mb.box(-Lf / 2, y, -0.03, Lf / 2, y + 0.09, 0.03, P.timberLight, 0.08);
  }
  return mb;
}

function buildGardenWall(lod: 0 | 1 | 2): MB {
  const mb = new MB(151);
  mb.tag = 'stone';
  const Lw = 4;
  mb.box(-Lw / 2, -0.4, -0.22, Lw / 2, 0.3, 0.22, P.stone, 0.06);
  mb.tag = 'plaster';
  mb.box(-Lw / 2 + 0.02, 0.3, -0.17, Lw / 2 - 0.02, 1.45, 0.17, P.plaster, 0.04, 8);
  mb.tag = 'wood';
  if (lod === 0) {
    for (let k = 0; k <= 2; k++)
      mb.box(
        -Lw / 2 + (Lw * k) / 2 - 0.06,
        0.3,
        -0.2,
        -Lw / 2 + (Lw * k) / 2 + 0.06,
        1.45,
        0.2,
        P.timber,
        0.08,
      );
  }
  mb.tag = 'roof';
  // Tile cap (gable section)
  const y0 = 1.45;
  for (const s of [-1, 1]) {
    mb.quad(
      [-Lw / 2 - 0.05, y0 + 0.14, 0],
      [Lw / 2 + 0.05, y0 + 0.14, 0],
      [Lw / 2 + 0.05, y0 - 0.03, s * 0.34],
      [-Lw / 2 - 0.05, y0 - 0.03, s * 0.34],
      P.tile,
      [0, 1, s * 0.5],
    );
  }
  mb.tube(
    [-Lw / 2 - 0.05, y0 + 0.16, 0],
    [Lw / 2 + 0.05, y0 + 0.16, 0],
    0.07,
    0.07,
    5,
    P.tileEdge,
    { caps: true },
  );
  return mb;
}

// ---------------------------------------------------------------------------------------------
// Vegetation
// ---------------------------------------------------------------------------------------------

function buildMaple(variant: number, lod: 0 | 1 | 2): MB {
  const mb = new MB(161 + variant);
  const seg = lod === 0 ? 7 : lod === 1 ? 5 : 4;
  const det = lod === 0 ? 2 : lod === 1 ? 1 : 0;
  const palettes = [
    { a: rgb('#9c2a1f'), b: rgb('#d2512a') }, // deep red
    { a: rgb('#c4481f'), b: rgb('#e5892f') }, // orange
    { a: rgb('#8b9a33'), b: rgb('#e0b038') }, // yellow-green turning
  ];
  const pal = palettes[variant % 3]!;
  const bark = rgb('#4f3d30');
  // Trunk + limbs.
  mb.tube([0, -0.15, 0], [0.12, 1.5, 0.05], 0.24, 0.17, seg, bark, { caps: true });
  const limbs: [V3, V3][] = [
    [
      [0.12, 1.4, 0.05],
      [-0.9, 3.3, 0.3],
    ],
    [
      [0.12, 1.5, 0.05],
      [1.1, 3.1, -0.4],
    ],
    [
      [0.12, 1.7, 0.05],
      [0.1, 3.9, 0.9],
    ],
  ];
  for (const [a, b] of limbs) mb.tube(a, b, 0.12, 0.06, seg, bark);
  const blobs: [number, number, number, number, number][] = [
    [-1.1, 3.8, 0.4, 1.7, 1.2],
    [1.3, 3.6, -0.5, 1.6, 1.15],
    [0.1, 4.7, 0.8, 1.6, 1.2],
    [0.1, 4.3, -1.0, 1.5, 1.0],
    [0.4, 5.6, 0.0, 1.35, 1.0],
    [-1.9, 3.2, -0.8, 1.2, 0.9],
  ];
  blobs.forEach(([x, y, z, rx, ry], i) => {
    const hueMix = mb.rnd() * 0.5 + (i % 2) * 0.25;
    mb.blob(x, y, z, rx, ry, rx * 0.95, det, 400 + variant * 10 + i, 0.3, (y01, n) => {
      const c = mixc(pal.a, pal.b, clamp01(hueMix + y01 * 0.5 + n * 0.5));
      return shade(c, 0.62 + y01 * 0.6);
    });
  });
  return mb;
}

function buildBamboo(variant: number, lod: 0 | 1 | 2): { culms: MB; leaves: MB } {
  const culms = new MB(171 + variant);
  const leaves = new MB(181 + variant);
  const rnd = prng(900 + variant * 31);
  const n = [7, 6, 8][variant % 3]!;
  const heights = [10.5, 12.5, 9.0];
  const h0 = heights[variant % 3]!;
  const seg = lod === 0 ? 5 : lod === 1 ? 4 : 3;
  const green = rgb('#6f9640');
  const greenDark = rgb('#4f7a34');
  const node = rgb('#a9ba66');
  const leafA = rgb('#3f6b25');
  const leafB = rgb('#8dbb45');
  for (let c = 0; c < n; c++) {
    const a = rnd() * Math.PI * 2;
    const rr = Math.sqrt(rnd()) * 0.85;
    const bx = Math.cos(a) * rr;
    const bz = Math.sin(a) * rr;
    const h = h0 * (0.82 + rnd() * 0.3);
    const lean = 0.5 + rnd() * 1.0;
    const la = a + (rnd() - 0.5) * 1.2; // outward-ish lean
    const lx = Math.cos(la) * lean;
    const lz = Math.sin(la) * lean;
    const r = 0.052 + rnd() * 0.02;
    const col = mixc(green, greenDark, rnd() * 0.6);
    const pathAt = (t: number): V3 => [bx + lx * t * t * 1.0, t * h, bz + lz * t * t * 1.0];
    const rad = (t: number): number => r * (1 - 0.65 * t);
    const inter = lod === 0 ? 0.75 : lod === 1 ? 1.8 : h;
    const ns = Math.max(1, Math.round(h / inter));
    for (let k = 0; k < ns; k++) {
      const t0 = k / ns;
      const t1 = (k + 1) / ns;
      const p0 = pathAt(t0);
      const p1 = pathAt(t1);
      if (lod === 0) {
        // Node band + internode.
        const pn = lerp3(p0, p1, 0.07);
        culms.tube(p0, pn, rad(t0) * 1.16, rad(t0) * 1.16, seg, node, { jit: 0.03 });
        culms.tube(pn, p1, rad(t0), rad(t1), seg, k % 2 ? col : shade(col, 1.06), { jit: 0.03 });
      } else {
        culms.tube(p0, p1, rad(t0), rad(t1), seg, col, { jit: 0.03 });
      }
    }
    // Leaf tufts on the upper third.
    const tufts = lod === 0 ? 9 : lod === 1 ? 5 : 0;
    for (let k = 0; k < tufts; k++) {
      const t = 0.58 + (0.42 * (k + rnd() * 0.6)) / tufts;
      const base = pathAt(Math.min(1, t));
      const blades = lod === 0 ? 5 : 3;
      const ta = rnd() * Math.PI * 2;
      for (let b = 0; b < blades; b++) {
        const ba = ta + (b / blades) * Math.PI * 2 + rnd() * 0.5;
        const dir: V3 = [Math.cos(ba), 0, Math.sin(ba)];
        const len0 = 0.55 + rnd() * 0.35;
        const root = add(base, mul(dir, 0.04));
        const tip = add(add(root, mul(dir, len0)), [0, -0.22 - rnd() * 0.12, 0]);
        const mid = add(lerp3(root, tip, 0.5), [0, 0.1, 0]);
        const side = mul(norm(cross(dir, [0, 1, 0])), 0.055);
        leaves.quad(
          root,
          add(mid, side),
          tip,
          sub(mid, side),
          [leafA, leafB, leafB, leafA],
          [0, 1, 0],
        );
      }
    }
    if (lod === 2) {
      // Crossed leaf cards along the crown (tapered, darker so distant groves read as foliage masses).
      const top = pathAt(1);
      const c0 = pathAt(0.62);
      const cMid = pathAt(0.82);
      for (const ang of [0.3, 0.3 + Math.PI / 2]) {
        const sx = Math.cos(ang);
        const sz = Math.sin(ang);
        const w0 = 0.45;
        const w1 = 0.7;
        leaves.quad(
          [c0[0] - sx * 0.1, c0[1], c0[2] - sz * 0.1],
          [c0[0] + sx * 0.1, c0[1], c0[2] + sz * 0.1],
          [cMid[0] + sx * w1, cMid[1], cMid[2] + sz * w1],
          [cMid[0] - sx * w1, cMid[1], cMid[2] - sz * w1],
          [leafA, leafA, leafB, leafB],
          [0, 1, 0],
        );
        leaves.quad(
          [cMid[0] - sx * w1, cMid[1], cMid[2] - sz * w1],
          [cMid[0] + sx * w1, cMid[1], cMid[2] + sz * w1],
          [top[0] + sx * w0, top[1] + 0.3, top[2] + sz * w0],
          [top[0] - sx * w0, top[1] + 0.3, top[2] - sz * w0],
          [leafB, leafB, leafA, leafA],
          [0, 1, 0],
        );
      }
    }
  }
  return { culms, leaves };
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

const HOUSE_A: HouseP = {
  L: 9.2,
  D: 6.6,
  wallH: 2.5,
  roof: 'hip',
  H: 2.5,
  ov: 1.55,
  ovX: 1.55,
  veranda: true,
  door: 1,
  fy: 0.6,
  wall: P.plaster,
  post: P.timber,
  dado: P.charred,
  roofA: P.tile,
  roofB: P.tileLight,
  lanterns: 2,
  seed: 1,
  shoji: true,
  steps: true,
  wallMat: 'plaster',
};
const HOUSE_B: HouseP = {
  ...HOUSE_A,
  L: 7.6,
  D: 5.8,
  wallH: 2.45,
  roof: 'gable',
  H: 2.3,
  ov: 1.4,
  ovX: 0.95,
  door: 2,
  wall: P.plasterWarm,
  lanterns: 1,
  seed: 2,
};
const HOUSE_C: HouseP = {
  ...HOUSE_A,
  L: 7.0,
  D: 5.4,
  wallH: 2.25,
  roof: 'thatch',
  H: 2.9,
  ov: 1.25,
  ovX: 1.25,
  door: 1,
  wall: rgb('#c9b890'),
  roofA: P.thatch,
  roofB: shade(P.thatch, 0.88),
  lanterns: 0,
  seed: 3,
};
const KURA: HouseP = {
  ...HOUSE_A,
  L: 4.8,
  D: 4.2,
  wallH: 3.1,
  roof: 'gable',
  H: 1.7,
  ov: 0.75,
  ovX: 0.55,
  veranda: false,
  door: 1,
  fy: 0.9,
  platform: true,
  wall: P.plasterWhite,
  lanterns: 0,
  seed: 4,
  steps: false,
  shoji: false,
  wallMat: 'wood',
};
const SHRINE: HouseP = {
  ...HOUSE_A,
  L: 4.6,
  D: 3.6,
  wallH: 2.7,
  roof: 'hip',
  H: 2.1,
  ov: 1.35,
  ovX: 1.35,
  veranda: true,
  door: -1,
  fy: 1.25,
  platform: true,
  wall: rgb('#a58863'),
  post: P.vermilion,
  dado: rgb('#7d6244'),
  roofA: rgb('#4a5a54'),
  roofB: rgb('#5a6a63'),
  lanterns: 0,
  seed: 7,
  shoji: false,
  steps: false,
  wallMat: 'wood',
  painted: true,
};

function houseSpecies(key: string, p: HouseP): Species {
  const lods = ([0, 1, 2] as const).map((l) => {
    const b = buildHouse(p, l);
    return [
      { mb: b.main, mat: 'main' as const },
      { mb: b.glow, mat: 'glow' as const },
    ];
  });
  const hgt = p.fy + p.wallH + p.H + 0.6;
  return finish(key, { height: hgt, radius: Math.max(p.L, p.D) / 2 + p.ov, glowIntensity: 4.2 }, [
    lods,
  ]);
}

function shrineSpecies(): Species {
  const lods = ([0, 1, 2] as const).map((l) => {
    const b = buildHouse(SHRINE, l);
    // Doors: lattice panels on the front.
    const zf = SHRINE.D / 2;
    const fy = SHRINE.fy;
    b.main.tag = 'main';
    b.main.box(
      -SHRINE.L / 2 + 0.3,
      fy,
      zf - 0.01,
      SHRINE.L / 2 - 0.3,
      fy + 2.0,
      zf + 0.04,
      P.timberDark,
      0.05,
      8,
    );
    for (let k = 0; k < 3; k++) {
      const x0 = -SHRINE.L / 2 + 0.35 + k * ((SHRINE.L - 0.7) / 3);
      const x1 = x0 + (SHRINE.L - 0.7) / 3 - 0.06;
      b.glow.quad(
        [x0, fy + 0.45, zf + 0.045],
        [x1, fy + 0.45, zf + 0.045],
        [x1, fy + 1.95, zf + 0.045],
        [x0, fy + 1.95, zf + 0.045],
        P.paper,
        [0, 0, 1],
      );
      if (l === 0)
        for (let q = 0; q <= 5; q++) {
          const xx = x0 + ((x1 - x0) * q) / 5;
          b.main.quad(
            [xx - 0.012, fy + 0.45, zf + 0.05],
            [xx + 0.012, fy + 0.45, zf + 0.05],
            [xx + 0.012, fy + 1.95, zf + 0.05],
            [xx - 0.012, fy + 1.95, zf + 0.05],
            P.timberDark,
            [0, 0, 1],
          );
        }
    }
    buildShrineExtras(b.main, b.glow, SHRINE, l);
    return [
      { mb: b.main, mat: 'main' as const },
      { mb: b.glow, mat: 'glow' as const },
    ];
  });
  return finish('shrine', { height: 8.5, radius: 5, glowIntensity: 4.2 }, [lods]);
}

function simple(key: string, cfg: Cfg, f: (lod: 0 | 1 | 2) => MB, nLod = 3): Species {
  const lods = ([0, 1, 2] as const).slice(0, nLod).map((l) => [{ mb: f(l), mat: 'main' as const }]);
  return finish(key, cfg, [lods]);
}

/** Registers `id` (all variants, for scatter) plus `id-<k>` (variant k only, for hand-placed props). */
function registerVariants(id: string, build: () => Species): void {
  registerPlaceholder(`village:${id}`, build);
  for (let k = 0; k < 3; k++) {
    registerPlaceholder(`village:${id}-${k}`, () => {
      const sp = build();
      const keep = sp.variants[k];
      if (!keep) return sp;
      return { ...sp, variants: [keep] };
    });
  }
}

export function registerVillagePlaceholders(): void {
  registerPlaceholder('village:house-a', () => houseSpecies('house-a', HOUSE_A));
  registerPlaceholder('village:house-b', () => houseSpecies('house-b', HOUSE_B));
  registerPlaceholder('village:house-c', () => houseSpecies('house-c', HOUSE_C));
  registerPlaceholder('village:storehouse', () => houseSpecies('storehouse', KURA));
  registerPlaceholder('village:shrine', shrineSpecies);
  registerPlaceholder('village:torii', () =>
    simple('torii', { height: 5.2, radius: 3.6 }, buildTorii),
  );
  registerPlaceholder('village:stairs', () =>
    simple('stairs', { height: 2.2, radius: 2.8 }, (l) => buildStairs(l), 2),
  );
  registerPlaceholder('village:well', () =>
    simple('well', { height: 3.2, radius: 1.2 }, buildWell),
  );
  registerPlaceholder('village:firewood', () =>
    simple('firewood', { height: 1.6, radius: 2 }, buildFirewood),
  );
  registerPlaceholder('village:bridge', () =>
    simple('bridge', { height: 1.3, radius: 3.2 }, buildBridge),
  );
  registerPlaceholder('village:gravel-bed', () =>
    simple('gravel-bed', { height: 0.2, radius: 4.5 }, buildGravel, 2),
  );
  registerPlaceholder('village:stepping-stones', () =>
    simple('stepping-stones', { height: 0.2, radius: 3.4 }, buildSteppingStones, 2),
  );
  registerPlaceholder('village:garden-wall', () =>
    simple('garden-wall', { height: 1.8, radius: 2.1 }, buildGardenWall, 2),
  );
  registerVariants('garden-rock', () => {
    const v = [0, 1, 2].map((k) =>
      ([0, 1, 2] as const).map((l) => [{ mb: buildGardenRock(k, l), mat: 'main' as const }]),
    );
    return finish('garden-rock', { height: 1.0, radius: 1.2 }, v);
  });
  registerVariants('fence', () => {
    const v = [0, 1].map((k) =>
      ([0, 1] as const).map((l) => [{ mb: buildFence(k, l), mat: 'main' as const }]),
    );
    return finish('fence', { height: 1.2, radius: 1.5 }, v);
  });
  registerVariants('stone-lantern', () => {
    const v = ([0, 1] as const).map((k) =>
      ([0, 1, 2] as const).map((l) => {
        const b = buildStoneLantern(k, l);
        return [
          { mb: b.stone, mat: 'main' as const },
          { mb: b.glow, mat: 'glow' as const },
        ];
      }),
    );
    return finish('stone-lantern', { height: 2.0, radius: 0.6, glowIntensity: 6 }, v);
  });
  registerVariants('lantern-post', () => {
    const v = ([0, 1] as const).map((k) =>
      ([0, 1, 2] as const).map((l) => {
        const b = buildLanternPost(k, l);
        return [
          { mb: b.mb, mat: 'main' as const },
          { mb: b.gl, mat: 'glow' as const },
        ];
      }),
    );
    return finish('lantern-post', { height: 3.0, radius: 0.9, glowIntensity: 5 }, v);
  });
  registerPlaceholder('village:lantern-string', () => {
    const v = [
      ([0, 1, 2] as const).map((l) => {
        const b = buildLanternString(l);
        return [
          { mb: b.mb, mat: 'main' as const },
          { mb: b.gl, mat: 'glow' as const },
        ];
      }),
    ];
    return finish('lantern-string', { height: 3.5, radius: 6, glowIntensity: 5 }, v);
  });
  const paddy = (rice: boolean) => () => {
    const lods = ([0, 1] as const).map((l) => {
      const b = buildPaddy(rice, l);
      return [
        { mb: b.mb, mat: 'main' as const },
        { mb: b.water, mat: 'water' as const },
        { mb: b.leaf, mat: 'leaf' as const, shadow: false },
      ];
    });
    return finish(
      rice ? 'paddy-rice' : 'paddy',
      { height: 0.5, radius: 15, wind: 0.04, windHeight: 0.5, flutter: 0.01 },
      [lods],
    );
  };
  registerPlaceholder('village:paddy', paddy(false));
  registerPlaceholder('village:paddy-rice', paddy(true));
  registerPlaceholder('village:pond', () => {
    const lods = ([0, 1] as const).map((l) => {
      const b = buildPond(l);
      return [
        { mb: b.mb, mat: 'main' as const },
        { mb: b.water, mat: 'water' as const },
      ];
    });
    return finish('pond', { height: 0.6, radius: 4.5 }, [lods]);
  });
  registerVariants('maple', () => {
    const v = [0, 1, 2].map((k) =>
      ([0, 1, 2] as const).map((l) => [{ mb: buildMaple(k, l), mat: 'main' as const }]),
    );
    return finish('maple', { wind: 0.2, windHeight: 7, flutter: 0.035, height: 7, radius: 0.4 }, v);
  });
  registerVariants('bamboo', () => {
    const v = [0, 1, 2].map((k) =>
      ([0, 1, 2] as const).map((l) => {
        const b = buildBamboo(k, l);
        return [
          { mb: b.culms, mat: 'main' as const },
          { mb: b.leaves, mat: 'leaf' as const },
        ];
      }),
    );
    return finish(
      'bamboo',
      { wind: 0.55, windHeight: 11, flutter: 0.05, height: 12, radius: 1.2 },
      v,
    );
  });
}
