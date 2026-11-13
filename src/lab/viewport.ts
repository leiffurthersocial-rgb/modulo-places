// Lab viewport: test set (displaced ground, sphere, rounded wall), mood lighting applied like
// SceneRuntime.applyMood, the production RenderPipeline, orbit camera and scissor split compare.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { QUALITY_PRESETS } from '../data/quality-presets';
import { Sky } from '../engine/atmosphere/sky';
import { MoodBlender, type MoodState } from '../engine/lighting/moods';
import { installFogChunks, sharedUniforms } from '../engine/render/materials';
import { FILM_LOOKS } from '../engine/render/grade';
import { type GradeInputs, RenderPipeline } from '../engine/render/pipeline';
import type { MoodDef } from '../engine/types';

export type CameraPreset = 'orbit' | 'walk' | 'close';
export type Layout = 'ground' | 'vertical';

const NEUTRAL = new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.9 });

/** Gentle height field so the patch is not flat (metres). */
function groundHeight(x: number, z: number): number {
  return (
    0.07 * Math.sin(x * 1.3 + 0.4) * Math.cos(z * 1.1) +
    0.035 * Math.sin(x * 3.1 + z * 2.3) +
    0.012 * Math.sin(x * 7.7 - z * 6.1)
  );
}

function makeGround(): THREE.Mesh {
  const g = new THREE.PlaneGeometry(6, 6, 96, 96);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, groundHeight(pos.getX(i), pos.getZ(i)));
  // UVs in metres so "repeats per metre" is the same on every shape.
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), -pos.getZ(i));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, NEUTRAL);
  m.receiveShadow = true;
  m.castShadow = false;
  m.name = 'ground';
  return m;
}

function scaleUv(g: THREE.BufferGeometry, su: number, sv: number): void {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

export class Viewport {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
  readonly pipeline: RenderPipeline;
  readonly controls: OrbitControls;
  readonly blender: MoodBlender;
  private sky = new Sky();
  private sun = new THREE.DirectionalLight(0xffffff, 3);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envAge = Infinity;
  private ground = makeGround();
  private sphere: THREE.Mesh;
  private wall: THREE.Mesh;
  private meshes: THREE.Mesh[];
  private raf = 0;
  private last = performance.now();
  private width = 1;
  private height = 1;
  private ro: ResizeObserver;
  private disposed = false;

  matA: THREE.Material | null = null;
  matB: THREE.Material | null = null;
  compare = false;
  /** Divider position, 0..1 of the viewport width. */
  split = 0.5;
  onFrame: (info: THREE.WebGLInfo['memory'], fps: number) => void = () => undefined;
  private fpsAcc = 0;
  private fpsN = 0;
  private fps = 0;

  constructor(private container: HTMLElement, initial: MoodDef) {
    installFogChunks();
    this.scene.fog = new THREE.FogExp2(0x000000, 0); // enables USE_FOG; real fog is in the chunks
    this.pipeline = new RenderPipeline(container, this.scene, this.camera);
    // Default is the high preset; ?quality=low|medium|... is a debug escape for weak GPUs/software GL.
    const qp = new URLSearchParams(location.search).get('quality');
    const preset =
      qp && qp in QUALITY_PRESETS ? QUALITY_PRESETS[qp as keyof typeof QUALITY_PRESETS] : QUALITY_PRESETS.high;
    this.pipeline.setQuality(preset);
    this.pmrem = new THREE.PMREMGenerator(this.pipeline.renderer);
    this.blender = new MoodBlender(initial);

    const envSky = new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material);
    envSky.scale.setScalar(100);
    this.envScene.add(envSky);

    this.scene.add(this.sky.mesh, this.hemi, this.sun, this.sun.target);
    const q = preset.shadows;
    this.sun.castShadow = q.enabled;
    this.sun.shadow.mapSize.set(q.mapSize, q.mapSize);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -7;
    sc.right = sc.top = 7;
    sc.near = 1;
    sc.far = 90;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;

    const sg = new THREE.SphereGeometry(0.7, 64, 32);
    scaleUv(sg, 2 * Math.PI * 0.7, Math.PI * 0.7);
    this.sphere = new THREE.Mesh(sg, NEUTRAL);
    const wg = new RoundedBoxGeometry(2, 2, 0.4, 6, 0.06);
    scaleUv(wg, 2, 2);
    this.wall = new THREE.Mesh(wg, NEUTRAL);
    this.sphere.castShadow = this.wall.castShadow = true;
    this.sphere.receiveShadow = this.wall.receiveShadow = true;
    this.meshes = [this.ground, this.sphere, this.wall];
    this.scene.add(...this.meshes);
    this.setLayout('ground');

    this.controls = new OrbitControls(this.camera, this.pipeline.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 14;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.setCameraPreset('orbit');

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    this.applyMood(0);
    this.raf = requestAnimationFrame(this.frame);
  }

  get domElement(): HTMLCanvasElement {
    return this.pipeline.domElement;
  }

  setLayout(layout: Layout): void {
    if (layout === 'ground') {
      this.sphere.position.set(-1.25, 0.7 + groundHeight(-1.25, -0.5), -0.5);
      this.wall.position.set(1.45, 1 + groundHeight(1.45, -1), -1);
      this.wall.rotation.y = -0.35;
    } else {
      this.wall.position.set(0, 1 + groundHeight(0, -0.4), -0.4);
      this.wall.rotation.y = 0;
      this.sphere.position.set(-1.7, 0.7 + groundHeight(-1.7, 0.6), 0.6);
    }
  }

  setCameraPreset(p: CameraPreset): void {
    const c = this.camera;
    const t = this.controls.target;
    if (p === 'walk') {
      c.position.set(0, 1.7, 2.9);
      t.set(0, 0, -1.1);
    } else if (p === 'close') {
      c.position.set(0.4, 0.9, 1.9);
      t.set(0, 0.25, 0.4);
    } else {
      c.position.set(3.6, 2.7, 4.6);
      t.set(0, 0.5, 0);
    }
    this.controls.update();
  }

  setMood(m: MoodDef, seconds = 3): void {
    this.blender.go(m, seconds);
    this.envAge = Infinity;
  }

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.round(r.width));
    this.height = Math.max(1, Math.round(r.height));
    this.pipeline.setSize(this.width, this.height);
  }

  /** Mirrors SceneRuntime.applyMood. */
  private applyMood(dt: number): void {
    const s: MoodState = this.blender.state;
    const u = this.sky.uniforms;
    u.uZenith.value.copy(s.zenith);
    u.uHorizon.value.copy(s.horizon);
    u.uGround.value.copy(s.ground);
    u.uSunDir.value.copy(s.sunDir);
    u.uSunColor.value.copy(s.sunColor);
    u.uSunDisc.value = s.sunDisc;
    u.uSunIntensity.value = 18 * Math.max(0.2, s.sunIntensity / 3);
    u.uHorizonFog.value = Math.min(1, s.fogDensity * 40 + 0.25);
    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity * THREE.MathUtils.smoothstep(s.sunDir.y, -0.02, 0.06);
    this.hemi.color.copy(s.ambSky);
    this.hemi.groundColor.copy(s.ambGround);
    this.hemi.intensity = s.ambIntensity * 0.55;
    sharedUniforms.uFogColor.value.copy(s.fogColor);
    sharedUniforms.uFogDensity.value = s.fogDensity;
    sharedUniforms.uFogHeightFalloff.value = s.fogFalloff;
    sharedUniforms.uFogBaseHeight.value = s.fogBase;
    sharedUniforms.uFogSunDir.value.copy(s.sunDir);
    sharedUniforms.uFogSunColor.value.copy(s.sunColor);
    sharedUniforms.uFogSunScatter.value = s.fogSunScatter;
    this.envAge += dt;
    if (this.envAge > (this.blender.blending ? 0.4 : Infinity) || !this.envRT) {
      this.envAge = 0;
      const prev = this.envRT;
      this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = 0.55;
      prev?.dispose();
    }
    this.sun.target.position.set(0, 0, 0);
    this.sun.position.copy(s.sunDir).multiplyScalar(30);
    this.sun.target.updateMatrixWorld();
  }

  private grade(): GradeInputs {
    const m = this.blender.state;
    return {
      exposure: m.exposure,
      temperature: m.temperature,
      tint: m.tint,
      contrast: m.contrast,
      saturation: m.saturation,
      bloom: m.bloom,
      vignette: m.vignette,
      grain: 0,
      chromaticAberration: 0,
      look: FILM_LOOKS.neutral,
      dof: { enabled: false, focusDistance: 10, focusRange: 5, bokehScale: 2 },
      lensFx: true,
    };
  }

  private setMaterial(m: THREE.Material | null): void {
    for (const mesh of this.meshes) mesh.material = m ?? NEUTRAL;
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.blender.update(dt);
    this.applyMood(dt);
    this.controls.update();
    this.sky.update(this.camera);
    this.pipeline.configure(this.grade(), false);
    const r = this.pipeline.renderer;
    if (this.compare && this.matA && this.matB) {
      // The composer's intermediate buffers ignore the canvas scissor; only the final pass that
      // writes to the screen is clipped, so rendering the whole chain twice yields two clean halves.
      const x = Math.round(this.split * this.width);
      r.setScissorTest(true);
      this.setMaterial(this.matA);
      r.setScissor(0, 0, x, this.height);
      this.pipeline.render(dt);
      this.setMaterial(this.matB);
      r.setScissor(x, 0, this.width - x, this.height);
      this.pipeline.render(dt);
      r.setScissorTest(false);
    } else {
      this.setMaterial(this.matA);
      this.pipeline.render(dt);
    }
    this.fpsAcc += dt;
    this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsN / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsN = 0;
      this.onFrame(r.info.memory, this.fps);
    }
  };

  get renderer(): THREE.WebGLRenderer {
    return this.pipeline.renderer;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.sky.dispose();
    for (const m of this.meshes) m.geometry.dispose();
    this.pipeline.dispose();
  }
}
