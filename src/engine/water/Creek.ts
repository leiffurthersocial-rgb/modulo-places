// Forest creek water: a ribbon following the carved channel, a cheap procedural-normal water shader
// (no render targets, no textures) and an optional pebble bed ribbon underneath.
import * as THREE from 'three';
import type { PbrMaterialMaps } from '../assets/AssetLoader';
import { patchMaterial, sharedUniforms } from '../render/materials';
import { smoothPolyline } from '../terrain/polyline';
import {
  downstreamSlope,
  minCrossSectionHeight,
  resampleUniform,
  ribbonIndices,
  waterProfile,
} from './math';

export interface CreekOptions {
  points: [number, number][];
  width: number;
  groundHeight: (x: number, z: number) => number;
  bed?: PbrMaterialMaps | null;
  quality: 'simple' | 'reflect' | 'refract';
}

const COLS = 9;
const SPACING = 0.6;
const WATER_DEPTH = 0.18;
const BED_TILE = 0.8;

const QUALITY_INDEX = { simple: 0, reflect: 1, refract: 2 } as const;

const VERT_PARS = /* glsl */ `
attribute float aSlope;
attribute vec2 aTan;
varying vec2 vWUv;
varying float vWSlope;
varying vec2 vWTan;
varying vec3 vWPos;
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform float uMotion;
uniform float uQ;
uniform float uWidth;
varying vec2 vWUv;
varying float vWSlope;
varying vec2 vWTan;
varying vec3 vWPos;

float wHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
}
// Gradient of a sum of 4 travelling sines (p.x across, p.y along; metres).
vec2 wRipple(vec2 p, float scale, float seed) {
  p *= scale;
  p += 0.35 * sin(p.yx * 0.9 + seed);
  vec2 g = vec2(0.0);
  vec2 k0 = vec2(1.0, 0.35);
  vec2 k1 = vec2(-0.7, 1.15);
  vec2 k2 = vec2(1.75, -0.45);
  vec2 k3 = vec2(0.45, 1.9);
  g += k0 * cos(dot(k0, p) * 1.00 + seed);
  g += k1 * cos(dot(k1, p) * 1.37 + seed * 1.7) * 0.8;
  g += k2 * cos(dot(k2, p) * 0.83 + seed * 2.3) * 0.6;
  g += k3 * cos(dot(k3, p) * 1.91 + seed * 0.4) * 0.45;
  return g * scale * 0.22;
}
`;

function buildWaterMaterial(uQ: { value: number }, width: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.04, 0.09, 0.055),
    roughness: 0.03,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    fog: true,
  });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -1;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = sharedUniforms.uTime;
    shader.uniforms.uMotion = sharedUniforms.uMotion;
    shader.uniforms.uQ = uQ;
    shader.uniforms.uWidth = { value: width };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
vWUv = uv;
vWSlope = aSlope;
vWTan = aTan;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
{
  float t = uTime * uMotion;
  float across = (vWUv.x - 0.5) * 2.0;
  float edge = clamp(abs(across), 0.0, 1.0);
  float edgeSoft = smoothstep(0.35, 1.0, edge);
  float steep = clamp(vWSlope * 4.0, 0.0, 1.0);
  vec2 p = vec2((vWUv.x - 0.5) * uWidth, vWUv.y);
  float speed = 0.6 * (1.0 + steep * 1.2);
  vec2 q1 = vec2(p.x, (p.y - speed * t) * 0.5);
  vec2 g = wRipple(q1, 2.2, 0.0) * vec2(1.0, 0.5);
  if (uQ > 0.5) {
    vec2 q2 = vec2(p.x * 1.15 + 3.7, (p.y - speed * 1.35 * t) * 0.6 + 11.0);
    g += wRipple(q2, 5.5, 2.0) * vec2(1.0, 0.6) * 0.55;
  }
  float turb = 0.5 + 1.2 * edgeSoft + 2.0 * steep;
  g *= 0.3 * turb;
  vec2 tn = normalize(vWTan + vec2(1e-5));
  vec2 an = vec2(-tn.y, tn.x);
  vec2 gw = an * g.x + tn * g.y;
  vec3 nw = normalize(vec3(-gw.x, 1.0, -gw.y));
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);

  // Depth / Fresnel opacity.
  vec3 vdir = normalize(vViewPosition);
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float ndv = clamp(dot(vdir, upV), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.0);
  float depthF = 1.0 - edge * edge; // 1 centre (deeper), 0 at the bank
  float baseA = mix(0.22, 0.78, depthF); // forest creeks read dark: tannin-stained, shaded
  float a = mix(baseA, 0.92, fres);
  a *= smoothstep(1.0, 0.82, edge);
  // Deeper centre = darker green-brown, shallows lighter tan-green.
  vec3 deep = vec3(0.010, 0.026, 0.018);
  vec3 shallow = vec3(0.07, 0.075, 0.045);
  vec3 col = mix(shallow, deep, depthF);
  if (uQ > 1.5) {
    // Cheap refraction stand-in: green tint + darkening of the bed in the channel centre.
    col *= mix(1.0, 0.7, depthF);
    a = clamp(a + 0.08 * depthF * (1.0 - fres), 0.0, 1.0);
  }
  // Foam streaks on steep / turbulent reaches.
  float foam = 0.0;
  if (uQ > 0.5) {
    vec2 fp = vec2(p.x * 3.0, (p.y - speed * 0.9 * t) * 0.9);
    float fn = wNoise(fp) * 0.6 + wNoise(fp * 2.3 + 7.0) * 0.4;
    float amount = smoothstep(0.12, 0.55, steep + edgeSoft * 0.12);
    foam = smoothstep(0.6, 0.78, fn) * amount;
  }
  diffuseColor.rgb = mix(col, vec3(0.8, 0.85, 0.82), foam * 0.7);
  diffuseColor.a = clamp(mix(a, 0.85, foam * 0.6), 0.0, 1.0);
  roughnessFactor = mix(roughnessFactor, 0.5, foam);
}`,
      )
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `// Premultiplied: diffuse (body) fades with opacity, reflections stay at full strength.
outgoingLight = totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance;
#include <opaque_fragment>`,
      )
      .replace(
        '#include <fog_fragment>',
        /* glsl */ `gl_FragColor.rgb /= max(gl_FragColor.a, 0.02);
#include <fog_fragment>
gl_FragColor.rgb *= gl_FragColor.a;`,
      );
  };
  return patchMaterial(mat, { key: 'creek-water' });
}

export class Creek {
  readonly root = new THREE.Group();
  readonly centerline: [number, number, number][] = [];
  private readonly waterGeo = new THREE.BufferGeometry();
  private readonly waterMat: THREE.MeshStandardMaterial;
  private readonly waterMesh: THREE.Mesh;
  private bedGeo: THREE.BufferGeometry | null = null;
  private bedMat: THREE.MeshStandardMaterial | null = null;
  private readonly uQ = { value: 1 };

  constructor(o: CreekOptions) {
    this.root.name = 'creek';
    const smooth = smoothPolyline(o.points, 10);
    const st = resampleUniform(smooth, SPACING);
    const rows = st.length;
    const ribbonW = o.width * 1.1;
    const half = ribbonW / 2;

    const minH = st.map((s) => minCrossSectionHeight(s, o.width / 2, 8, o.groundHeight));
    const wh = waterProfile(minH, WATER_DEPTH);
    const slope = downstreamSlope(
      wh,
      st.map((s) => s.s),
    );

    const pos = new Float32Array(rows * COLS * 3);
    const nrm = new Float32Array(rows * COLS * 3);
    const uv = new Float32Array(rows * COLS * 2);
    const aSlope = new Float32Array(rows * COLS);
    const aTan = new Float32Array(rows * COLS * 2);
    const bedPos = new Float32Array(rows * COLS * 3);
    const bedUv = new Float32Array(rows * COLS * 2);
    for (let r = 0; r < rows; r++) {
      const s = st[r]!;
      const y = wh[r]!;
      this.centerline.push([s.x, y, s.z]);
      for (let c = 0; c < COLS; c++) {
        const u = c / (COLS - 1);
        const off = (u - 0.5) * 2 * half;
        const x = s.x - s.tz * off;
        const z = s.z + s.tx * off;
        const i = r * COLS + c;
        pos.set([x, y, z], i * 3);
        nrm.set([0, 1, 0], i * 3);
        uv.set([u, s.s], i * 2);
        aSlope[i] = slope[r]!;
        aTan.set([s.tx, s.tz], i * 2);
        // The pebble bed only spans the wetted channel and always stays under the water surface,
        // so it never cuts through the banks (the terrain and ribbon triangulate differently).
        const bOff = off * 0.55;
        const bx = s.x - s.tz * bOff;
        const bz = s.z + s.tx * bOff;
        bedPos.set([bx, Math.min(o.groundHeight(bx, bz) + 0.04, y - 0.03), bz], i * 3);
        bedUv.set([(u * ribbonW * 0.55) / BED_TILE, s.s / BED_TILE], i * 2);
      }
    }
    const index = ribbonIndices(rows, COLS);

    this.waterGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.waterGeo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    this.waterGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.waterGeo.setAttribute('aSlope', new THREE.BufferAttribute(aSlope, 1));
    this.waterGeo.setAttribute('aTan', new THREE.BufferAttribute(aTan, 2));
    this.waterGeo.setIndex(index);
    this.waterGeo.computeBoundingSphere();
    this.waterGeo.computeBoundingBox();

    this.waterMat = buildWaterMaterial(this.uQ, ribbonW);
    this.waterMesh = new THREE.Mesh(this.waterGeo, this.waterMat);
    this.waterMesh.name = 'creek-water';
    this.waterMesh.renderOrder = 2;
    this.waterMesh.castShadow = false;
    this.waterMesh.receiveShadow = false;

    if (o.bed) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(bedPos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(bedUv, 2));
      g.setIndex(index);
      g.computeVertexNormals();
      // Terrain normals are mostly up for the bed; force it so the pebble normal map lights consistently.
      const bn = g.getAttribute('normal') as THREE.BufferAttribute;
      for (let i = 0; i < bn.count; i++)
        bn.setXYZ(i, bn.getX(i) * 0.3, Math.abs(bn.getY(i)) + 0.7, bn.getZ(i) * 0.3);
      g.computeBoundingSphere();
      for (const t of [o.bed.map, o.bed.normalMap, o.bed.armMap]) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
      }
      const m = new THREE.MeshStandardMaterial({
        map: o.bed.map,
        normalMap: o.bed.normalMap,
        roughnessMap: o.bed.armMap,
        metalness: 0,
        roughness: 1,
        color: new THREE.Color(0.75, 0.72, 0.62), // wet-stone darkening
        fog: true,
      });
      this.bedGeo = g;
      this.bedMat = patchMaterial(m);
      const bm = new THREE.Mesh(g, m);
      bm.name = 'creek-bed';
      bm.receiveShadow = true;
      bm.renderOrder = 1;
      this.root.add(bm);
    }
    this.root.add(this.waterMesh);
    this.setQuality(o.quality);
  }

  setQuality(q: CreekOptions['quality']): void {
    this.uQ.value = QUALITY_INDEX[q];
  }

  update(): void {
    // Animation is driven by sharedUniforms.uTime / uMotion (advanced by the renderer); nothing to do.
  }

  dispose(): void {
    this.waterGeo.dispose();
    this.waterMat.dispose();
    this.bedGeo?.dispose();
    this.bedMat?.dispose();
    this.root.clear();
  }
}
