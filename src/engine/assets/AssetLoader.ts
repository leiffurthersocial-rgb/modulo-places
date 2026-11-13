// Runtime asset loading for one scene: reads /pack/manifest.json (written by process-assets.ts),
// loads KTX2 material tiers, meshopt GLBs and HDRIs, and disposes everything it created on dispose().
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export type Tier = 512 | 1024 | 2048 | 4096;

export interface PackManifest {
  materials: Record<
    string,
    {
      source: string;
      id: string;
      tiers: Partial<Record<Tier, { color: string; normal: string; arm: string; bytes: number }>>;
    }
  >;
  models: Record<
    string,
    { source: string; id: string; file: string; bytes: number; lods: number; triangles: number[] }
  >;
  hdris: Record<string, { source: string; id: string; '1k': string; '2k': string; bytes: number }>;
  audio: Record<string, { ogg: string; m4a: string; bytes: number }>;
}

export interface PbrMaterialMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** R = AO, G = roughness, B = metalness (glTF ORM layout, usable as aoMap/roughnessMap/metalnessMap). */
  armMap: THREE.Texture;
}

let manifestPromise: Promise<PackManifest | null> | null = null;
export function loadPackManifest(): Promise<PackManifest | null> {
  manifestPromise ??= fetch('/pack/manifest.json')
    .then((r) => (r.ok ? (r.json() as Promise<PackManifest>) : null))
    .catch(() => null);
  return manifestPromise;
}

export class AssetLoader {
  private ktx2: KTX2Loader;
  private gltf: GLTFLoader;
  private hdr = new HDRLoader();
  private textures = new Map<string, Promise<THREE.Texture>>();
  private owned = new Set<THREE.Texture | THREE.BufferGeometry | THREE.Material>();
  bytesLoaded = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    readonly manifest: PackManifest,
    private onBytes?: (bytes: number) => void,
  ) {
    this.ktx2 = new KTX2Loader().setTranscoderPath('/vendor/basis/').detectSupport(renderer);
    this.ktx2.setWorkerLimit(2);
    this.gltf = new GLTFLoader().setKTX2Loader(this.ktx2).setMeshoptDecoder(MeshoptDecoder);
  }

  /** Highest available tier ≤ requested (falls back to the lowest available). */
  pickTier(key: string, wanted: Tier): Tier | null {
    const tiers = Object.keys(this.manifest.materials[key]?.tiers ?? {})
      .map(Number)
      .sort((a, b) => a - b) as Tier[];
    if (tiers.length === 0) return null;
    return [...tiers].reverse().find((t) => t <= wanted) ?? tiers[0]!;
  }

  private ktx(url: string, srgb: boolean, anisotropy: number): Promise<THREE.Texture> {
    let p = this.textures.get(url);
    if (!p) {
      p = this.ktx2.loadAsync(url).then((t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = anisotropy;
        t.needsUpdate = true;
        this.owned.add(t);
        return t;
      });
      this.textures.set(url, p);
    }
    return p;
  }

  async material(key: string, tier: Tier, anisotropy: number): Promise<PbrMaterialMaps | null> {
    const t = this.pickTier(key, tier);
    const entry = t ? this.manifest.materials[key]?.tiers[t] : undefined;
    if (!entry) return null;
    const [map, normalMap, armMap] = await Promise.all([
      this.ktx(entry.color, true, anisotropy),
      this.ktx(entry.normal, false, anisotropy),
      this.ktx(entry.arm, false, anisotropy),
    ]);
    this.bytesLoaded += entry.bytes;
    this.onBytes?.(entry.bytes);
    return { map, normalMap, armMap };
  }

  async model(key: string): Promise<GLTF | null> {
    const m = this.manifest.models[key];
    if (!m) return null;
    const g = await this.gltf.loadAsync(m.file);
    this.bytesLoaded += m.bytes;
    this.onBytes?.(m.bytes);
    g.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.owned.add(mesh.geometry);
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        this.owned.add(mat);
        for (const v of Object.values(mat))
          if ((v as THREE.Texture)?.isTexture) this.owned.add(v as THREE.Texture);
      }
    });
    return g;
  }

  async hdri(key: string, res: '1k' | '2k'): Promise<THREE.DataTexture | null> {
    const h = this.manifest.hdris[key];
    if (!h) return null;
    const t = await this.hdr.loadAsync(h[res]);
    t.mapping = THREE.EquirectangularReflectionMapping;
    this.owned.add(t);
    this.bytesLoaded += h.bytes / 2;
    return t;
  }

  /** Take ownership of something derived from loaded assets (e.g. cloned materials). */
  own<T extends THREE.Texture | THREE.BufferGeometry | THREE.Material>(x: T): T {
    this.owned.add(x);
    return x;
  }

  dispose(): void {
    for (const x of this.owned) x.dispose();
    this.owned.clear();
    this.textures.clear();
    this.ktx2.dispose();
  }
}
