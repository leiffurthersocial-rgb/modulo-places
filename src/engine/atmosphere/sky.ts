// Sky dome: analytic gradient + sun disc, optionally replaced by (cross-faded) equirect HDRIs.
// Rendered as a large inverted sphere following the camera; the same material is rendered into
// the PMREM environment so IBL always matches the visible sky. A fog band at the horizon blends
// distant terrain into the sky.
import * as THREE from 'three';
import { FOG_GLSL, sharedUniforms } from '../render/materials';

/** Azimuth (radians, our convention: atan2(x, z)) and elevation of the brightest HDRI region. */
export function findHdriSun(tex: THREE.DataTexture): { azimuth: number; elevation: number } {
  const img = tex.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const { data, width, height } = img;
  const half = data instanceof Uint16Array;
  const val = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(data[i]!) : data[i]!);
  let best = -1;
  let bu = 0.5;
  let bv = 0.75;
  const step = Math.max(1, Math.floor(width / 256));
  for (let y = 0; y < height / 2; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const l = val(i) * 0.2126 + val(i + 1) * 0.7152 + val(i + 2) * 0.0722;
      if (l > best) {
        best = l;
        bu = (x + 0.5) / width;
        bv = 1 - (y + 0.5) / height; // row 0 = top (flipY false for DataTexture from HDRLoader)
      }
    }
  }
  // Inverse of equirectUv: u = atan(d.z, d.x)/(2π) + 0.5, v = asin(d.y)/π + 0.5
  const phi = (bu - 0.5) * Math.PI * 2;
  const el = (bv - 0.5) * Math.PI;
  const dir = new THREE.Vector3(
    Math.cos(phi) * Math.cos(el),
    Math.sin(el),
    Math.sin(phi) * Math.cos(el),
  );
  return { azimuth: Math.atan2(dir.x, dir.z), elevation: el };
}

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uGround: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSunDisc: { value: 0.9995 },
    uSunIntensity: { value: 20 },
    uHorizonFog: { value: 0.5 },
    tHdriA: { value: null as THREE.Texture | null },
    tHdriB: { value: null as THREE.Texture | null },
    uHdriRotA: { value: 0 },
    uHdriRotB: { value: 0 },
    uHdriMix: { value: 0 }, // 0 = A, 1 = B
    uHdriWeightA: { value: 0 }, // 0 = analytic sky, 1 = HDRI (per slot, so analytic↔HDRI fades work)
    uHdriWeightB: { value: 0 },
    uHdriIntensityA: { value: 1 },
    uHdriIntensityB: { value: 1 },
  };
  private fade = { t: 1, dur: 1 };

  constructor() {
    const mat = new THREE.ShaderMaterial({
      name: 'Sky',
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        ...this.uniforms,
        uFogColor: sharedUniforms.uFogColor,
        uFogDensity: sharedUniforms.uFogDensity,
        uFogHeightFalloff: sharedUniforms.uFogHeightFalloff,
        uFogBaseHeight: sharedUniforms.uFogBaseHeight,
        uFogSunDir: sharedUniforms.uFogSunDir,
        uFogSunColor: sharedUniforms.uFogSunColor,
        uFogSunScatter: sharedUniforms.uFogSunScatter,
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww; // at far plane
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunColor;
        uniform float uSunDisc, uSunIntensity, uHorizonFog;
        uniform sampler2D tHdriA, tHdriB;
        uniform float uHdriRotA, uHdriRotB, uHdriMix, uHdriWeightA, uHdriWeightB, uHdriIntensityA, uHdriIntensityB;
        varying vec3 vDir;
        ${FOG_GLSL}
        vec3 rotY(vec3 d, float a) { float c = cos(a), s = sin(a); return vec3(d.x * c + d.z * s, d.y, -d.x * s + d.z * c); }
        vec2 eqUv(vec3 d) { return vec2(atan(d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5); }
        vec3 analytic(vec3 d) {
          float y = d.y;
          vec3 col = y > 0.0
            ? mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.45))
            : mix(uHorizon, uGround, pow(clamp(-y * 3.0, 0.0, 1.0), 0.6));
          float mu = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(mu, 6.0) * 0.18 + pow(mu, 64.0) * 0.6);
          float disc = smoothstep(uSunDisc, uSunDisc + 0.00015, mu);
          col += uSunColor * disc * uSunIntensity * step(-0.02, uSunDir.y);
          return col;
        }
        vec3 slot(sampler2D t, float rot, float w, float k, vec3 d, vec3 fallback) {
          if (w <= 0.0) return fallback;
          vec3 h = texture(t, eqUv(rotY(d, -rot))).rgb * k;
          return mix(fallback, h, w);
        }
        void main() {
          vec3 d = normalize(vDir);
          vec3 a = analytic(d);
          vec3 col = mix(slot(tHdriA, uHdriRotA, uHdriWeightA, uHdriIntensityA, d, a),
                         slot(tHdriB, uHdriRotB, uHdriWeightB, uHdriIntensityB, d, a), uHdriMix);
          // Blend toward fog colour near the horizon so distant terrain meets the sky softly.
          float horizonBand = exp(-abs(d.y) * 9.0) * uHorizonFog;
          col = mix(col, heightFogColor(d), clamp(horizonBand, 0.0, 1.0));
          gl_FragColor = vec4(col, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(900);
  }

  /** Cross-fade to an HDRI (or to the analytic sky with tex = null). */
  setHdri(tex: THREE.Texture | null, rotation: number, intensity: number, seconds: number): void {
    const u = this.uniforms;
    // Current visible state collapses into slot A, the new target goes to slot B.
    if (u.uHdriMix.value > 0.5) {
      u.tHdriA.value = u.tHdriB.value;
      u.uHdriRotA.value = u.uHdriRotB.value;
      u.uHdriWeightA.value = u.uHdriWeightB.value;
      u.uHdriIntensityA.value = u.uHdriIntensityB.value;
    }
    u.tHdriB.value = tex;
    u.uHdriRotB.value = rotation;
    u.uHdriWeightB.value = tex ? 1 : 0;
    u.uHdriIntensityB.value = intensity;
    u.uHdriMix.value = 0;
    this.fade = { t: seconds <= 0 ? 1 : 0, dur: Math.max(1e-3, seconds) };
    if (seconds <= 0) u.uHdriMix.value = 1;
  }

  get fading(): boolean {
    return this.fade.t < 1;
  }

  update(camera: THREE.Camera, dt = 0): void {
    this.mesh.position.copy(camera.position);
    if (this.fade.t < 1) {
      this.fade.t = Math.min(1, this.fade.t + dt / this.fade.dur);
      const e = this.fade.t * this.fade.t * (3 - 2 * this.fade.t);
      this.uniforms.uHdriMix.value = e;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
