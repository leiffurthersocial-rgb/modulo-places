// Terrain rendering for the greybox: one indexed grid mesh with per-vertex splat weights blended
// into vertex colours, plus tiling procedural detail (albedo variation + normal) textures. Phase 3
// replaces the colours with a real splat shader sampling KTX2 layer textures.
import * as THREE from 'three';
import { hashSeed, Noise2D, smoothstep } from '../core/random';
import { patchMaterial } from '../render/materials';
import type { TerrainLayerDef } from '../types';
import { type Heightfield, sampleHeight, sampleSlope } from './heightfield';

export interface SplatSampler {
  /** Normalised weight of layer id at (x, z). */
  weight(layer: string, x: number, z: number): number;
}

function band(v: number, r: [number, number] | undefined, soft: number): number {
  if (!r) return 1;
  return smoothstep(r[0] - soft, r[0] + soft, v) * (1 - smoothstep(r[1] - soft, r[1] + soft, v));
}

export function createSplatSampler(
  layers: TerrainLayerDef[],
  hf: Heightfield,
  seed: number,
): SplatSampler {
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
  return {
    weight(layer, x, z) {
      let sum = 0;
      let mine = 0;
      layers.forEach((l, i) => {
        const w = raw(l, x, z, i);
        sum += w;
        if (l.id === layer) mine = w;
      });
      return sum > 0 ? mine / sum : 0;
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

export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  readonly splat: SplatSampler;
  private textures: THREE.Texture[];

  constructor(hf: Heightfield, layers: TerrainLayerDef[], seed: number, anisotropy: number) {
    this.splat = createSplatSampler(layers, hf, seed);
    const geo = new THREE.PlaneGeometry(hf.size, hf.size, hf.res - 1, hf.res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
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
      layers.forEach((l, li) => {
        const w = this.splat.weight(l.id, x, z);
        tmp.r += layerColors[li]!.r * w;
        tmp.g += layerColors[li]!.g * w;
        tmp.b += layerColors[li]!.b * w;
      });
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const { map, normal } = detailTextures(seed);
    map.anisotropy = normal.anisotropy = anisotropy;
    map.repeat.set(hf.size / 4.5, hf.size / 4.5);
    normal.repeat.copy(map.repeat);
    this.textures = [map, normal];
    const roughness = layers.reduce((s, l) => s + l.roughness, 0) / Math.max(1, layers.length);
    const mat = patchMaterial(
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
