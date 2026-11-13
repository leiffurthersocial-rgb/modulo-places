// Greybox species: procedurally built low-poly meshes with vertex colours and LOD chains.
// Replaced by real assets (glTF + impostors) in Phase 2/3; ids stay the same so scene.json works.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Noise2D } from '../core/random';

export interface Species {
  lods: THREE.BufferGeometry[];
  material: THREE.MeshStandardMaterial;
  wind: number;
  windHeight: number;
  flutter: number;
  /** Local-space height (m) at scale 1, for collision proxies. */
  height: number;
  radius: number;
  doubleSided?: boolean;
}

function paint(
  g: THREE.BufferGeometry,
  color: THREE.ColorRepresentation,
  jitter = 0,
  seed = 1,
): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = geo.attributes.position!.count;
  const arr = new Float32Array(n * 3);
  const noise = new Noise2D(seed);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) {
    const k = 1 + jitter * noise.noise(p.getX(i) * 3.1 + p.getY(i) * 1.7, p.getZ(i) * 2.3);
    arr.set([c.r * k, c.g * k, c.b * k], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  return geo;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('mergeGeometries failed');
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function displace(
  g: THREE.BufferGeometry,
  amount: number,
  freq: number,
  seed: number,
): THREE.BufferGeometry {
  const noise = new Noise2D(seed);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = noise.fbm(v.x * freq + v.y * 0.7, v.z * freq - v.y * 0.5, 3);
    v.multiplyScalar(1 + n * amount);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function conifer(seg: number, tiers: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(
    paint(
      new THREE.CylinderGeometry(0.12, 0.28, 10, Math.max(4, seg - 2)).translate(0, 5, 0),
      '#4a3a2c',
      0.15,
      3,
    ),
  );
  for (let i = 0; i < tiers; i++) {
    const t = i / Math.max(1, tiers - 1);
    const r = 2.6 - t * 1.9;
    const h = 3.6 - t * 1.4;
    const y = 3.2 + t * 7.2;
    parts.push(
      paint(
        new THREE.ConeGeometry(r, h, seg, 1, true).translate(0, y, 0),
        t > 0.6 ? '#2f4a2a' : '#283f24',
        0.25,
        7 + i,
      ),
    );
  }
  return merge(parts);
}

function broadleaf(detail: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    paint(new THREE.CylinderGeometry(0.18, 0.35, 7, 7).translate(0, 3.5, 0), '#4b3c30', 0.15, 2),
  ];
  const blobs: [number, number, number, number][] = [
    [0, 8, 0, 2.6],
    [1.6, 7, 0.6, 1.9],
    [-1.4, 7.3, -0.8, 2.0],
    [0.4, 6.4, -1.6, 1.7],
    [-0.6, 9.4, 0.7, 1.6],
  ];
  blobs.forEach(([x, y, z, r], i) => {
    const g = displace(new THREE.IcosahedronGeometry(r, detail), 0.25, 0.6, 11 + i).translate(
      x,
      y,
      z,
    );
    parts.push(paint(g, i % 2 ? '#3b5a2e' : '#34502a', 0.3, 20 + i));
  });
  return merge(parts);
}

function rock(detail: number, seed: number): THREE.BufferGeometry {
  const g = displace(new THREE.IcosahedronGeometry(1, detail), 0.35, 0.9, seed);
  g.scale(1.2, 0.7, 1);
  g.translate(0, 0.25, 0);
  return merge([paint(g, '#77746c', 0.18, seed)]);
}

function bush(detail: number): THREE.BufferGeometry {
  const parts = [
    displace(new THREE.IcosahedronGeometry(0.8, detail), 0.3, 1.2, 5).translate(0, 0.55, 0),
    displace(new THREE.IcosahedronGeometry(0.6, detail), 0.3, 1.2, 6).translate(0.5, 0.45, 0.2),
    displace(new THREE.IcosahedronGeometry(0.55, detail), 0.3, 1.2, 7).translate(-0.4, 0.4, -0.3),
  ].map((g, i) => paint(g, '#38522c', 0.3, 30 + i));
  return merge(parts);
}

/** Tuft of tapered blades (real geometry, no alpha). */
function grass(blades: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const base = new THREE.Color('#5d7a3a');
  const tip = new THREE.Color('#a8b56a');
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + i * 0.7;
    const r = 0.06 + (i % 3) * 0.05;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = 0.35 + ((i * 37) % 10) / 22;
    const w = 0.025;
    const lean = 0.12 + (i % 4) * 0.04;
    const tx = x + Math.cos(a) * lean;
    const tz = z + Math.sin(a) * lean;
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    pos.push(x - px, 0, z - pz, x + px, 0, z + pz, tx, h, tz);
    col.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  // Grass shades better with up-facing normals (avoids dark back faces).
  const n = g.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, n.getX(i) * 0.3, 1, n.getZ(i) * 0.3);
  n.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

function fern(fronds: number, segs: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const c0 = new THREE.Color('#2f5a26');
  const c1 = new THREE.Color('#4f7d34');
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs;
      const t1 = (s + 1) / segs;
      const L = 0.9;
      const p = (t: number) =>
        [dx * t * L, Math.sin(t * Math.PI * 0.85) * 0.45, dz * t * L] as const;
      const w0 = Math.sin(t0 * Math.PI) * 0.13 + 0.01;
      const w1 = Math.sin(t1 * Math.PI) * 0.13 + 0.01;
      const a0 = p(t0);
      const a1 = p(t1);
      const sx = -dz;
      const sz = dx;
      pos.push(
        a0[0] - sx * w0,
        a0[1],
        a0[2] - sz * w0,
        a0[0] + sx * w0,
        a0[1],
        a0[2] + sz * w0,
        a1[0] + sx * w1,
        a1[1],
        a1[2] + sz * w1,
      );
      pos.push(
        a0[0] - sx * w0,
        a0[1],
        a0[2] - sz * w0,
        a1[0] + sx * w1,
        a1[1],
        a1[2] + sz * w1,
        a1[0] - sx * w1,
        a1[1],
        a1[2] - sz * w1,
      );
      for (let k = 0; k < 6; k++) {
        const c = c0.clone().lerp(c1, t0);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function log(seg: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.28, 0.32, 6, seg)
    .rotateZ(Math.PI / 2)
    .translate(0, 0.22, 0);
  return merge([paint(displace(g, 0.05, 2, 9), '#5a4836', 0.2, 9)]);
}

function pebble(detail: number): THREE.BufferGeometry {
  return merge([
    paint(
      displace(new THREE.IcosahedronGeometry(0.12, detail), 0.3, 6, 13)
        .scale(1, 0.6, 1)
        .translate(0, 0.04, 0),
      '#7c786f',
      0.2,
      13,
    ),
  ]);
}

function stump(): THREE.BufferGeometry {
  return merge([
    paint(new THREE.CylinderGeometry(0.38, 0.5, 0.7, 9).translate(0, 0.3, 0), '#4f3f30', 0.2, 17),
  ]);
}

function material(doubleSided = false): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

export function buildPlaceholderSpecies(id: string): Species {
  switch (id) {
    case 'tree':
      return {
        lods: [conifer(10, 5), conifer(6, 4), conifer(4, 3)],
        material: material(),
        wind: 0.18,
        windHeight: 12,
        flutter: 0.01,
        height: 10,
        radius: 0.3,
      };
    case 'broadleaf':
      return {
        lods: [broadleaf(2), broadleaf(1), broadleaf(0)],
        material: material(),
        wind: 0.22,
        windHeight: 10,
        flutter: 0.02,
        height: 9,
        radius: 0.35,
      };
    case 'bush':
      return {
        lods: [bush(2), bush(1), bush(0)],
        material: material(),
        wind: 0.05,
        windHeight: 1.2,
        flutter: 0.01,
        height: 1.1,
        radius: 0.8,
      };
    case 'rock':
      return {
        lods: [rock(3, 21), rock(2, 21), rock(1, 21)],
        material: material(),
        wind: 0,
        windHeight: 1,
        flutter: 0,
        height: 0.9,
        radius: 1.1,
      };
    case 'boulder':
      return {
        lods: [rock(4, 23), rock(3, 23), rock(1, 23)],
        material: material(),
        wind: 0,
        windHeight: 1,
        flutter: 0,
        height: 0.9,
        radius: 1.1,
      };
    case 'grass':
      return {
        lods: [grass(9), grass(5), grass(3)],
        material: material(true),
        wind: 0.07,
        windHeight: 0.6,
        flutter: 0.01,
        height: 0.5,
        radius: 0.2,
        doubleSided: true,
      };
    case 'fern':
      return {
        lods: [fern(9, 6), fern(6, 3), fern(4, 2)],
        material: material(true),
        wind: 0.06,
        windHeight: 0.5,
        flutter: 0.015,
        height: 0.45,
        radius: 0.9,
        doubleSided: true,
      };
    case 'log':
      return {
        lods: [log(10), log(6)],
        material: material(),
        wind: 0,
        windHeight: 1,
        flutter: 0,
        height: 0.6,
        radius: 0.3,
      };
    case 'pebble':
      return {
        lods: [pebble(1), pebble(0)],
        material: material(),
        wind: 0,
        windHeight: 1,
        flutter: 0,
        height: 0.1,
        radius: 0.12,
      };
    case 'stump':
      return {
        lods: [stump()],
        material: material(),
        wind: 0,
        windHeight: 1,
        flutter: 0,
        height: 0.7,
        radius: 0.5,
      };
    default:
      return {
        lods: [merge([paint(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), '#ff00ff')])],
        material: material(),
        wind: 0,
        windHeight: 1,
        flutter: 0,
        height: 1,
        radius: 0.5,
      };
  }
}
