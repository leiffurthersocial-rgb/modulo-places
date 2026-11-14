// Greybox species for the Jungle Ruin scene (registered before the scene loads).
// Everything is procedural: merged geometries with per-vertex colours, 2-3 LODs for plants that are
// scattered in numbers. Real models/textures replace these later; ids ('jungle:<name>') stay stable.
//
// Scale reference (metres): stair riser 0.3, tread 0.4, doorway 2.6 x 3.0, giant tree crown 25-35.
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Noise2D, Rng, smoothstep } from '../../engine/core/random';
import { patchMaterial } from '../../engine/render/materials';
import { sceneMaterial } from '../../engine/render/sceneMaterials';
import { registerPlaceholder, type Species } from '../../engine/scatter/species';

// ---------------------------------------------------------------------------------------------
// Colour + noise helpers
// ---------------------------------------------------------------------------------------------

type RGB = [number, number, number];
type ColFn = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => RGB;

const col = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const mul = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const NZ = new Noise2D(90210);
const hnoise = (x: number, y: number, seed = 0): number =>
  NZ.noise(x + seed * 17.3, y - seed * 9.1);
const fnoise = (x: number, y: number, seed = 0, oct = 3): number =>
  NZ.fbm(x + seed * 17.3, y - seed * 9.1, oct);

// ---------------------------------------------------------------------------------------------
// Mesh builder
// ---------------------------------------------------------------------------------------------

class MB {
  readonly p: number[] = [];
  readonly c: number[] = [];
  readonly i: number[] = [];
  get count(): number {
    return this.p.length / 3;
  }
  v(x: number, y: number, z: number, c: RGB): number {
    this.p.push(x, y, z);
    this.c.push(c[0], c[1], c[2]);
    return this.p.length / 3 - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.i.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.i.push(a, b, c, a, c, d);
  }
  /** `up` blends vertex normals toward +Y (foliage reads softer and never goes black). */
  geometry(up = 0): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeVertexNormals();
    if (up > 0) {
      const n = g.attributes.normal as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let k = 0; k < n.count; k++) {
        v.fromBufferAttribute(n, k);
        v.multiplyScalar(1 - up);
        v.y += up;
        v.normalize();
        n.setXYZ(k, v.x, v.y, v.z);
      }
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

interface BoxOpts {
  /** Target segment length (m) for subdivision of big faces. */
  seg?: number;
  /** Interior vertex jitter along the face normal (m). */
  jit?: number;
  seed?: number;
  noBottom?: boolean;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _id = new THREE.Matrix4();

/** Box with its base centred on the local origin ([-w/2,w/2] x [0,h] x [-d/2,d/2]), transformed by m. */
function box(
  b: MB,
  w: number,
  h: number,
  d: number,
  m: THREE.Matrix4,
  fn: ColFn,
  o: BoxOpts = {},
): void {
  const seg = o.seg ?? 1.2;
  const jit = o.jit ?? 0;
  const sd = o.seed ?? 0;
  const x0 = -w / 2;
  const x1 = w / 2;
  const z0 = -d / 2;
  const z1 = d / 2;
  type Face = [number[], number[], number[], number[], number, number];
  const faces: Face[] = [
    [[x0, h, z1], [w, 0, 0], [0, 0, -d], [0, 1, 0], w, d],
    [[x0, 0, z1], [w, 0, 0], [0, h, 0], [0, 0, 1], w, h],
    [[x1, 0, z0], [-w, 0, 0], [0, h, 0], [0, 0, -1], w, h],
    [[x1, 0, z1], [0, 0, -d], [0, h, 0], [1, 0, 0], d, h],
    [[x0, 0, z0], [0, 0, d], [0, h, 0], [-1, 0, 0], d, h],
  ];
  if (!o.noBottom) faces.push([[x0, 0, z0], [w, 0, 0], [0, 0, d], [0, -1, 0], w, d]);
  for (const [O, U, V, N, lu, lv] of faces) {
    const nu = Math.max(1, Math.min(14, Math.round(lu / seg)));
    const nv = Math.max(1, Math.min(14, Math.round(lv / seg)));
    _n.set(N[0]!, N[1]!, N[2]!).transformDirection(m);
    const nx = _n.x;
    const ny = _n.y;
    const nz = _n.z;
    const idx: number[] = [];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const a = i / nu;
        const c = j / nv;
        let px = O[0]! + U[0]! * a + V[0]! * c;
        let py = O[1]! + U[1]! * a + V[1]! * c;
        let pz = O[2]! + U[2]! * a + V[2]! * c;
        if (jit > 0 && i > 0 && i < nu && j > 0 && j < nv) {
          const k = jit * hnoise(px * 2.3 + pz * 1.7, py * 2.9 + pz * 0.9, sd);
          px += N[0]! * k;
          py += N[1]! * k;
          pz += N[2]! * k;
        }
        _v.set(px, py, pz).applyMatrix4(m);
        idx.push(b.v(_v.x, _v.y, _v.z, fn(_v.x, _v.y, _v.z, nx, ny, nz)));
      }
    }
    const row = nu + 1;
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        b.quad(
          idx[j * row + i]!,
          idx[j * row + i + 1]!,
          idx[(j + 1) * row + i + 1]!,
          idx[(j + 1) * row + i]!,
        );
      }
    }
  }
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

function xf(x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0): THREE.Matrix4 {
  _e.set(pitch, yaw, roll, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q, _s);
}

/** Axis-aligned convenience: box spanning [x0,x1] x [y0,y1] x [z0,z1]. */
function bx(
  b: MB,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  fn: ColFn,
  o: BoxOpts = {},
): void {
  box(b, x1 - x0, y1 - y0, z1 - z0, xf((x0 + x1) / 2, y0, (z0 + z1) / 2), fn, o);
}

/** Round tube along a polyline (parallel-transport frame). */
function tube(
  b: MB,
  pts: THREE.Vector3[],
  radius: (t: number, a: number) => number,
  sides: number,
  color: (t: number, a: number) => RGB,
  cap = false,
): void {
  const n = pts.length;
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const rings: number[][] = [];
  for (let k = 0; k < n; k++) {
    const a = pts[Math.max(0, k - 1)]!;
    const c = pts[Math.min(n - 1, k + 1)]!;
    T.subVectors(c, a).normalize();
    if (k === 0) {
      const ref = Math.abs(T.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      N.copy(ref).addScaledVector(T, -ref.dot(T)).normalize();
    } else {
      N.copy(prev).addScaledVector(T, -prev.dot(T)).normalize();
    }
    prev.copy(N);
    B.crossVectors(T, N);
    const t = k / (n - 1);
    const p = pts[k]!;
    const ring: number[] = [];
    for (let j = 0; j < sides; j++) {
      const ang = (j / sides) * Math.PI * 2;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      const r = radius(t, ang);
      ring.push(
        b.v(
          p.x + (N.x * cs + B.x * sn) * r,
          p.y + (N.y * cs + B.y * sn) * r,
          p.z + (N.z * cs + B.z * sn) * r,
          color(t, ang),
        ),
      );
    }
    rings.push(ring);
  }
  for (let k = 0; k < n - 1; k++) {
    const r0 = rings[k]!;
    const r1 = rings[k + 1]!;
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      b.quad(r0[j]!, r0[j1]!, r1[j1]!, r1[j]!);
    }
  }
  if (cap) {
    const first = pts[0]!;
    const last = pts[n - 1]!;
    const c0 = b.v(first.x, first.y, first.z, color(0, 0));
    const c1 = b.v(last.x, last.y, last.z, color(1, 0));
    const r0 = rings[0]!;
    const r1 = rings[n - 1]!;
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      b.tri(c0, r0[j1]!, r0[j]!);
      b.tri(c1, r1[j]!, r1[j1]!);
    }
  }
}

/** Displaced ellipsoid (leaf clump, boulder). */
function blob(
  b: MB,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  rz: number,
  detail: number,
  fn: ColFn,
  o: { disp?: number; seed?: number; m?: THREE.Matrix4 } = {},
): void {
  const g0 = new THREE.IcosahedronGeometry(1, detail);
  g0.deleteAttribute('normal');
  g0.deleteAttribute('uv');
  const g = mergeVertices(g0, 1e-4);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const idx = g.index!;
  const disp = o.disp ?? 0.25;
  const sd = o.seed ?? 0;
  const ids: number[] = [];
  for (let k = 0; k < pos.count; k++) {
    const ux = pos.getX(k);
    const uy = pos.getY(k);
    const uz = pos.getZ(k);
    const f = 1 + disp * fnoise(ux * 1.7 + uy * 0.9, uz * 1.6 - uy * 1.1, sd, 2);
    _v.set(cx + ux * rx * f, cy + uy * ry * f, cz + uz * rz * f);
    if (o.m) _v.applyMatrix4(o.m);
    ids.push(b.v(_v.x, _v.y, _v.z, fn(_v.x, _v.y, _v.z, ux, uy, uz)));
  }
  for (let k = 0; k < idx.count; k += 3) {
    b.tri(ids[idx.getX(k)]!, ids[idx.getX(k + 1)]!, ids[idx.getX(k + 2)]!);
  }
  g0.dispose();
  g.dispose();
}

// ---------------------------------------------------------------------------------------------
// Leaf blades, stalks, vines
// ---------------------------------------------------------------------------------------------

type BladeShape = 'ovate' | 'heart' | 'paddle' | 'frond' | 'lance';

interface BladeOpts {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Initial elevation (rad, 0 = horizontal, +up). */
  pitch: number;
  len: number;
  wid: number;
  droop?: number;
  fold?: number;
  shape?: BladeShape;
  nU?: number;
  nV?: number;
  c0: RGB;
  c1: RGB;
  vein?: RGB;
}

function halfWidth(shape: BladeShape, u: number, i: number): number {
  switch (shape) {
    case 'ovate':
      return Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 0.9);
    case 'heart':
      return Math.pow(Math.sin(Math.PI * (0.07 + 0.93 * Math.pow(u, 0.62))), 0.8);
    case 'paddle':
      return Math.min(1, u / 0.07 + 0.2) * Math.sqrt(Math.max(0.02, 1 - Math.pow(u, 9)));
    case 'frond':
      return Math.pow(1 - u, 0.55) * Math.min(1, u * 7 + 0.15) * (i % 2 === 1 ? 0.5 : 1);
    case 'lance':
      return Math.pow(Math.sin(Math.PI * Math.pow(u, 0.8)), 0.9);
  }
}

/** One curved leaf blade; returns the tip position. */
function blade(b: MB, o: BladeOpts): THREE.Vector3 {
  const nU = o.nU ?? 5;
  const nV = o.nV ?? 1;
  const dx = Math.sin(o.yaw);
  const dz = Math.cos(o.yaw);
  const sx = dz;
  const sz = -dx;
  const droop = o.droop ?? 0.9;
  const fold = o.fold ?? 0.25;
  const shape = o.shape ?? 'ovate';
  const ds = o.len / nU;
  let px = o.x;
  let py = o.y;
  let pz = o.z;
  const rows: number[][] = [];
  for (let i = 0; i <= nU; i++) {
    const u = i / nU;
    const hw = (halfWidth(shape, u, i) * o.wid) / 2;
    const base = mix(o.c0, o.c1, u);
    const row: number[] = [];
    for (let v = -nV; v <= nV; v++) {
      const vf = v / nV;
      const w = vf * hw;
      let c = mul(base, 1 - 0.22 * vf * vf);
      if (o.vein && Math.abs(vf) < 0.01) c = mix(c, o.vein, 0.35);
      row.push(b.v(px + sx * w, py - fold * Math.abs(vf) * hw * 0.6, pz + sz * w, c));
    }
    rows.push(row);
    const ph = o.pitch - droop * Math.pow((i + 0.5) / nU, 1.4);
    px += dx * Math.cos(ph) * ds;
    pz += dz * Math.cos(ph) * ds;
    py += Math.sin(ph) * ds;
  }
  for (let i = 0; i < nU; i++) {
    for (let j = 0; j < 2 * nV; j++) {
      b.quad(rows[i]![j]!, rows[i + 1]![j]!, rows[i + 1]![j + 1]!, rows[i]![j + 1]!);
    }
  }
  return new THREE.Vector3(px, py, pz);
}

/** Thin petiole ribbon rising from the ground and leaning along `yaw`; returns tip + end pitch. */
function stalk(
  b: MB,
  x: number,
  y: number,
  z: number,
  yaw: number,
  height: number,
  lean: number,
  width: number,
  c: RGB,
): { tip: THREE.Vector3; pitch: number } {
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  const sx = dz * width * 0.5;
  const sz = -dx * width * 0.5;
  const n = 3;
  let prev: [number, number] | null = null;
  let tip = new THREE.Vector3(x, y, z);
  let pitch = Math.PI / 2;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const px = x + dx * lean * t * t;
    const pz = z + dz * lean * t * t;
    const py = y + height * t;
    const w = 1 - 0.4 * t;
    const l = b.v(px - sx * w, py, pz - sz * w, mul(c, 0.8 + 0.2 * t));
    const r = b.v(px + sx * w, py, pz + sz * w, mul(c, 0.8 + 0.2 * t));
    if (prev) b.quad(prev[0], prev[1], r, l);
    prev = [l, r];
    // Tangent at the tip: dy/dt = height, d(horizontal)/dt = 2 * lean * t.
    pitch = Math.atan2(height, Math.max(1e-3, 2 * lean * t));
    tip = new THREE.Vector3(px, py, pz);
  }
  return { tip, pitch: Math.min(Math.PI / 2, Math.max(0.2, pitch)) };
}

/** Hanging vine: thin triangular tube with small leaves along it. */
function vine(
  b: MB,
  x: number,
  yTop: number,
  z: number,
  len: number,
  rng: Rng,
  o: { leafEvery: number; leafSize: number; radius?: number; sway?: number; leaves?: boolean },
): void {
  const segs = Math.max(3, Math.ceil(len / 2));
  const sway = o.sway ?? 0.6;
  const ph = rng.range(0, 6.28);
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    pts.push(
      new THREE.Vector3(
        x + Math.sin(ph + t * 5) * sway * t,
        yTop - len * t,
        z + Math.cos(ph * 1.3 + t * 4) * sway * t,
      ),
    );
  }
  const vc = col('#46562a');
  const vc2 = col('#2f4421');
  tube(
    b,
    pts,
    (t) => (o.radius ?? 0.035) * (1.1 - 0.4 * t),
    3,
    (t) => mix(vc, vc2, t),
  );
  if (o.leaves === false) return;
  const lc0 = col('#2f6a22');
  const lc1 = col('#5aa032');
  for (let y = o.leafEvery * 0.6; y < len; y += o.leafEvery * rng.range(0.7, 1.3)) {
    const t = y / len;
    const k = Math.min(segs - 1, Math.floor(t * segs));
    const p = pts[k]!;
    blade(b, {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: rng.range(0, 6.28),
      pitch: -0.5,
      len: o.leafSize * rng.range(0.8, 1.3),
      wid: o.leafSize * 0.75,
      droop: 0.5,
      nU: 2,
      nV: 1,
      c0: lc0,
      c1: lc1,
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Stone
// ---------------------------------------------------------------------------------------------

const STONE = col('#858a80');
const STONE_D = col('#545a52');
const MOSS = col('#456f29');
const MOSS_D = col('#2d4d1e');
const LICHEN = col('#9fa886');

function stoneFn(seed: number, moss = 0.5, dark = 1): ColFn {
  return (x, y, z, _nx, ny) => {
    const a = fnoise(x * 0.55 + z * 0.4, y * 0.7 + z * 0.2, seed, 3);
    const n = hnoise(x * 2.4 - z * 1.9, y * 2.9 + x * 0.8, seed + 3);
    let c = mix(STONE_D, STONE, clamp01(0.55 + 0.7 * a + 0.15 * n));
    const damp = 1 - smoothstep(0, 2.2, y);
    const score = moss * 0.55 + 0.95 * a + 0.15 * n + 0.45 * Math.max(0, ny) + 0.2 * damp;
    const t = smoothstep(0.55, 0.98, score);
    c = mix(c, mix(MOSS_D, MOSS, clamp01(0.5 + n * 0.8)), t);
    if (ny < 0.4 && n > 0.5) c = mix(c, LICHEN, 0.3);
    return mul(c, dark);
  };
}

/** Course of masonry blocks laid flush against one face of a volume. */
function skin(
  b: MB,
  face: '+z' | '-z' | '+x' | '-x',
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  plane: number,
  fn: ColFn,
  rng: Rng,
  o: { course?: number; thick?: number; bulge?: number; blockMin?: number; blockMax?: number } = {},
): void {
  const course = o.course ?? 0.6;
  const thick = o.thick ?? 0.2;
  const bulge = o.bulge ?? 0.07;
  const rows = Math.max(1, Math.round((y1 - y0) / course));
  const ch = (y1 - y0) / rows;
  for (let r = 0; r < rows; r++) {
    let a = a0 - rng.range(0, 0.9);
    while (a < a1 - 0.05) {
      const len = rng.range(o.blockMin ?? 1.1, o.blockMax ?? 2.4);
      const s = Math.max(a, a0);
      const e = Math.min(a + len, a1);
      a += len;
      if (e - s < 0.2) continue;
      const mid = (s + e) / 2;
      const prot = rng.range(0, bulge);
      const yb = y0 + r * ch + 0.012;
      const hh = ch - 0.025;
      const tilt = rng.range(-0.012, 0.012);
      const sg = face[0] === '+' ? 1 : -1;
      if (face === '+z' || face === '-z') {
        box(
          b,
          e - s - 0.03,
          hh,
          thick,
          xf(mid, yb, plane + sg * (prot - thick / 2), 0, tilt, 0),
          fn,
          { noBottom: true, seg: 3 },
        );
      } else {
        box(
          b,
          thick,
          hh,
          e - s - 0.03,
          xf(plane + sg * (prot - thick / 2), yb, mid, 0, 0, tilt),
          fn,
          { noBottom: true, seg: 3 },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Materials + species assembly
// ---------------------------------------------------------------------------------------------

interface MatOpts {
  rough?: number;
  double?: boolean;
  wind?: number;
  windHeight?: number;
  flutter?: number;
  invisible?: boolean;
  /** Double-sided materials default to translucent leaf lighting; set false for solid two-sided meshes. */
  translucent?: boolean;
}

// Leaves are translucent: keep the back side lit like the front instead of three's flipped normal
// (which turns every leaf underside black). Done in a hook that patchMaterial chains after.
const LEAF_NORMAL_CHUNK = THREE.ShaderChunk.normal_fragment_begin.replace(
  'gl_FrontFacing ? 1.0 : - 1.0',
  '1.0',
);

function mat(key: string, o: MatOpts = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: o.rough ?? 0.92,
    metalness: 0,
    side: o.double ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (o.invisible) m.visible = false;
  const lit = !!o.double && (o.flutter ?? 0) >= 0 && o.translucent !== false;
  if (lit)
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        LEAF_NORMAL_CHUNK,
      );
    };
  return patchMaterial(m, {
    key: `jungle-${key}${lit ? '-lit' : ''}`,
    wind: o.wind,
    windHeight: o.windHeight,
    flutter: o.flutter,
  });
}

interface PartDef {
  geo: THREE.BufferGeometry;
  material: THREE.Material;
  shadow?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Scene-library (triplanar PBR) materials + geometry splitting
// ---------------------------------------------------------------------------------------------

/** Library materials are owned by the scene runtime: never dispose them from a species. */
const LIB = new WeakSet<THREE.Material>();

/**
 * Triplanar pack material `libKey` (declared in scene.json `materials`), or a vertex-coloured
 * fallback when the pack/scene does not provide it. With wind > 0 the library material is cloned
 * so the vegetation still bends (the clone is owned by the species, the textures stay shared).
 */
function triMat(libKey: string, name: string, o: MatOpts = {}): THREE.Material {
  const fallback = mat(name, o);
  const lib = sceneMaterial(libKey, fallback);
  if (lib === fallback) return fallback;
  fallback.dispose();
  if (!o.wind && !o.double) {
    LIB.add(lib);
    return lib;
  }
  const m = lib.clone();
  if (o.double) m.side = THREE.DoubleSide;
  m.onBeforeCompile = lib.onBeforeCompile;
  m.customProgramCacheKey = lib.customProgramCacheKey;
  return patchMaterial(m, {
    key: `jungle-${name}-tri`,
    wind: o.wind,
    windHeight: o.windHeight,
    flutter: o.flutter,
  });
}

interface MossRule {
  /** Triangles whose upward normal is above this are mossy (top faces). */
  up?: number;
  /** Triangles whose vertex colour is this much greener than red are mossy. */
  green?: number;
  /** Triangles above this height are mossy (weathered upper courses). */
  yMin?: number;
}

/** Splits a coloured, indexed geometry into plain-stone and mossy triangles (shared vertex buffers). */
function splitMoss(g: THREE.BufferGeometry, rule: MossRule = {}): [PartGeo, PartGeo] {
  const up = rule.up ?? 0.82;
  const green = rule.green ?? 1.12;
  const yMin = rule.yMin ?? Infinity;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const colA = g.attributes.color as THREE.BufferAttribute;
  const idx = g.index!;
  const a: number[] = [];
  const m: number[] = [];
  for (let k = 0; k < idx.count; k += 3) {
    const i0 = idx.getX(k);
    const i1 = idx.getX(k + 1);
    const i2 = idx.getX(k + 2);
    const ny = (nor.getY(i0) + nor.getY(i1) + nor.getY(i2)) / 3;
    const r = colA.getX(i0) + colA.getX(i1) + colA.getX(i2);
    const gr = colA.getY(i0) + colA.getY(i1) + colA.getY(i2);
    const y = (pos.getY(i0) + pos.getY(i1) + pos.getY(i2)) / 3;
    const mossy = ny > up || gr > r * green || y > yMin;
    (mossy ? m : a).push(i0, i1, i2);
  }
  const make = (ix: number[]): PartGeo => {
    if (ix.length === 0) return null;
    const out = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(g.attributes)) out.setAttribute(name, attr);
    out.setIndex(ix);
    out.boundingSphere = g.boundingSphere?.clone() ?? null;
    out.boundingBox = g.boundingBox?.clone() ?? null;
    return out;
  };
  return [make(a), make(m)];
}
type PartGeo = THREE.BufferGeometry | null;

/** Stone parts of a ruin geometry: plain sandstone + mossy stone, using the same split for every LOD. */
function stoneParts(
  g: THREE.BufferGeometry,
  st: THREE.Material,
  mo: THREE.Material,
  rule?: MossRule,
): PartDef[] {
  const [a, m] = splitMoss(g, rule);
  const out: PartDef[] = [];
  if (a) out.push({ geo: a, material: st });
  if (m) out.push({ geo: m, material: mo });
  return out;
}

interface StoneMats {
  st: THREE.Material;
  mo: THREE.Material;
}
function stoneMats(name: string): StoneMats {
  return {
    st: triMat('jungle/jungle-stone', `${name}-stone`, { rough: 0.94 }),
    mo: triMat('jungle/mossy-stone', `${name}-moss`, { rough: 0.94 }),
  };
}

/** Ruin species: every variant/LOD is split into stone + mossy parts. */
function ruin(
  name: string,
  variants: THREE.BufferGeometry[][],
  height: number,
  radius: number,
  rule?: MossRule,
  mossOnly = false,
): Species {
  const { st, mo } = stoneMats(name);
  return assemble(
    variants.map((v) =>
      v.map((lod) => (mossOnly ? [{ geo: lod, material: mo }] : stoneParts(lod, st, mo, rule))),
    ),
    height,
    radius,
  );
}

function assemble(variants: PartDef[][][], height: number, radius: number): Species {
  const owned = new Set<THREE.BufferGeometry | THREE.Material>();
  for (const v of variants)
    for (const l of v)
      for (const p of l) {
        owned.add(p.geo);
        if (!LIB.has(p.material)) owned.add(p.material);
      }
  return {
    variants: variants.map((v) =>
      v.map((l) =>
        l.map((p) => ({ geometry: p.geo, material: p.material, castShadow: p.shadow ?? true })),
      ),
    ),
    height,
    radius,
    owned: [...owned],
  };
}

/** Single-material species: variants[v] = LOD geometries. */
function simple(
  m: THREE.Material,
  variants: THREE.BufferGeometry[][],
  height: number,
  radius: number,
): Species {
  return assemble(
    variants.map((v) => v.map((geo) => [{ geo, material: m }])),
    height,
    radius,
  );
}

// ---------------------------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------------------------

const BARK_A = col('#5d5244');
const BARK_B = col('#43392e');
const LICH = col('#7c8466');
const LEAF_TOP = col('#3f8a2c');
const LEAF_MID = col('#2f6a22');
const LEAF_UNDER = col('#4b7a2a');

interface TreeKind {
  trunkTop: [number, number];
  baseRadius: [number, number];
  fins: number;
  finReach: [number, number];
  finHeight: [number, number];
  blobs: number;
  blobR: [number, number];
  blobRy: [number, number];
  crownSpread: [number, number];
  limbs: number;
  lianas: number;
  curtains: number;
}

const GIANT: TreeKind = {
  trunkTop: [24, 29],
  baseRadius: [1.0, 1.35],
  fins: 6,
  finReach: [3.4, 6.2],
  finHeight: [5.5, 9.5],
  blobs: 12,
  blobR: [5.5, 9],
  blobRy: [2.0, 3.2],
  crownSpread: [2.5, 8.5],
  limbs: 5,
  lianas: 3,
  curtains: 3,
};

const MID: TreeKind = {
  trunkTop: [12, 16],
  baseRadius: [0.4, 0.55],
  fins: 4,
  finReach: [1.2, 2.2],
  finHeight: [2, 3.5],
  blobs: 5,
  blobR: [2.6, 4.2],
  blobRy: [1.5, 2.3],
  crownSpread: [1.5, 4.5],
  limbs: 3,
  lianas: 0,
  curtains: 1,
};

function canopyTree(
  seed: number,
  lod: number,
  kind: TreeKind,
): { bark: THREE.BufferGeometry; leaf: THREE.BufferGeometry } {
  const r = new Rng(seed);
  const bark = new MB();
  const leaf = new MB();
  const H = r.range(kind.trunkTop[0], kind.trunkTop[1]);
  const Rb = r.range(kind.baseRadius[0], kind.baseRadius[1]);
  const sides = [10, 7, 5][lod]!;
  const segs = [12, 7, 4][lod]!;
  const wob = r.range(0, 6);
  const lean = r.range(-1.2, 1.2) * (H / 26);
  const lean2 = r.range(-1.2, 1.2) * (H / 26);
  const centre = (y: number): THREE.Vector3 => {
    const t = (y + 1.5) / (H + 1.5);
    return new THREE.Vector3(
      lean * t * t + 0.2 * Math.sin(t * 5 + wob) * (H / 26),
      y,
      lean2 * t * t + 0.2 * Math.cos(t * 4 + wob) * (H / 26),
    );
  };
  const trunkR = (y: number): number => {
    const t = (y + 1.5) / (H + 1.5);
    return Rb * (1 - 0.42 * t) + Rb * 0.7 * Math.exp(-t * 10);
  };
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= segs; k++) pts.push(centre(-1.5 + ((H + 1.5) * k) / segs));
  tube(
    bark,
    pts,
    (t, a) =>
      trunkR(-1.5 + (H + 1.5) * t) *
      (1 + 0.07 * Math.sin(a * 7 + t * 6 + seed) * (lod === 0 ? 1 : 0.5)),
    sides,
    (t, a) => {
      const y = -1.5 + (H + 1.5) * t;
      const n = hnoise(a * 2.6, y * 0.18, seed);
      let c = mix(BARK_B, BARK_A, 0.5 + 0.5 * n);
      const l = hnoise(a * 1.7 + 4, y * 0.35, seed + 2);
      if (l > 0.35) c = mix(c, LICH, clamp01((l - 0.35) * 1.2));
      if (y < 4) c = mix(c, MOSS_D, 0.4 * (1 - y / 4) * clamp01(0.5 + n));
      return c;
    },
    true,
  );

  // Buttress fins.
  const nF = lod === 0 ? kind.fins : lod === 1 ? Math.max(3, kind.fins - 2) : 0;
  const S = lod === 0 ? 8 : 5;
  for (let f = 0; f < nF; f++) {
    const th = ((f + r.range(-0.2, 0.2)) / nF) * Math.PI * 2;
    const reach = r.range(kind.finReach[0], kind.finReach[1]);
    const Hf = r.range(kind.finHeight[0], kind.finHeight[1]);
    const thick = r.range(0.45, 0.7) * (Rb / 1.2 + 0.3);
    const dxr = Math.cos(th);
    const dzr = Math.sin(th);
    const px = -dzr;
    const pz = dxr;
    type Q = { ip: number; op: number; im: number; om: number };
    const cols: Q[] = [];
    for (let j = 0; j <= S; j++) {
      const s = j / S;
      const y = -0.5 + (Hf + 0.5) * s;
      const c0 = centre(y);
      const rt = trunkR(y);
      const ro = rt + (reach - rt) * Math.pow(1 - s, 2.6);
      const ri = rt * 0.6;
      const th2 = thick * (1 - 0.55 * s) * 0.5;
      const cb = mix(BARK_A, BARK_B, 0.3 + 0.5 * s);
      const cm = y < 2.5 ? mix(cb, MOSS_D, 0.35) : cb;
      const co = mul(cm, 0.9);
      cols.push({
        ip: bark.v(c0.x + dxr * ri + px * th2, y, c0.z + dzr * ri + pz * th2, cm),
        op: bark.v(c0.x + dxr * ro + px * th2, y, c0.z + dzr * ro + pz * th2, co),
        im: bark.v(c0.x + dxr * ri - px * th2, y, c0.z + dzr * ri - pz * th2, cm),
        om: bark.v(c0.x + dxr * ro - px * th2, y, c0.z + dzr * ro - pz * th2, co),
      });
    }
    for (let j = 0; j < S; j++) {
      const a = cols[j]!;
      const c = cols[j + 1]!;
      bark.quad(a.ip, a.op, c.op, c.ip);
      bark.quad(a.im, c.im, c.om, a.om);
      bark.quad(a.op, a.om, c.om, c.op);
    }
  }

  // Crown: limbs + leaf clumps.
  const nb = lod === 0 ? kind.blobs : lod === 1 ? Math.ceil(kind.blobs * 0.6) : 3;
  const hc = H + (kind === GIANT ? 3 : 2);
  const blobs: { x: number; y: number; z: number; rx: number; ry: number; rz: number }[] = [];
  const c0 = centre(H);
  for (let i = 0; i < nb; i++) {
    const ang = (i / nb) * Math.PI * 2 + r.range(-0.4, 0.4);
    const rr = i === 0 ? 0 : r.range(kind.crownSpread[0], kind.crownSpread[1]);
    blobs.push({
      x: c0.x + Math.cos(ang) * rr,
      y: hc + r.range(-1.8, 2.2) + (rr < kind.crownSpread[0] + 1 ? 1.8 : 0),
      z: c0.z + Math.sin(ang) * rr,
      rx: r.range(kind.blobR[0], kind.blobR[1]),
      ry: r.range(kind.blobRy[0], kind.blobRy[1]),
      rz: r.range(kind.blobR[0], kind.blobR[1]),
    });
  }
  const nl = lod === 2 ? 0 : lod === 1 ? Math.min(3, kind.limbs) : kind.limbs;
  for (let l = 0; l < nl; l++) {
    const bl = blobs[1 + (l % Math.max(1, blobs.length - 1))] ?? blobs[0]!;
    const y0 = H - r.range(1, 5);
    const p0 = centre(y0);
    const p3 = new THREE.Vector3(bl.x, bl.y - bl.ry * 0.6, bl.z);
    const mid = p0.clone().lerp(p3, 0.5);
    mid.y = p0.y + (p3.y - p0.y) * 0.35 + 1.2;
    const lp: THREE.Vector3[] = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      const a = p0.clone().lerp(mid, t);
      const bb = mid.clone().lerp(p3, t);
      lp.push(a.lerp(bb, t));
    }
    tube(
      bark,
      lp,
      (t) => Math.max(0.12, trunkR(y0) * 0.55 * (1 - 0.65 * t)),
      lod === 0 ? 6 : 4,
      (t, a) => mix(BARK_A, BARK_B, 0.5 + 0.5 * hnoise(a * 2, t * 4, seed + l)),
    );
  }
  const detail = [2, 1, 0][lod]!;
  blobs.forEach((bl, i) => {
    const tone = r.range(0.85, 1.15);
    blob(
      leaf,
      bl.x,
      bl.y,
      bl.z,
      bl.rx,
      bl.ry,
      bl.rz,
      detail,
      (x, y, z, _nx, ny) => {
        const n = hnoise(x * 0.35 + z * 0.2, y * 0.4, seed + i);
        const t = clamp01(0.5 + 0.7 * ny + 0.15 * n);
        const base = ny > 0 ? mix(LEAF_MID, LEAF_TOP, t) : mix(LEAF_UNDER, LEAF_MID, t);
        return mul(base, tone * (0.92 + 0.12 * n));
      },
      { disp: 0.3, seed: seed + i },
    );
  });

  if (lod === 0) {
    // Trunk climbers (spiral vines) and hanging lianas from the limbs.
    for (let v = 0; v < kind.lianas; v++) {
      const ph0 = r.range(0, 6.28);
      const hv = r.range(0.55, 0.85) * H;
      const sp: THREE.Vector3[] = [];
      for (let k = 0; k <= 14; k++) {
        const t = k / 14;
        const y = 1 + (hv - 1) * t;
        const c = centre(y);
        const ang = ph0 + t * 9;
        const rr = trunkR(y) + 0.04;
        sp.push(new THREE.Vector3(c.x + Math.cos(ang) * rr, y, c.z + Math.sin(ang) * rr));
      }
      tube(
        leaf,
        sp,
        (t) => 0.07 * (1 - 0.4 * t),
        4,
        (t) => mix(col('#4a4a30'), col('#2f4421'), t),
      );
    }
    for (let cu = 0; cu < kind.curtains; cu++) {
      const bl = blobs[1 + ((cu * 2) % Math.max(1, blobs.length - 1))] ?? blobs[0]!;
      const len = r.range(0.45, 0.8) * (bl.y - 2);
      const nStr = kind === GIANT ? 5 : 3;
      for (let s = 0; s < nStr; s++) {
        vine(
          leaf,
          bl.x + r.range(-1.6, 1.6),
          bl.y - bl.ry * 0.7,
          bl.z + r.range(-1.6, 1.6),
          len * r.range(0.7, 1),
          r,
          {
            leafEvery: 1.4,
            leafSize: 0.5,
            radius: 0.05,
            sway: 0.8,
          },
        );
      }
    }
  }
  return { bark: bark.geometry(), leaf: leaf.geometry(0.6) };
}

function buildCanopyTrees(
  key: string,
  kind: TreeKind,
  seeds: number[],
  height: number,
  radius: number,
): Species {
  const H = height;
  const wind = kind === GIANT ? 0.55 : 0.4;
  const barkM = triMat(kind === GIANT ? 'forest/bark' : 'jungle/bark-tropical', `${key}-bark`, {
    rough: 0.95,
    double: true,
    wind,
    windHeight: H,
    translucent: false,
  });
  const leafM = mat(`${key}-leaf`, {
    rough: 0.85,
    double: true,
    wind,
    windHeight: H,
    flutter: 0.06,
  });
  const variants: PartDef[][][] = seeds.map((s) =>
    [0, 1, 2].map((lod) => {
      const g = canopyTree(s, lod, kind);
      return [
        { geo: g.bark, material: barkM },
        { geo: g.leaf, material: leafM },
      ];
    }),
  );
  return assemble(variants, height, radius);
}

/** Very cheap far-field giant (one part, one LOD), for the ring of canopy beyond the walkable area. */
function buildGiantFar(): Species {
  const m = mat('giant-far', {
    rough: 0.95,
    double: true,
    wind: 0.4,
    windHeight: 36,
    translucent: false,
  });
  const geos = [301, 302].map((s) => {
    const g = canopyTree(s, 2, GIANT);
    const merged = new MB();
    const append = (geo: THREE.BufferGeometry): void => {
      const p = geo.attributes.position as THREE.BufferAttribute;
      const c = geo.attributes.color as THREE.BufferAttribute;
      const base = merged.count;
      for (let k = 0; k < p.count; k++)
        merged.v(p.getX(k), p.getY(k), p.getZ(k), [c.getX(k), c.getY(k), c.getZ(k)]);
      const idx = geo.index!;
      for (let k = 0; k < idx.count; k++) merged.i.push(base + idx.getX(k));
    };
    append(g.bark);
    append(g.leaf);
    g.bark.dispose();
    g.leaf.dispose();
    return merged.geometry();
  });
  return simple(
    m,
    geos.map((g) => [g]),
    36,
    6,
  );
}

// ---------------------------------------------------------------------------------------------
// Palms, tree ferns, saplings
// ---------------------------------------------------------------------------------------------

function palm(
  seed: number,
  lod: number,
): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; h: number } {
  const r = new Rng(seed);
  const trunk = new MB();
  const crown = new MB();
  const h = r.range(9, 13);
  const lx = r.range(-1.2, 1.2);
  const lz = r.range(-1.2, 1.2);
  const segs = [10, 6, 3][lod]!;
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    pts.push(new THREE.Vector3(lx * t * t, h * t - 0.4, lz * t * t));
  }
  tube(
    trunk,
    pts,
    (t) => 0.2 - 0.07 * t + 0.1 * Math.exp(-t * 14),
    [7, 5, 4][lod]!,
    (t) => {
      const ring = Math.floor((t * h) / 0.35) % 2;
      return mix(col('#4f473a'), col('#6a6150'), ring * 0.7 + 0.15 * hnoise(t * 30, seed));
    },
    true,
  );
  const top = pts[pts.length - 1]!;
  const nf = [13, 9, 6][lod]!;
  const nU = [8, 4, 2][lod]!;
  for (let f = 0; f < nf; f++) {
    const yaw = (f / nf) * Math.PI * 2 + r.range(-0.2, 0.2);
    const upper = f % 3 === 0;
    blade(crown, {
      x: top.x,
      y: top.y,
      z: top.z,
      yaw,
      pitch: upper ? 1.0 : 0.45,
      len: r.range(3.0, 4.0) * (upper ? 0.85 : 1),
      wid: 1.0,
      droop: upper ? 1.6 : 2.0,
      fold: 0.5,
      shape: 'frond',
      nU,
      nV: lod === 2 ? 1 : 2,
      c0: col('#3d7a2c'),
      c1: col('#6aa83c'),
      vein: col('#8ab85a'),
    });
  }
  return { trunk: trunk.geometry(), crown: crown.geometry(0.5), h };
}

function buildPalm(): Species {
  const wind = 0.5;
  const tm = triMat('jungle/bark-tropical', 'palm-trunk', {
    rough: 0.9,
    double: true,
    wind,
    windHeight: 12,
    translucent: false,
  });
  const lm = mat('palm-leaf', { rough: 0.8, double: true, wind, windHeight: 12, flutter: 0.1 });
  const variants = [41, 42, 43].map((s) =>
    [0, 1, 2].map((lod) => {
      const p = palm(s, lod);
      return [
        { geo: p.trunk, material: tm },
        { geo: p.crown, material: lm },
      ];
    }),
  );
  return assemble(variants, 13, 2.5);
}

function treeFern(
  seed: number,
  lod: number,
): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry } {
  const r = new Rng(seed);
  const trunk = new MB();
  const crown = new MB();
  const h = r.range(2.4, 4.2);
  const pts: THREE.Vector3[] = [];
  const sg = [5, 3, 2][lod]!;
  const lx = r.range(-0.3, 0.3);
  for (let k = 0; k <= sg; k++)
    pts.push(new THREE.Vector3(lx * (k / sg) ** 2, h * (k / sg) - 0.2, 0));
  tube(
    trunk,
    pts,
    (t) => 0.11 + 0.04 * (1 - t),
    lod === 2 ? 4 : 6,
    (t, a) => mix(col('#4c3b2a'), col('#6c5a3c'), 0.5 + 0.5 * hnoise(a * 3, t * 6, seed)),
    true,
  );
  const top = pts[pts.length - 1]!;
  const nf = [16, 10, 7][lod]!;
  for (let f = 0; f < nf; f++) {
    const yaw = (f / nf) * Math.PI * 2 + r.range(-0.2, 0.2);
    blade(crown, {
      x: top.x,
      y: top.y,
      z: top.z,
      yaw,
      pitch: f % 2 ? 0.9 : 0.35,
      len: r.range(1.7, 2.4),
      wid: 0.55,
      droop: 1.5,
      fold: 0.4,
      shape: 'frond',
      nU: [8, 5, 3][lod]!,
      nV: 1,
      c0: col('#2f6a26'),
      c1: col('#5c9a36'),
    });
  }
  return { trunk: trunk.geometry(), crown: crown.geometry(0.5) };
}

function buildTreeFern(): Species {
  const wind = 0.15;
  const tm = triMat('jungle/bark-tropical', 'treefern-trunk', {
    rough: 0.95,
    double: true,
    wind,
    windHeight: 4,
    translucent: false,
  });
  const lm = mat('treefern-leaf', { rough: 0.8, double: true, wind, windHeight: 4, flutter: 0.06 });
  const variants = [51, 52, 53].map((s) =>
    [0, 1, 2].map((lod) => {
      const p = treeFern(s, lod);
      return [
        { geo: p.trunk, material: tm },
        { geo: p.crown, material: lm },
      ];
    }),
  );
  return assemble(variants, 4.5, 1.8);
}

function sapling(
  seed: number,
  lod: number,
): { trunk: THREE.BufferGeometry; leaf: THREE.BufferGeometry } {
  const r = new Rng(seed);
  const trunk = new MB();
  const leaf = new MB();
  const h = r.range(4, 7.5);
  const lx = r.range(-0.5, 0.5);
  const pts: THREE.Vector3[] = [];
  const sg = [6, 4, 2][lod]!;
  for (let k = 0; k <= sg; k++) {
    const t = k / sg;
    pts.push(
      new THREE.Vector3(
        lx * t * t + 0.1 * Math.sin(t * 5 + seed),
        h * t - 0.2,
        0.2 * Math.cos(t * 4 + seed),
      ),
    );
  }
  tube(
    trunk,
    pts,
    (t) => 0.11 * (1 - 0.55 * t) + 0.02,
    lod === 2 ? 4 : 5,
    (t, a) => mix(col('#5c4f3a'), col('#7b6c52'), 0.5 + 0.5 * hnoise(a * 2, t * 5, seed)),
    true,
  );
  const tiers = lod === 2 ? 2 : 3;
  for (let ti = 0; ti < tiers; ti++) {
    const y = h * (0.45 + 0.55 * (ti / Math.max(1, tiers - 1)) ** 0.8);
    const k = Math.min(sg, Math.round((y / h) * sg));
    const c = pts[k]!;
    const nl = lod === 2 ? 3 : 5;
    for (let l = 0; l < nl; l++) {
      blade(leaf, {
        x: c.x,
        y: c.y,
        z: c.z,
        yaw: (l / nl) * Math.PI * 2 + ti * 0.9 + r.range(-0.3, 0.3),
        pitch: 0.35,
        len: r.range(1.2, 1.7) * (1.1 - ti * 0.15),
        wid: 0.7,
        droop: 0.9,
        shape: 'ovate',
        nU: lod === 0 ? 4 : 2,
        nV: 1,
        c0: col('#2f6a22'),
        c1: col('#5fa532'),
        vein: col('#9ccf62'),
      });
    }
  }
  return { trunk: trunk.geometry(), leaf: leaf.geometry(0.5) };
}

function buildSapling(): Species {
  const wind = 0.25;
  const tm = triMat('jungle/bark-tropical', 'sapling-trunk', {
    rough: 0.95,
    double: true,
    wind,
    windHeight: 7,
    translucent: false,
  });
  const lm = mat('sapling-leaf', { rough: 0.8, double: true, wind, windHeight: 7, flutter: 0.1 });
  const variants = [61, 62, 63].map((s) =>
    [0, 1, 2].map((lod) => {
      const p = sapling(s, lod);
      return [
        { geo: p.trunk, material: tm },
        { geo: p.leaf, material: lm },
      ];
    }),
  );
  return assemble(variants, 7.5, 1.4);
}

// ---------------------------------------------------------------------------------------------
// Broad-leaf understory and ground plants (single foliage part, double-sided)
// ---------------------------------------------------------------------------------------------

function foliageMat(
  key: string,
  wind: number,
  windHeight: number,
  flutter: number,
): THREE.MeshStandardMaterial {
  return mat(key, { rough: 0.78, double: true, wind, windHeight, flutter });
}

function monstera(seed: number, lod: number): THREE.BufferGeometry {
  const r = new Rng(seed);
  const b = new MB();
  const n = [8, 6, 4][lod]!;
  const stemC = col('#4c7a2e');
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3);
    const h = r.range(0.55, 1.0);
    const lean = r.range(0.2, 0.55);
    const x0 = Math.sin(yaw) * 0.08;
    const z0 = Math.cos(yaw) * 0.08;
    const s = stalk(b, x0, 0, z0, yaw, h, lean, 0.035, stemC);
    blade(b, {
      x: s.tip.x,
      y: s.tip.y,
      z: s.tip.z,
      yaw: yaw + r.range(-0.25, 0.25),
      pitch: 0.45,
      len: r.range(0.75, 1.0),
      wid: r.range(0.7, 0.9),
      droop: 1.3,
      fold: 0.3,
      shape: 'heart',
      nU: [6, 3, 2][lod]!,
      nV: lod === 2 ? 1 : 2,
      c0: col('#21561c'),
      c1: col('#3d8a2a'),
      vein: col('#6fb04a'),
    });
  }
  return b.geometry(0.45);
}

function elephantEar(seed: number, lod: number): THREE.BufferGeometry {
  const r = new Rng(seed);
  const b = new MB();
  const n = [6, 5, 3][lod]!;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + r.range(-0.4, 0.4);
    const h = r.range(0.9, 1.5);
    const s = stalk(
      b,
      Math.sin(yaw) * 0.1,
      0,
      Math.cos(yaw) * 0.1,
      yaw,
      h,
      r.range(0.15, 0.4),
      0.04,
      col('#5a8a34'),
    );
    blade(b, {
      x: s.tip.x,
      y: s.tip.y,
      z: s.tip.z,
      yaw,
      pitch: -0.1,
      len: r.range(0.8, 1.15),
      wid: r.range(0.6, 0.85),
      droop: 1.0,
      fold: 0.15,
      shape: 'heart',
      nU: [6, 3, 2][lod]!,
      nV: lod === 2 ? 1 : 2,
      c0: col('#1f5a24'),
      c1: col('#3f9a3a'),
      vein: col('#7cc060'),
    });
  }
  return b.geometry(0.5);
}

function banana(seed: number, lod: number): THREE.BufferGeometry {
  const r = new Rng(seed);
  const b = new MB();
  const h = r.range(2.4, 3.4);
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k <= 4; k++)
    pts.push(new THREE.Vector3(0.1 * Math.sin(k + seed), (h * k) / 4, 0));
  tube(
    b,
    pts,
    (t) => 0.16 - 0.06 * t,
    lod === 2 ? 4 : 6,
    (t) => mix(col('#6e8a3a'), col('#52702c'), t),
    true,
  );
  const top = pts[4]!;
  const n = [9, 7, 5][lod]!;
  for (let i = 0; i < n; i++) {
    const dead = i === 3;
    blade(b, {
      x: top.x,
      y: top.y - (i % 3) * 0.12,
      z: top.z,
      yaw: (i / n) * Math.PI * 2 + r.range(-0.2, 0.2),
      pitch: 1.0 - (i % 3) * 0.3,
      len: r.range(2.0, 2.8),
      wid: 0.75,
      droop: 2.0,
      fold: 0.35,
      shape: 'paddle',
      nU: [7, 4, 3][lod]!,
      nV: lod === 2 ? 1 : 2,
      c0: dead ? col('#6a5a2c') : col('#2f6a22'),
      c1: dead ? col('#8a7a3a') : col('#4a8a32'),
      vein: dead ? col('#9a8a4a') : col('#9ccf62'),
    });
  }
  return b.geometry(0.5);
}

function bigFern(seed: number, lod: number): THREE.BufferGeometry {
  const r = new Rng(seed);
  const b = new MB();
  const n = [13, 9, 6][lod]!;
  for (let i = 0; i < n; i++) {
    blade(b, {
      x: 0,
      y: 0.05,
      z: 0,
      yaw: (i / n) * Math.PI * 2 + r.range(-0.2, 0.2),
      pitch: 0.55 + (i % 3) * 0.2,
      len: r.range(1.1, 1.7),
      wid: 0.38,
      droop: 1.5,
      fold: 0.3,
      shape: 'frond',
      nU: [9, 5, 3][lod]!,
      nV: 1,
      c0: col('#2b5e22'),
      c1: col('#4a8a30'),
    });
  }
  return b.geometry(0.55);
}

function groundLeaf(seed: number, lod: number): THREE.BufferGeometry {
  const r = new Rng(seed);
  const b = new MB();
  const n = [7, 5, 4][lod]!;
  for (let i = 0; i < n; i++) {
    blade(b, {
      x: Math.sin(i * 2.4) * 0.05,
      y: 0,
      z: Math.cos(i * 2.4) * 0.05,
      yaw: (i / n) * Math.PI * 2 + r.range(-0.3, 0.3),
      pitch: 0.7,
      len: r.range(0.55, 0.85),
      wid: 0.3,
      droop: 1.1,
      fold: 0.3,
      shape: 'ovate',
      nU: lod === 0 ? 4 : 2,
      nV: 1,
      c0: col('#265a20'),
      c1: col('#448230'),
      vein: col('#8ccc5c'),
    });
  }
  return b.geometry(0.6);
}

function ginger(seed: number, lod: number): THREE.BufferGeometry {
  const r = new Rng(seed);
  const b = new MB();
  const n = [9, 6, 4][lod]!;
  for (let i = 0; i < n; i++) {
    const yaw = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3);
    const h = r.range(0.8, 1.6);
    const s = stalk(b, 0, 0, 0, yaw, h, r.range(0.1, 0.35), 0.03, col('#4c7a2e'));
    blade(b, {
      x: s.tip.x,
      y: s.tip.y,
      z: s.tip.z,
      yaw,
      pitch: 0.5,
      len: r.range(0.6, 0.9),
      wid: 0.28,
      droop: 0.9,
      shape: 'lance',
      nU: lod === 0 ? 4 : 2,
      nV: 1,
      c0: col('#2b6a24'),
      c1: col('#4c8c32'),
      vein: col('#9ccf62'),
    });
  }
  return b.geometry(0.5);
}

function shrub(seed: number, lod: number): THREE.BufferGeometry {
  const r = new Rng(seed);
  const b = new MB();
  const n = [16, 10, 7][lod]!;
  for (let i = 0; i < n; i++) {
    const ring = i % 2;
    blade(b, {
      x: r.range(-0.15, 0.15),
      y: 0.1 + ring * 0.4,
      z: r.range(-0.15, 0.15),
      yaw: (i / n) * Math.PI * 4 + r.range(-0.3, 0.3),
      pitch: 0.55 - ring * 0.15,
      len: r.range(0.8, 1.2),
      wid: 0.42,
      droop: 0.8,
      shape: 'ovate',
      nU: lod === 0 ? 4 : 2,
      nV: 1,
      c0: col('#2b5e20'),
      c1: col('#468430'),
      vein: col('#8ccc5c'),
    });
  }
  return b.geometry(0.5);
}

function lowFern(seed: number, lod: number): THREE.BufferGeometry {
  const r = new Rng(seed);
  const b = new MB();
  const n = [9, 6, 4][lod]!;
  for (let i = 0; i < n; i++) {
    blade(b, {
      x: 0,
      y: 0.03,
      z: 0,
      yaw: (i / n) * Math.PI * 2 + r.range(-0.3, 0.3),
      pitch: 0.4,
      len: r.range(0.5, 0.8),
      wid: 0.2,
      droop: 1.2,
      shape: 'frond',
      nU: [6, 3, 2][lod]!,
      nV: 1,
      c0: col('#2f6a26'),
      c1: col('#4c8c32'),
    });
  }
  return b.geometry(0.55);
}

function plantSpecies(
  key: string,
  seeds: number[],
  build: (seed: number, lod: number) => THREE.BufferGeometry,
  wind: number,
  windHeight: number,
  height: number,
  radius: number,
): Species {
  const m = foliageMat(key, wind, windHeight, 0.05);
  return simple(
    m,
    seeds.map((s) => [0, 1, 2].map((lod) => build(s, lod))),
    height,
    radius,
  );
}

// ---------------------------------------------------------------------------------------------
// Natural ground features
// ---------------------------------------------------------------------------------------------

function boulderGeo(seed: number, detail: number): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const ROCK = col('#7d7a6e');
  const ROCK_D = col('#4f4c42');
  blob(
    b,
    0,
    0.35,
    0,
    1.25 * r.range(0.9, 1.2),
    0.8 * r.range(0.8, 1.1),
    1.0 * r.range(0.9, 1.2),
    detail,
    (x, y, z, _nx, ny) => {
      const n = hnoise(x * 1.6 + z, y * 1.8, seed);
      let c = mix(ROCK_D, ROCK, clamp01(0.6 + 0.5 * n));
      const m = smoothstep(0.1, 0.55, ny + 0.25 * n);
      c = mix(c, mix(MOSS_D, MOSS, clamp01(0.5 + n)), m * 0.9);
      if (y < 0.1) c = mul(c, 0.7);
      return c;
    },
    { disp: 0.38, seed },
  );
  return b.geometry();
}

function logGeo(seed: number, len: number, lod: number): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const pts: THREE.Vector3[] = [];
  const n = lod === 0 ? 8 : 4;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    pts.push(
      new THREE.Vector3(
        -len / 2 + len * t,
        0.5 + 0.06 * Math.sin(t * 5 + seed),
        0.15 * Math.sin(t * 3),
      ),
    );
  }
  tube(
    b,
    pts,
    (t) => 0.36 - 0.06 * t + 0.08 * Math.exp(-t * 12),
    lod === 0 ? 9 : 6,
    (t, a) => {
      const top = Math.max(0, Math.cos(a));
      const nz = hnoise(t * 14, a * 2, seed);
      let c = mix(col('#4a3d2e'), col('#6b5a43'), 0.5 + 0.5 * nz);
      c = mix(c, mix(MOSS_D, MOSS, 0.5 + 0.5 * nz), clamp01(top * 1.2 - 0.15 + 0.2 * nz) * 0.9);
      return c;
    },
    true,
  );
  if (lod === 0) {
    // Shelf fungi + a stub branch for silhouette interest.
    tube(
      b,
      [
        new THREE.Vector3(r.range(-1, 1), 0.7, 0.2),
        new THREE.Vector3(r.range(-1, 1), 1.0, 0.7),
        new THREE.Vector3(r.range(-1, 1), 1.2, 1.2),
      ],
      (t) => 0.13 - 0.08 * t,
      5,
      () => col('#56473a'),
      true,
    );
  }
  return b.geometry();
}

function rootSpread(seed: number, lod: number): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const n = lod === 0 ? 6 : 4;
  const ROOT = col('#4c4033');
  const ROOT_D = col('#382d24');
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + r.range(-0.4, 0.4);
    const L = r.range(3.5, 6.5);
    const wig = r.range(0.3, 0.9);
    const ph = r.range(0, 6);
    const pts: THREE.Vector3[] = [];
    const seg = lod === 0 ? 8 : 4;
    for (let k = 0; k <= seg; k++) {
      const t = k / seg;
      const a2 = ang + Math.sin(t * 4 + ph) * 0.25 * wig;
      pts.push(
        new THREE.Vector3(
          Math.cos(a2) * L * t,
          0.1 * (1 - t) + 0.04 + 0.04 * Math.sin(t * 9 + ph),
          Math.sin(a2) * L * t,
        ),
      );
    }
    tube(
      b,
      pts,
      (t) => 0.15 * Math.pow(1 - t, 0.9) + 0.035,
      lod === 0 ? 6 : 4,
      (t, a) => {
        const top = Math.max(0, Math.cos(a));
        const c = mix(ROOT_D, ROOT, 0.5 + 0.5 * hnoise(t * 8, a, seed + i));
        return mix(c, MOSS_D, top * 0.4 * (0.4 + t * 0.6));
      },
    );
  }
  return b.geometry();
}

/** Roots draping over a wall or stair edge: vertical strands with a tangled top. */
function rootCurtain(seed: number, width: number, drop: number): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const n = Math.round(width * 2.2);
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(1, n - 1) - 0.5) * width + r.range(-0.2, 0.2);
    const len = drop * r.range(0.35, 1.0);
    const pts: THREE.Vector3[] = [];
    const ph = r.range(0, 6);
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      pts.push(
        new THREE.Vector3(
          x + Math.sin(t * 5 + ph) * 0.12,
          -len * t,
          0.25 * Math.sin(t * 3) * t + 0.12 * t,
        ),
      );
    }
    tube(
      b,
      pts,
      (t) => 0.1 * (1 - t) + 0.025,
      5,
      (t, a) => mix(col('#54463a'), col('#3c4a28'), t * 0.6 + 0.3 * hnoise(a, t, seed)),
    );
  }
  return b.geometry();
}

// ---------------------------------------------------------------------------------------------
// Ruin pieces
// ---------------------------------------------------------------------------------------------

function pillarGeo(seed: number, kind: 'full' | 'broken' | 'stump'): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const fn = stoneFn(seed, 0.55);
  const full = kind === 'full' ? 4.6 : kind === 'broken' ? r.range(2.6, 3.4) : 1.0;
  const sd = seed;
  // Plinth, shaft, carved bands, capital.
  bx(b, -0.75, 0.75, -0.6, 0.45, -0.75, 0.75, fn, { jit: 0.03, seed: sd });
  bx(b, -0.45, 0.45, 0.45, full, -0.45, 0.45, fn, {
    seg: 0.35,
    jit: kind === 'full' ? 0.012 : 0.07,
    seed: sd + 1,
  });
  const band = (y0: number, y1: number): void => {
    if (y1 < full)
      bx(b, -0.51, 0.51, y0, y1, -0.51, 0.51, stoneFn(seed + 5, 0.3, 0.9), { seg: 1, jit: 0.01 });
  };
  band(1.2, 1.45);
  band(2.4, 2.65);
  band(3.5, 3.75);
  if (kind === 'full') {
    bx(b, -0.62, 0.62, full, full + 0.28, -0.62, 0.62, fn, { jit: 0.015, seed: sd + 2 });
    bx(b, -0.85, 0.85, full + 0.28, full + 0.6, -0.85, 0.85, fn, { jit: 0.02, seed: sd + 3 });
  }
  // Carved diamond relief on each face.
  const relief = stoneFn(seed + 7, 0.1, 0.8);
  for (let f = 0; f < 4; f++) {
    const a = (f * Math.PI) / 2;
    if (1.9 + 0.7 < full)
      box(
        b,
        0.38,
        0.38,
        0.1,
        xf(Math.sin(a) * 0.47, 1.65, Math.cos(a) * 0.47, a, 0, 0.785),
        relief,
        { seg: 1, noBottom: true },
      );
  }
  return b.geometry();
}

function fallenPillarGeo(seed: number): THREE.BufferGeometry {
  const b = new MB();
  const fn = stoneFn(seed, 0.8);
  // Three drum segments with small offsets, lying along +x.
  let x = -2.4;
  const r = new Rng(seed);
  for (let k = 0; k < 3; k++) {
    const len = [1.9, 1.6, 1.3][k]! + r.range(-0.1, 0.2);
    box(
      b,
      len,
      0.9,
      0.9,
      xf(x + len / 2, 0, r.range(-0.15, 0.15), r.range(-0.12, 0.12), 0, 0),
      fn,
      { seg: 0.5, jit: 0.02, seed: seed + k },
    );
    x += len + r.range(0.02, 0.35);
  }
  bx(b, 0, 0.6, 0, 0.18, 0.7, 1.3, fn);
  return b.geometry();
}

function wallGeo(
  seed: number,
  len: number,
  hMax: number,
  hMin: number,
  thick = 1.1,
): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const fn = stoneFn(seed, 0.6);
  const ch = 0.55;
  const prof = (x: number): number =>
    hMin + (hMax - hMin) * clamp01(0.5 + 0.9 * fnoise(x * 0.35, seed * 0.1, seed, 2));
  for (let row = 0; row < Math.ceil(hMax / ch); row++) {
    let x = -len / 2 - r.range(0, 0.6);
    while (x < len / 2) {
      const l = r.range(0.9, 1.9);
      const s = Math.max(x, -len / 2);
      const e = Math.min(x + l, len / 2);
      const mid = (s + e) / 2;
      x += l;
      if (e - s < 0.3) continue;
      if ((row + 1) * ch > prof(mid) + r.range(-0.15, 0.2)) continue;
      box(
        b,
        e - s - 0.04,
        ch - 0.03,
        thick + r.range(-0.08, 0.1),
        xf(
          mid,
          row * ch - 0.9,
          r.range(-0.05, 0.05),
          r.range(-0.03, 0.03),
          r.range(-0.012, 0.012),
          0,
        ),
        fn,
        { seg: 2, noBottom: row > 0 },
      );
    }
  }
  return b.geometry();
}

function blockGeo(seed: number): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const fn = stoneFn(seed, 0.4);
  const w = r.range(0.9, 1.5);
  const h = r.range(0.55, 0.9);
  const d = r.range(0.7, 1.1);
  box(
    b,
    w,
    h,
    d,
    xf(0, -0.08, 0, r.range(0, 6.28), r.range(-0.12, 0.12), r.range(-0.12, 0.12)),
    fn,
    { seg: 0.4, jit: 0.025, seed },
  );
  // Carved band / boss on one face.
  box(
    b,
    w * 0.7,
    0.12,
    0.08,
    xf(0, h * 0.45, d / 2 - 0.02, 0, 0, 0),
    stoneFn(seed + 9, 0.2, 0.85),
    { noBottom: true },
  );
  return b.geometry();
}

function slabGeo(seed: number, lod: number): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const fn = stoneFn(seed, 0.4);
  const w = r.range(1.2, 1.9);
  const d = r.range(1.1, 1.7);
  box(
    b,
    w,
    0.34,
    d,
    xf(0, -0.22, 0, r.range(-0.1, 0.1), r.range(-0.04, 0.04), r.range(-0.04, 0.04)),
    fn,
    {
      seg: lod === 0 ? 0.5 : 2,
      jit: lod === 0 ? 0.025 : 0,
      seed,
      noBottom: true,
    },
  );
  return b.geometry();
}

function rubbleGeo(seed: number): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const fn = stoneFn(seed, 0.7);
  const n = 11;
  for (let i = 0; i < n; i++) {
    const a = r.range(0, 6.28);
    const rr = r.range(0, 1.3) * (1 - i / (n * 1.6));
    const sz = r.range(0.5, 1.15);
    box(
      b,
      sz * r.range(0.8, 1.4),
      sz * r.range(0.5, 0.9),
      sz * r.range(0.7, 1.2),
      xf(
        Math.cos(a) * rr * 1.5,
        i * 0.05 - 0.1,
        Math.sin(a) * rr,
        r.range(0, 6.28),
        r.range(-0.4, 0.4),
        r.range(-0.4, 0.4),
      ),
      fn,
      { seg: 0.5, jit: 0.02, seed: seed + i },
    );
  }
  return b.geometry();
}

function steleGeo(seed: number): THREE.BufferGeometry {
  const b = new MB();
  const fn = stoneFn(seed, 0.6);
  bx(b, -0.7, 0.7, -0.4, 0.4, -0.6, 0.6, fn, { jit: 0.02, seed });
  bx(b, -0.45, 0.45, 0.4, 3.0, -0.2, 0.2, fn, { seg: 0.4, jit: 0.015, seed: seed + 1 });
  bx(b, -0.36, 0.36, 3.0, 3.25, -0.17, 0.17, fn, { jit: 0.01, seed: seed + 2 });
  const rel = stoneFn(seed + 3, 0.1, 0.78);
  bx(b, -0.28, 0.28, 1.0, 1.15, 0.2, 0.26, rel);
  bx(b, -0.28, 0.28, 1.5, 1.65, 0.2, 0.26, rel);
  bx(b, -0.12, 0.12, 1.15, 1.5, 0.2, 0.26, rel);
  bx(b, -0.28, 0.28, 2.1, 2.9, 0.2, 0.25, rel);
  return b.geometry();
}

function guardianGeo(): THREE.BufferGeometry {
  const b = new MB();
  const fn = stoneFn(77, 0.5);
  const dk = stoneFn(78, 0.2, 0.7);
  bx(b, -1.0, 1.0, -0.4, 0.55, -0.9, 0.9, fn, { jit: 0.02, seed: 1 });
  bx(b, -0.75, 0.75, 0.55, 1.5, -0.55, 0.55, fn, { seg: 0.4, jit: 0.02, seed: 2 });
  bx(b, -0.85, 0.85, 1.5, 2.3, -0.5, 0.5, fn, { seg: 0.4, jit: 0.02, seed: 3 });
  bx(b, -0.5, 0.5, 2.3, 3.0, -0.5, 0.5, fn, { seg: 0.4, jit: 0.02, seed: 4 });
  bx(b, -0.62, 0.62, 3.0, 3.35, -0.6, 0.6, fn, { jit: 0.02, seed: 5 });
  bx(b, -0.35, -0.12, 2.6, 2.75, 0.5, 0.58, dk);
  bx(b, 0.12, 0.35, 2.6, 2.75, 0.5, 0.58, dk);
  bx(b, -0.2, 0.2, 2.35, 2.5, 0.5, 0.56, dk);
  bx(b, -0.45, 0.45, 1.7, 2.0, 0.5, 0.58, dk);
  // Folded arms on the lap.
  bx(b, -0.7, 0.7, 1.0, 1.25, 0.55, 0.85, fn, { jit: 0.01, seed: 6 });
  return b.geometry();
}

// ---------------------------------------------------------------------------------------------
// The temple (hero mesh)
// ---------------------------------------------------------------------------------------------
// Local origin = centre of the courtyard pad at ground level. The temple faces +Z.
//   tier 1: top 2.4 m, tier 2: 4.8 m, tier 3: 7.2 m (24 risers of 0.3 m), stair 6.8 m wide.
//   Shrine chamber on tier 3; doorway 2.6 wide x 3.0 high at z = -19.5.

export const TEMPLE = {
  stairHalf: 3.4,
  riser: 0.3,
  tread: 0.4,
  stairZ0: -6,
  steps: 24,
  topY: 7.2,
  doorZ: -19.5,
  doorW: 2.6,
  doorH: 3.0,
  wallH: 6.4,
};

function templeGeo(): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(2026);
  const T = TEMPLE;
  const fn = stoneFn(11, 0.55);
  const topBase = stoneFn(12, 0.5);
  // Inside the shrine the floor is in shadow, and every downward face (ceiling) is dark.
  const fnTop: ColFn = (x, y, z, nx, ny, nz) => {
    const c = topBase(x, y, z, nx, ny, nz);
    return Math.abs(x) < 3.6 && z < -21.7 && z > -28.3 && y < 7.4 ? mul(c, 0.3) : c;
  };
  const core = stoneFn(13, 0.2, 0.62);
  const tiers = [
    { w: 16, h: 2.4, z0: -34, z1: -6 },
    { w: 12.5, h: 4.8, z0: -33, z1: -9.2 },
    { w: 9, h: 7.2, z0: -32, z1: -12.4 },
  ];
  const sh = T.stairHalf;
  tiers.forEach((t, ti) => {
    const sides: [number, number][] = [
      [-t.w, -sh],
      [sh, t.w],
    ];
    for (const [xa, xb] of sides) {
      bx(b, xa + 0.04, xb - 0.04, -3, t.h, t.z0 + 0.04, t.z1 - 0.04, ti === 2 ? fnTop : core, {
        seg: 2,
        jit: 0.03,
        seed: 20 + ti,
      });
    }
    if (ti === 2)
      bx(b, -sh + 0.04, sh - 0.04, -3, t.h, t.z0 + 0.04, -15.6, fnTop, {
        seg: 2,
        jit: 0.03,
        seed: 29,
      });
    const y0 = ti === 0 ? 0 : tiers[ti - 1]!.h;
    const course = 0.6;
    // Fronts (+z) of the flank blocks.
    skin(b, '+z', -t.w, -sh, y0, t.h, t.z1, fn, r, { course });
    skin(b, '+z', sh, t.w, y0, t.h, t.z1, fn, r, { course });
    // Outer sides (+/-x), stair channel walls, and the back.
    skin(b, '+x', t.z0, t.z1, y0, t.h, t.w, fn, r, { course });
    skin(b, '-x', t.z0, t.z1, y0, t.h, -t.w, fn, r, { course });
    skin(b, '-z', -t.w, t.w, y0, t.h, t.z0, fn, r, { course });
    skin(b, '-x', t.z0, t.z1, y0 + (ti === 0 ? 0 : 0), t.h, sh, fn, r, { course }); // channel wall facing the stair (right side)
    skin(b, '+x', t.z0, t.z1, y0, t.h, -sh, fn, r, { course }); // channel wall (left side)
    // Cornice lip.
    skin(b, '+z', -t.w, -sh, t.h - 0.3, t.h, t.z1, fn, r, {
      course: 0.3,
      thick: 0.4,
      bulge: 0.22,
      blockMin: 1.6,
      blockMax: 3,
    });
    skin(b, '+z', sh, t.w, t.h - 0.3, t.h, t.z1, fn, r, {
      course: 0.3,
      thick: 0.4,
      bulge: 0.22,
      blockMin: 1.6,
      blockMax: 3,
    });
    skin(b, '+x', t.z0, t.z1, t.h - 0.3, t.h, t.w, fn, r, {
      course: 0.3,
      thick: 0.4,
      bulge: 0.22,
      blockMin: 1.6,
      blockMax: 3,
    });
    skin(b, '-x', t.z0, t.z1, t.h - 0.3, t.h, -t.w, fn, r, {
      course: 0.3,
      thick: 0.4,
      bulge: 0.22,
      blockMin: 1.6,
      blockMax: 3,
    });
  });

  // Stair: only the visible riser slice of each step (solid colliders are separate props).
  for (let i = 1; i <= T.steps; i++) {
    const zf = T.stairZ0 - T.tread * (i - 1);
    const top = T.riser * i;
    const settle = r.range(-0.012, 0.012);
    const damaged = r.next() < 0.14;
    const stepFn = stoneFn(100 + i, 0.55 + (i % 5) * 0.04);
    if (damaged) {
      const cut = r.range(1.0, 1.8);
      const left = r.next() < 0.5;
      const xs = left ? [-sh, -sh + cut] : [sh - cut, sh];
      const xr = left ? [-sh + cut, sh] : [-sh, sh - cut];
      bx(b, xr[0]!, xr[1]!, top - 0.35, top + settle, zf - T.tread, zf, stepFn, {
        seg: 0.9,
        jit: 0.02,
        seed: i,
      });
      bx(b, xs[0]!, xs[1]!, top - 0.45, top - 0.12 + settle, zf - T.tread, zf + 0.02, stepFn, {
        seg: 0.9,
        jit: 0.035,
        seed: i + 50,
      });
    } else {
      const split = r.range(-1.8, 1.8);
      bx(b, -sh, split - 0.02, top - 0.35, top + settle, zf - T.tread, zf, stepFn, {
        seg: 0.9,
        jit: 0.02,
        seed: i,
      });
      bx(b, split + 0.02, sh, top - 0.35, top - settle * 1.5, zf - T.tread, zf, stepFn, {
        seg: 0.9,
        jit: 0.02,
        seed: i + 50,
      });
    }
  }

  // Paving slabs on the top terrace (also under the shrine) so the floor reads at human scale.
  const slabFn = stoneFn(14, 0.45);
  const slabInside: ColFn = (x, y, z, nx, ny, nz) =>
    mul(slabFn(x, y, z, nx, ny, nz), Math.abs(x) < 3.6 && z < -21.7 && z > -28.3 ? 0.3 : 1);
  for (let gx = -8.4; gx < 8.4; gx += 1.7) {
    for (let gz = -31; gz < -12.6; gz += 1.7) {
      if (Math.abs(gx) < sh + 0.1 && gz > -15.7) continue; // stair mouth
      const wob = r.range(-0.05, 0.05);
      box(
        b,
        1.6 + r.range(-0.1, 0.05),
        0.14,
        1.6 + r.range(-0.1, 0.05),
        xf(
          gx + 0.85,
          T.topY - 0.03 + wob,
          gz + 0.85,
          r.range(-0.04, 0.04),
          r.range(-0.02, 0.02),
          r.range(-0.02, 0.02),
        ),
        slabInside,
        { noBottom: true, seg: 3 },
      );
    }
  }

  // Shrine chamber on tier 3.
  const y0 = T.topY;
  const wh = T.wallH;
  const dz = T.doorZ;
  const hw = T.doorW / 2;
  const inner = stoneFn(31, 0.1, 0.34);
  const wallBase = stoneFn(32, 0.6);
  const wall: ColFn = (x, y, z, nx, ny, nz) =>
    mul(wallBase(x, y, z, nx, ny, nz), ny < -0.5 ? 0.3 : 1);
  const wallCore = stoneFn(33, 0.3, 0.6);
  const parts: [number, number, number, number][] = [
    [-5.8, -hw, dz - 2.2, dz], // front-left
    [hw, 5.8, dz - 2.2, dz], // front-right
    [-5.8, -3.6, -30.5, dz], // left wall
    [3.6, 5.8, -30.5, dz], // right wall
    [-5.8, 5.8, -30.5, -28.3], // back wall
  ];
  for (const [xa, xb, za, zb] of parts) {
    bx(b, xa + 0.05, xb - 0.05, y0 - 0.1, y0 + wh, za + 0.05, zb - 0.05, wallCore, { seg: 2.5 });
  }
  const yt = y0 + wh;
  skin(b, '+z', -5.8, -hw, y0, yt, dz, wall, r, { course: 0.64 });
  skin(b, '+z', hw, 5.8, y0, yt, dz, wall, r, { course: 0.64 });
  skin(b, '+x', -30.5, dz, y0, yt, 5.8, wall, r, { course: 0.64 });
  skin(b, '-x', -30.5, dz, y0, yt, -5.8, wall, r, { course: 0.64 });
  skin(b, '-z', -5.8, 5.8, y0, yt, -30.5, wall, r, { course: 0.64 });
  // Interior faces (dark).
  skin(b, '-x', -28.3, dz - 2.2, y0, yt, 3.6, inner, r, { course: 0.64 });
  skin(b, '+x', -28.3, dz - 2.2, y0, yt, -3.6, inner, r, { course: 0.64 });
  skin(b, '+z', -3.6, 3.6, y0, yt, -28.3, inner, r, { course: 0.64 });
  skin(b, '-z', -3.6, -hw, y0, yt, dz - 2.2, inner, r, { course: 0.64 });
  skin(b, '-z', hw, 3.6, y0, yt, dz - 2.2, inner, r, { course: 0.64 });
  // Door jambs (reveal) and lintel.
  skin(b, '+x', dz - 2.2, dz, y0, y0 + T.doorH, -hw, wall, r, { course: 0.5, thick: 0.2 });
  skin(b, '-x', dz - 2.2, dz, y0, y0 + T.doorH, hw, wall, r, { course: 0.5, thick: 0.2 });
  bx(b, -hw - 0.5, hw + 0.5, y0 + T.doorH, y0 + T.doorH + 1.0, dz - 2.25, dz + 0.22, wall, {
    seg: 0.8,
    jit: 0.02,
    seed: 7,
  });
  bx(b, -hw - 0.9, hw + 0.9, y0 + T.doorH + 1.0, y0 + T.doorH + 1.35, dz - 2.3, dz + 0.4, wall, {
    seg: 0.8,
    jit: 0.02,
    seed: 8,
  });
  // Engaged pillars flanking the door.
  for (const sx of [-1, 1]) {
    bx(b, sx * (hw + 1.3) - 0.45, sx * (hw + 1.3) + 0.45, y0, y0 + 4.2, dz + 0.02, dz + 0.9, wall, {
      seg: 0.5,
      jit: 0.015,
      seed: 40 + sx,
    });
    bx(
      b,
      sx * (hw + 1.3) - 0.6,
      sx * (hw + 1.3) + 0.6,
      y0 + 4.2,
      y0 + 4.55,
      dz + 0.02,
      dz + 1.05,
      wall,
      { jit: 0.02, seed: 44 + sx },
    );
    bx(b, sx * (hw + 1.3) - 0.62, sx * (hw + 1.3) + 0.62, y0, y0 + 0.4, dz + 0.0, dz + 1.1, wall, {
      jit: 0.02,
      seed: 46 + sx,
    });
  }
  // Roof: partly collapsed slab, stepped crown.
  bx(b, -6.4, 0.2, yt, yt + 0.9, -31.1, dz + 0.6, wall, { seg: 1.2, jit: 0.04, seed: 50 });
  bx(b, 0.5, 6.4, yt, yt + 0.9, -31.1, -25.5, wall, { seg: 1.2, jit: 0.05, seed: 51 });
  bx(b, -4.6, 0.4, yt + 0.9, yt + 1.9, -29.8, -21.2, wall, { seg: 1.2, jit: 0.04, seed: 52 });
  bx(b, 1.0, 4.6, yt + 0.9, yt + 1.7, -29.8, -26.0, wall, { seg: 1.2, jit: 0.07, seed: 53 });
  bx(b, -2.8, 0.2, yt + 1.9, yt + 2.8, -28.2, -23.0, wall, { seg: 1.2, jit: 0.05, seed: 54 });
  // Altar in the dark chamber.
  bx(b, -1.1, 1.1, y0, y0 + 1.0, -27.6, -26.2, stoneFn(60, 0.1, 0.4), {
    seg: 0.8,
    jit: 0.015,
    seed: 60,
  });
  bx(b, -1.3, 1.3, y0 + 1.0, y0 + 1.18, -27.8, -26.0, stoneFn(61, 0.1, 0.4), {
    jit: 0.01,
    seed: 61,
  });
  return b.geometry();
}

/** Roots, vines and moss clumps that claim the temple (same local frame as the temple). */
function templeGrowthGeo(): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(808);
  const T = TEMPLE;
  const surfaceY = (z: number): number => {
    const t = (T.stairZ0 - z) / T.tread;
    return Math.max(0, Math.min(T.steps, Math.ceil(t))) * T.riser;
  };
  // Roots crawling down the stair, hugging the treads.
  const ROOT = col('#4c4033');
  const ROOT_D = col('#382d24');
  for (let i = 0; i < 5; i++) {
    const x0 = r.range(-3.0, 3.0);
    const drift = r.range(-1.2, 1.2);
    const pts: THREE.Vector3[] = [];
    const zStart = -6 - r.range(2, 8);
    const zEnd = zStart + r.range(6, 11);
    for (let k = 0; k <= 22; k++) {
      const t = k / 22;
      const z = zStart + (zEnd - zStart) * t;
      pts.push(
        new THREE.Vector3(
          x0 + drift * t + 0.25 * Math.sin(t * 9 + i),
          surfaceY(z) + 0.12 + 0.07 * Math.sin(t * 40),
          z,
        ),
      );
    }
    tube(
      b,
      pts,
      (t) => 0.09 * (1 - 0.6 * t) + 0.03,
      5,
      (t, a) => mix(ROOT_D, ROOT, 0.5 + 0.5 * hnoise(a, t * 6, 80 + i)),
    );
  }
  // Moss cushions on terraces and stair cheeks.
  const place: [number, number, number, number][] = [
    [-12, 2.4, -8, 1.6],
    [11, 2.4, -7.6, 1.4],
    [-10.5, 4.8, -11, 1.5],
    [9.5, 4.8, -10.5, 1.3],
    [-7.5, 7.2, -14.5, 1.7],
    [7, 7.2, -15, 1.5],
    [-5.2, 7.2, -17.5, 1.2],
    [5.0, 7.2, -17, 1.1],
  ];
  place.forEach(([x, y, z, rr], i) => {
    blob(
      b,
      x,
      y + 0.05,
      z,
      rr * 0.8,
      0.28,
      rr * 0.55,
      1,
      (px, py, pz, _nx, ny) =>
        mix(MOSS_D, MOSS, clamp01(0.5 + 0.7 * ny + 0.2 * hnoise(px * 2, pz * 2, i))),
      { disp: 0.3, seed: i },
    );
  });
  // Vine curtains: the door lintel, tier lips and roof edge.
  const curtain = (
    x: number,
    y: number,
    z: number,
    len: number,
    n: number,
    spread: number,
  ): void => {
    for (let k = 0; k < n; k++) {
      vine(
        b,
        x + (k / Math.max(1, n - 1) - 0.5) * spread + r.range(-0.15, 0.15),
        y,
        z + r.range(-0.1, 0.15),
        len * r.range(0.6, 1),
        r,
        {
          leafEvery: 0.55,
          leafSize: 0.34,
          radius: 0.022,
          sway: 0.3,
        },
      );
    }
  };
  const yd = T.topY + T.doorH + 1.35;
  curtain(-hwDoor() - 1.2, yd, T.doorZ + 0.5, 3.6, 5, 2.6);
  curtain(hwDoor() + 1.5, yd, T.doorZ + 0.5, 4.8, 6, 3.2);
  curtain(-5, T.topY + T.wallH + 0.9, T.doorZ + 0.3, 8, 7, 4.5);
  curtain(4.5, T.topY + T.wallH + 0.9, T.doorZ + 0.3, 6.5, 6, 4);
  curtain(-9, 4.8, -9.0, 2.6, 5, 3);
  curtain(9, 4.8, -9.0, 2.2, 5, 3);
  curtain(-13, 2.4, -5.8, 2.2, 6, 4);
  curtain(12.5, 2.4, -5.8, 2.0, 5, 3.5);
  curtain(-12.5, 7.2, -12.4, 2.4, 4, 2.5);
  // Root curtains draping over the roof edge and right tier.
  const rc = rootCurtain(3, 3.2, 5.5);
  const pos = rc.attributes.position as THREE.BufferAttribute;
  const colr = rc.attributes.color as THREE.BufferAttribute;
  const idx = rc.index!;
  const place2: [number, number, number][] = [
    [2.8, T.topY + T.wallH + 0.9, T.doorZ + 0.45],
    [-3.8, 4.8 + 0.0, -9.05],
    [8, 2.4, -5.9],
  ];
  for (const [ox, oy, oz] of place2) {
    const base = b.count;
    for (let k = 0; k < pos.count; k++)
      b.v(pos.getX(k) + ox, pos.getY(k) + oy, pos.getZ(k) + oz, [
        colr.getX(k),
        colr.getY(k),
        colr.getZ(k),
      ]);
    for (let k = 0; k < idx.count; k++) b.i.push(base + idx.getX(k));
  }
  rc.dispose();
  return b.geometry(0.3);
}

function hwDoor(): number {
  return TEMPLE.doorW / 2;
}

// ---------------------------------------------------------------------------------------------
// Liana (free-hanging vine bundle), colliders
// ---------------------------------------------------------------------------------------------

function lianaGeo(seed: number, lod: number): THREE.BufferGeometry {
  const b = new MB();
  const r = new Rng(seed);
  const top = r.range(24, 31);
  const n = lod === 0 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    vine(b, r.range(-0.4, 0.4), top, r.range(-0.4, 0.4), top - r.range(1.5, 4), r, {
      leafEvery: 1.3,
      leafSize: 0.5,
      radius: 0.06,
      sway: 1.0,
      leaves: lod === 0,
    });
  }
  return b.geometry(0.5);
}

function colliderGeo(): THREE.BufferGeometry {
  const b = new MB();
  box(b, 1, 1, 1, _id, () => [0.5, 0.5, 0.5], { seg: 10 });
  return b.geometry();
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

function boulderSpecies(): Species {
  const st = triMat('forest/rock', 'boulder-rock', { rough: 0.94 });
  const mo = triMat('jungle/mossy-stone', 'boulder-moss', { rough: 0.94 });
  return assemble(
    [301, 302, 303].map((s) =>
      [boulderGeo(s, 3), boulderGeo(s, 2), boulderGeo(s, 1)].map((g) =>
        stoneParts(g, st, mo, { up: 0.55, green: 1.05 }),
      ),
    ),
    1.4,
    1.4,
  );
}

export const JUNGLE_SPECIES: Record<string, () => Species> = {
  'jungle:temple': () => ruin('temple', [[templeGeo()]], 18, 18, { up: 0.9, yMin: 10.5 }),
  'jungle:temple-growth': () =>
    simple(mat('temple-growth', { rough: 0.85, double: true }), [[templeGrowthGeo()]], 18, 18),
  'jungle:collider': () => simple(mat('collider', { invisible: true }), [[colliderGeo()]], 1, 0.5),
  'jungle:pillar': () => ruin('pillar', [[pillarGeo(5, 'full')]], 5.2, 0.9, { yMin: 3.4 }),
  'jungle:pillar-broken': () => ruin('pillar', [[pillarGeo(6, 'broken')]], 3.4, 0.9),
  'jungle:pillar-stump': () => ruin('pillar', [[pillarGeo(8, 'stump')]], 1.2, 0.9),
  'jungle:pillar-fallen': () => ruin('pillar', [[fallenPillarGeo(9)]], 1, 3.2, undefined, true),
  'jungle:wall': () => ruin('wall', [[wallGeo(21, 8, 3.4, 1.2)]], 3.4, 4.2, { yMin: 1.6 }),
  'jungle:wall-b': () => ruin('wall', [[wallGeo(22, 6, 2.6, 0.7)]], 2.6, 3.2, { yMin: 1.4 }),
  'jungle:wall-low': () => ruin('wall', [[wallGeo(23, 7, 1.2, 0.5)]], 1.2, 3.6, { yMin: 0.6 }),
  'jungle:block': () =>
    ruin(
      'block',
      [71, 72, 73].map((s) => [blockGeo(s)]),
      1,
      1,
    ),
  'jungle:rubble': () => ruin('rubble', [[rubbleGeo(31)], [rubbleGeo(32)]], 1.2, 1.8, { up: 0.5 }),
  'jungle:slab': () =>
    ruin(
      'slab',
      [81, 82, 83, 84].map((s) => [slabGeo(s, 0), slabGeo(s, 1)]),
      0.2,
      1,
      { up: 0.7 },
    ),
  'jungle:stele': () => ruin('stele', [[steleGeo(91)]], 3.3, 0.8, { yMin: 2.9 }),
  'jungle:guardian': () => ruin('guardian', [[guardianGeo()]], 3.4, 1.0, { yMin: 3.0 }),
  'jungle:root-spread': () =>
    simple(
      triMat('jungle/bark-tropical', 'root', { rough: 0.95, double: true, translucent: false }),
      [11, 12, 13, 14].map((s) => [rootSpread(s, 0), rootSpread(s, 1)]),
      0.5,
      5,
    ),
  'jungle:boulder': boulderSpecies,
  'jungle:log': () =>
    simple(
      triMat('forest/bark', 'log', { rough: 0.95 }),
      [
        [logGeo(5, 7, 0), logGeo(5, 7, 1)],
        [logGeo(6, 10, 0), logGeo(6, 10, 1)],
      ],
      1.2,
      3,
    ),
  'jungle:giant-tree': () => buildCanopyTrees('giant', GIANT, [101, 102, 103], 38, 3),
  'jungle:giant-far': buildGiantFar,
  'jungle:canopy-tree': () => buildCanopyTrees('mid', MID, [111, 112, 113], 22, 1.5),
  'jungle:palm': buildPalm,
  'jungle:tree-fern': buildTreeFern,
  'jungle:sapling': buildSapling,
  'jungle:liana': () =>
    simple(
      mat('liana', { rough: 0.85, double: true, wind: 0.5, windHeight: 30, flutter: 0.05 }),
      [121, 122, 123].map((s) => [lianaGeo(s, 0), lianaGeo(s, 1)]),
      31,
      0.5,
    ),
  'jungle:monstera': () => plantSpecies('monstera', [201, 202], monstera, 0.1, 1.6, 1.8, 1.2),
  'jungle:elephant-ear': () =>
    plantSpecies('elephant-ear', [211, 212], elephantEar, 0.1, 1.8, 2.0, 1.1),
  'jungle:banana': () => plantSpecies('banana', [221, 222], banana, 0.2, 4, 4.5, 2.2),
  'jungle:fern-big': () => plantSpecies('fern-big', [231, 232, 233], bigFern, 0.08, 1.2, 1.3, 1.5),
  'jungle:ground-leaf': () =>
    plantSpecies('ground-leaf', [241, 242, 243], groundLeaf, 0.05, 0.7, 0.8, 0.6),
  'jungle:ginger': () => plantSpecies('ginger', [251, 252], ginger, 0.1, 2, 2.2, 1),
  'jungle:shrub': () => plantSpecies('shrub', [261, 262, 263], shrub, 0.08, 1.4, 1.5, 1.1),
  'jungle:fern-low': () => plantSpecies('fern-low', [271, 272, 273], lowFern, 0.04, 0.5, 0.5, 0.7),
};

export function registerJunglePlaceholders(): void {
  for (const [id, build] of Object.entries(JUNGLE_SPECIES)) registerPlaceholder(id, build);
}
