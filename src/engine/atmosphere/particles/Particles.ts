// GPU particle atmosphere. One draw call per layer; all motion is computed in the vertex shader from
// per-particle seeds, wrapped in a camera-centred world-space box (no per-frame buffer uploads).
import * as THREE from 'three';
import { sharedUniforms } from '../../render/materials';
import { makeSeeds, stepIntensity, visibleCount } from './math';
import { PARTICLE_FRAG, PARTICLE_VERT } from './shaders';

export type ParticlePreset = 'pollen' | 'dust' | 'mist' | 'leaves' | 'rain' | 'snow';

export interface ParticleLayerOptions {
  preset: ParticlePreset;
  count: number;
  /** Half-extent of the camera-centred box (m). */
  radius: number;
  /** [min, max] metres above ground. */
  height: [number, number];
}

interface PresetConfig {
  mode: 'point' | 'quad';
  size: [number, number]; // world metres (point diameter / quad edge)
  pointClamp: [number, number]; // px at DPR 1
  opacity: number;
  fall: number; // m/s
  windFactor: number;
  color: [number, number, number]; // linear
}

const CONFIG: Record<ParticlePreset, PresetConfig> = {
  pollen: {
    mode: 'point',
    size: [0.025, 0.06],
    pointClamp: [1.5, 6],
    opacity: 1.0,
    fall: 0,
    windFactor: 0.35,
    color: [1.0, 0.82, 0.45],
  },
  dust: {
    mode: 'point',
    size: [0.015, 0.04],
    pointClamp: [1.2, 4],
    opacity: 0.7,
    fall: 0,
    windFactor: 0.2,
    color: [0.9, 0.85, 0.75],
  },
  mist: {
    mode: 'quad',
    size: [6, 14],
    pointClamp: [1, 1],
    opacity: 0.42,
    fall: 0,
    windFactor: 0.12,
    color: [1, 1, 1],
  },
  leaves: {
    mode: 'quad',
    size: [0.18, 0.3],
    pointClamp: [1, 1],
    opacity: 1,
    fall: 0.75,
    windFactor: 0.6,
    color: [1, 1, 1],
  },
  rain: {
    mode: 'quad',
    size: [1, 1],
    pointClamp: [1, 1],
    opacity: 0.55,
    fall: 9,
    windFactor: 1,
    color: [0.75, 0.82, 0.9],
  },
  snow: {
    mode: 'point',
    size: [0.03, 0.08],
    pointClamp: [1.5, 8],
    opacity: 0.9,
    fall: 1.0,
    windFactor: 0.5,
    color: [1, 1, 1],
  },
};

const DEFINES: Record<ParticlePreset, string> = {
  pollen: 'P_POLLEN',
  dust: 'P_DUST',
  mist: 'P_MIST',
  leaves: 'P_LEAVES',
  rain: 'P_RAIN',
  snow: 'P_SNOW',
};

interface Layer {
  preset: ParticlePreset;
  count: number;
  mesh: THREE.Mesh | THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
  intensity: number;
  target: number;
  seconds: number;
}

export class ParticleField {
  readonly root = new THREE.Group();
  private readonly groundHeight: (x: number, z: number) => number;
  private layers: Layer[] = [];
  private density = 1;
  private readonly pending = new Map<ParticlePreset, { v: number; seconds: number }>();

  // Uniform objects shared by every layer of this field.
  private readonly shared = {
    uWindOff: { value: new THREE.Vector2() },
    uWind: { value: new THREE.Vector2() },
    uPixelRatio: { value: 1 },
    uViewH: { value: 900 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 0.9, 0.7) },
    uAmbient: { value: new THREE.Color(0.3, 0.35, 0.4) },
    uGround: { value: 0 },
  };

  constructor(opts: { groundHeight: (x: number, z: number) => number }) {
    this.groundHeight = opts.groundHeight;
    this.root.name = 'particles';
  }

  setLayers(layers: ParticleLayerOptions[]): void {
    this.disposeLayers();
    let seedBase = 1337;
    for (const opt of layers) {
      const layer = this.buildLayer(opt, seedBase++);
      const p = this.pending.get(opt.preset);
      if (p) {
        layer.intensity = layer.target = p.v;
      }
      this.applyCount(layer);
      layer.mesh.visible = layer.intensity > 0.002;
      this.layers.push(layer);
      this.root.add(layer.mesh);
    }
  }

  setIntensity(preset: ParticlePreset, v: number, seconds = 0): void {
    const target = Math.min(1, Math.max(0, v));
    this.pending.set(preset, { v: target, seconds });
    for (const l of this.layers) {
      if (l.preset !== preset) continue;
      l.target = target;
      l.seconds = seconds;
      if (seconds <= 0) {
        l.intensity = target;
        this.applyIntensity(l);
      }
    }
  }

  setLight(sunDir: THREE.Vector3, sunColor: THREE.Color, ambient: THREE.Color): void {
    this.shared.uSunDir.value.copy(sunDir).normalize();
    this.shared.uSunColor.value.copy(sunColor);
    this.shared.uAmbient.value.copy(ambient);
  }

  setDensityScale(q: number): void {
    this.density = Math.min(1, Math.max(0, q));
    for (const l of this.layers) this.applyCount(l);
  }

  /** Optional: viewport height in CSS px and device pixel ratio (point-size scaling). */
  setViewport(heightCssPx: number, pixelRatio: number): void {
    this.shared.uViewH.value = Math.max(1, heightCssPx);
    this.shared.uPixelRatio.value = Math.max(0.5, pixelRatio);
  }

  update(camera: THREE.Camera, dt: number, windDir: THREE.Vector2, windStrength: number): void {
    const wx = windDir.x * windStrength;
    const wz = windDir.y * windStrength;
    const m = sharedUniforms.uMotion.value;
    this.shared.uWind.value.set(wx, wz);
    this.shared.uWindOff.value.x += wx * dt * m;
    this.shared.uWindOff.value.y += wz * dt * m;
    this.shared.uGround.value = this.groundHeight(camera.position.x, camera.position.z);
    for (const l of this.layers) {
      if (l.intensity !== l.target) {
        l.intensity = stepIntensity(l.intensity, l.target, dt, l.seconds);
        this.applyIntensity(l);
      }
    }
  }

  dispose(): void {
    this.disposeLayers();
    this.root.removeFromParent();
  }

  private applyIntensity(l: Layer): void {
    const u = l.material.uniforms.uIntensity;
    if (u) u.value = l.intensity;
    l.mesh.visible = l.intensity > 0.002;
  }

  private applyCount(l: Layer): void {
    const n = visibleCount(l.count, this.density);
    if (l.geometry instanceof THREE.InstancedBufferGeometry) l.geometry.instanceCount = n;
    else l.geometry.setDrawRange(0, n);
  }

  private disposeLayers(): void {
    for (const l of this.layers) {
      this.root.remove(l.mesh);
      l.geometry.dispose();
      l.material.dispose();
    }
    this.layers = [];
  }

  private buildLayer(opt: ParticleLayerOptions, seed: number): Layer {
    const cfg = CONFIG[opt.preset];
    const count = Math.max(1, Math.floor(opt.count));
    const seeds = new THREE.InstancedBufferAttribute(makeSeeds(count, seed), 4);
    let geometry: THREE.BufferGeometry;
    if (cfg.mode === 'point') {
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds.array, 4));
    } else {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
      );
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.setAttribute('aSeed', seeds);
      g.instanceCount = count;
      geometry = g;
    }
    const defines: Record<string, string> = { [DEFINES[opt.preset]]: '' };
    if (cfg.mode === 'point') defines.MODE_POINT = '';
    const material = new THREE.ShaderMaterial({
      name: `Particles-${opt.preset}`,
      defines,
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      fog: false,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: opt.preset === 'leaves' || opt.preset === 'rain' ? THREE.DoubleSide : THREE.FrontSide,
      uniforms: {
        uTime: sharedUniforms.uTime,
        uFogColor: sharedUniforms.uFogColor,
        uFogDensity: sharedUniforms.uFogDensity,
        uFogHeightFalloff: sharedUniforms.uFogHeightFalloff,
        uFogBaseHeight: sharedUniforms.uFogBaseHeight,
        uFogSunDir: sharedUniforms.uFogSunDir,
        uFogSunColor: sharedUniforms.uFogSunColor,
        uFogSunScatter: sharedUniforms.uFogSunScatter,
        ...this.shared,
        uRadius: { value: opt.radius },
        uHeightMin: { value: opt.height[0] },
        uHeightMax: { value: opt.height[1] },
        uSizeRange: { value: new THREE.Vector2(cfg.size[0], cfg.size[1]) },
        uPointClamp: { value: new THREE.Vector2(cfg.pointClamp[0], cfg.pointClamp[1]) },
        uFall: { value: cfg.fall },
        uWindF: { value: cfg.windFactor },
        uOpacity: { value: cfg.opacity },
        uColor: { value: new THREE.Color(cfg.color[0], cfg.color[1], cfg.color[2]) },
        uIntensity: { value: 1 },
      },
    });
    const mesh: THREE.Mesh | THREE.Points =
      cfg.mode === 'point'
        ? new THREE.Points(geometry, material)
        : new THREE.Mesh(geometry, material);
    mesh.name = `particles-${opt.preset}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = opt.preset === 'mist' ? 10 : 11;
    return {
      preset: opt.preset,
      count,
      mesh,
      geometry,
      material,
      intensity: 1,
      target: 1,
      seconds: 0,
    };
  }
}
