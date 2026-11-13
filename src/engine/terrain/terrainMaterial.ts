// Terrain splat material: 4 PBR layers (color / normal / ARM each) blended by a splat texture with
// height-based transitions, optional triplanar projection per layer (steep rock), shader-only
// anti-tiling, and per-vertex wetness (creek banks). Built on MeshStandardMaterial so lighting,
// shadows, IBL and our height fog all keep working.
//
// Texture budget: 12 layer maps + 1 splat (+ shadow map + env map) = 15 ≤ 16 units (iPad GPUs).
import * as THREE from 'three';
import type { PbrMaterialMaps } from '../assets/AssetLoader';
import { patchMaterial } from '../render/materials';

export interface TerrainLayerMaps {
  maps: PbrMaterialMaps;
  /** Metres per texture repeat. */
  scale: number;
  triplanar: boolean;
}

export interface TerrainMaterialOptions {
  layers: TerrainLayerMaps[]; // exactly 4 (pad by repeating the last)
  splat: THREE.DataTexture; // RGBA weights for layers 0..3
  terrainSize: number;
  splatRes: number;
  antiTiling: boolean;
}

const GLSL_PARS = /* glsl */ `
uniform sampler2D tSplat;
uniform sampler2D tC0; uniform sampler2D tC1; uniform sampler2D tC2; uniform sampler2D tC3;
uniform sampler2D tN0; uniform sampler2D tN1; uniform sampler2D tN2; uniform sampler2D tN3;
uniform sampler2D tA0; uniform sampler2D tA1; uniform sampler2D tA2; uniform sampler2D tA3;
uniform vec4 uScale;      // 1 / metres-per-repeat
uniform vec4 uTriplanar;  // 1 = triplanar
uniform float uTerrainSize;
uniform float uSplatRes;
uniform float uNormalStrength;
varying vec3 vTWorld;
varying vec3 vTNormal;
varying float vWet;

float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y);
}

// Planar (top-down) sample with optional anti-tiling: blend a second, rotated, larger-scale sample
// using low-frequency noise so repeats are broken up (colour only — normals stay single-sample).
vec4 tTop(sampler2D t, vec2 uv, float anti) {
  vec4 a = texture(t, uv);
#ifdef TERRAIN_ANTITILE
  if (anti > 0.5) {
    const mat2 R = mat2(0.8, -0.6, 0.6, 0.8);
    vec4 b = texture(t, R * uv * 0.37 + 0.31);
    float n = smoothstep(0.35, 0.65, tNoise(uv * 0.17));
    a = mix(a, b, n * 0.55);
  }
#endif
  return a;
}

vec3 tTriBlend(vec3 n) {
  vec3 b = pow(abs(n), vec3(4.0));
  return b / (b.x + b.y + b.z);
}

vec4 tSample(sampler2D t, vec3 wp, vec3 wn, float scale, float tri, float anti) {
  if (tri < 0.5) return tTop(t, wp.xz * scale, anti);
  vec3 b = tTriBlend(wn);
  return texture(t, wp.zy * scale) * b.x + tTop(t, wp.xz * scale, anti) * b.y + texture(t, wp.xy * scale) * b.z;
}

// Whiteout-blended triplanar normal (or top projection only), returned in world space.
vec3 tNormal(sampler2D t, vec3 wp, vec3 wn, float scale, float tri) {
  vec3 tnY = texture(t, wp.xz * scale).xyz * 2.0 - 1.0;
  tnY.xy *= uNormalStrength;
  vec3 rY = vec3(tnY.xy + wn.xz, abs(tnY.z) * wn.y);
  if (tri < 0.5) return normalize(rY.xzy);
  vec3 b = tTriBlend(wn);
  vec3 tnX = texture(t, wp.zy * scale).xyz * 2.0 - 1.0; tnX.xy *= uNormalStrength;
  vec3 tnZ = texture(t, wp.xy * scale).xyz * 2.0 - 1.0; tnZ.xy *= uNormalStrength;
  vec3 rX = vec3(tnX.xy + wn.zy, abs(tnX.z) * wn.x);
  vec3 rZ = vec3(tnZ.xy + wn.xy, abs(tnZ.z) * wn.z);
  return normalize(rX.zyx * b.x + rY.xzy * b.y + rZ.xyz * b.z);
}
`;

const GLSL_LAYERS = /* glsl */ `
  vec3 tWn = normalize(vTNormal);
  vec2 sUv = (vTWorld.xz / uTerrainSize + 0.5) * (uSplatRes - 1.0) / uSplatRes + 0.5 / uSplatRes;
  vec4 splat = texture(tSplat, sUv);
  // Layer samples (anti-tiling only on the large flat ground layers 0..2).
  vec4 c0 = tSample(tC0, vTWorld, tWn, uScale.x, uTriplanar.x, 1.0);
  vec4 c1 = tSample(tC1, vTWorld, tWn, uScale.y, uTriplanar.y, 1.0);
  vec4 c2 = tSample(tC2, vTWorld, tWn, uScale.z, uTriplanar.z, 1.0);
  vec4 c3 = tSample(tC3, vTWorld, tWn, uScale.w, uTriplanar.w, 0.0);
  vec4 a0 = tSample(tA0, vTWorld, tWn, uScale.x, uTriplanar.x, 0.0);
  vec4 a1 = tSample(tA1, vTWorld, tWn, uScale.y, uTriplanar.y, 0.0);
  vec4 a2 = tSample(tA2, vTWorld, tWn, uScale.z, uTriplanar.z, 0.0);
  vec4 a3 = tSample(tA3, vTWorld, tWn, uScale.w, uTriplanar.w, 0.0);
  // Height-based blend: AO (cavity) acts as a height proxy so moss fills cracks and rock tops poke out.
  vec4 h = splat * 1.6 + vec4(a0.r, a1.r, a2.r, a3.r) * 0.6;
  float hMax = max(max(h.x, h.y), max(h.z, h.w));
  vec4 w = max(h - (hMax - 0.25), 0.0) * step(0.002, splat);
  w /= max(w.x + w.y + w.z + w.w, 1e-4);
  vec3 tAlbedo = c0.rgb * w.x + c1.rgb * w.y + c2.rgb * w.z + c3.rgb * w.w;
  vec3 tArm = a0.rgb * w.x + a1.rgb * w.y + a2.rgb * w.z + a3.rgb * w.w;
  // Macro variation: very low-frequency brightness/hue drift kills large-scale repetition.
  float macro = tNoise(vTWorld.xz * 0.025) * 0.6 + tNoise(vTWorld.xz * 0.11) * 0.4;
  tAlbedo *= mix(0.86, 1.1, macro);
  // Wet banks: darker, glossier.
  tAlbedo *= 1.0 - 0.42 * vWet;
  diffuseColor.rgb *= tAlbedo;
`;

export function createTerrainMaterial(o: TerrainMaterialOptions): THREE.MeshStandardMaterial {
  const L = o.layers;
  const mat = new THREE.MeshStandardMaterial({ name: 'terrain-splat', roughness: 1, metalness: 0 });
  const uniforms: Record<string, THREE.IUniform> = {
    tSplat: { value: o.splat },
    uScale: { value: new THREE.Vector4(...L.map((l) => 1 / l.scale)) },
    uTriplanar: { value: new THREE.Vector4(...L.map((l) => (l.triplanar ? 1 : 0))) },
    uTerrainSize: { value: o.terrainSize },
    uSplatRes: { value: o.splatRes },
    uNormalStrength: { value: 1.0 },
  };
  L.forEach((l, i) => {
    uniforms[`tC${i}`] = { value: l.maps.map };
    uniforms[`tN${i}`] = { value: l.maps.normalMap };
    uniforms[`tA${i}`] = { value: l.maps.armMap };
  });
  if (o.antiTiling) mat.defines = { TERRAIN_ANTITILE: '' };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aWet;\nvarying vec3 vTWorld;\nvarying vec3 vTNormal;\nvarying float vWet;',
      )
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTNormal = normalize(mat3(modelMatrix) * objectNormal);\nvWet = aWet;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_PARS)
      .replace('#include <map_fragment>', GLSL_LAYERS)
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = mix(clamp(tArm.g, 0.04, 1.0), 0.16, vWet * 0.85);',
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec3 n0 = tNormal(tN0, vTWorld, tWn, uScale.x, uTriplanar.x);
          vec3 n1 = tNormal(tN1, vTWorld, tWn, uScale.y, uTriplanar.y);
          vec3 n2 = tNormal(tN2, vTWorld, tWn, uScale.z, uTriplanar.z);
          vec3 n3 = tNormal(tN3, vTWorld, tWn, uScale.w, uTriplanar.w);
          vec3 nW = normalize(n0 * w.x + n1 * w.y + n2 * w.z + n3 * w.w);
          nW = normalize(mix(nW, tWn, vWet * 0.5));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`,
      )
      .replace(
        '#include <aomap_fragment>',
        `{
          float ambientOcclusion = mix(1.0, tArm.r, 0.85);
          reflectedLight.indirectDiffuse *= ambientOcclusion;
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
            reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
          #endif
        }`,
      );
  };
  return patchMaterial(mat, { key: `terrain${o.antiTiling ? '-at' : ''}` });
}
