// Analytic gradient sky with sun disc + glow, rendered as a large inverted sphere that follows the
// camera. HDRI skies replace this in Phase 3; the same uniforms drive fog/sun so moods stay coherent.
import * as THREE from 'three';
import { FOG_GLSL, sharedUniforms } from '../render/materials';

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
  };

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
        varying vec3 vDir;
        ${FOG_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 col = y > 0.0
            ? mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.45))
            : mix(uHorizon, uGround, pow(clamp(-y * 3.0, 0.0, 1.0), 0.6));
          float mu = max(dot(d, uSunDir), 0.0);
          // Wide forward-scattering glow + tight halo + disc.
          col += uSunColor * (pow(mu, 6.0) * 0.18 + pow(mu, 64.0) * 0.6);
          float disc = smoothstep(uSunDisc, uSunDisc + 0.00015, mu);
          col += uSunColor * disc * uSunIntensity * step(-0.02, uSunDir.y);
          // Blend toward fog colour near the horizon so distant terrain meets the sky softly.
          float horizonBand = exp(-abs(y) * 9.0) * uHorizonFog;
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

  update(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
