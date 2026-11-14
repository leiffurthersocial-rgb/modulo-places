// Cheap volumetric-looking light shafts ("cards" tier): instanced soft beams aligned with the sun
// direction, billboarded around their own axis, additive, brightest when looking toward the sun
// (forward scattering). One draw call; positions are seeded on a world grid around the camera so
// they stay put while walking and only re-seed when the camera changes grid cell.
import * as THREE from 'three';
import { hash01 } from '../core/random';
import { FOG_GLSL, sharedUniforms } from '../render/materials';

const COUNT = 36;
const GRID = 9; // metres between candidate shaft positions
const RADIUS = 4; // cells around the camera

export class LightShafts {
  readonly mesh: THREE.Mesh;
  private offsets: THREE.InstancedBufferAttribute;
  private params: THREE.InstancedBufferAttribute;
  private cell = new THREE.Vector2(Infinity, Infinity);
  private uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
    uStrength: { value: 0 },
    uTime: sharedUniforms.uTime,
  };

  constructor(
    private groundHeight: (x: number, z: number) => number,
    private canopyHeight = 18,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1, 1, 8).translate(0, 0.5, 0); // y: 0..1 along the beam
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    this.offsets = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 4), 4); // width, length, phase, strength
    geo.setAttribute('aOffset', this.offsets);
    geo.setAttribute('aParams', this.params);
    geo.instanceCount = COUNT;
    const mat = new THREE.ShaderMaterial({
      name: 'LightShafts',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
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
        attribute vec3 aOffset;
        attribute vec4 aParams;
        uniform vec3 uSunDir;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vStrength;
        void main() {
          vUv = uv;
          vStrength = aParams.w;
          // Beam axis points from the ground spot up toward the sun.
          vec3 axis = normalize(uSunDir);
          vec3 toCam = normalize(cameraPosition - aOffset);
          vec3 side = normalize(cross(axis, toCam));
          vec3 p = aOffset + axis * position.y * aParams.y + side * position.x * aParams.x;
          vWorld = p;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uStrength;
        uniform float uTime;
        varying vec2 vUv;
        varying vec3 vWorld;
        varying float vStrength;
        ${FOG_GLSL}
        void main() {
          float across = vUv.x * 2.0 - 1.0;
          float core = exp(-across * across * 3.5);
          float along = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
          // Slow drifting density so beams breathe a little.
          float n = 0.75 + 0.25 * sin(uTime * 0.25 + vWorld.x * 0.31 + vWorld.z * 0.17);
          vec3 V = normalize(vWorld - cameraPosition);
          float forward = 0.35 + 1.8 * pow(max(dot(V, normalize(uSunDir)), 0.0), 3.0);
          float d = length(vWorld - cameraPosition);
          float near = smoothstep(1.5, 6.0, d); // never a flat card in your face
          float a = core * along * n * forward * near * vStrength * uStrength;
          // Fog: shafts are light scattered by the same medium; distant ones dissolve into fog.
          a *= 1.0 - 0.7 * heightFogAmount(cameraPosition, vWorld);
          gl_FragColor = vec4(uSunColor * a, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'light-shafts';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  private reseed(cx: number, cz: number): void {
    const o = this.offsets.array as Float32Array;
    const prm = this.params.array as Float32Array;
    let n = 0;
    for (let gz = -RADIUS; gz <= RADIUS && n < COUNT; gz++) {
      for (let gx = -RADIUS; gx <= RADIUS && n < COUNT; gx++) {
        const ix = cx + gx;
        const iz = cz + gz;
        if (hash01(ix, iz, 911) > 0.6) continue; // only some cells have a canopy gap
        const x = (ix + hash01(ix, iz, 3)) * GRID;
        const z = (iz + hash01(ix, iz, 7)) * GRID;
        o.set([x, this.groundHeight(x, z), z], n * 3);
        prm.set(
          [
            1.0 + hash01(ix, iz, 13) * 3.0,
            this.canopyHeight * (0.8 + hash01(ix, iz, 17) * 0.6),
            hash01(ix, iz, 19),
            0.35 + hash01(ix, iz, 23) * 0.65,
          ],
          n * 4,
        );
        n++;
      }
    }
    for (; n < COUNT; n++) prm.set([0, 0, 0, 0], n * 4);
    this.offsets.needsUpdate = true;
    this.params.needsUpdate = true;
  }

  /** strength: mood shafts × sun visibility (0 hides the mesh). */
  update(
    camera: THREE.Camera,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    strength: number,
  ): void {
    const cx = Math.floor(camera.position.x / GRID);
    const cz = Math.floor(camera.position.z / GRID);
    if (cx !== this.cell.x || cz !== this.cell.y) {
      this.cell.set(cx, cz);
      this.reseed(cx, cz);
    }
    const sunUp = THREE.MathUtils.smoothstep(sunDir.y, 0.02, 0.12);
    const s = strength * sunUp;
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.copy(sunColor);
    this.uniforms.uStrength.value = s * 0.9;
    this.mesh.visible = s > 0.01;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
