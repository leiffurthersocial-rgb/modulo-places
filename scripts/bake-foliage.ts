// Bake "branch card" textures from the Poly Haven fir/pine scans.
//
//   npm run assets:bake-foliage [-- --only fir|pine] [--png-only]
//
// The scans have 400k-800k tiny cut-out needle cards. We pick a few outer branch tips (a patch of
// whole connected components), render each orthographically along the branch's dominant plane
// (PCA of card centroids) in headless Chromium (three.js), and pack 4 patches into a 1024^2 atlas:
// albedo+alpha (ETC1S) and tangent-space normal (UASTC). Output: public/pack/foliage/<species>/ and
// manifest.json "foliage". Procedural conifers (src/engine/scatter/conifer.ts) build from these.
//
// Needs: NODE_OPTIONS=--max-old-space-size=12000 (set by the npm script).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { encodeToKTX2 } from 'ktx2-encoder';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { Rng } from '../src/engine/core/random';

const ROOT = process.cwd();
const PACK = join(ROOT, 'public', 'pack');
const CACHE = join(ROOT, '.asset-cache', 'foliage');
const PAGE_DIR = join(ROOT, 'scripts', 'lib', 'bake-page');
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;
const pngOnly = argv.includes('--png-only');

// Atlas tile; 1024 → 2048² atlas (1024² was visibly soft on cards 3–5 m away). Override: --tile 512
const TILE = argv.includes('--tile') ? Number(argv[argv.indexOf('--tile') + 1]) : 1024;
const SS = 2; // supersampling in the bake render
const MARGIN = 10; // px between patch and tile edge (room for colour dilation)

type V3 = [number, number, number];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

interface Species {
  id: 'fir' | 'pine' | 'broadleaf' | 'maple';
  gltf: string;
  /** Material-name suffix of the cut-out card primitive in the scan. */
  prim: string;
  /** Recolour the baked albedo (maple: green -> autumn red/orange, luminance preserved). */
  tint?: 'maple';
  /** Candidate patch half-extents are scaled by this when picking (default 1). */
  seedBase: number;
  /** Min radial distance (m) of a tip candidate from the trunk axis, and lateral/height slab (m). */
  rMin?: number;
  slab?: number;
  /** Erode the trusted-colour mask by N px (kills dark cut-out fringes on leaves). */
  erode?: number;
  /** Height band (fraction of the twig y-range) to look for outer branch tips in. */
  band: [number, number];
  /** Patch half extents (m): across, along, thickness; and tip-sector half-angle (deg). */
  across: number;
  along: number;
  /** sRGB-byte brightness gain (scanned pine needles are very dark for a game lighting rig). */
  gain: number;
  thick: number;
}

const SPECIES: Species[] = [
  {
    id: 'fir',
    prim: '_twig',
    seedBase: 1337,
    gain: 1.1,
    gltf: '.asset-cache/polyhaven/models/fir_tree_01/2k/fir_tree_01_2k.gltf',
    band: [0.25, 0.5],
    across: 0.7,
    along: 0.85,
    thick: 0.75,
  },
  {
    id: 'pine',
    prim: '_twig',
    seedBase: 4242,
    gain: 1.4,
    gltf: '.asset-cache/polyhaven/models/pine_tree_01/2k/pine_tree_01_2k.gltf',
    band: [0.4, 0.7],
    across: 0.65,
    along: 0.85,
    thick: 0.5,
  },
  {
    id: 'broadleaf',
    prim: '_leaves',
    seedBase: 777,
    gain: 1.25,
    gltf: '.asset-cache/polyhaven/models/tree_small_02/2k/tree_small_02_2k.gltf',
    band: [0.35, 0.75],
    across: 0.4,
    along: 0.45,
    thick: 0.32,
    rMin: 0.35,
    slab: 0.5,
    erode: 2,
  },
  {
    id: 'maple',
    prim: '_leaves',
    tint: 'maple',
    seedBase: 777, // same patches as 'broadleaf', recoloured
    gain: 1.25,
    gltf: '.asset-cache/polyhaven/models/tree_small_02/2k/tree_small_02_2k.gltf',
    band: [0.35, 0.75],
    across: 0.4,
    along: 0.45,
    thick: 0.32,
    rMin: 0.35,
    slab: 0.5,
    erode: 2,
  },
];

interface Twig {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
  albedo: Uint8Array;
  normal: Uint8Array;
}

async function loadTwig(file: string, sp: Species): Promise<Twig> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(join(ROOT, file));
  const mesh = doc.getRoot().listMeshes()[0]!;
  const prim = mesh.listPrimitives().find((p) => p.getMaterial()?.getName().endsWith(sp.prim));
  if (!prim) throw new Error('no ' + sp.prim + ' primitive in ' + file);
  const mat = prim.getMaterial()!;
  const arr = (n: string) => prim.getAttribute(n)!.getArray()!;
  return {
    pos: arr('POSITION') as Float32Array,
    nrm: arr('NORMAL') as Float32Array,
    uv: arr('TEXCOORD_0') as Float32Array,
    idx: Uint32Array.from(prim.getIndices()!.getArray()!),
    albedo: mat.getBaseColorTexture()!.getImage()!,
    normal: mat.getNormalTexture()!.getImage()!,
  };
}

interface Components {
  count: number;
  /** vertex -> component (-1 if unused) */
  of: Int32Array;
  centroid: Float32Array;
}

function components(t: Twig): Components {
  const n = t.pos.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]!]!;
      a = parent[a]!;
    }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const used = new Uint8Array(n);
  for (let i = 0; i < t.idx.length; i += 3) {
    const a = t.idx[i]!;
    const b = t.idx[i + 1]!;
    const c = t.idx[i + 2]!;
    used[a] = used[b] = used[c] = 1;
    union(a, b);
    union(b, c);
  }
  const rootToId = new Int32Array(n).fill(-1);
  const of = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const r = find(i);
    if (rootToId[r]! < 0) rootToId[r] = count++;
    of[i] = rootToId[r]!;
  }
  const sum = new Float64Array(count * 3);
  const cnt = new Float64Array(count);
  for (let i = 0; i < n; i++) {
    const c = of[i]!;
    if (c < 0) continue;
    sum[c * 3]! += t.pos[i * 3]!;
    sum[c * 3 + 1]! += t.pos[i * 3 + 1]!;
    sum[c * 3 + 2]! += t.pos[i * 3 + 2]!;
    cnt[c] = cnt[c]! + 1;
  }
  const centroid = new Float32Array(count * 3);
  for (let c = 0; c < count; c++)
    for (let k = 0; k < 3; k++) centroid[c * 3 + k] = sum[c * 3 + k]! / cnt[c]!;
  return { count, of, centroid };
}

/** Principal axes of points (power iteration + deflation). */
function pca(pts: V3[]): [V3, V3, V3] {
  const m: V3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) m[k] = m[k]! + p[k]! / pts.length;
  const c = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ] as number[][];
  for (const p of pts)
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) c[i]![j]! += ((p[i]! - m[i]!) * (p[j]! - m[j]!)) / pts.length;
  const eig = (seed: V3): [V3, number] => {
    let v = seed;
    let l = 0;
    for (let it = 0; it < 60; it++) {
      const w: V3 = [
        c[0]![0]! * v[0] + c[0]![1]! * v[1] + c[0]![2]! * v[2],
        c[1]![0]! * v[0] + c[1]![1]! * v[1] + c[1]![2]! * v[2],
        c[2]![0]! * v[0] + c[2]![1]! * v[1] + c[2]![2]! * v[2],
      ];
      l = Math.hypot(w[0], w[1], w[2]);
      if (l < 1e-12) break;
      v = norm(w);
    }
    return [v, l];
  };
  const [e1, l1] = eig([1, 0.3, 0.2]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i]![j]! -= l1 * e1[i]! * e1[j]!;
  let [e2] = eig([0.2, 1, 0.3]);
  e2 = norm([
    e2[0] - dot(e2, e1) * e1[0],
    e2[1] - dot(e2, e1) * e1[1],
    e2[2] - dot(e2, e1) * e1[2],
  ]);
  return [e1, e2, cross(e1, e2)];
}

interface Frame {
  c: V3;
  u: V3;
  v: V3;
  n: V3;
}

/** Choose a patch (set of whole components) around an outer branch tip at azimuth `theta`. */
function pickPatch(
  t: Twig,
  comp: Components,
  sp: Species,
  theta: number,
  bandT: number,
  yRange: [number, number],
): { sel: Uint8Array; frame: Frame } {
  const cen = (i: number): V3 => [
    comp.centroid[i * 3]!,
    comp.centroid[i * 3 + 1]!,
    comp.centroid[i * 3 + 2]!,
  ];
  const y0 = yRange[0] + (yRange[1] - yRange[0]) * (sp.band[0] + (sp.band[1] - sp.band[0]) * bandT);
  const dir: V3 = [Math.cos(theta), 0, Math.sin(theta)];
  // Candidates: cards in a height slab and azimuth sector; tip = mean of the farthest few.
  const cand: { r: number; i: number }[] = [];
  for (let i = 0; i < comp.count; i++) {
    const p = cen(i);
    if (Math.abs(p[1] - y0) > (sp.slab ?? 0.6)) continue;
    const r = p[0] * dir[0] + p[2] * dir[2];
    if (r < (sp.rMin ?? 0.5)) continue;
    const lateral = Math.abs(p[0] * -dir[2] + p[2] * dir[0]);
    if (lateral > 0.6) continue;
    cand.push({ r, i });
  }
  cand.sort((a, b) => b.r - a.r);
  const top = cand.slice(0, Math.max(8, Math.floor(cand.length * 0.02)));
  const tip: V3 = [0, 0, 0];
  for (const c of top) for (let k = 0; k < 3; k++) tip[k] = tip[k]! + cen(c.i)[k]! / top.length;

  let v: V3 = dir;
  let center: V3 = [tip[0] - dir[0] * sp.along * 0.8, tip[1], tip[2] - dir[2] * sp.along * 0.8];
  let u: V3 = norm(cross(v, [0, 1, 0]));
  let n: V3 = norm(cross(u, v));
  const sel = new Uint8Array(comp.count);
  for (let iter = 0; iter < 3; iter++) {
    sel.fill(0);
    const pts: V3[] = [];
    for (let i = 0; i < comp.count; i++) {
      const p = cen(i);
      const d: V3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
      const lu = dot(d, u) / sp.across;
      const lv = dot(d, v) / sp.along;
      const ln = dot(d, n) / sp.thick;
      // Pointed oval along the branch: width tapers toward the tip (v > 0).
      const taper = lv > 0 ? 1 - 0.55 * lv : 1;
      const w = Math.abs(lu) / Math.max(0.3, taper);
      if (w * w + lv * lv * 0.85 + ln * ln < 1) {
        sel[i] = 1;
        pts.push(p);
      }
    }
    if (pts.length < 20) break;
    const [e1, e2, e3] = pca(pts);
    v = e1[0] * dir[0] + e1[2] * dir[2] < 0 ? [-e1[0], -e1[1], -e1[2]] : e1;
    n = e3[1] < 0 ? [-e3[0], -e3[1], -e3[2]] : e3;
    u = norm(cross(v, n));
    void e2;
    n = norm(cross(u, v));
    const mean: V3 = [0, 0, 0];
    for (const p of pts) for (let k = 0; k < 3; k++) mean[k] = mean[k]! + p[k]! / pts.length;
    // Re-centre on the patch but keep it anchored toward the tip.
    center = [(mean[0] + center[0]) / 2, (mean[1] + center[1]) / 2, (mean[2] + center[2]) / 2];
  }
  void t;
  return { sel, frame: { c: center, u, v, n } };
}

interface PatchGeo {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
  min: V3;
  max: V3;
  tris: number;
}

function extractPatch(t: Twig, comp: Components, sel: Uint8Array, f: Frame): PatchGeo {
  const map = new Int32Array(t.pos.length / 3).fill(-1);
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  const take = (i: number): number => {
    let m = map[i]!;
    if (m >= 0) return m;
    m = pos.length / 3;
    map[i] = m;
    const p: V3 = [t.pos[i * 3]! - f.c[0], t.pos[i * 3 + 1]! - f.c[1], t.pos[i * 3 + 2]! - f.c[2]];
    const q: V3 = [dot(p, f.u), dot(p, f.v), dot(p, f.n)];
    pos.push(...q);
    const nn: V3 = [t.nrm[i * 3]!, t.nrm[i * 3 + 1]!, t.nrm[i * 3 + 2]!];
    nrm.push(dot(nn, f.u), dot(nn, f.v), dot(nn, f.n));
    uv.push(t.uv[i * 2]!, t.uv[i * 2 + 1]!);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, q[k]!);
      max[k] = Math.max(max[k]!, q[k]!);
    }
    return m;
  };
  for (let i = 0; i < t.idx.length; i += 3) {
    const a = t.idx[i]!;
    if (!sel[comp.of[a]!]) continue;
    idx.push(take(a), take(t.idx[i + 1]!), take(t.idx[i + 2]!));
  }
  return {
    pos: new Float32Array(pos),
    nrm: new Float32Array(nrm),
    uv: new Float32Array(uv),
    idx: Uint32Array.from(idx),
    min,
    max,
    tris: idx.length / 3,
  };
}

async function patchGlb(t: Twig, g: PatchGeo): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC2' | 'SCALAR', arr: Float32Array | Uint32Array) =>
    doc
      .createAccessor()
      .setType(type)
      .setArray(arr as Float32Array<ArrayBuffer>)
      .setBuffer(buf);
  const albedo = doc.createTexture('albedo').setImage(t.albedo).setMimeType('image/jpeg');
  const normal = doc.createTexture('normal').setImage(t.normal).setMimeType('image/jpeg');
  const mat = doc
    .createMaterial('twig')
    .setBaseColorTexture(albedo)
    .setNormalTexture(normal)
    .setDoubleSided(true);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', acc('VEC3', g.pos))
    .setAttribute('NORMAL', acc('VEC3', g.nrm))
    .setAttribute('TEXCOORD_0', acc('VEC2', g.uv))
    .setIndices(acc('SCALAR', g.idx))
    .setMaterial(mat);
  const mesh = doc.createMesh('patch').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('patch').setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

// ---- image helpers ---------------------------------------------------------------------------

interface Img {
  w: number;
  h: number;
  d: Uint8Array;
}

async function decode(dataUrl: string): Promise<Img> {
  const b = Buffer.from(dataUrl.split(',')[1]!, 'base64');
  const { data, info } = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, d: new Uint8Array(data) };
}

/** Box-downsample by SS; colour weighted by alpha (alpha channel of the normal image is ignored). */
function downsample(img: Img, f: number, alphaWeighted: boolean): Img {
  const w = img.w / f;
  const h = img.h / f;
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let j = 0; j < f; j++)
        for (let i = 0; i < f; i++) {
          const p = ((y * f + j) * img.w + x * f + i) * 4;
          const al = img.d[p + 3]! / 255;
          const wt = alphaWeighted ? al : 1;
          r += img.d[p]! * wt;
          g += img.d[p + 1]! * wt;
          b += img.d[p + 2]! * wt;
          a += al;
          wsum += wt;
        }
      const o = (y * w + x) * 4;
      const k = wsum > 0 ? 1 / wsum : 0;
      d[o] = r * k;
      d[o + 1] = g * k;
      d[o + 2] = b * k;
      d[o + 3] = (a / (f * f)) * 255;
    }
  return { w, h, d };
}

/** Fatten thin needle coverage so it survives mip-mapping + alpha test (denser read at distance). */
function thickenAlpha(img: Img): void {
  const a = new Float32Array(img.w * img.h);
  for (let i = 0; i < a.length; i++) a[i] = img.d[i * 4 + 3]! / 255;
  for (let pass = 0; pass < 1; pass++) {
    const o = new Float32Array(a.length);
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x < img.w; x++) {
        let s = 0;
        let mx = 0;
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            const xx = Math.min(img.w - 1, Math.max(0, x + i));
            const yy = Math.min(img.h - 1, Math.max(0, y + j));
            const v = a[yy * img.w + xx]!;
            s += v;
            mx = Math.max(mx, v);
          }
        o[y * img.w + x] = Math.min(1, (s / 9) * 0.5 + mx * 0.5 + (s / 9) * 0.35);
      }
    a.set(o);
  }
  for (let i = 0; i < a.length; i++) img.d[i * 4 + 3] = Math.min(255, a[i]! * 255 * 1.1);
}

/** Fill texels where mask is false with the mean of the nearest filled neighbours (iterative). */
function dilate(img: Img, mask: Uint8Array, iterations: number): void {
  const filled = Uint8Array.from(mask);
  for (let it = 0; it < iterations; it++) {
    const add: number[] = [];
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x < img.w; x++) {
        const i = y * img.w + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++) {
            const xx = x + k;
            const yy = y + j;
            if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue;
            const q = yy * img.w + xx;
            if (!filled[q]) continue;
            r += img.d[q * 4]!;
            g += img.d[q * 4 + 1]!;
            b += img.d[q * 4 + 2]!;
            c++;
          }
        if (c > 0) add.push(i, r / c, g / c, b / c);
      }
    if (add.length === 0) break;
    for (let k = 0; k < add.length; k += 4) {
      const i = add[k]!;
      img.d[i * 4] = add[k + 1]!;
      img.d[i * 4 + 1] = add[k + 2]!;
      img.d[i * 4 + 2] = add[k + 3]!;
      filled[i] = 1;
    }
  }
}

/** Green leaf -> red/orange maple foliage. Luminance (shading, veins) is kept; hue varies per leaf
 * (value noise at leaf scale) from crimson through red-orange to amber, saturation rises, veins and
 * stems keep a lighter, slightly yellower tone. */
function mapleTint(img: Img, seed: number): void {
  const hash = (x: number, y: number): number => {
    let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const noise = (x: number, y: number, cell: number): number => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash(x0, y0) * (1 - sx) + hash(x0 + 1, y0) * sx;
    const b = hash(x0, y0 + 1) * (1 - sx) + hash(x0 + 1, y0 + 1) * sx;
    return a * (1 - sy) + b * sy;
  };
  // sRGB (0..1) palette: deep crimson -> red -> red-orange -> amber, picked per leaf/branch by noise.
  const pal: V3[] = [
    [0.5, 0.07, 0.09],
    [0.68, 0.1, 0.08],
    [0.8, 0.22, 0.07],
    [0.82, 0.4, 0.1],
  ];
  const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let lsum = 0;
  let cnt = 0;
  for (let i = 0; i < img.w * img.h; i++)
    if (img.d[i * 4 + 3]! > 200) {
      lsum += lum(img.d[i * 4]! / 255, img.d[i * 4 + 1]! / 255, img.d[i * 4 + 2]! / 255);
      cnt++;
    }
  const lAvg = lsum / Math.max(1, cnt);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const o = (y * img.w + x) * 4;
      const r = img.d[o]! / 255;
      const g = img.d[o + 1]! / 255;
      const b = img.d[o + 2]! / 255;
      const l0 = lum(r, g, b);
      const n = Math.min(
        0.999,
        Math.max(0, 0.5 * noise(x, y, 70) + 0.3 * noise(x, y, 260) + 0.2 * noise(x, y, 24)),
      );
      const f = Math.min(2.999, Math.max(0, (n - 0.2) / 0.6) * 3);
      const i0 = Math.floor(f);
      const t = f - i0;
      const c0 = pal[i0]!;
      const c1 = pal[Math.min(3, i0 + 1)]!;
      // Shade from the scan luminance (leaf blade shading, veins), gamma-ish so darks stay rich.
      const sh = Math.min(1.45, Math.max(0.3, Math.pow(l0 / lAvg, 0.9)));
      // Veins/stems are lighter and yellower than the blade: tint toward amber.
      const vein = Math.max(0, Math.min(1, (g - b) / Math.max(0.05, g + b + r) - 0.15) * 2) * 0.5;
      for (let k = 0; k < 3; k++) {
        const base = c0[k]! * (1 - t) + c1[k]! * t;
        const v = base * sh * (1 - vein) + (pal[3]![k]! * 1.1 + 0.05) * vein * Math.min(1.2, sh);
        img.d[o + k] = Math.max(0, Math.min(255, v * 255));
      }
    }
}

/** Density x connectedness of a tile's coverage: rewards full sprays, punishes fragments. */
function patchScore(img: Img, x0: number, y0: number, x1: number, y1: number): number {
  const C = 8;
  const gw = img.w / C;
  const on = new Uint8Array(gw * gw);
  let covered = 0;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      if (img.d[(y * img.w + x) * 4 + 3]! >= 128) {
        on[((y / C) | 0) * gw + ((x / C) | 0)] = 1;
        covered++;
      }
  const bboxArea = (x1 - x0 + 1) * (y1 - y0 + 1);
  const thick = new Uint8Array(on.length);
  for (let y = 0; y < gw; y++)
    for (let x = 0; x < gw; x++)
      if (on[y * gw + x])
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            const xx = x + i;
            const yy = y + j;
            if (xx >= 0 && yy >= 0 && xx < gw && yy < gw) thick[yy * gw + xx] = 1;
          }
  const seen = new Uint8Array(on.length);
  let best = 0;
  let total = 0;
  for (let s = 0; s < thick.length; s++) {
    if (!thick[s]) continue;
    total++;
  }
  for (let s = 0; s < thick.length; s++) {
    if (!thick[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let n = 0;
    while (stack.length) {
      const q = stack.pop()!;
      n++;
      const qx = q % gw;
      const qy = (q / gw) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const xx = qx + dx;
        const yy = qy + dy;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gw) continue;
        const r = yy * gw + xx;
        if (thick[r] && !seen[r]) {
          seen[r] = 1;
          stack.push(r);
        }
      }
    }
    best = Math.max(best, n);
  }
  const conn = total > 0 ? best / total : 0;
  return (covered / bboxArea) * conn * conn * Math.sqrt(bboxArea / (img.w * img.h));
}

// ---- static server + browser -----------------------------------------------------------------

function startServer(tmp: Map<string, Uint8Array>): Promise<{ server: Server; port: number }> {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.glb': 'model/gltf-binary',
  };
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    let body: Uint8Array | undefined;
    if (url.startsWith('/tmp/')) body = tmp.get(url.slice(5));
    else {
      const rel = url === '/' ? 'index.html' : url.slice(1);
      const base = rel.startsWith('three/') ? join(ROOT, 'node_modules') : PAGE_DIR;
      const p = normalize(join(base, rel));
      if (p.startsWith(base) && existsSync(p)) body = readFileSync(p);
    }
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type':
        types[extname(url === '/' ? 'index.html' : url)] ?? 'application/octet-stream',
    });
    res.end(body);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    ),
  );
}

// ---- main ------------------------------------------------------------------------------------

function writeHashed(dir: string, name: string, data: Uint8Array): string {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
  const abs = join(PACK, dir);
  mkdirSync(abs, { recursive: true });
  const file = `${name}.${hash}.ktx2`;
  if (!existsSync(join(abs, file))) writeFileSync(join(abs, file), data);
  return `/pack/${dir}/${file}`;
}

const imageDecoder = async (buffer: Uint8Array) => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

interface FoliageEntry {
  albedo: string;
  normal: string;
  rects: [number, number, number, number][];
  aspect: number[];
  bytes: number;
}

async function bakeSpecies(
  sp: Species,
  page: import('playwright').Page,
  port: number,
  tmp: Map<string, Uint8Array>,
): Promise<FoliageEntry | null> {
  console.log(`[${sp.id}] loading scan…`);
  const t = await loadTwig(sp.gltf, sp);
  const comp = components(t);
  console.log(`[${sp.id}] ${t.idx.length / 3} tris, ${comp.count} cards`);
  let ymin = Infinity;
  let ymax = -Infinity;
  for (let i = 0; i < comp.count; i++) {
    ymin = Math.min(ymin, comp.centroid[i * 3 + 1]!);
    ymax = Math.max(ymax, comp.centroid[i * 3 + 1]!);
  }

  const rng = new Rng(sp.seedBase);
  const N = 4;
  const M = 14; // candidates; the best N by coverage score go into the atlas
  const cands: { score: number; alb: Img; nor: Img; box: [number, number, number, number] }[] = [];
  const atlasA = { w: TILE * 2, h: TILE * 2, d: new Uint8Array(TILE * 2 * TILE * 2 * 4) };
  const atlasN = { w: TILE * 2, h: TILE * 2, d: new Uint8Array(TILE * 2 * TILE * 2 * 4) };
  const rects: [number, number, number, number][] = [];
  const aspect: number[] = [];

  for (let k = 0; k < M; k++) {
    const theta = ((k + rng.range(-0.2, 0.2)) / M) * Math.PI * 2 + 0.4;
    const { sel, frame } = pickPatch(t, comp, sp, theta, (k % 2) * 0.6 + rng.range(0, 0.4), [
      ymin,
      ymax,
    ]);
    const g = extractPatch(t, comp, sel, frame);
    console.log(
      `[${sp.id}] patch ${k}: ${g.tris} tris, size ${(g.max[0] - g.min[0]).toFixed(2)} x ${(g.max[1] - g.min[1]).toFixed(2)} x ${(g.max[2] - g.min[2]).toFixed(2)} m`,
    );
    const w = g.max[0] - g.min[0];
    const h = g.max[1] - g.min[1];
    const scale = (TILE - MARGIN * 2) / Math.max(w, h); // px per metre
    const extent = TILE / scale;
    const name = `${sp.id}-${k}.glb`;
    tmp.set(name, await patchGlb(t, g));
    const out = (await page.evaluate(
      async ([url, o]) =>
        (
          window as unknown as {
            bake: (u: string, o: unknown) => Promise<{ albedo: string; normal: string }>;
          }
        ).bake(url as string, o),
      [
        `http://127.0.0.1:${port}/tmp/${name}`,
        {
          cx: (g.min[0] + g.max[0]) / 2,
          cy: (g.min[1] + g.max[1]) / 2,
          extent,
          size: TILE * SS,
          zMin: g.min[2],
          zMax: g.max[2],
          dark: 0.6,
        },
      ] as const,
    )) as { albedo: string; normal: string };
    const alb = downsample(await decode(out.albedo), SS, true);
    const nor = downsample(await decode(out.normal), SS, false);
    // Colour is only trusted where coverage is (nearly) full: re-fill the rest from inside.
    const mask = new Uint8Array(TILE * TILE);
    let x0 = TILE;
    let y0 = TILE;
    let x1 = 0;
    let y1 = 0;
    for (let i = 0; i < TILE * TILE; i++) {
      const a = alb.d[i * 4 + 3]!;
      if (a >= 235) mask[i] = 1;
      if (a >= 128) {
        const x = i % TILE;
        const y = (i / TILE) | 0;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    for (let e = 0; e < (sp.erode ?? 0); e++) {
      const src = Uint8Array.from(mask);
      for (let y = 1; y < TILE - 1; y++)
        for (let x = 1; x < TILE - 1; x++) {
          const i = y * TILE + x;
          if (src[i] && !(src[i - 1] && src[i + 1] && src[i - TILE] && src[i + TILE])) mask[i] = 0;
        }
    }
    dilate(alb, mask, 24);
    dilate(nor, mask, 24);
    thickenAlpha(alb);
    for (let i = 0; i < TILE * TILE; i++)
      for (let c = 0; c < 3; c++) alb.d[i * 4 + c] = Math.min(255, alb.d[i * 4 + c]! * sp.gain);
    if (sp.tint === 'maple') mapleTint(alb, sp.seedBase);
    // Renormalise normals.
    for (let i = 0; i < TILE * TILE; i++) {
      const nx = (nor.d[i * 4]! / 255) * 2 - 1;
      const ny = (nor.d[i * 4 + 1]! / 255) * 2 - 1;
      const nz = (nor.d[i * 4 + 2]! / 255) * 2 - 1;
      const l = Math.hypot(nx, ny, nz) || 1;
      nor.d[i * 4] = ((nx / l) * 0.5 + 0.5) * 255;
      nor.d[i * 4 + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      nor.d[i * 4 + 2] = ((nz / l) * 0.5 + 0.5) * 255;
      nor.d[i * 4 + 3] = 255;
    }
    // Soften the very noisy scan card normals (they are blended with a proxy normal at runtime).
    for (let i = 0; i < TILE * TILE; i++) {
      for (let c = 0; c < 2; c++) nor.d[i * 4 + c] = 128 + (nor.d[i * 4 + c]! - 128) * 0.5;
    }
    const score = patchScore(alb, x0, y0, x1, y1);
    console.log(`[${sp.id}]   score ${score.toFixed(3)}`);
    cands.push({ score, alb, nor, box: [x0, y0, x1, y1] });
  }
  cands.sort((a, b) => b.score - a.score);
  for (let k = 0; k < N; k++) {
    const { alb, nor, box } = cands[k]!;
    const [x0, y0, x1, y1] = box;
    const ox = (k % 2) * TILE;
    const oy = Math.floor(k / 2) * TILE;
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const s = (y * TILE + x) * 4;
        const d = ((oy + y) * atlasA.w + ox + x) * 4;
        for (let c = 0; c < 4; c++) {
          atlasA.d[d + c] = alb.d[s + c]!;
          atlasN.d[d + c] = nor.d[s + c]!;
        }
      }
    // Rect in texture space (v from the top row, i.e. KTX2 / flipY=false). Branch base at bottom.
    rects.push([
      (ox + x0) / atlasA.w,
      (oy + y0) / atlasA.h,
      (ox + x1 + 1) / atlasA.w,
      (oy + y1 + 1) / atlasA.h,
    ]);
    aspect.push((x1 + 1 - x0) / (y1 + 1 - y0));
  }

  mkdirSync(CACHE, { recursive: true });
  const png = (a: Img) =>
    sharp(Buffer.from(a.d), { raw: { width: a.w, height: a.h, channels: 4 } })
      .png()
      .toBuffer();
  const albPng = await png(atlasA);
  const norPng = await png(atlasN);
  writeFileSync(join(CACHE, `${sp.id}-albedo.png`), albPng);
  writeFileSync(join(CACHE, `${sp.id}-normal.png`), norPng);
  // Preview over a mid-green background for inspection.
  await sharp({
    create: {
      width: atlasA.w,
      height: atlasA.h,
      channels: 3,
      background: { r: 120, g: 150, b: 190 },
    },
  })
    .composite([{ input: albPng }])
    .png()
    .toFile(join(CACHE, `${sp.id}-albedo-preview.png`));
  if (pngOnly) return null;

  const kAlb = await encodeToKTX2(new Uint8Array(albPng), {
    isUASTC: false,
    qualityLevel: 200,
    compressionLevel: 2,
    generateMipmap: true,
    isPerceptual: true,
    isSetKTX2SRGBTransferFunc: true,
    imageDecoder,
  });
  const kNor = await encodeToKTX2(new Uint8Array(norPng), {
    isUASTC: true,
    isNormalMap: true,
    needSupercompression: true,
    generateMipmap: true,
    isPerceptual: false,
    imageDecoder,
  });
  const dir = `foliage/${sp.id}`;
  const entry: FoliageEntry = {
    albedo: writeHashed(dir, 'albedo', kAlb),
    normal: writeHashed(dir, 'normal', kNor),
    rects,
    aspect,
    bytes: kAlb.byteLength + kNor.byteLength,
  };
  console.log(`[${sp.id}] ✓ ${(entry.bytes / 1024).toFixed(0)} KB`, JSON.stringify(rects), aspect);
  return entry;
}

async function main(): Promise<void> {
  const tmp = new Map<string, Uint8Array>();
  const { server, port } = await startServer(tmp);
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const results: Record<string, FoliageEntry> = {};
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.log('[page]', m.text());
    });
    page.on('pageerror', (e) => console.log('[page error]', e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(
      () => (window as unknown as { bakeReady?: boolean }).bakeReady === true,
    );
    for (const sp of SPECIES) {
      if (only && sp.id !== only) continue;
      const e = await bakeSpecies(sp, page, port, tmp);
      if (e) results[sp.id] = e;
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (Object.keys(results).length === 0) return;
  const manifestPath = join(PACK, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.foliage = { ...((manifest.foliage as object | undefined) ?? {}), ...results };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
  console.log('manifest.json updated (foliage)');
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
