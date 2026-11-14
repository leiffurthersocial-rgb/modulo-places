// Greybox species for the Snowy Mountain Cabin scene (registered before the scene loads).
// Everything is procedural: vertex-coloured low-poly meshes with LOD chains. Real models and
// textures replace these later; the ids (`cabin:*`) stay stable so scene.json keeps working.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Noise2D, Rng } from '../../engine/core/random';
import { patchMaterial } from '../../engine/render/materials';
import { registerPlaceholder, type Species, type SpeciesPart } from '../../engine/scatter/species';

type V3 = [number, number, number];
type Geo = THREE.BufferGeometry;

// --- palette (hex, converted to linear by THREE.Color) -------------------------------------------
const SNOW = '#f3f6fb';
const SNOW_SHADE = '#e3ebf6';
const LOG_COLORS = ['#7b5836', '#6e4d2f', '#86613c', '#62442a', '#74533a'];
const LOG_CUT = '#cfae78';
const PLANK = ['#8a6a48', '#7d5f40', '#93724d', '#76593c'];
const DARK_WOOD = '#3f2a1a';
const STONE = ['#7d7a74', '#6b6862', '#8a867e', '#5f5d59', '#76726b'];
const ROCK = '#6c6d72';
const IRON = '#262626';

// --- tiny geometry toolkit --------------------------------------------------------------------

const _c = new THREE.Color();
function col(hex: string): [number, number, number] {
  _c.set(hex);
  return [_c.r, _c.g, _c.b];
}

/** Final-space transform helper: rotate (Euler XYZ, radians) then translate. */
function place(g: Geo, pos: V3, rot?: V3): Geo {
  if (rot)
    g.applyMatrix4(
      new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'YXZ')),
    );
  g.translate(pos[0], pos[1], pos[2]);
  return g;
}

/** Make non-indexed, drop uv, and write vertex colours from fn(position, normal). */
function paint(g: Geo, fn: (p: THREE.Vector3, n: THREE.Vector3) => [number, number, number]): Geo {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const arr = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    arr.set(fn(p, n), i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

const noise = new Noise2D(4417);

/** Flat colour with a per-piece brightness and a little positional variation. */
function flat(g: Geo, hex: string, rng: Rng, piece = 0.08, jitter = 0.05): Geo {
  const base = col(hex);
  const k0 = 1 + (rng.next() - 0.5) * 2 * piece;
  return paint(g, (p) => {
    const k = k0 * (1 + jitter * noise.noise(p.x * 3.1 + p.y * 1.7, p.z * 2.3));
    return [base[0] * k, base[1] * k, base[2] * k];
  });
}

function boxG(size: V3, pos: V3, rot?: V3): Geo {
  return place(new THREE.BoxGeometry(size[0], size[1], size[2]), pos, rot);
}

/** Cylinder whose axis is x, y or z. */
function cylG(
  r0: number,
  r1: number,
  len: number,
  seg: number,
  axis: 'x' | 'y' | 'z',
  pos: V3,
): Geo {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, false);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  else if (axis === 'z') g.rotateX(Math.PI / 2);
  return place(g, pos);
}

function displace(g: Geo, amount: number, freq: number, seed: number): Geo {
  const n = new Noise2D(seed);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = n.fbm(v.x * freq + v.y * 0.7, v.z * freq - v.y * 0.5, 3);
    v.multiplyScalar(1 + k * amount);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

/** Icosphere that is welded so displacement does not tear, then flat-shaded. */
function lump(
  r: [number, number, number],
  detail: number,
  amount: number,
  freq: number,
  seed: number,
  pos: V3,
): Geo {
  const g = new THREE.IcosahedronGeometry(1, detail);
  displace(g, amount, freq, seed);
  g.scale(r[0], r[1], r[2]);
  g.translate(pos[0], pos[1], pos[2]);
  const flatG = g.index ? g.toNonIndexed() : g;
  flatG.computeVertexNormals();
  return flatG;
}

function merge(parts: Geo[]): Geo {
  const norm = parts.map((g) => {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo.attributes.uv) geo.deleteAttribute('uv');
    return geo;
  });
  const g = mergeGeometries(norm, false);
  if (!g) throw new Error('cabin placeholders: mergeGeometries failed');
  g.computeBoundingSphere();
  return g;
}

function stdMat(key: string, roughness = 0.9): THREE.MeshStandardMaterial {
  return patchMaterial(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0 }),
    { key },
  );
}

/** Warm window / lantern glass: only glows when the mood's post.nightLights > 0. */
function glowMat(): THREE.MeshStandardMaterial {
  return patchMaterial(
    new THREE.MeshStandardMaterial({
      color: '#1b2430',
      emissive: '#ffa850',
      emissiveIntensity: 6,
      roughness: 0.25,
      metalness: 0,
    }),
    { key: 'cabin-window-glow', nightLight: true },
  );
}

interface PartSpec {
  geo: Geo;
  mat: THREE.Material;
  shadow?: boolean;
}

function makeSpecies(variants: PartSpec[][][], height: number, radius: number): Species {
  const owned = new Set<Geo | THREE.Material>();
  const out: SpeciesPart[][][] = variants.map((lods) =>
    lods.map((parts) =>
      parts.map((p) => {
        owned.add(p.geo);
        owned.add(p.mat);
        return { geometry: p.geo, material: p.mat, castShadow: p.shadow ?? true };
      }),
    ),
  );
  return { variants: out, height, radius, owned: [...owned] };
}

/** Collect pieces of two material classes. */
class Parts {
  main: Geo[] = [];
  glow: Geo[] = [];
  mainMerged(): Geo {
    return merge(this.main);
  }
}

// --- log walls ----------------------------------------------------------------------------------

interface Opening {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

/** A horizontal round log along `axis` at fixed `plane`; cut ends are pale wood. */
function logPiece(
  axis: 'x' | 'z',
  plane: number,
  a0: number,
  a1: number,
  y: number,
  r: number,
  seg: number,
  rng: Rng,
): Geo {
  const len = a1 - a0;
  const mid = (a0 + a1) / 2;
  const pos: V3 = axis === 'x' ? [mid, y, plane] : [plane, y, mid];
  const g = cylG(r, r, len, seg, axis, pos);
  const base = col(LOG_COLORS[rng.int(0, LOG_COLORS.length - 1)]!);
  const cut = col(LOG_CUT);
  const k0 = 0.92 + rng.next() * 0.16;
  const ai = axis === 'x' ? 0 : 2;
  return paint(g, (p, n) => {
    const isCap = Math.abs(ai === 0 ? n.x : n.z) > 0.7;
    const c = isCap ? cut : base;
    const k = k0 * (1 + 0.1 * noise.noise(p.x * 5 + p.y * 3, p.z * 4));
    return [c[0] * k, c[1] * k, c[2] * k];
  });
}

function cutRanges(
  from: number,
  to: number,
  y: number,
  r: number,
  openings: Opening[],
): [number, number][] {
  let ranges: [number, number][] = [[from, to]];
  for (const o of openings) {
    if (!(o.y0 < y + r && o.y1 > y - r)) continue;
    const next: [number, number][] = [];
    for (const [a, b] of ranges) {
      if (o.a1 <= a || o.a0 >= b) next.push([a, b]);
      else {
        if (o.a0 > a) next.push([a, o.a0]);
        if (o.a1 < b) next.push([o.a1, b]);
      }
    }
    ranges = next;
  }
  return ranges.filter(([a, b]) => b - a > 0.06);
}

// --- the cabin ------------------------------------------------------------------------------------

const W = 7.0; // x extent of the walls
const D = 5.4; // z extent of the walls
const LOG_R = 0.17;
const LOG_PITCH = 0.31;
const BASE_Y = 0.45; // top of the stone foundation
const LAYERS = 9;
const WALL_TOP = 3.45;
const PITCH = (40 * Math.PI) / 180;
const RIDGE_Y = WALL_TOP + (D / 2) * Math.tan(PITCH);
const PORCH_Z = D / 2 + 2.1; // outer edge of the porch

function buildHouse(lod: 0 | 1): { main: Geo; glow: Geo } {
  const rng = new Rng(77);
  const P = new Parts();
  const seg = lod === 0 ? 10 : 6;
  const hx = W / 2;
  const hz = D / 2;

  const frontOpen: Opening[] = [
    { a0: -0.5, a1: 0.5, y0: BASE_Y - 0.1, y1: 2.52 },
    { a0: 1.85, a1: 2.85, y0: 1.15, y1: 2.05 },
    { a0: -2.85, a1: -1.85, y0: 1.15, y1: 2.05 },
  ];
  const backOpen: Opening[] = [{ a0: -0.6, a1: 0.5, y0: 1.15, y1: 2.05 }];
  const rightOpen: Opening[] = [{ a0: -0.6, a1: 0.6, y0: 1.15, y1: 2.05 }];

  // Stacked round logs. Front/back run along x, sides along z; ends cross past the corners
  // (saddle-notch look), sides sit half a step higher so the courses interlock.
  const ext = 0.32;
  for (let i = 0; i < LAYERS; i++) {
    const y = BASE_Y + LOG_R + i * LOG_PITCH;
    for (const [plane, open] of [
      [hz, frontOpen],
      [-hz, backOpen],
    ] as [number, Opening[]][]) {
      for (const [a, b] of cutRanges(-hx - ext, hx + ext, y, LOG_R, open))
        P.main.push(logPiece('x', plane, a, b, y, LOG_R, seg, rng));
    }
  }
  // Side walls continue up into the gable, shortening as the roof closes in.
  for (let i = 0; i < LAYERS + 6; i++) {
    const y = BASE_Y + LOG_R + LOG_PITCH / 2 + i * LOG_PITCH;
    const roofHalf = (RIDGE_Y - y) / Math.tan(PITCH) - 0.28;
    const half = Math.min(hz + ext, roofHalf + (y > WALL_TOP ? 0 : 99));
    if (half < 0.3) break;
    for (const [plane, open] of [
      [hx, rightOpen],
      [-hx, [] as Opening[]],
    ] as [number, Opening[]][]) {
      for (const [a, b] of cutRanges(-half, half, y, LOG_R, open))
        P.main.push(logPiece('z', plane, a, b, y, LOG_R, seg, rng));
    }
  }

  // Stone foundation.
  if (lod === 0) {
    const stoneRow = (axis: 'x' | 'z', plane: number, len: number, y: number, h: number) => {
      let a = -len / 2 - 0.1;
      while (a < len / 2 + 0.1) {
        const w = 0.45 + rng.next() * 0.5;
        const mid = a + w / 2;
        const sz: V3 = axis === 'x' ? [w - 0.02, h, 0.62] : [0.62, h, w - 0.02];
        const pos: V3 = axis === 'x' ? [mid, y, plane] : [plane, y, mid];
        P.main.push(flat(boxG(sz, pos), STONE[rng.int(0, STONE.length - 1)]!, rng, 0.12, 0.08));
        a += w;
      }
    };
    for (const [y, h] of [
      [BASE_Y - 0.24, 0.46],
      [BASE_Y - 0.62, 0.34],
    ] as [number, number][]) {
      stoneRow('x', hz, W + 0.4, y, h);
      stoneRow('x', -hz, W + 0.4, y, h);
      stoneRow('z', hx, D + 0.4, y, h);
      stoneRow('z', -hx, D + 0.4, y, h);
    }
  } else {
    P.main.push(flat(boxG([W + 0.5, 0.9, D + 0.5], [0, BASE_Y - 0.4, 0]), STONE[0]!, rng));
  }

  // Door (front, centred) with plank detail and trim.
  const dz = hz - 0.02;
  for (let i = 0; i < 4; i++)
    P.main.push(
      flat(
        boxG([0.24, 2.0, 0.09], [-0.375 + i * 0.25, BASE_Y + 1.0, dz]),
        i % 2 ? '#52331f' : '#4a2e1c',
        rng,
        0.1,
      ),
    );
  P.main.push(flat(boxG([0.9, 0.08, 0.1], [0, BASE_Y + 0.5, dz + 0.01]), IRON, rng, 0));
  P.main.push(flat(boxG([0.9, 0.08, 0.1], [0, BASE_Y + 1.6, dz + 0.01]), IRON, rng, 0));
  P.main.push(flat(boxG([0.06, 0.2, 0.08], [0.35, BASE_Y + 1.0, dz + 0.08]), IRON, rng, 0));
  // door frame
  P.main.push(flat(boxG([0.1, 2.2, 0.18], [-0.58, BASE_Y + 1.05, hz + 0.04]), DARK_WOOD, rng));
  P.main.push(flat(boxG([0.1, 2.2, 0.18], [0.58, BASE_Y + 1.05, hz + 0.04]), DARK_WOOD, rng));
  P.main.push(flat(boxG([1.26, 0.12, 0.18], [0, BASE_Y + 2.1, hz + 0.04]), DARK_WOOD, rng));

  // Windows: dark trim, sill, glowing pane and muntins.
  const window3 = (
    axis: 'z' | 'x',
    plane: number,
    sign: number,
    a0: number,
    a1: number,
    y0: number,
    y1: number,
  ) => {
    const am = (a0 + a1) / 2;
    const w = a1 - a0;
    const h = y1 - y0;
    const ym = (y0 + y1) / 2;
    const at = (a: number, y: number, o: number): V3 =>
      axis === 'z' ? [am + a, y, plane + sign * o] : [plane + sign * o, y, am + a];
    const sz = (sa: number, sy: number, so: number): V3 =>
      axis === 'z' ? [sa, sy, so] : [so, sy, sa];
    P.glow.push(boxG(sz(w, h, 0.05), at(0, ym, 0)));
    const t = 0.09;
    P.main.push(flat(boxG(sz(w + 0.2, t, 0.16), at(0, y1 + t / 2, 0.05)), DARK_WOOD, rng));
    P.main.push(flat(boxG(sz(w + 0.28, 0.1, 0.26), at(0, y0 - 0.05, 0.1)), PLANK[1]!, rng));
    P.main.push(flat(boxG(sz(t, h, 0.16), at(-w / 2 - t / 2 + 0.0, ym, 0.05)), DARK_WOOD, rng));
    P.main.push(flat(boxG(sz(t, h, 0.16), at(w / 2 + t / 2, ym, 0.05)), DARK_WOOD, rng));
    P.main.push(flat(boxG(sz(0.05, h, 0.09), at(0, ym, 0.03)), DARK_WOOD, rng));
    P.main.push(flat(boxG(sz(w, 0.05, 0.09), at(0, ym, 0.03)), DARK_WOOD, rng));
  };
  window3('z', hz, 1, 1.85, 2.85, 1.15, 2.05);
  window3('z', hz, 1, -2.85, -1.85, 1.15, 2.05);
  window3('z', -hz, -1, -0.6, 0.5, 1.15, 2.05);
  window3('x', hx, 1, -0.6, 0.6, 1.15, 2.05);

  // Porch deck, steps, posts, rails.
  const deckTop = BASE_Y;
  const deckZ0 = hz - 0.05;
  const deckLen = PORCH_Z - deckZ0;
  if (lod === 0) {
    const pw = 0.17;
    for (let i = 0; i * pw < 5.4; i++) {
      const x = -2.7 + pw / 2 + i * pw;
      P.main.push(
        flat(
          boxG([pw - 0.02, 0.1, deckLen], [x, deckTop - 0.05, deckZ0 + deckLen / 2]),
          PLANK[rng.int(0, 3)]!,
          rng,
          0.1,
        ),
      );
    }
  } else {
    P.main.push(
      flat(boxG([5.4, 0.1, deckLen], [0, deckTop - 0.05, deckZ0 + deckLen / 2]), PLANK[0]!, rng),
    );
  }
  P.main.push(flat(boxG([5.4, 0.5, 0.14], [0, deckTop - 0.3, PORCH_Z - 0.05]), PLANK[3]!, rng));
  P.main.push(
    flat(boxG([0.14, 0.5, deckLen], [-2.7, deckTop - 0.3, deckZ0 + deckLen / 2]), PLANK[3]!, rng),
  );
  P.main.push(
    flat(boxG([0.14, 0.5, deckLen], [2.7, deckTop - 0.3, deckZ0 + deckLen / 2]), PLANK[3]!, rng),
  );
  // steps
  for (let i = 0; i < 2; i++) {
    P.main.push(
      flat(
        boxG([1.7, 0.1, 0.34], [0, deckTop - 0.22 - i * 0.2, PORCH_Z + 0.2 + i * 0.32]),
        PLANK[2]!,
        rng,
      ),
    );
    P.main.push(
      flat(
        boxG([1.7, 0.16, 0.06], [0, deckTop - 0.3 - i * 0.2, PORCH_Z + 0.35 + i * 0.32]),
        PLANK[3]!,
        rng,
      ),
    );
  }
  // posts + header beam
  const postX = [-2.55, -1.05, 1.05, 2.55];
  const postTop = 2.62;
  const postZ = PORCH_Z - 0.2;
  for (const x of postX)
    P.main.push(
      flat(
        boxG([0.17, postTop - deckTop, 0.17], [x, (postTop + deckTop) / 2, postZ]),
        LOG_COLORS[1]!,
        rng,
      ),
    );
  P.main.push(flat(boxG([5.5, 0.2, 0.2], [0, postTop + 0.05, postZ]), LOG_COLORS[3]!, rng));
  // railing
  const rails: [number, number][] = [
    [-2.55, -1.05],
    [1.05, 2.55],
  ];
  for (const [a, b] of rails) {
    const mid = (a + b) / 2;
    P.main.push(flat(boxG([b - a, 0.07, 0.07], [mid, 1.35, postZ]), PLANK[0]!, rng));
    P.main.push(flat(boxG([b - a, 0.06, 0.06], [mid, 0.92, postZ]), PLANK[0]!, rng));
    if (lod === 0)
      for (let k = 1; k <= 3; k++)
        P.main.push(
          flat(boxG([0.05, 0.9, 0.05], [a + ((b - a) * k) / 4, 0.9, postZ]), PLANK[1]!, rng),
        );
  }
  for (const x of [-2.55, 2.55]) {
    P.main.push(
      flat(
        boxG([0.07, 0.07, deckLen - 0.2], [x, 1.35, deckZ0 + 0.1 + (deckLen - 0.2) / 2]),
        PLANK[0]!,
        rng,
      ),
    );
    P.main.push(
      flat(
        boxG([0.06, 0.06, deckLen - 0.2], [x, 0.92, deckZ0 + 0.1 + (deckLen - 0.2) / 2]),
        PLANK[0]!,
        rng,
      ),
    );
  }
  // porch lantern (glows at night)
  P.glow.push(boxG([0.2, 0.3, 0.2], [1.05, 2.1, postZ - 0.28]));
  P.main.push(flat(boxG([0.26, 0.05, 0.26], [1.05, 2.28, postZ - 0.28]), IRON, rng, 0));
  P.main.push(flat(boxG([0.26, 0.05, 0.26], [1.05, 1.94, postZ - 0.28]), IRON, rng, 0));
  P.main.push(flat(boxG([0.04, 0.3, 0.04], [1.05, 2.43, postZ - 0.28]), IRON, rng, 0));
  P.main.push(flat(boxG([0.04, 0.04, 0.3], [1.05, 2.5, postZ - 0.12]), IRON, rng, 0));

  // --- roof: boards + thick snow -----------------------------------------------------------------
  const tanP = Math.tan(PITCH);
  const oSide = 0.62;
  const roofW = W + oSide * 2;
  const boardT = 0.12;
  const snowT = 0.4;

  /** Slab along the line (z0,y0)->(z1,y1), thickness t, offset `off` along the up-normal. */
  const slab = (
    z0: number,
    y0: number,
    z1: number,
    y1: number,
    width: number,
    t: number,
    off: number,
    xc: number,
    extra = 0,
  ): Geo => {
    const dz2 = z1 - z0;
    const dy2 = y1 - y0;
    const L = Math.hypot(dz2, dy2) + extra;
    const ang = Math.atan2(-dy2, dz2); // rotation about x, +z end goes down
    const ux = dz2 / Math.hypot(dz2, dy2);
    const uy = dy2 / Math.hypot(dz2, dy2);
    const nz = -uy;
    const ny = ux;
    const mz = (z0 + z1) / 2 + (ux * extra) / 2 + nz * off;
    const my = (y0 + y1) / 2 + (uy * extra) / 2 + ny * off;
    const sgn = dz2 >= 0 ? 1 : -1;
    const g = new THREE.BoxGeometry(width, t, L);
    g.rotateX(sgn > 0 ? ang : -Math.atan2(-dy2, -dz2));
    g.translate(xc, my, mz);
    return g;
  };

  const eaveF = hz + 0.6;
  const eaveB = -(hz + 0.62);
  const yEF = WALL_TOP - 0.6 * tanP;
  const yEB = WALL_TOP - 0.62 * tanP;
  const roofBoard = (z1: number, y1: number) =>
    flat(slab(0, RIDGE_Y, z1, y1, roofW, boardT, -boardT / 2, 0), '#5a4330', rng, 0.1);
  P.main.push(roofBoard(eaveF, yEF));
  P.main.push(roofBoard(eaveB, yEB));

  // Snow on the main planes: lumpy chunks along x + eave roll.
  const chunks = lod === 0 ? 5 : 2;
  const snowSlab = (z1: number, y1: number): void => {
    for (let k = 0; k < chunks; k++) {
      const w = roofW / chunks;
      const t = snowT * (0.85 + rng.next() * 0.45);
      const g = slab(
        0,
        RIDGE_Y,
        z1,
        y1,
        w + 0.02,
        t,
        t / 2 + 0.01,
        -roofW / 2 + w * (k + 0.5),
        0.4,
      );
      P.main.push(
        paint(g, (p, n) => {
          const k2 = 1 - 0.03 * noise.noise(p.x * 1.3, p.z * 1.7) - (n.y < 0.2 ? 0.06 : 0);
          const c = col(n.y < 0.5 ? SNOW_SHADE : SNOW);
          return [c[0] * k2, c[1] * k2, c[2] * k2];
        }),
      );
    }
  };
  snowSlab(eaveF, yEF);
  snowSlab(eaveB, yEB);
  // eave rolls (the sagging cornice) + ridge cap
  for (const [z, y] of [
    [eaveF + 0.34, yEF - 0.14],
    [eaveB - 0.34, yEB - 0.14],
  ] as [number, number][]) {
    const g = cylG(0.26, 0.26, roofW + 0.5, lod === 0 ? 8 : 5, 'x', [0, y + 0.1, z]);
    P.main.push(flat(g, SNOW, rng, 0.02, 0.02));
  }
  {
    const g = new THREE.CylinderGeometry(0.5, 0.58, roofW + 0.5, lod === 0 ? 10 : 6).rotateZ(
      Math.PI / 2,
    );
    g.scale(1, 0.62, 1);
    g.translate(0, RIDGE_Y + 0.12, 0);
    P.main.push(flat(g, SNOW, rng, 0.02, 0.02));
  }
  // Porch roof: flatter skirt continuing from the front eave, with its own snow.
  {
    const skirtPitch = (15 * Math.PI) / 180;
    const z0 = eaveF;
    const y0 = yEF;
    const z1 = PORCH_Z + 0.25;
    const y1 = y0 - (z1 - z0) * Math.tan(skirtPitch);
    const sw = 5.9;
    P.main.push(flat(slab(z0, y0, z1, y1, sw, boardT, -boardT / 2, 0), '#5a4330', rng, 0.1));
    for (let k = 0; k < (lod === 0 ? 3 : 1); k++) {
      const w = sw / (lod === 0 ? 3 : 1);
      const t = 0.34 * (0.85 + rng.next() * 0.4);
      P.main.push(
        paint(
          slab(z0, y0, z1, y1, w + 0.02, t, t / 2 + 0.01, -sw / 2 + w * (k + 0.5), 0.25),
          (p, n) => {
            const c = col(n.y < 0.5 ? SNOW_SHADE : SNOW);
            const k2 = 1 - 0.03 * noise.noise(p.x * 1.1, p.z * 1.9);
            return [c[0] * k2, c[1] * k2, c[2] * k2];
          },
        ),
      );
    }
    P.main.push(
      flat(cylG(0.2, 0.2, sw + 0.4, 6, 'x', [0, y1 - 0.0, z1 + 0.22]), SNOW, rng, 0.02, 0.02),
    );
    // icicles
    if (lod === 0) {
      for (let k = 0; k < 14; k++) {
        const x = -2.8 + k * 0.43 + rng.next() * 0.15;
        const len = 0.18 + rng.next() * 0.34;
        const g = new THREE.ConeGeometry(0.035, len, 5).rotateX(Math.PI);
        P.main.push(flat(place(g, [x, y1 - 0.2 - len / 2, z1 + 0.34]), '#d4e8f6', rng, 0.04, 0.02));
      }
    }
  }

  // --- stone chimney against the +x gable end ------------------------------------------------------
  {
    const cx = -(hx + 0.72);
    const cz = -0.3;
    const rows = lod === 0 ? 20 : 4;
    const rowH = 0.34;
    const topY = RIDGE_Y + 1.3;
    const n = Math.floor((topY - 0) / rowH);
    for (let i = 0; i < (lod === 0 ? n : 0); i++) {
      const y = -0.1 + i * rowH + rowH / 2;
      const hearth = y < 2.5;
      const sx = hearth ? 1.5 : 1.05;
      const sz = hearth ? 1.7 : 1.25;
      const nb = hearth ? 3 : 2;
      for (let b = 0; b < nb; b++) {
        const w = sx / nb;
        const off = (i % 2) * 0.05;
        P.main.push(
          flat(
            boxG(
              [w - 0.015, rowH - 0.02, sz + (rng.next() - 0.5) * 0.04],
              [cx - sx / 2 + w * (b + 0.5) + off, y, cz],
            ),
            STONE[rng.int(0, STONE.length - 1)]!,
            rng,
            0.14,
            0.08,
          ),
        );
      }
    }
    if (lod === 1) {
      P.main.push(flat(boxG([1.5, 2.6, 1.7], [cx, 1.2, cz]), STONE[0]!, rng));
      P.main.push(flat(boxG([1.05, topY - 2.5, 1.25], [cx, (topY + 2.5) / 2, cz]), STONE[1]!, rng));
    }
    void rows;
    // shoulder (snow ledge) where the hearth narrows + cap
    P.main.push(flat(boxG([1.6, 0.16, 1.8], [cx, 2.55, cz]), SNOW, rng, 0.02, 0.02));
    P.main.push(flat(boxG([1.35, 0.18, 1.55], [cx, topY + 0.08, cz]), STONE[3]!, rng));
    P.main.push(flat(boxG([1.2, 0.22, 1.4], [cx, topY + 0.28, cz]), SNOW, rng, 0.02, 0.02));
    P.main.push(flat(boxG([0.55, 0.2, 0.55], [cx, topY + 0.12, cz]), IRON, rng, 0));
  }

  return { main: P.mainMerged(), glow: merge(P.glow) };
}

function houseSpecies(): Species {
  const mat = stdMat('cabin-house', 0.88);
  const glow = glowMat();
  const lods = ([0, 1] as const).map((l) => {
    const { main, glow: gl } = buildHouse(l);
    return [
      { geo: main, mat },
      { geo: gl, mat: glow, shadow: false },
    ] as PartSpec[];
  });
  return makeSpecies([lods], RIDGE_Y + 1.6, 5);
}

// --- woodpile under a lean-to ---------------------------------------------------------------------

function buildWoodpile(lod: 0 | 1): Geo {
  const rng = new Rng(311);
  const g: Geo[] = [];
  const Wd = 3.4;
  const Dp = 1.6;
  const H = 1.9;
  // corner posts (front taller than back so the roof slopes forward)
  const hb = 2.15;
  const hf = 1.75;
  for (const [x, z, h] of [
    [-Wd / 2, -Dp / 2, hb],
    [Wd / 2, -Dp / 2, hb],
    [-Wd / 2, Dp / 2, hf],
    [Wd / 2, Dp / 2, hf],
  ] as V3[])
    g.push(flat(boxG([0.14, h, 0.14], [x, h / 2, z]), LOG_COLORS[1]!, rng));
  // back wall boards
  for (let i = 0; i < 9; i++)
    g.push(
      flat(
        boxG(
          [Wd / 9 - 0.01, hb - 0.2, 0.05],
          [-Wd / 2 + (i + 0.5) * (Wd / 9), (hb - 0.2) / 2 + 0.05, -Dp / 2 - 0.03],
        ),
        PLANK[i % 4]!,
        rng,
        0.1,
      ),
    );
  // floor pallet
  g.push(flat(boxG([Wd - 0.1, 0.12, Dp - 0.1], [0, 0.06, 0]), '#5b4a37', rng));
  // roof: tilted boards + snow slab
  const slope = Math.atan2(hb - hf, Dp);
  const roofL = Math.hypot(Dp, hb - hf) + 0.9;
  const roof = new THREE.BoxGeometry(Wd + 0.8, 0.09, roofL);
  roof.rotateX(slope);
  roof.translate(0, (hb + hf) / 2 + 0.06, 0.2);
  g.push(flat(roof, '#4e3b2a', rng));
  const snow = new THREE.BoxGeometry(Wd + 0.95, 0.3, roofL + 0.1);
  snow.rotateX(slope);
  snow.translate(0, (hb + hf) / 2 + 0.26, 0.22);
  g.push(
    paint(snow, (p, n) => {
      const c = col(n.y < 0.5 ? SNOW_SHADE : SNOW);
      const k = 1 - 0.03 * noise.noise(p.x * 1.2, p.z * 1.4);
      return [c[0] * k, c[1] * k, c[2] * k];
    }),
  );
  g.push(
    flat(cylG(0.18, 0.18, Wd + 1.0, 6, 'x', [0, hf - 0.12, Dp / 2 + 0.62]), SNOW, rng, 0.02, 0.02),
  );
  // stacked split logs, end-grain facing +z
  const rowsN = 10;
  const colsN = 22;
  const r = Wd / colsN / 2;
  const seg = lod === 0 ? 6 : 4;
  if (lod === 0) {
    for (let row = 0; row < rowsN; row++) {
      const fill = row > 7 ? 0.55 : 1;
      for (let c = 0; c < colsN; c++) {
        if (rng.next() > fill) continue;
        const rr = r * (0.82 + rng.next() * 0.28);
        const x = -Wd / 2 + r + 0.07 + ((c + (row % 2) * 0.5) * (Wd - 0.2)) / colsN;
        if (x > Wd / 2 - 0.1) continue;
        const y = 0.12 + rr + row * r * 1.78;
        const len = Dp - 0.15 - rng.next() * 0.12;
        const geo = cylG(rr, rr, len, seg, 'z', [x, y, -0.04 - (rng.next() - 0.5) * 0.06]);
        const base = col(['#8f6a45', '#7b5a3a', '#a2784c', '#6a4a30'][rng.int(0, 3)]!);
        const cut = col('#d8b680');
        g.push(
          paint(geo, (_p, n) => {
            const c2 = Math.abs(n.z) > 0.7 ? cut : base;
            return [c2[0], c2[1], c2[2]];
          }),
        );
      }
    }
    // a loose pile of logs in front
    for (let i = 0; i < 6; i++) {
      const geo = cylG(0.09, 0.09, 0.75, 6, 'x', [
        -0.9 + (i % 3) * 0.2,
        0.1 + Math.floor(i / 3) * 0.17,
        Dp / 2 + 0.22,
      ]);
      g.push(flat(geo, '#8c6a46', rng, 0.1));
    }
  } else {
    g.push(flat(boxG([Wd - 0.2, 1.5, Dp - 0.2], [0, 0.85, 0]), '#8c6a46', rng));
  }
  void H;
  return merge(g);
}

// --- split-rail fence (one 3 m section; place several) -------------------------------------------

function buildFence(lod: 0 | 1): Geo {
  const rng = new Rng(613);
  const g: Geo[] = [];
  const L = 3.0;
  const seg = lod === 0 ? 6 : 4;
  const snowCap = (x: number, y: number, rx: number, ry: number, rz: number) => {
    const s = lump([rx, ry, rz], lod === 0 ? 1 : 0, 0.18, 2, 5 + Math.floor(x * 7), [x, y, 0]);
    g.push(paint(s, () => col(SNOW)));
  };
  for (const x of [-L / 2, L / 2]) {
    g.push(flat(cylG(0.075, 0.09, 1.55, seg, 'y', [x, 0.45, 0]), LOG_COLORS[3]!, rng, 0.1));
    // crossed leaning posts (the classic split-rail X)
    snowCap(x, 1.24, 0.17, 0.1, 0.17);
  }
  for (const [y, ang] of [
    [0.38, 0.015],
    [0.72, -0.012],
    [1.06, 0.02],
  ] as [number, number][]) {
    const rail = cylG(0.055, 0.055, L + 0.5, seg, 'x', [0, y, 0.0]);
    rail.rotateZ(ang);
    g.push(flat(rail, LOG_COLORS[rng.int(0, 4)]!, rng, 0.1));
    if (y > 1) {
      snowCap(-0.7, y + 0.07, 0.65, 0.07, 0.11);
      snowCap(0.75, y + 0.07, 0.55, 0.06, 0.1);
    }
  }
  return merge(g);
}

// --- small tool shed / outhouse ----------------------------------------------------------------

function buildShed(lod: 0 | 1): Geo {
  const rng = new Rng(907);
  const g: Geo[] = [];
  const w = 1.7;
  const d = 1.5;
  const hf = 2.35; // front height
  const hb = 2.0;
  g.push(flat(boxG([w + 0.3, 0.3, d + 0.3], [0, 0.0, 0]), STONE[0]!, rng));
  const planks = lod === 0 ? 8 : 1;
  for (let i = 0; i < planks; i++) {
    const pw = w / planks;
    const x = -w / 2 + pw * (i + 0.5);
    g.push(
      flat(
        boxG([pw - 0.01, hf - 0.1, 0.07], [x, (hf - 0.1) / 2 + 0.15, d / 2]),
        PLANK[i % 4]!,
        rng,
        0.1,
      ),
    ); // front
    g.push(
      flat(
        boxG([pw - 0.01, hb - 0.1, 0.07], [x, (hb - 0.1) / 2 + 0.15, -d / 2]),
        PLANK[(i + 1) % 4]!,
        rng,
        0.1,
      ),
    ); // back
  }
  const pd = d / (lod === 0 ? 7 : 1);
  for (let i = 0; i < (lod === 0 ? 7 : 1); i++) {
    const z = -d / 2 + pd * (i + 0.5);
    const hh = hb + ((hf - hb) * (z + d / 2)) / d;
    for (const sx of [-1, 1])
      g.push(
        flat(
          boxG([0.07, hh - 0.1, pd - 0.01], [sx * (w / 2), (hh - 0.1) / 2 + 0.15, z]),
          PLANK[(i + 2) % 4]!,
          rng,
          0.1,
        ),
      );
  }
  // door (front, slightly darker) + latch + little moon-ish vent
  g.push(flat(boxG([0.8, 1.7, 0.08], [0.0, 1.0, d / 2 + 0.05]), '#503520', rng, 0.05));
  g.push(flat(boxG([0.07, 0.2, 0.09], [0.28, 1.0, d / 2 + 0.11]), IRON, rng, 0));
  g.push(flat(boxG([0.3, 0.2, 0.09], [0.0, 1.65, d / 2 + 0.1]), DARK_WOOD, rng, 0));
  // mono-pitch roof + thick snow
  const slope = Math.atan2(hf - hb, d);
  const roofL = Math.hypot(d, hf - hb) + 0.5;
  const roof = new THREE.BoxGeometry(w + 0.5, 0.08, roofL);
  roof.rotateX(slope);
  roof.translate(0, (hf + hb) / 2 + 0.25, 0.08);
  g.push(flat(roof, '#4e3b2a', rng));
  const snow = new THREE.BoxGeometry(w + 0.6, 0.36, roofL + 0.1);
  snow.rotateX(slope);
  snow.translate(0, (hf + hb) / 2 + 0.47, 0.1);
  g.push(paint(snow, (_p, n) => col(n.y < 0.5 ? SNOW_SHADE : SNOW)));
  g.push(
    flat(cylG(0.2, 0.2, w + 0.7, 6, 'x', [0, hf - 0.02, d / 2 + 0.36]), SNOW, rng, 0.02, 0.02),
  );
  return merge(g);
}

// --- chopping block with axe ----------------------------------------------------------------------

function buildChopBlock(lod: 0 | 1): Geo {
  const rng = new Rng(1201);
  const g: Geo[] = [];
  const seg = lod === 0 ? 10 : 6;
  const block = cylG(0.34, 0.4, 0.55, seg, 'y', [0, 0.27, 0]);
  const bc = col('#7a5a3a');
  const cut = col('#cdaa74');
  g.push(
    paint(block, (_p, n) => {
      const c = n.y > 0.7 ? cut : bc;
      return [c[0], c[1], c[2]];
    }),
  );
  g.push(flat(lump([0.4, 0.07, 0.38], 1, 0.12, 2, 3, [0.02, 0.57, 0.0]), SNOW, rng, 0.02, 0.02));
  // axe stuck in the block
  g.push(
    flat(
      place(new THREE.CylinderGeometry(0.025, 0.03, 0.8, 5), [0.12, 0.88, 0.0], [0, 0, -0.35]),
      '#6a4b2c',
      rng,
    ),
  );
  g.push(flat(boxG([0.18, 0.12, 0.04], [0.02, 1.2, 0.0], [0, 0, -0.35]), IRON, rng, 0));
  // split logs lying around
  for (let i = 0; i < 4; i++) {
    const a = i * 1.7;
    const geo = cylG(0.09, 0.09, 0.4, 6, 'x', [Math.cos(a) * 0.75, 0.09, Math.sin(a) * 0.7]);
    geo.rotateY(a);
    g.push(flat(geo, '#8c6a46', rng, 0.12));
  }
  return merge(g);
}

// --- rocks, drifts, shrubs, fallen logs -------------------------------------------------------------

function snowRock(detail: number, seed: number, sx: number, sy: number, sz: number): Geo {
  const g = lump([sx, sy, sz], detail, 0.4, 0.9, seed, [0, sy * 0.28, 0]);
  const base = col(ROCK);
  const snow = col(SNOW);
  const shade = col(SNOW_SHADE);
  const rng = new Rng(seed);
  const rockJit = 0.9 + rng.next() * 0.2;
  return paint(g, (p, n) => {
    const t = THREE.MathUtils.smoothstep(n.y, 0.28, 0.6);
    const k = rockJit * (1 + 0.14 * noise.noise(p.x * 2.3 + p.y, p.z * 2.1));
    const s = n.y > 0.8 ? snow : shade;
    return [
      base[0] * k * (1 - t) + s[0] * t,
      base[1] * k * (1 - t) + s[1] * t,
      base[2] * k * (1 - t) + s[2] * t,
    ];
  });
}

function rockSpecies(): Species {
  const mat = stdMat('cabin-snowrock', 0.85);
  const shapes: [number, number, number, number][] = [
    [21, 1.35, 0.85, 1.0],
    [37, 1.0, 1.0, 1.15],
    [53, 1.25, 0.7, 0.9],
  ];
  const variants = shapes.map(([seed, sx, sy, sz]) =>
    [3, 2, 1].map((d) => [{ geo: snowRock(d, seed, sx, sy, sz), mat }] as PartSpec[]),
  );
  return makeSpecies(variants, 1.0, 1.4);
}

function driftGeo(detail: number, seed: number, rx: number, rz: number): Geo {
  const g = lump([rx, 0.34, rz], detail, 0.22, 0.8, seed, [0, 0.0, 0]);
  const a = col(SNOW);
  const b = col(SNOW_SHADE);
  return paint(g, (p, n) => {
    const t =
      THREE.MathUtils.clamp(0.5 + 0.5 * noise.noise(p.x * 0.9, p.z * 0.9), 0, 1) * (1 - n.y) * 1.2;
    return [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
  });
}

function driftSpecies(): Species {
  const mat = stdMat('cabin-drift', 0.95);
  const shapes: [number, number, number][] = [
    [5, 1.5, 1.0],
    [9, 1.2, 1.1],
    [14, 1.8, 0.8],
  ];
  const variants = shapes.map(([s, rx, rz]) =>
    [2, 1, 0].map((d) => [{ geo: driftGeo(d, s, rx, rz), mat, shadow: false }] as PartSpec[]),
  );
  return makeSpecies(variants, 0.4, 1.4);
}

function shrubGeo(detail: number, seed: number): Geo {
  const rng = new Rng(seed);
  const parts: Geo[] = [];
  const dark = col('#26382b');
  const snow = col(SNOW);
  const n = 3 + rng.int(0, 1);
  for (let i = 0; i < n; i++) {
    const r = 0.45 + rng.next() * 0.4;
    const pos: V3 =
      i === 0 ? [0, r * 0.45, 0] : [(rng.next() - 0.5) * 1.1, r * 0.4, (rng.next() - 0.5) * 1.1];
    const g = lump([r, r * 0.7, r], detail, 0.28, 1.2, seed + i, pos);
    parts.push(
      paint(g, (p, nn) => {
        const t = THREE.MathUtils.smoothstep(nn.y, 0.2, 0.55);
        const k = 1 + 0.2 * noise.noise(p.x * 3, p.z * 3);
        return [
          dark[0] * k * (1 - t) + snow[0] * t,
          dark[1] * k * (1 - t) + snow[1] * t,
          dark[2] * k * (1 - t) + snow[2] * t,
        ];
      }),
    );
  }
  return merge(parts);
}

function shrubSpecies(): Species {
  const mat = stdMat('cabin-shrub', 0.92);
  const variants = [61, 67, 73].map((s) =>
    [2, 1, 0].map((d) => [{ geo: shrubGeo(d, s), mat }] as PartSpec[]),
  );
  return makeSpecies(variants, 0.9, 1.0);
}

function snowLogGeo(len: number, r: number, seg: number, seed: number): Geo {
  const rng = new Rng(seed);
  const parts: Geo[] = [];
  const log = cylG(r, r * 1.08, len, seg, 'x', [0, r * 0.9, 0]);
  const bc = col('#5f4630');
  const cut = col('#b99a6c');
  parts.push(
    paint(log, (p, n) => {
      const c = Math.abs(n.x) > 0.7 ? cut : bc;
      const k = 1 + 0.12 * noise.noise(p.x * 2, p.z * 4);
      return [c[0] * k, c[1] * k, c[2] * k];
    }),
  );
  const cap = lump([len * 0.46, r * 0.5, r * 0.85], seg > 5 ? 1 : 0, 0.15, 1.5, seed, [
    (rng.next() - 0.5) * 0.3,
    r * 1.6,
    0,
  ]);
  parts.push(paint(cap, () => col(SNOW)));
  return merge(parts);
}

function snowLogSpecies(): Species {
  const mat = stdMat('cabin-snowlog', 0.9);
  const variants = [
    [4.5, 0.26, 3],
    [6.5, 0.32, 8],
    [3.2, 0.22, 12],
  ].map(([len, r, s]) =>
    [10, 6].map((seg, i) => [{ geo: snowLogGeo(len!, r!, seg, s! + i), mat }] as PartSpec[]),
  );
  return makeSpecies(variants, 0.9, 3);
}

// --- registration ----------------------------------------------------------------------------

function simpleSpecies(
  key: string,
  builder: (lod: 0 | 1) => Geo,
  height: number,
  radius: number,
  rough = 0.9,
): Species {
  const mat = stdMat(key, rough);
  const lods = ([0, 1] as const).map((l) => [{ geo: builder(l), mat }] as PartSpec[]);
  return makeSpecies([lods], height, radius);
}

export function registerCabinPlaceholders(): void {
  registerPlaceholder('cabin:house', houseSpecies);
  registerPlaceholder('cabin:woodpile', () =>
    simpleSpecies('cabin-woodpile', buildWoodpile, 2.3, 2.2),
  );
  registerPlaceholder('cabin:fence', () => simpleSpecies('cabin-fence', buildFence, 1.4, 1.6));
  registerPlaceholder('cabin:shed', () => simpleSpecies('cabin-shed', buildShed, 3, 1.4));
  registerPlaceholder('cabin:chopblock', () =>
    simpleSpecies('cabin-chopblock', buildChopBlock, 1.3, 1.0),
  );
  registerPlaceholder('cabin:snowrock', rockSpecies);
  registerPlaceholder('cabin:drift', driftSpecies);
  registerPlaceholder('cabin:shrub', shrubSpecies);
  registerPlaceholder('cabin:snowlog', snowLogSpecies);
}
