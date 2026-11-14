// Per-scene material library + world-space triplanar PBR materials.
//
// Greybox/procedural geometry (houses, ruins, cabins …) has no UVs, so scene materials are applied
// by triplanar projection in world space (instancing-aware). Scene placeholder builders ask for a
// material by pack key; SceneRuntime fills the library from scene.json `materials` before any
// species is built, and clears/disposes it on scene exit. Builders must NOT dispose library
// materials (do not add them to Species.owned).
import * as THREE from 'three';
import type { PbrMaterialMaps } from '../assets/AssetLoader';
import { patchMaterial } from './materials';

export interface TriplanarOptions {
  /** Metres per texture repeat. */
  scale: number;
  /** Multiplies the albedo (sRGB hex), e.g. to warm or darken a texture. */
  tint?: string;
  /** Multiplies roughness from the ARM map. */
  roughness?: number;
  side?: THREE.Side;
  /** Blend sharpness between projection axes (higher = crisper seams). */
  sharpness?: number;
  snow?: boolean;
}

const library = new Map<string, THREE.Material>();

export function setSceneMaterial(key: string, m: THREE.Material): void {
  library.set(key, m);
}

/** Library material for `key`, or `fallback` when the scene/pack does not provide it. */
export function sceneMaterial<T extends THREE.Material>(key: string, fallback: T): THREE.Material {
  return library.get(key) ?? fallback;
}

export function hasSceneMaterial(key: string): boolean {
  return library.has(key);
}

export function clearSceneMaterials(): void {
  for (const m of library.values()) m.dispose();
  library.clear();
}

const PARS = /* glsl */ `
uniform sampler2D tTriC; uniform sampler2D tTriN; uniform sampler2D tTriA;
uniform float uTriScale; uniform float uTriSharp; uniform vec3 uTriTint; uniform float uTriRough;
varying vec3 vTriWorld; varying vec3 vTriNormal;
vec3 triW(vec3 n) { vec3 b = pow(abs(n), vec3(uTriSharp)); return b / (b.x + b.y + b.z); }
vec4 triSample(sampler2D t, vec3 p, vec3 w) {
  return texture(t, p.zy * uTriScale) * w.x + texture(t, p.xz * uTriScale) * w.y + texture(t, p.xy * uTriScale) * w.z;
}
vec3 triNormal(vec3 p, vec3 n, vec3 w) {
  vec3 tx = texture(tTriN, p.zy * uTriScale).xyz * 2.0 - 1.0;
  vec3 ty = texture(tTriN, p.xz * uTriScale).xyz * 2.0 - 1.0;
  vec3 tz = texture(tTriN, p.xy * uTriScale).xyz * 2.0 - 1.0;
  // Whiteout blend; sign-correct for faces pointing along negative axes.
  vec3 s = sign(n);
  tx = vec3(tx.xy * vec2(s.x, 1.0) + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy * vec2(1.0, s.y) + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy * vec2(-s.z, 1.0) + n.xy, abs(tz.z) * n.z);
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}
`;

export function createTriplanarMaterial(
  key: string,
  maps: PbrMaterialMaps,
  o: TriplanarOptions,
): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    name: `tri:${key}`,
    roughness: 1,
    metalness: 0,
    side: o.side ?? THREE.FrontSide,
  });
  for (const t of [maps.map, maps.normalMap, maps.armMap]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const uniforms = {
    tTriC: { value: maps.map },
    tTriN: { value: maps.normalMap },
    tTriA: { value: maps.armMap },
    uTriScale: { value: 1 / o.scale },
    uTriSharp: { value: o.sharpness ?? 6 },
    uTriTint: { value: new THREE.Color(o.tint ?? '#ffffff') },
    uTriRough: { value: o.roughness ?? 1 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vTriWorld;\nvarying vec3 vTriNormal;',
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 tw = vec4(transformed, 1.0);
          mat3 tn = mat3(modelMatrix);
          #ifdef USE_INSTANCING
            tw = instanceMatrix * tw;
            tn = tn * mat3(instanceMatrix);
          #endif
          vTriWorld = (modelMatrix * tw).xyz;
          vTriNormal = normalize(tn * objectNormal);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace(
        '#include <map_fragment>',
        `vec3 triN = normalize(vTriNormal);
        vec3 triWt = triW(triN);
        vec3 triArm = triSample(tTriA, vTriWorld, triWt).rgb;
        diffuseColor.rgb *= triSample(tTriC, vTriWorld, triWt).rgb * uTriTint;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = clamp(triArm.g * uTriRough, 0.04, 1.0);',
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace(
        '#include <normal_fragment_maps>',
        `{ vec3 nW = triNormal(vTriWorld, triN, triWt);
           normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz) * faceDirection; }`,
      )
      .replace(
        '#include <aomap_fragment>',
        `{ float ambientOcclusion = mix(1.0, triArm.r, 0.8);
           reflectedLight.indirectDiffuse *= ambientOcclusion;
           #if defined( USE_ENVMAP ) && defined( STANDARD )
             float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
             reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
           #endif
         }`,
      );
  };
  return patchMaterial(mat, { key: `tri-${key}`, snow: o.snow });
}
