// Bake the tropical foliage atlases used by src/engine/scatter/tropical.ts.
//
//   npm run assets:bake-tropical [-- --png-only] [--candidates]
//
// "tropical" (2048^2): single leaves flattened from Poly Haven plant scans (calathea, anthurium,
//   fern; CC0). Each scan leaf is a separate mesh component: we orient it by PCA (petiole at the
//   bottom, upper surface toward the camera), render it orthographically in headless Chromium and
//   pack albedo+alpha / tangent normal into one atlas. A monstera leaf is derived from a calathea
//   leaf (stripes muted, fenestrations cut).
// "bamboo-leaf" (2048^2): procedurally drawn lanceolate bamboo-leaf sprays and palm leaflet fans
//   (SVG -> sharp, with a derived normal map), since no CC0 bamboo/palm scan exists.
//
// Output: public/pack/foliage/{tropical,bamboo-leaf}/ + manifest.json "foliage" (new keys only) +
// assets/LICENSES.json. Needs NODE_OPTIONS=--max-old-space-size=12000 (set by the npm script).
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
import { loadLicenses, saveLicenses, upsertLicense } from './lib/licenses';
import { polyhavenInfo, polyhavenModel } from './lib/sources';
import {
  blit,
  boxBlurRgb,
  decodeDataUrl,
  dilate,
  downsample,
  imageDecoder,
  newImg,
  toPng,
  writeHashed,
  type Img,
} from './lib/tropical-img';

const ROOT = process.cwd();
const PACK = join(ROOT, 'public', 'pack');
const CACHE = join(ROOT, '.asset-cache', 'foliage');
const PAGE_DIR = join(ROOT, 'scripts', 'lib', 'bake-tropical-page');
const argv = process.argv.slice(2);
const pngOnly = argv.includes('--png-only');
const candidatesMode = argv.includes('--candidates');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;
const SS = 2;
const ATLAS = 2048;
const MARGIN = 14;

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// ---- scan leaves ---------------------------------------------------------------------------------

interface Comp {
  label: string;
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
}
interface Scan {
  id: string;
  comps: Comp[];
  albedo: Uint8Array;
  normal: Uint8Array;
}

async function loadScan(id: string): Promise<Scan> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const file = await polyhavenModel(id, '2k');
  const doc = await io.read(file);
  const comps: Comp[] = [];
  let albedo: Uint8Array | undefined;
  let normal: Uint8Array | undefined;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()!;
      albedo ??= mat.getBaseColorTexture()!.getImage()!;
      normal ??= mat.getNormalTexture()!.getImage()!;
      const pos = prim.getAttribute('POSITION')!.getArray() as Float32Array;
      const nrm = prim.getAttribute('NORMAL')!.getArray() as Float32Array;
      const uv = prim.getAttribute('TEXCOORD_0')!.getArray() as Float32Array;
      const idx = Uint32Array.from(prim.getIndices()!.getArray()!);
      const n = pos.length / 3;
      const parent = new Int32Array(n);
      for (let i = 0; i < n; i++) parent[i] = i;
      const find = (a: number): number => {
        while (parent[a] !== a) {
          parent[a] = parent[parent[a]!]!;
          a = parent[a]!;
        }
        return a;
      };
      for (let i = 0; i < idx.length; i += 3) {
        parent[find(idx[i]!)] = find(idx[i + 1]!);
        parent[find(idx[i + 1]!)] = find(idx[i + 2]!);
      }
      const byRoot = new Map<number, number[]>();
      for (let i = 0; i < idx.length; i += 3) {
        const r = find(idx[i]!);
        let l = byRoot.get(r);
        if (!l) byRoot.set(r, (l = []));
        l.push(i);
      }
      let k = 0;
      for (const tris of byRoot.values()) {
        const map = new Map<number, number>();
        const p: number[] = [];
        const nn: number[] = [];
        const u: number[] = [];
        const ix: number[] = [];
        const take = (v: number): number => {
          let m = map.get(v);
          if (m === undefined) {
            m = p.length / 3;
            map.set(v, m);
            p.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
            nn.push(nrm[v * 3]!, nrm[v * 3 + 1]!, nrm[v * 3 + 2]!);
            u.push(uv[v * 2]!, uv[v * 2 + 1]!);
          }
          return m;
        };
        for (const t of tris) ix.push(take(idx[t]!), take(idx[t + 1]!), take(idx[t + 2]!));
        comps.push({
          label: `${node.getName()}#${k++}`,
          pos: new Float32Array(p),
          nrm: new Float32Array(nn),
          uv: new Float32Array(u),
          idx: Uint32Array.from(ix),
        });
      }
    }
  }
  return { id, comps, albedo: albedo!, normal: normal! };
}

interface Framed {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  idx: Uint32Array;
  min: V3;
  max: V3;
}

/**
 * Leaf frame, built from the scan's own UV layout: the scans' UV islands are flat, undistorted
 * leaves, so rendering in UV space "unrolls" the 3D curvature (a plain projection of a curled
 * leaf bends the whole blade into a banana). x = across, y = base -> tip, z toward the camera.
 */
function frameComp(c: Comp): Framed {
  const n = c.pos.length / 3;
  // Metric scale (m per uv unit) from 3D vs UV triangle area.
  let a3 = 0;
  let a2 = 0;
  for (let t = 0; t < c.idx.length; t += 3) {
    const i = c.idx[t]!;
    const j = c.idx[t + 1]!;
    const k = c.idx[t + 2]!;
    const p = (q: number): V3 => [c.pos[q * 3]!, c.pos[q * 3 + 1]!, c.pos[q * 3 + 2]!];
    const A = p(i);
    const B = p(j);
    const C = p(k);
    const cr = cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]);
    a3 += Math.hypot(cr[0], cr[1], cr[2]) / 2;
    const ux = c.uv[j * 2]! - c.uv[i * 2]!;
    const uy = c.uv[j * 2 + 1]! - c.uv[i * 2 + 1]!;
    const vx = c.uv[k * 2]! - c.uv[i * 2]!;
    const vy = c.uv[k * 2 + 1]! - c.uv[i * 2 + 1]!;
    a2 += Math.abs(ux * vy - uy * vx) / 2;
  }
  const sc = Math.sqrt(a3 / Math.max(1e-12, a2));
  // Base = closest to the plant origin (leaves grow out of (0, 0, 0)); tip = farthest.
  let base = 0;
  let tip = 0;
  let bd = Infinity;
  let td = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(c.pos[i * 3]!, c.pos[i * 3 + 1]! * 0.5, c.pos[i * 3 + 2]!);
    if (d < bd) {
      bd = d;
      base = i;
    }
    if (d > td) {
      td = d;
      tip = i;
    }
  }
  const bx = c.uv[base * 2]!;
  const by = -c.uv[base * 2 + 1]!;
  const dx = c.uv[tip * 2]! - bx;
  const dy = -c.uv[tip * 2 + 1]! - by;
  const ang = Math.PI / 2 - Math.atan2(dy, dx); // rotate tip direction onto +y
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = (c.uv[i * 2]! - bx) * sc;
    const y = (-c.uv[i * 2 + 1]! - by) * sc;
    const q: V3 = [x * ca - y * sa, x * sa + y * ca, 0];
    pos.set(q, i * 3);
    nrm.set([0, 0, 1], i * 3);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, q[k]!);
      max[k] = Math.max(max[k]!, q[k]!);
    }
  }
  return { pos, nrm, uv: c.uv, idx: c.idx, min, max };
}

async function framedGlb(s: Scan, g: Framed): Promise<Uint8Array> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC2' | 'SCALAR', arr: Float32Array | Uint32Array) =>
    doc
      .createAccessor()
      .setType(type)
      .setArray(arr as Float32Array<ArrayBuffer>)
      .setBuffer(buf);
  const albedo = doc.createTexture('albedo').setImage(s.albedo).setMimeType('image/jpeg');
  const normal = doc.createTexture('normal').setImage(s.normal).setMimeType('image/jpeg');
  const mat = doc
    .createMaterial('leaf')
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
  const mesh = doc.createMesh('leaf').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('leaf').setMesh(mesh));
  return new NodeIO().writeBinary(doc);
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

interface Renderer {
  page: import('playwright').Page;
  port: number;
  tmp: Map<string, Uint8Array>;
}

/** Render a framed leaf into square albedo+normal images of `size` px; `scale` = px per metre. */
async function renderLeaf(
  r: Renderer,
  s: Scan,
  g: Framed,
  name: string,
  size: number,
  scale: number,
  center: [number, number],
): Promise<{ alb: Img; nor: Img }> {
  r.tmp.set(name, await framedGlb(s, g));
  const out = (await r.page.evaluate(
    async ([url, o]) =>
      (
        window as unknown as {
          bake: (u: string, o: unknown) => Promise<{ albedo: string; normal: string }>;
        }
      ).bake(url as string, o),
    [
      `http://127.0.0.1:${r.port}/tmp/${name}`,
      {
        cx: center[0],
        cy: center[1],
        extent: size / scale,
        size,
        zMin: g.min[2],
        zMax: g.max[2],
        dark: 1,
      },
    ] as const,
  )) as { albedo: string; normal: string };
  return { alb: await decodeDataUrl(out.albedo), nor: await decodeDataUrl(out.normal) };
}

async function candidateSheets(r: Renderer, scans: Scan[]): Promise<void> {
  const T = 256;
  mkdirSync(CACHE, { recursive: true });
  for (const s of scans) {
    const cols = 8;
    const rows = Math.ceil(s.comps.length / cols);
    const sheet = newImg(cols * T, rows * T);
    const labels: string[] = [];
    for (let i = 0; i < s.comps.length; i++) {
      const g = frameComp(s.comps[i]!);
      const w = g.max[0] - g.min[0];
      const h = g.max[1] - g.min[1];
      const scale = (T - 16) / Math.max(w, h);
      const { alb } = await renderLeaf(
        r,
        s,
        g,
        `c${i}.glb`,
        T,
        scale,
        [(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2],
      );
      // composite on blue-grey
      for (let p = 0; p < T * T; p++) {
        const a = alb.d[p * 4 + 3]! / 255;
        for (let c = 0; c < 3; c++)
          alb.d[p * 4 + c] = alb.d[p * 4 + c]! * a + [110, 140, 200][c]! * (1 - a);
        alb.d[p * 4 + 3] = 255;
      }
      blit(sheet, alb, (i % cols) * T, Math.floor(i / cols) * T);
      labels.push(
        `<text x="${(i % cols) * T + 6}" y="${Math.floor(i / cols) * T + 18}" font-size="18" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${i} ${(w).toFixed(2)}x${h.toFixed(2)}</text>`,
      );
    }
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}" height="${sheet.h}">${labels.join('')}</svg>`);
    await sharp(await toPng(sheet))
      .composite([{ input: svg }])
      .png()
      .toFile(join(CACHE, `tropical-cand-${s.id}.png`));
    console.log(`[${s.id}] candidates: ${s.comps.length}`);
  }
}

async function withBrowser<T>(fn: (r: Renderer) => Promise<T>): Promise<T> {
  const tmp = new Map<string, Uint8Array>();
  const { server, port } = await startServer(tmp);
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
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
    return await fn({ page, port, tmp });
  } finally {
    await browser.close();
    server.close();
  }
}

// ---- tropical atlas -------------------------------------------------------------------------------

type Rect = [number, number, number, number]; // px: x0, y0, x1, y1 (exclusive)
interface Cell {
  scan: string;
  comp: number;
  rect: Rect;
  gain: number;
  /** Mute the calathea stripes and cut monstera-style fenestrations. */
  monstera?: boolean;
  tint?: [number, number, number];
}

const CELLS: Cell[] = [
  { scan: 'calathea_orbifolia_01', comp: 9, rect: [0, 0, 1024, 1024], gain: 1.12 },
  { scan: 'calathea_orbifolia_01', comp: 22, rect: [1024, 0, 2048, 1024], gain: 1.0, monstera: true },
  { scan: 'anthurium_botany_01', comp: 1, rect: [0, 1024, 512, 2048], gain: 1.25 },
  { scan: 'anthurium_botany_01', comp: 4, rect: [512, 1024, 1024, 2048], gain: 1.25 },
  { scan: 'fern_02', comp: 5, rect: [1024, 1024, 1536, 2048], gain: 1.2, tint: [0.82, 1, 0.9] },
  { scan: 'fern_02', comp: 10, rect: [1536, 1024, 2048, 2048], gain: 1.2, tint: [0.82, 1, 0.9] },
];

/** Round the scan's low-poly outline and trim the pale border: blur alpha, then re-threshold. */
function smoothAlpha(img: Img, r: number, edge: number): void {
  let a = new Float32Array(img.w * img.h);
  for (let i = 0; i < a.length; i++) a[i] = img.d[i * 4 + 3]! / 255;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(a.length);
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x < img.w; x++) {
        let sum = 0;
        let n = 0;
        for (let j = -r; j <= r; j++)
          for (let i = -r; i <= r; i++) {
            const xx = Math.min(img.w - 1, Math.max(0, x + i));
            const yy = Math.min(img.h - 1, Math.max(0, y + j));
            sum += a[yy * img.w + xx]!;
            n++;
          }
        o[y * img.w + x] = sum / n;
      }
    a = o;
  }
  for (let i = 0; i < a.length; i++) {
    const t = Math.min(1, Math.max(0, (a[i]! - (edge - 0.2)) / 0.4));
    img.d[i * 4 + 3] = t * t * (3 - 2 * t) * 255;
  }
}

function normalise(nor: Img): void {
  for (let i = 0; i < nor.w * nor.h; i++) {
    const nx = ((nor.d[i * 4]! / 255) * 2 - 1) * 0.8;
    const ny = ((nor.d[i * 4 + 1]! / 255) * 2 - 1) * 0.8;
    const nz = Math.max(0.2, (nor.d[i * 4 + 2]! / 255) * 2 - 1);
    const l = Math.hypot(nx, ny, nz) || 1;
    nor.d[i * 4] = ((nx / l) * 0.5 + 0.5) * 255;
    nor.d[i * 4 + 1] = ((ny / l) * 0.5 + 0.5) * 255;
    nor.d[i * 4 + 2] = ((nz / l) * 0.5 + 0.5) * 255;
    nor.d[i * 4 + 3] = 255;
  }
}

/** Monstera look from a calathea blade: mute stripes, darken, cut slits + holes in the alpha. */
async function monsteraize(alb: Img, bbox: Rect): Promise<Img> {
  const blur = boxBlurRgb(alb, 9);
  for (let i = 0; i < alb.w * alb.h; i++)
    for (let c = 0; c < 3; c++) {
      const base = blur.d[i * 4 + c]!;
      alb.d[i * 4 + c] = Math.min(255, (alb.d[i * 4 + c]! * 0.3 + base * 0.7) * [0.8, 0.95, 0.72][c]!);
    }
  const [x0, y0, x1, y1] = bbox;
  const W = x1 - x0;
  const H = y1 - y0;
  const cx = (x0 + x1) / 2;
  const rng = new Rng(77);
  const shapes: string[] = [];
  for (const side of [-1, 1])
    for (const s of [0.2, 0.34, 0.48, 0.62, 0.76]) {
      const y = y1 - s * H + rng.range(-0.02, 0.02) * H;
      const th = (34 + 14 * (1 - s) + rng.range(-5, 5)) * (Math.PI / 180);
      const dx = Math.cos(th) * side;
      const dy = -Math.sin(th);
      const startLat = (0.22 + rng.range(0, 0.06)) * (W / 2);
      const px = cx + side * startLat;
      const len = W * rng.range(0.42, 0.6);
      const wNear = 1.2;
      const wFar = 8 + 5 * s + rng.range(0, 3);
      const nx = -dy;
      const ny = dx;
      const ex = px + dx * len;
      const ey = y + dy * len;
      shapes.push(
        `<polygon points="${px + nx * wNear},${y + ny * wNear} ${ex + nx * wFar},${ey + ny * wFar} ${ex - nx * wFar},${ey - ny * wFar} ${px - nx * wNear},${y - ny * wNear}" fill="#fff"/>`,
      );
      const hx = cx + side * (0.12 + rng.range(0, 0.04)) * W;
      const hy = y - 0.07 * H;
      shapes.push(`<ellipse cx="${hx}" cy="${hy}" rx="${3 + 3 * rng.next()}" ry="${6 + 4 * rng.next()}" fill="#fff" transform="rotate(${side * 25} ${hx} ${hy})"/>`);
    }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${alb.w}" height="${alb.h}"><rect width="100%" height="100%" fill="#000"/>${shapes.join('')}</svg>`;
  const mask = await sharp(Buffer.from(svg)).blur(1.2).grayscale().raw().toBuffer();
  for (let i = 0; i < alb.w * alb.h; i++) {
    const cut = mask[i * 1]! / 255; // grayscale -> 1 channel
    alb.d[i * 4 + 3] = alb.d[i * 4 + 3]! * (1 - Math.min(1, cut * 1.4));
  }
  return alb;
}

async function bakeTropical(r: Renderer, scans: Scan[]): Promise<{ png: Img; nor: Img; rects: Rect[]; aspect: number[] }> {
  const atlasA = newImg(ATLAS, ATLAS);
  const atlasN = newImg(ATLAS, ATLAS);
  for (let i = 0; i < ATLAS * ATLAS; i++) {
    atlasN.d[i * 4] = 128;
    atlasN.d[i * 4 + 1] = 128;
    atlasN.d[i * 4 + 2] = 255;
    atlasN.d[i * 4 + 3] = 255;
  }
  const rects: Rect[] = [];
  const aspect: number[] = [];
  for (const [k, cell] of CELLS.entries()) {
    const s = scans.find((q) => q.id === cell.scan)!;
    const g = frameComp(s.comps[cell.comp]!);
    const [rx0, ry0, rx1, ry1] = cell.rect;
    const cw = rx1 - rx0;
    const ch = ry1 - ry0;
    const w = g.max[0] - g.min[0];
    const h = g.max[1] - g.min[1];
    const scale = Math.min((cw - MARGIN * 2) / w, (ch - MARGIN * 2) / h);
    const S = Math.max(cw, ch);
    const { alb: a0, nor: n0 } = await renderLeaf(
      r,
      s,
      g,
      `t${k}.glb`,
      S * SS,
      scale * SS,
      [(g.min[0] + g.max[0]) / 2, (g.min[1] + g.max[1]) / 2],
    );
    let alb = downsample(a0, SS, true);
    const nor = downsample(n0, SS, false);
    // crop the centre cw x ch window
    const crop = (im: Img): Img => {
      const o = newImg(cw, ch);
      const ox = Math.floor((S - cw) / 2);
      const oy = Math.floor((S - ch) / 2);
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++)
          for (let c = 0; c < 4; c++) o.d[(y * cw + x) * 4 + c] = im.d[((y + oy) * S + x + ox) * 4 + c]!;
      return o;
    };
    alb = crop(alb);
    const nc = crop(nor);
    smoothAlpha(alb, 5, 0.66);
    const mask = new Uint8Array(cw * ch);
    let x0 = cw;
    let y0 = ch;
    let x1 = 0;
    let y1 = 0;
    for (let i = 0; i < cw * ch; i++) {
      const a = alb.d[i * 4 + 3]!;
      if (a >= 235) mask[i] = 1;
      if (a >= 128) {
        const x = i % cw;
        const y = (i / cw) | 0;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    dilate(alb, mask, 28);
    dilate(nc, mask, 28);
    for (let i = 0; i < cw * ch; i++)
      for (let c = 0; c < 3; c++)
        alb.d[i * 4 + c] = Math.min(255, alb.d[i * 4 + c]! * cell.gain * (cell.tint?.[c] ?? 1));
    if (cell.monstera) await monsteraize(alb, [x0, y0, x1, y1]);
    normalise(nc);
    blit(atlasA, alb, rx0, ry0);
    blit(atlasN, nc, rx0, ry0);
    rects.push([(rx0 + x0) / ATLAS, (ry0 + y0) / ATLAS, (rx0 + x1 + 1) / ATLAS, (ry0 + y1 + 1) / ATLAS]);
    aspect.push((x1 + 1 - x0) / (y1 + 1 - y0));
  }
  return { png: atlasA, nor: atlasN, rects, aspect };
}

// ---- bamboo-leaf atlas (procedural) ---------------------------------------------------------------

type Mode = 'color' | 'height';

/** One lanceolate leaf pointing up (-y) from the origin; len/wid in px. */
function leafSvg(rng: Rng, mode: Mode, len: number, wid: number, bend: number, pale = 0): string {
  const w = wid / 2;
  const b = bend;
  const half = (sx: number): string =>
    `C ${sx * w * 1.05 + b * 0.3},${-len * 0.16} ${sx * w * 1.0 + b * 0.8},${-len * 0.5} ${b},${-len}`;
  const cid = `c${Math.floor(rng.next() * 1e9)}`;
  const clip = `<clipPath id="${cid}"><path d="@@O@@"/></clipPath>`;
  const outline = `M0,0 ${half(1)} C ${-w * 1.0 + b * 0.8},${-len * 0.5} ${-w * 1.05 + b * 0.3},${-len * 0.16} 0,0 Z`;
  const clipped = (v: string): string => `<g clip-path="url(#${cid})">${v}</g>`;
  const defsClip = clip.replace('@@O@@', outline);
  if (mode === 'height') {
    const veins: string[] = [];
    for (let k = 1; k < 16; k++) {
      const t = k / 16;
      const x = b * t * t;
      const y = -len * t;
      const wt = w * Math.sin(Math.PI * Math.pow(t, 0.7)) * 0.95;
      veins.push(
        `<path d="M${x},${y} L${x + wt},${y - len * 0.07} M${x},${y} L${x - wt},${y - len * 0.07}" stroke="#6a6a6a" stroke-width="1.6" fill="none"/>`,
      );
    }
    return `${defsClip}<path d="${outline}" fill="#909090"/>${clipped(veins.join(''))}<path d="M0,0 Q${b * 0.2},${-len * 0.5} ${b},${-len}" stroke="#d0d0d0" stroke-width="${Math.max(2, wid * 0.06)}" fill="none"/>`;
  }
  const hue = 92 + rng.range(0, 16);
  const sat = 38 + rng.range(0, 14);
  const l0 = 24 + rng.range(0, 8) + pale * 10;
  const id = `g${Math.floor(rng.next() * 1e9)}`;
  const tipYellow = pale > 0 ? `<stop offset="1" stop-color="hsl(${hue - 28},${sat + 8}%,${l0 + 18}%)"/>` : `<stop offset="1" stop-color="hsl(${hue + 4},${sat - 4}%,${l0 + 5}%)"/>`;
  const veins: string[] = [];
  for (let k = 1; k < 20; k++) {
    const t = k / 20;
    const x = b * t * t;
    const y = -len * t;
    const wt = w * Math.sin(Math.PI * Math.pow(t, 0.7)) * 0.7;
    veins.push(
      `<path d="M${x},${y} L${x + wt},${y - len * 0.06} M${x},${y} L${x - wt},${y - len * 0.06}" stroke="hsl(${hue},${sat}%,${l0 + 11}%)" stroke-opacity="0.35" stroke-width="1.3" fill="none"/>`,
    );
  }
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="-1"><stop offset="0" stop-color="hsl(${hue + 6},${sat - 6}%,${l0 + 4}%)"/><stop offset="0.5" stop-color="hsl(${hue},${sat}%,${l0}%)"/>${tipYellow}</linearGradient></defs>
${defsClip}<path d="${outline}" fill="url(#${id})"/>
<path d="M0,0 ${half(-1)} L0,0 Z" fill="#000" fill-opacity="0.13"/>
${clipped(veins.join(''))}
<path d="M0,0 Q${b * 0.2},${-len * 0.5} ${b},${-len}" stroke="hsl(${hue - 4},${sat - 8}%,${l0 + 22}%)" stroke-width="${Math.max(1.6, wid * 0.05)}" fill="none" stroke-opacity="0.85"/>`;
}

interface Placed {
  x: number;
  y: number;
  rot: number;
  len: number;
  wid: number;
  bend: number;
  pale: number;
}

/** Cell layouts (1024 px square cells, base at bottom centre, tip up). */
function sprayLayout(rng: Rng, variant: number): { leaves: Placed[]; twig: string } {
  const leaves: Placed[] = [];
  const cx = 512;
  const n = variant === 0 ? 8 : 10;
  const pts: [number, number][] = [];
  const twigLen = 560 + variant * 60;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push([cx + Math.sin(t * 2.4 + variant) * 30 + t * t * 55 * (variant ? -1 : 1), 1000 - t * twigLen]);
  }
  const twig = `M${pts.map((p) => p.join(',')).join(' L')}`;
  for (let i = 0; i < n; i++) {
    const t = 0.18 + (i / n) * 0.8;
    const k = Math.min(12, Math.floor(t * 12));
    const [x, y] = pts[k]!;
    for (const side of [-1, 1]) {
      if (rng.next() < 0.18) continue;
      const rot = side * (28 + rng.range(-8, 14)) + (t > 0.8 ? side * -8 : 0);
      leaves.push({
        x,
        y,
        rot,
        len: 300 * (1 - 0.25 * Math.abs(t - 0.5)) * rng.range(0.82, 1.1),
        wid: 36 * rng.range(0.85, 1.15),
        bend: side * rng.range(14, 38),
        pale: rng.next() < 0.1 ? 1 : 0,
      });
    }
  }
  // terminal leaf pair
  const [tx, ty] = pts[12]!;
  for (const side of [-1, 1])
    leaves.push({ x: tx, y: ty, rot: side * (12 + rng.range(0, 8)), len: 250, wid: 32, bend: side * 14, pale: 0 });
  return { leaves, twig };
}

function leafletFan(rng: Rng, variant: number): Placed[] {
  const out: Placed[] = [];
  const n = variant === 0 ? 11 : 15;
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n - 0.5;
    out.push({
      x: 512 + f * 800,
      y: 1010,
      rot: f * (variant === 0 ? 14 : 18) + rng.range(-1.5, 1.5),
      len: 960 * rng.range(0.8, 1) * (1 - 0.18 * Math.abs(f)),
      wid: (variant === 0 ? 112 : 84) * rng.range(0.85, 1.1),
      bend: -f * 30 + rng.range(-8, 8),
      pale: 0,
    });
  }
  return out;
}

async function rasterSvg(svg: string, size: number): Promise<Img> {
  const { data, info } = await sharp(Buffer.from(svg), { density: 72 * (size / 1024) })
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, d: new Uint8Array(data) };
}

/** Low-frequency + fine multiplicative colour noise so vector fills read as organic. */
function grain(img: Img, seed: number): void {
  const h = (x: number, y: number, o: number): number => {
    let n = (x * 374761393 + y * 668265263 + (seed + o) * 1274126177) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const vnoise = (x: number, y: number, cell: number, o: number): number => {
    const gx = x / cell;
    const gy = y / cell;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = h(x0, y0, o);
    const b = h(x0 + 1, y0, o);
    const c = h(x0, y0 + 1, o);
    const d = h(x0 + 1, y0 + 1, o);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const n = (vnoise(x, y, 40, 1) - 0.5) * 0.22 + (vnoise(x, y, 9, 2) - 0.5) * 0.14 + (h(x, y, 3) - 0.5) * 0.06;
      const k = 1 + n;
      const i = (y * img.w + x) * 4;
      img.d[i] = Math.min(255, img.d[i]! * k);
      img.d[i + 1] = Math.min(255, img.d[i + 1]! * k);
      img.d[i + 2] = Math.min(255, img.d[i + 2]! * k);
    }
}

async function bakeBamboo(): Promise<{ png: Img; nor: Img; rects: Rect[]; aspect: number[] }> {
  const rng = new Rng(2024);
  const atlasA = newImg(ATLAS, ATLAS);
  const atlasN = newImg(ATLAS, ATLAS);
  const rects: Rect[] = [];
  const aspect: number[] = [];
  const cells: { leaves: Placed[]; twig?: string }[] = [
    sprayLayout(rng, 0),
    sprayLayout(rng, 1),
    { leaves: leafletFan(rng, 0) },
    { leaves: leafletFan(rng, 1) },
  ];
  for (const [k, cell] of cells.entries()) {
    const seed = 900 + k;
    const svgFor = (mode: Mode): string => {
      const r2 = new Rng(seed);
      const body = cell.leaves
        .map((l) => `<g transform="translate(${l.x},${l.y}) rotate(${l.rot})">${leafSvg(r2, mode, l.len, l.wid, l.bend, l.pale)}</g>`)
        .join('\n');
      const twig = cell.twig
        ? `<path d="${cell.twig}" stroke="${mode === 'color' ? '#5b4a2c' : '#a0a0a0'}" stroke-width="7" fill="none" stroke-linecap="round"/>`
        : `<path d="M60,1012 Q512,990 964,1012" stroke="${mode === 'color' ? '#6d5a34' : '#a0a0a0'}" stroke-width="14" fill="none" stroke-linecap="round"/>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${twig}${body}</svg>`;
    };
    const alb = downsample(await rasterSvg(svgFor('color'), 1024 * SS), SS, true);
    const hgt = downsample(await rasterSvg(svgFor('height'), 1024 * SS), SS, true);
    const T = 1024;
    const mask = new Uint8Array(T * T);
    let x0 = T;
    let y0 = T;
    let x1 = 0;
    let y1 = 0;
    for (let i = 0; i < T * T; i++) {
      const a = alb.d[i * 4 + 3]!;
      if (a >= 235) mask[i] = 1;
      if (a >= 128) {
        const x = i % T;
        const y = (i / T) | 0;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    dilate(alb, mask, 24);
    grain(alb, seed);
    // normal from height
    const nor = newImg(T, T);
    const hv = (x: number, y: number): number => hgt.d[(Math.min(T - 1, Math.max(0, y)) * T + Math.min(T - 1, Math.max(0, x))) * 4]! / 255;
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const dx = hv(x + 1, y) - hv(x - 1, y);
        const dy = hv(x, y + 1) - hv(x, y - 1);
        const nx = -dx * 3.2;
        const ny = dy * 3.2;
        const l = Math.hypot(nx, ny, 1);
        const o = (y * T + x) * 4;
        nor.d[o] = ((nx / l) * 0.5 + 0.5) * 255;
        nor.d[o + 1] = ((ny / l) * 0.5 + 0.5) * 255;
        nor.d[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
        nor.d[o + 3] = 255;
      }
    const ox = (k % 2) * T;
    const oy = Math.floor(k / 2) * T;
    blit(atlasA, alb, ox, oy);
    blit(atlasN, nor, ox, oy);
    rects.push([(ox + x0) / ATLAS, (oy + y0) / ATLAS, (ox + x1 + 1) / ATLAS, (oy + y1 + 1) / ATLAS]);
    aspect.push((x1 + 1 - x0) / (y1 + 1 - y0));
  }
  return { png: atlasA, nor: atlasN, rects, aspect };
}

interface FoliageEntry {
  albedo: string;
  normal: string;
  rects: Rect[];
  aspect: number[];
  bytes: number;
}

async function encodeAtlas(
  id: string,
  a: { png: Img; nor: Img; rects: Rect[]; aspect: number[] },
): Promise<FoliageEntry | null> {
  mkdirSync(CACHE, { recursive: true });
  const albPng = await toPng(a.png);
  const norPng = await toPng(a.nor);
  writeFileSync(join(CACHE, `${id}-albedo.png`), albPng);
  writeFileSync(join(CACHE, `${id}-normal.png`), norPng);
  await sharp({
    create: { width: ATLAS, height: ATLAS, channels: 3, background: { r: 120, g: 150, b: 190 } },
  })
    .composite([{ input: albPng }])
    .png()
    .toFile(join(CACHE, `${id}-albedo-preview.png`));
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
  const dir = `foliage/${id}`;
  const entry: FoliageEntry = {
    albedo: writeHashed(PACK, dir, 'albedo', kAlb),
    normal: writeHashed(PACK, dir, 'normal', kNor),
    rects: a.rects,
    aspect: a.aspect,
    bytes: kAlb.byteLength + kNor.byteLength,
  };
  console.log(`[${id}] ok ${(entry.bytes / 1024).toFixed(0)} KB`, JSON.stringify(a.rects), a.aspect);
  return entry;
}

async function main(): Promise<void> {
  const scans: Scan[] = [];
  for (const id of ['calathea_orbifolia_01', 'anthurium_botany_01', 'fern_02'])
    scans.push(await loadScan(id));
  if (candidatesMode) {
    await withBrowser((r) => candidateSheets(r, scans));
    return;
  }
  const results: Record<string, FoliageEntry> = {};
  if (only !== 'bamboo-leaf') {
    const tropical = await withBrowser((r) => bakeTropical(r, scans));
    const t = await encodeAtlas('tropical', tropical);
    if (t) results.tropical = t;
  }
  if (only !== 'tropical') {
    const b = await encodeAtlas('bamboo-leaf', await bakeBamboo());
    if (b) results['bamboo-leaf'] = b;
  }
  if (Object.keys(results).length === 0) return;

  const lic = loadLicenses();
  for (const id of ['calathea_orbifolia_01', 'anthurium_botany_01', 'fern_02'])
    upsertLicense(lic, await polyhavenInfo(id));
  saveLicenses(lic);

  const manifestPath = join(PACK, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const foliage = (manifest.foliage as Record<string, unknown> | undefined) ?? {};
  for (const [k, v] of Object.entries(results)) foliage[k] = v;
  manifest.foliage = foliage;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
  console.log('manifest.json updated (foliage)');
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
