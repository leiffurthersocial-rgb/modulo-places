// Candidate materials for the lab: texture loading/caching, tuning and the wet/frost/moss shader
// extension chained on top of the engine's patchMaterial (so fog keeps working).
import * as THREE from 'three';
import { patchMaterial } from '../engine/render/materials';
import type { LabMaterial } from './manifest';

export interface Tuning {
  /** UV repeats per metre. */
  tiling: number;
  normalStrength: number;
  roughnessMul: number;
}

export const DEFAULT_TUNING: Tuning = { tiling: 1, normalStrength: 1, roughnessMul: 1 };

/** Shared by every lab material: sliders update .value once. */
export const labUniforms = {
  uLabWet: { value: 0 },
  uLabFrost: { value: 0 },
  uLabMoss: { value: 0 },
};

export const candidateKey = (c: { source: string; id: string }): string => `${c.source}:${c.id}`;

const NOISE_GLSL = /* glsl */ `
varying vec3 vLabWPos;
varying vec3 vLabWNrm;
uniform float uLabWet;
uniform float uLabFrost;
uniform float uLabMoss;
float labHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float labNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(labHash(i), labHash(i + vec3(1,0,0)), f.x), mix(labHash(i + vec3(0,1,0)), labHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(labHash(i + vec3(0,0,1)), labHash(i + vec3(1,0,1)), f.x), mix(labHash(i + vec3(0,1,1)), labHash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float labFbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * labNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}`;

const COAT_GLSL = /* glsl */ `
float labWet = 0.0;
float labFrost = 0.0;
float labMoss = 0.0;
{
  vec3 lwn = normalize(vLabWNrm);
  float lup = clamp(lwn.y, 0.0, 1.0);
  float lao = 1.0;
  #ifdef USE_AOMAP
    lao = texture2D(aoMap, vAoMapUv).r;
  #endif
  float cav = 1.0 - smoothstep(0.35, 1.0, lao);
  float n1 = labFbm(vLabWPos * 2.3);
  float n2 = labFbm(vLabWPos * 5.1 + 7.0);
  float mscore = lup * 0.5 + cav * 0.5 + (n1 - 0.5) * 0.9;
  float mth = 1.05 - uLabMoss * 0.85;
  labMoss = smoothstep(mth, mth + 0.16, mscore) * step(0.001, uLabMoss);
  float fscore = lup * 0.9 + (n2 - 0.5) * 0.7;
  float fth = 1.0 - uLabFrost * 0.95;
  labFrost = smoothstep(fth - 0.05, fth + 0.12, fscore) * step(0.001, uLabFrost) * (1.0 - labMoss * 0.6);
  labWet = clamp(uLabWet * (0.75 + 0.35 * cav), 0.0, 1.0);
  vec3 mossCol = mix(vec3(0.02, 0.055, 0.01), vec3(0.07, 0.14, 0.02), n2);
  diffuseColor.rgb *= 1.0 - 0.45 * labWet * (0.55 + 0.45 * cav);
  diffuseColor.rgb = mix(diffuseColor.rgb, mossCol, labMoss * 0.92);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.86, 0.96), labFrost * 0.85);
}`;

/** Chain wet/frost/moss onto a material already patched by patchMaterial. */
export function patchLabMaterial<T extends THREE.MeshStandardMaterial>(mat: T): T {
  patchMaterial(mat);
  const prevCompile = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(mat, shader, renderer);
    shader.uniforms.uLabWet = labUniforms.uLabWet;
    shader.uniforms.uLabFrost = labUniforms.uLabFrost;
    shader.uniforms.uLabMoss = labUniforms.uLabMoss;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLabWPos;\nvarying vec3 vLabWNrm;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vLabWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vLabWNrm = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${COAT_GLSL}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.08, labWet * 0.9);
roughnessFactor = mix(roughnessFactor, 0.95, labMoss);
roughnessFactor = mix(roughnessFactor, max(roughnessFactor, 0.72), labFrost);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
normal = normalize(mix(normal, nonPerturbedNormal, clamp(labWet * 0.35 + labMoss * 0.5 + labFrost * 0.5, 0.0, 1.0)));`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey()}:lab-wfm-v1`;
  return mat;
}

export type LoadState = 'loading' | 'ready' | 'error';

export class CandidateMaterial {
  readonly material: THREE.MeshStandardMaterial;
  state: LoadState = 'loading';
  error = '';
  readonly urls: string[];
  disposed = false;

  constructor(
    readonly candidate: LabMaterial,
    private lib: MaterialLibrary,
  ) {
    this.material = patchLabMaterial(
      new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.85, metalness: 0 }),
    );
    this.material.name = candidateKey(candidate);
    const m = candidate.maps;
    this.urls = [m.color, m.normal, ...(m.arm ? [m.arm] : [])];
  }
}

export class MaterialLibrary {
  private items = new Map<string, CandidateMaterial>();
  private textures = new Map<string, Promise<THREE.Texture>>();
  private loaded = new Map<string, THREE.Texture>();
  private loader = new THREE.TextureLoader();
  tuning: Tuning = { ...DEFAULT_TUNING };
  onChange: () => void = () => undefined;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.loader.setCrossOrigin('anonymous');
  }

  private texture(url: string, srgb: boolean): Promise<THREE.Texture> {
    let p = this.textures.get(url);
    if (!p) {
      p = this.loader.loadAsync(url).then((t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        t.repeat.set(this.tuning.tiling, this.tuning.tiling);
        this.loaded.set(url, t);
        return t;
      });
      this.textures.set(url, p);
      p.catch(() => this.textures.delete(url));
    }
    return p;
  }

  get(c: LabMaterial): CandidateMaterial {
    const key = candidateKey(c);
    const existing = this.items.get(key);
    if (existing) return existing;
    const cm = new CandidateMaterial(c, this);
    this.items.set(key, cm);
    this.applyTo(cm);
    void this.load(cm);
    return cm;
  }

  private async load(cm: CandidateMaterial): Promise<void> {
    const m = cm.candidate.maps;
    try {
      const [color, normal, arm] = await Promise.all([
        this.texture(m.color, true),
        this.texture(m.normal, false),
        m.arm ? this.texture(m.arm, false) : Promise.resolve(null),
      ]);
      if (cm.disposed) return;
      const mat = cm.material;
      mat.map = color;
      mat.color.set(0xffffff);
      mat.normalMap = normal;
      if (arm) {
        mat.aoMap = arm;
        mat.roughnessMap = arm;
        mat.metalnessMap = arm;
        mat.metalness = 1;
        mat.roughness = 1;
      }
      mat.needsUpdate = true;
      cm.state = 'ready';
      this.applyTo(cm);
    } catch (e) {
      cm.state = 'error';
      cm.error = e instanceof Error ? e.message : 'texture failed to load';
      if (m.color.startsWith('http')) cm.error = `Could not load textures (${m.color})`;
    }
    this.onChange();
  }

  private applyTo(cm: CandidateMaterial): void {
    const t = this.tuning;
    const mat = cm.material;
    for (const tex of [mat.map, mat.normalMap, mat.aoMap]) tex?.repeat.set(t.tiling, t.tiling);
    mat.normalScale.set(t.normalStrength, t.normalStrength);
    if (mat.roughnessMap) mat.roughness = t.roughnessMul;
    else mat.roughness = Math.min(1, 0.85 * t.roughnessMul);
  }

  setTuning(t: Tuning): void {
    this.tuning = { ...t };
    for (const cm of this.items.values()) this.applyTo(cm);
  }

  /** Dispose every candidate material (and unreferenced textures) not in `keep`. */
  prune(keep: ReadonlySet<string>): void {
    for (const [key, cm] of this.items) {
      if (keep.has(key)) continue;
      cm.disposed = true;
      cm.material.dispose();
      this.items.delete(key);
    }
    const used = new Set<string>();
    for (const cm of this.items.values()) for (const u of cm.urls) used.add(u);
    for (const [url, tex] of this.loaded) {
      if (used.has(url)) continue;
      tex.dispose();
      this.loaded.delete(url);
      this.textures.delete(url);
    }
    // Pending loads for dropped URLs: drop the cache entry so a later request starts fresh.
    for (const url of [...this.textures.keys()]) if (!used.has(url)) this.textures.delete(url);
  }

  dispose(): void {
    this.prune(new Set());
  }

  get stats(): { materials: number; textures: number } {
    return { materials: this.items.size, textures: this.loaded.size };
  }
}
