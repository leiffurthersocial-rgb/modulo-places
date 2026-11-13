// Runtime impostor baking for far-LOD trees: a horizontal yaw-ring of N orthographic views (slightly
// looking down) packed into two atlases (albedo+alpha, view-space normal+depth), drawn as a
// cylindrical billboard that cross-fades the two nearest views. Works with InstancedMesh.
import * as THREE from 'three';
import { FOG_GLSL, sharedUniforms } from '../../render/materials';
import { atlasGrid, projectedExtent, TAU } from './math';

export interface ImpostorOptions {
  views: number;
  /** Texels along the longer side of one view cell. */
  resolution: number;
  elevationDeg?: number;
}

export interface Impostor {
  /** Single quad; pivot at the base centre. userData.size = {width, height}. */
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  /** [albedo+alpha (sRGB), view-space normal*0.5+0.5 + depth in alpha (linear)]. */
  atlases: THREE.Texture[];
  /** Sun direction points TOWARDS the sun. Colours are as passed to DirectionalLight/HemisphereLight (colour*intensity). */
  setLighting(
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    skyColor: THREE.Color,
    groundColor: THREE.Color,
  ): void;
  dispose(): void;
}

const BAKE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
#ifdef USE_COLOR
  varying vec3 vCol;
#endif
uniform mat3 uUvTransform;
void main() {
  vUv = (uUvTransform * vec3(uv, 1.0)).xy;
  vec3 pos = position;
  vec3 nrm = normal;
  #ifdef USE_INSTANCING
    mat4 im = instanceMatrix;
    pos = (im * vec4(pos, 1.0)).xyz;
    nrm = mat3(im) * nrm;
  #endif
  #ifdef USE_COLOR
    vCol = color.rgb;
  #endif
  vN = mat3(viewMatrix) * normalize(mat3(modelMatrix) * nrm);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(pos, 1.0);
}`;

const BAKE_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oNormal;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uAlphaTest;
uniform float uBlend; // 1 when alpha carries coverage (alphaTest or transparent)
varying vec2 vUv;
varying vec3 vN;
#ifdef USE_COLOR
  varying vec3 vCol;
#endif
void main() {
  vec4 c = vec4(uColor, uOpacity);
  #ifdef USE_MAP
    c *= texture2D(uMap, vUv);
  #endif
  #ifdef USE_COLOR
    c.rgb *= vCol;
  #endif
  float a = uBlend > 0.5 ? c.a : 1.0;
  if (a < max(uAlphaTest, 0.004)) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  oAlbedo = vec4(c.rgb, a);
  oNormal = vec4(n * 0.5 + 0.5, mix(0.02, 1.0, clamp(gl_FragCoord.z, 0.0, 1.0)));
}`;

const DILATE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// A texel is "valid" when its normal-target alpha (depth, never 0 for geometry) is non-zero.
// Invalid texels copy the average of valid neighbours; alpha stays 0 so they never show.
const DILATE_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 oAlbedo;
layout(location = 1) out vec4 oNormal;
uniform sampler2D tAlbedo;
uniform sampler2D tNormal;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 a = texture2D(tAlbedo, vUv);
  vec4 n = texture2D(tNormal, vUv);
  if (n.a > 0.0) { oAlbedo = a; oNormal = n; return; }
  vec3 sc = vec3(0.0); vec3 sn = vec3(0.0); float sd = 0.0; float w = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vUv + vec2(float(x), float(y)) * uTexel;
      vec4 nn = texture2D(tNormal, o);
      if (nn.a > 0.0) {
        sc += texture2D(tAlbedo, o).rgb; sn += nn.rgb; sd += nn.a; w += 1.0;
      }
    }
  }
  if (w > 0.0) { oAlbedo = vec4(sc / w, 0.0); oNormal = vec4(sn / w, sd / w); }
  else { oAlbedo = a; oNormal = n; }
}`;

const RUNTIME_VERT = /* glsl */ `
uniform float uViews;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vSel;      // i0, i1, w
varying vec2 vYaw;      // cos, sin of instance yaw
void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = m * instanceMatrix;
  #endif
  vec3 base = m[3].xyz;
  float s = length(m[0].xyz);
  // R_y(yaw): col0 = (cos, 0, -sin)
  float yaw = atan(-m[0].z, m[0].x);
  vYaw = vec2(cos(yaw), sin(yaw));
  vec3 toCam = cameraPosition - base;
  vec2 h = toCam.xz;
  float hl = length(h);
  h = hl > 1e-4 ? h / hl : vec2(0.0, 1.0);
  vec3 right = vec3(h.y, 0.0, -h.x);
  // camera azimuth in the object's local frame
  float lx = vYaw.x * toCam.x - vYaw.y * toCam.z;
  float lz = vYaw.y * toCam.x + vYaw.x * toCam.z;
  float phi = atan(lx, lz);
  float f = phi * (uViews / ${TAU.toFixed(8)});
  f -= uViews * floor(f / uViews);
  float i0 = min(floor(f), uViews - 1.0);
  vSel = vec3(i0, mod(i0 + 1.0, uViews), f - i0);
  vec3 world = base + (right * position.x + vec3(0.0, position.y, 0.0)) * s;
  vWorld = world;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const RUNTIME_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform float uViews;
uniform vec2 uGrid;
uniform vec2 uInset;   // cell-uv inset
uniform vec2 uElev;    // sin, cos of elevation
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform float uWrap;
uniform float uDitherOffset;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vSel;
varying vec2 vYaw;
${FOG_GLSL}

vec2 cellUv(float idx) {
  float col = mod(idx, uGrid.x);
  float row = floor(idx / uGrid.x);
  vec2 c = clamp(vUv, uInset, 1.0 - uInset);
  return (vec2(col, row) + c) / uGrid;
}
vec3 viewToLocal(float idx, vec3 n) {
  float phi = idx * ${TAU.toFixed(8)} / uViews;
  float sp = sin(phi), cp = cos(phi);
  vec3 right = vec3(cp, 0.0, -sp);
  vec3 up = vec3(-uElev.x * sp, uElev.y, -uElev.x * cp);
  vec3 back = vec3(sp * uElev.y, uElev.x, cp * uElev.y);
  return right * n.x + up * n.y + back * n.z;
}
float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0.,8.,2.,10., 12.,4.,14.,6., 3.,11.,1.,9., 15.,7.,13.,5.);
  return (m[idx] + 0.5) / 16.0;
}
void main() {
  float i0 = floor(vSel.x + 0.5);
  float i1 = floor(vSel.y + 0.5);
  float w = vSel.z;
  vec2 uv0 = cellUv(i0);
  vec2 uv1 = cellUv(i1);
  vec4 a0 = texture2D(uAlbedo, uv0);
  vec4 a1 = texture2D(uAlbedo, uv1);
  float al = mix(a0.a, a1.a, w);
  #ifdef ALPHA_TO_COVERAGE
    al = clamp((al - 0.5) / max(fwidth(al), 1e-4) + 0.5, 0.0, 1.0);
    if (al <= 0.0) discard;
  #else
    if (al < 0.5) discard;
  #endif
  if (uDitherOffset > 0.0 && bayer4(gl_FragCoord.xy) < uDitherOffset) discard;
  float w0 = (1.0 - w) * max(a0.a, 0.001);
  float w1 = w * max(a1.a, 0.001);
  vec3 albedo = (a0.rgb * w0 + a1.rgb * w1) / (w0 + w1);
  vec3 n0 = viewToLocal(i0, texture2D(uNormal, uv0).xyz * 2.0 - 1.0);
  vec3 n1 = viewToLocal(i1, texture2D(uNormal, uv1).xyz * 2.0 - 1.0);
  vec3 nl = normalize(mix(n0, n1, w));
  // local -> world (R_y(yaw))
  vec3 n = normalize(vec3(vYaw.x * nl.x + vYaw.y * nl.z, nl.y, -vYaw.y * nl.x + vYaw.x * nl.z));
  float ndl = dot(n, uSunDir);
  float lam = max(ndl, 0.0);
  float wrap = max((ndl + 0.5) / 1.5, 0.0);
  float diff = mix(lam, wrap, uWrap);
  vec3 amb = mix(uGroundColor, uSkyColor, n.y * 0.5 + 0.5);
  vec3 col = albedo * (uSunColor * diff + amb) * ${(1 / Math.PI).toFixed(8)};
  gl_FragColor = vec4(col, 1.0);
  #ifdef ALPHA_TO_COVERAGE
    gl_FragColor.a = al;
  #endif
  #include <colorspace_fragment>
  // Fog after the colour-space conversion, exactly like three's built-in materials (see materials.ts).
  float fogF = heightFogAmount(cameraPosition, vWorld);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, heightFogColor(normalize(vWorld - cameraPosition)), fogF);
}`;

function makeBakeMaterial(src: THREE.Material): THREE.ShaderMaterial {
  const m = src as THREE.MeshStandardMaterial;
  const map = m.map ?? null;
  const uvT = new THREE.Matrix3();
  if (map) {
    if (map.matrixAutoUpdate) map.updateMatrix();
    uvT.copy(map.matrix);
  }
  const blend = m.alphaTest > 0 || m.transparent;
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_FRAG,
    defines: { ...(map ? { USE_MAP: '' } : {}), ...(m.vertexColors ? { USE_COLOR: '' } : {}) },
    uniforms: {
      uMap: { value: map },
      uUvTransform: { value: uvT },
      uColor: { value: m.color ? m.color.clone() : new THREE.Color(1, 1, 1) },
      uOpacity: { value: m.opacity ?? 1 },
      uAlphaTest: { value: m.alphaTest ?? 0 },
      uBlend: { value: blend ? 1 : 0 },
    },
    side: m.side,
    blending: THREE.NoBlending,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    vertexColors: !!m.vertexColors,
    fog: false,
  });
}

/** Horizontal radius (about the pivot's vertical axis) of all mesh vertices. */
function horizontalRadius(root: THREE.Object3D, pivot: THREE.Vector3): number {
  let r2 = 0;
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    const insts = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh) : null;
    const im = new THREE.Matrix4();
    const count = insts ? insts.count : 1;
    for (let k = 0; k < count; k++) {
      const mw = mesh.matrixWorld.clone();
      if (insts) {
        insts.getMatrixAt(k, im);
        mw.multiply(im);
      }
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mw);
        const dx = v.x - pivot.x;
        const dz = v.z - pivot.z;
        const d = dx * dx + dz * dz;
        if (d > r2) r2 = d;
      }
    }
  });
  return Math.sqrt(r2);
}

export function bakeImpostor(
  renderer: THREE.WebGLRenderer,
  source: THREE.Object3D,
  opts: ImpostorOptions,
): Impostor {
  const views = Math.max(2, Math.floor(opts.views));
  const elev = ((opts.elevationDeg ?? 8) * Math.PI) / 180;

  // Work on a detached clone (shared geometry/textures) so the caller's scene is untouched.
  const clone = source.clone(true);
  clone.updateMatrixWorld(true);
  const scene = new THREE.Scene();
  scene.add(clone);
  clone.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(clone);
  const pivot = new THREE.Vector3().setFromMatrixPosition(clone.matrixWorld);
  pivot.y = box.min.y;
  let radius = horizontalRadius(clone, pivot);
  if (radius < 1e-4) radius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5;
  const height = Math.max(box.max.y - box.min.y, 1e-3);
  const pad = 0.03 * Math.max(2 * radius, height);
  const ext = projectedExtent(radius, height, elev);
  const halfW = radius + pad;
  const vMin = ext.vMin - pad;
  const vMax = ext.vMax + pad;
  const quadW = halfW * 2;
  const quadH = vMax - vMin;

  const res = Math.max(16, Math.floor(opts.resolution));
  const cellW = Math.max(8, quadW >= quadH ? res : Math.round((res * quadW) / quadH));
  const cellH = Math.max(8, quadH > quadW ? res : Math.round((res * quadH) / quadW));
  const grid = atlasGrid(views, cellW / cellH);
  const atlasW = grid.cols * cellW;
  const atlasH = grid.rows * cellH;

  const dist = Math.hypot(radius, height) + 1;
  const depthNear = 0.01;
  const depthFar = dist * 2;

  // Swap every mesh material for the unlit MRT bake material.
  const bakeMats = new Map<THREE.Material, THREE.ShaderMaterial>();
  const bakeFor = (mat: THREE.Material): THREE.ShaderMaterial => {
    let b = bakeMats.get(mat);
    if (!b) bakeMats.set(mat, (b = makeBakeMaterial(mat)));
    return b;
  };
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(bakeFor)
      : bakeFor(mesh.material);
  });

  const mkTarget = (depthBuffer: boolean): THREE.WebGLRenderTarget => {
    const rt = new THREE.WebGLRenderTarget(atlasW, atlasH, {
      count: 2,
      depthBuffer,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    const albedo = rt.textures[0];
    const normal = rt.textures[1];
    if (albedo) albedo.colorSpace = THREE.SRGBColorSpace;
    if (normal) normal.colorSpace = THREE.NoColorSpace;
    return rt;
  };
  const rtA = mkTarget(true);
  const rtB = mkTarget(false);

  // Save renderer state.
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAuto = renderer.autoClear;
  const prevXr = renderer.xr.enabled;
  renderer.xr.enabled = false;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);

  try {
    // 1. Render each view into its atlas cell.
    renderer.setRenderTarget(rtA);
    rtA.scissorTest = false;
    rtA.viewport.set(0, 0, atlasW, atlasH);
    renderer.clear(true, true, false);
    rtA.scissorTest = true;
    const cam = new THREE.OrthographicCamera(-halfW, halfW, vMax, vMin, depthNear, depthFar);
    for (let i = 0; i < views; i++) {
      const az = (i / views) * TAU;
      const dir = new THREE.Vector3(
        Math.sin(az) * Math.cos(elev),
        Math.sin(elev),
        Math.cos(az) * Math.cos(elev),
      );
      cam.position.copy(pivot).addScaledVector(dir, dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(pivot);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      const col = i % grid.cols;
      const row = Math.floor(i / grid.cols);
      rtA.viewport.set(col * cellW, row * cellH, cellW, cellH);
      rtA.scissor.set(col * cellW, row * cellH, cellW, cellH);
      renderer.setRenderTarget(rtA);
      renderer.render(scene, cam);
    }

    // 2. Dilate colour/normal into empty texels, ping-ponging A -> B -> A (even pass count).
    const dilateMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: DILATE_VERT,
      fragmentShader: DILATE_FRAG,
      uniforms: {
        tAlbedo: { value: null },
        tNormal: { value: null },
        uTexel: { value: new THREE.Vector2(1 / atlasW, 1 / atlasH) },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), dilateMat);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const passes = 4;
    let src = rtA;
    let dst = rtB;
    for (let p = 0; p < passes; p++) {
      const last = p === passes - 1;
      for (const t of dst.textures) t.generateMipmaps = last;
      dst.scissorTest = false;
      dst.viewport.set(0, 0, atlasW, atlasH);
      dilateMat.uniforms.tAlbedo!.value = src.textures[0];
      dilateMat.uniforms.tNormal!.value = src.textures[1];
      renderer.setRenderTarget(dst);
      renderer.render(quadScene, quadCam);
      [src, dst] = [dst, src];
    }
    quad.geometry.dispose();
    dilateMat.dispose();
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.xr.enabled = prevXr;
    for (const m of bakeMats.values()) m.dispose();
  }
  rtB.dispose();

  const atlases = rtA.textures;
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  for (const t of atlases) {
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = maxAniso;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  }

  // Quad geometry: x in [-halfW, halfW], y in [vMin, vMax] (y = 0 at the base centre).
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [-halfW, vMin, 0, halfW, vMin, 0, halfW, vMax, 0, -halfW, vMax, 0],
      3,
    ),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, (vMin + vMax) / 2, 0),
    Math.hypot(halfW, quadH / 2),
  );
  geometry.userData.size = { width: quadW, height: quadH, baseOffset: vMin };

  let aa = false;
  try {
    aa = !!renderer.getContext().getContextAttributes()?.antialias;
  } catch {
    aa = false;
  }
  const material = new THREE.ShaderMaterial({
    name: 'Impostor',
    vertexShader: RUNTIME_VERT,
    fragmentShader: RUNTIME_FRAG,
    uniforms: {
      uAlbedo: { value: atlases[0] },
      uNormal: { value: atlases[1] },
      uViews: { value: views },
      uGrid: { value: new THREE.Vector2(grid.cols, grid.rows) },
      uInset: { value: new THREE.Vector2(1 / cellW, 1 / cellH) },
      uElev: { value: new THREE.Vector2(Math.sin(elev), Math.cos(elev)) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
      uSunColor: { value: new THREE.Color(3, 2.8, 2.5) },
      uSkyColor: { value: new THREE.Color(0.6, 0.75, 1.0) },
      uGroundColor: { value: new THREE.Color(0.25, 0.2, 0.15) },
      uWrap: { value: 0.35 },
      /** 0 = opaque; 1 = fully dithered out (reserved for LOD cross-fades). */
      uDitherOffset: { value: 0 },
      uFogColor: sharedUniforms.uFogColor,
      uFogDensity: sharedUniforms.uFogDensity,
      uFogHeightFalloff: sharedUniforms.uFogHeightFalloff,
      uFogBaseHeight: sharedUniforms.uFogBaseHeight,
      uFogSunDir: sharedUniforms.uFogSunDir,
      uFogSunColor: sharedUniforms.uFogSunColor,
      uFogSunScatter: sharedUniforms.uFogSunScatter,
    },
    side: THREE.DoubleSide,
    transparent: false,
    alphaToCoverage: aa,
    fog: false,
  });

  const impostor: Impostor = {
    geometry,
    material,
    atlases,
    setLighting(sunDir, sunColor, skyColor, groundColor) {
      (material.uniforms.uSunDir!.value as THREE.Vector3).copy(sunDir).normalize();
      (material.uniforms.uSunColor!.value as THREE.Color).copy(sunColor);
      (material.uniforms.uSkyColor!.value as THREE.Color).copy(skyColor);
      (material.uniforms.uGroundColor!.value as THREE.Color).copy(groundColor);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      rtA.dispose();
    },
  };
  return impostor;
}
