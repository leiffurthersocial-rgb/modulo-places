// Terrain rendering: one grid mesh. With real layer materials it uses the splat shader
// (terrainMaterial.ts); without them (greybox / missing assets) it falls back to vertex colours plus
// procedural detail textures.
import * as THREE from 'three';
import { hashSeed, Noise2D, smoothstep } from '../core/random';
import { patchMaterial } from '../render/materials';
import type { TerrainDef, TerrainLayerDef } from '../types';
import { distToPolyline, smoothPolyline } from './polyline';
import { createTerrainMaterial, type TerrainLayerMaps } from './terrainMaterial';
import { type Heightfield, sampleHeight, sampleSlope } from './heightfield';

export interface SplatSampler {
  /** Normalised weight of layer id at (x, z) (rules, then paths and creek banks painted on top). */
  weight(layer: string, x: number, z: number): number;
  /** 0..1 wetness near the creek. */
  wetness(x: number, z: number): number;
}

function band(v: number, r: [number, number] | undefined, soft: number): number {
  if (!r) return 1;
  return smoothstep(r[0] - soft, r[0] + soft, v) * (1 - smoothstep(r[1] - soft, r[1] + soft, v));
}

export function createSplatSampler(def: TerrainDef, hf: Heightfield, seed: number): SplatSampler {
  const layers = def.layers;
  const noise = new Noise2D(hashSeed(seed, 'splat'));
  const raw = (l: TerrainLayerDef, x: number, z: number, i: number) => {
    const slope = sampleSlope(hf, x, z);
    const h = sampleHeight(hf, x, z);
    let w = band(slope, l.slope, 4) * band(h, l.height, 1.5);
    if (l.noise)
      w *= THREE.MathUtils.clamp(
        0.5 + noise.fbm(x * 0.045 + i * 19.7, z * 0.045, 3) * l.noise * 1.5,
        0,
        1,
      );
    return w + 1e-4;
  };
  const paths = (def.paths ?? []).map((p) => ({ ...p, pts: smoothPolyline(p.points, 8) }));
  const creek = def.creek ? { ...def.creek, pts: smoothPolyline(def.creek.points, 10) } : null;
  const edgeNoise = (x: number, z: number) => noise.fbm(x * 0.35, z * 0.35, 2) * 0.35;
  const paint = (x: number, z: number): { layer: string; k: number }[] => {
    const out: { layer: string; k: number }[] = [];
    if (creek?.bankLayer) {
      const { d } = distToPolyline(creek.pts, x, z);
      out.push({
        layer: creek.bankLayer,
        k: 1 - smoothstep(creek.width * 0.6, creek.width * (2.2 + edgeNoise(x, z) * 2), d),
      });
    }
    for (const p of paths) {
      const { d } = distToPolyline(p.pts, x, z);
      out.push({
        layer: p.layer,
        k: 1 - smoothstep(p.width * 0.35, p.width * (0.6 + edgeNoise(x, z)), d),
      });
    }
    return out;
  };
  return {
    weight(layer, x, z) {
      let sum = 0;
      let mine = 0;
      layers.forEach((l, i) => {
        const w = raw(l, x, z, i);
        sum += w;
        if (l.id === layer) mine = w;
      });
      let v = sum > 0 ? mine / sum : 0;
      for (const p of paint(x, z)) v = v * (1 - p.k) + (p.layer === layer ? p.k : 0);
      return v;
    },
    wetness(x, z) {
      if (!creek) return 0;
      const { d } = distToPolyline(creek.pts, x, z);
      return 1 - smoothstep(creek.width * 0.4, creek.width * 2.0, d);
    },
  };
}

function detailTextures(seed: number): { map: THREE.DataTexture; normal: THREE.DataTexture } {
  const N = 256;
  const n = new Noise2D(hashSeed(seed, 'detail'));
  const hgt = new Float32Array(N * N);
  // Tileable noise via 4D-ish torus trick: sample on two circles.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const a = (x / N) * Math.PI * 2;
      const b = (y / N) * Math.PI * 2;
      const r = 4;
      const v =
        n.fbm(Math.cos(a) * r + Math.cos(b) * r * 0.5, Math.sin(a) * r + Math.sin(b) * r * 0.5, 5) *
          0.6 +
        n.noise(Math.cos(a) * r * 4, Math.sin(b) * r * 4) * 0.4;
      hgt[y * N + x] = v;
    }
  }
  const albedo = new Uint8Array(N * N * 4);
  const normal = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const v = hgt[i]!;
      const g = Math.round(THREE.MathUtils.clamp(215 + v * 45, 0, 255));
      albedo.set([g, g, g, 255], i * 4);
      const hx = hgt[y * N + ((x + 1) % N)]! - hgt[y * N + ((x - 1 + N) % N)]!;
      const hy = hgt[((y + 1) % N) * N + x]! - hgt[((y - 1 + N) % N) * N + x]!;
      const s = 1.1;
      const nx = -hx * s;
      const ny = -hy * s;
      const len = Math.hypot(nx, ny, 1);
      normal.set(
        [
          ((nx / len) * 0.5 + 0.5) * 255,
          ((ny / len) * 0.5 + 0.5) * 255,
          ((1 / len) * 0.5 + 0.5) * 255,
          255,
        ],
        i * 4,
      );
    }
  }
  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(albedo, true), normal: mk(normal, false) };
}

export interface TerrainBuildOptions {
  anisotropy: number;
  /** Real layer materials (index-aligned with def.layers, first 4 used); null → greybox colours. */
  layerMaps?: (TerrainLayerMaps | null)[] | null;
  antiTiling?: boolean;
}

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  readonly splat: SplatSampler;
  private textures: THREE.Texture[] = [];

  constructor(hf: Heightfield, def: TerrainDef, seed: number, opts: TerrainBuildOptions) {
    const layers = def.layers;
    this.splat = createSplatSampler(def, hf, seed);
    const geo = new THREE.PlaneGeometry(hf.size, hf.size, hf.res - 1, hf.res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const wet = new Float32Array(pos.count);
    const splatData = new Uint8Array(hf.res * hf.res * 4);
    const layerColors = layers.map((l) => new THREE.Color(l.color));
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      // PlaneGeometry rotated -90° about X: row 0 is at z = -size/2, matching our row-major layout.
      const ix = Math.round((x + hf.size / 2) / hf.step);
      const iz = Math.round((z + hf.size / 2) / hf.step);
      pos.setY(i, hf.heights[iz * hf.res + ix]!);
      tmp.setRGB(0, 0, 0);
      const ws = layers.map((l) => this.splat.weight(l.id, x, z));
      ws.forEach((w, li) => {
        tmp.r += layerColors[li]!.r * w;
        tmp.g += layerColors[li]!.g * w;
        tmp.b += layerColors[li]!.b * w;
      });
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
      const sum4 = Math.max(1e-4, (ws[0] ?? 0) + (ws[1] ?? 0) + (ws[2] ?? 0) + (ws[3] ?? 0));
      const o = (iz * hf.res + ix) * 4;
      for (let k = 0; k < 4; k++) splatData[o + k] = Math.round(((ws[k] ?? 0) / sum4) * 255);
      wet[i] = this.splat.wetness(x, z);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aWet', new THREE.BufferAttribute(wet, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const real = opts.layerMaps?.slice(0, 4);
    let mat: THREE.Material;
    if (real && real.length > 0 && real.every((l) => l)) {
      const L = real as TerrainLayerMaps[];
      while (L.length < 4) L.push(L[L.length - 1]!);
      const splat = new THREE.DataTexture(splatData, hf.res, hf.res, THREE.RGBAFormat);
      splat.magFilter = THREE.LinearFilter;
      splat.minFilter = THREE.LinearFilter;
      splat.needsUpdate = true;
      this.textures.push(splat);
      mat = createTerrainMaterial({
        layers: L,
        splat,
        terrainSize: hf.size,
        splatRes: hf.res,
        antiTiling: opts.antiTiling ?? true,
      });
    } else {
      const { map, normal } = detailTextures(seed);
      map.anisotropy = normal.anisotropy = opts.anisotropy;
      map.repeat.set(hf.size / 4.5, hf.size / 4.5);
      normal.repeat.copy(map.repeat);
      this.textures.push(map, normal);
      const roughness = layers.reduce((s, l) => s + l.roughness, 0) / Math.max(1, layers.length);
      mat = patchMaterial(
        new THREE.MeshStandardMaterial({
          name: 'terrain',
          vertexColors: true,
          map,
          normalMap: normal,
          normalScale: new THREE.Vector2(0.6, 0.6),
          roughness,
          metalness: 0,
        }),
      );
    }
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
  }

  setAnisotropy(a: number): void {
    for (const t of this.textures) {
      t.anisotropy = a;
      t.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    for (const t of this.textures) t.dispose();
  }
}
