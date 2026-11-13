// Material extensions shared by every scene material, injected with onBeforeCompile so scene code
// keeps using MeshStandardMaterial (keeps a WebGPU/TSL port contained to this file; DECISIONS D-006).
//
// 1. Exponential height fog (analytic integral along the view ray) with sun in-scattering tint.
// 2. Optional wind: main bend (height-weighted sway, per-instance phase) + detail flutter.
import * as THREE from 'three';

/** Shared uniform objects: updating .value here updates every patched material. */
export const sharedUniforms = {
  uTime: { value: 0 },
  uFogColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
  uFogDensity: { value: 0.02 },
  uFogHeightFalloff: { value: 0.1 },
  uFogBaseHeight: { value: 0 },
  uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uFogSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
  uFogSunScatter: { value: 0.3 },
  uWindDir: { value: new THREE.Vector2(1, 0.3).normalize() },
  uWindStrength: { value: 1 },
  uMotion: { value: 1 }, // 0 = frozen (photo mode pause / reduce motion)
};

export const FOG_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogBaseHeight;
uniform vec3 uFogSunDir;
uniform vec3 uFogSunColor;
uniform float uFogSunScatter;

// Integral of density(h) = d * exp(-b * (h - h0)) along the segment camera -> point.
float heightFogAmount(vec3 camPos, vec3 worldPos) {
  vec3 ray = worldPos - camPos;
  float dist = length(ray);
  float b = max(uFogHeightFalloff, 1e-4);
  float camTerm = uFogDensity * exp(-b * (camPos.y - uFogBaseHeight));
  float dy = ray.y;
  float k = b * dy;
  float lineIntegral = abs(k) > 1e-3 ? (1.0 - exp(-k)) / k : 1.0 - 0.5 * k;
  float optical = camTerm * lineIntegral * dist;
  return 1.0 - exp(-max(optical, 0.0));
}

vec3 heightFogColor(vec3 viewDir) {
  float s = pow(max(dot(viewDir, uFogSunDir), 0.0), 8.0) * uFogSunScatter;
  return mix(uFogColor, uFogSunColor, clamp(s, 0.0, 1.0));
}
`;

let chunksInstalled = false;

/**
 * Replace three's fog chunks globally. Fog only activates on materials where `fog: true` AND the
 * scene has a `scene.fog` (we set a FogExp2 placeholder so USE_FOG is defined), and the material
 * was patched (patchMaterial adds the uniforms). Unpatched materials with fog would fail to compile,
 * so every scene material must go through patchMaterial or set fog: false.
 */
export function installFogChunks(): void {
  if (chunksInstalled) return;
  chunksInstalled = true;
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vec4 fogWP = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    fogWP = batchingMatrix * fogWP;
  #endif
  #ifdef USE_INSTANCING
    fogWP = instanceMatrix * fogWP;
  #endif
  vFogWorldPos = (modelMatrix * fogWP).xyz;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
  ${FOG_GLSL}
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  vec3 fogView = normalize(vFogWorldPos - cameraPosition);
  float fogF = heightFogAmount(cameraPosition, vFogWorldPos);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, heightFogColor(fogView), fogF);
#endif`;
}

export interface PatchOptions {
  /** Wind sway amplitude (m at the top of the object). 0 disables. */
  wind?: number;
  /** Object height used to normalise the bend mask (m, in local space). */
  windHeight?: number;
  /** Leaf flutter amplitude (m). */
  flutter?: number;
  /**
   * Distinguishes shader variants whose onBeforeCompile code differs (e.g. "terrain"). three's
   * program cache does not hash onBeforeCompile, so different custom shaders MUST use different keys.
   */
  key?: string;
}

const patched = new WeakSet<THREE.Material>();

export function patchMaterial<T extends THREE.Material>(mat: T, opts: PatchOptions = {}): T {
  if (patched.has(mat)) return mat;
  patched.add(mat);
  const wind = opts.wind ?? 0;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    shader.uniforms.uFogColor = sharedUniforms.uFogColor;
    shader.uniforms.uFogDensity = sharedUniforms.uFogDensity;
    shader.uniforms.uFogHeightFalloff = sharedUniforms.uFogHeightFalloff;
    shader.uniforms.uFogBaseHeight = sharedUniforms.uFogBaseHeight;
    shader.uniforms.uFogSunDir = sharedUniforms.uFogSunDir;
    shader.uniforms.uFogSunColor = sharedUniforms.uFogSunColor;
    shader.uniforms.uFogSunScatter = sharedUniforms.uFogSunScatter;
    if (wind > 0) {
      shader.uniforms.uTime = sharedUniforms.uTime;
      shader.uniforms.uWindDir = sharedUniforms.uWindDir;
      shader.uniforms.uWindStrength = sharedUniforms.uWindStrength;
      shader.uniforms.uMotion = sharedUniforms.uMotion;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uMotion;`,
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
{
  vec3 basePos = vec3(0.0);
  vec3 windLocal = vec3(uWindDir.x, 0.0, uWindDir.y);
  #ifdef USE_INSTANCING
    basePos = instanceMatrix[3].xyz;
    // Rotate world wind into instance space (rotation + uniform scale: inverse = transpose / s^2).
    mat3 im = mat3(instanceMatrix);
    windLocal = transpose(im) * windLocal / max(dot(im[0], im[0]), 1e-4);
  #endif
  basePos = (modelMatrix * vec4(basePos, 1.0)).xyz;
  float phase = dot(basePos.xz, vec2(0.37, 0.21));
  float t = uTime * uMotion;
  float h = clamp(position.y / ${(opts.windHeight ?? 1).toFixed(3)}, 0.0, 1.5);
  float bendMask = h * h;
  float gust = 0.55 + 0.45 * sin(t * 0.35 + phase * 0.15) * sin(t * 0.13 + phase * 0.05);
  float sway = (sin(t * 1.1 + phase) * 0.6 + sin(t * 2.3 + phase * 1.7) * 0.25 + 0.35) * gust;
  vec3 bend = windLocal * sway * ${wind.toFixed(4)} * uWindStrength * bendMask;
  float fl = ${(opts.flutter ?? 0).toFixed(4)} * h * sin(t * 7.0 + dot(position, vec3(3.1, 2.3, 4.7)) + phase) * uWindStrength;
  transformed += bend + vec3(fl, fl * 0.5, -fl) * 0.5;
  transformed.y -= length(bend.xz) * 0.15 * bendMask;
}`,
        );
    }
  };
  // Stable cache key so patched materials with identical options share programs.
  mat.customProgramCacheKey = () =>
    `modulo:${opts.key ?? 'std'}:w${wind}:${opts.windHeight ?? 1}:${opts.flutter ?? 0}`;
  return mat;
}
