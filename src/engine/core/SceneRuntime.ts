// One loaded scene: terrain, scatter, physics, lights, sky and moods. Owns every GPU and physics
// resource it creates and releases them in dispose() (verified by the enter/exit leak test).
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Sky } from '../atmosphere/sky';
import { MoodBlender, type MoodState } from '../lighting/moods';
import { PlayerController } from '../player/PlayerController';
import { sharedUniforms } from '../render/materials';
import { scatterAll, type ScatterResult } from '../scatter/scatter';
import { ScatterRenderer } from '../scatter/ScatterRenderer';
import { rapierHeightfieldDesc } from '../terrain/collision';
import { generateHeightfield, type Heightfield, sampleHeight } from '../terrain/heightfield';
import { TerrainMesh } from '../terrain/terrain';
import type { InputFrame, MoodDef, QualitySettings, SceneDef } from '../types';
import type { SettingsStore } from './settings';

type Rapier = typeof RAPIER_NS;

export type Progress = (p: number, label: string) => void;

const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

export class SceneRuntime {
  readonly def: SceneDef;
  readonly seed: number;
  readonly root = new THREE.Group();
  hf!: Heightfield;
  terrain!: TerrainMesh;
  scatter!: ScatterRenderer;
  results: ScatterResult[] = [];
  world!: RAPIER_NS.World;
  player!: PlayerController;
  readonly sky = new Sky();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  moods!: MoodBlender;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envScene = new THREE.Scene();
  private envSky: THREE.Mesh;
  private envAge = Infinity;
  private quality: QualitySettings;
  private R: Rapier;

  constructor(R: Rapier, def: SceneDef, quality: QualitySettings, seedOverride: number | null) {
    this.R = R;
    this.def = def;
    this.seed = seedOverride ?? def.seed;
    this.quality = quality;
    this.root.name = `scene:${def.id}`;
    this.envSky = new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material);
    this.envSky.scale.setScalar(100);
    this.envScene.add(this.envSky);
  }

  async load(settings: SettingsStore, progress: Progress): Promise<void> {
    const d = this.def;
    progress(0.05, 'Shaping terrain');
    await nextFrame();
    this.hf = generateHeightfield(d.terrain, this.seed);
    // Flatten targets without explicit height adopt the generated height at their centre.
    progress(0.25, 'Painting ground');
    await nextFrame();
    this.terrain = new TerrainMesh(this.hf, d.terrain.layers, this.seed, this.quality.anisotropy);
    this.root.add(this.terrain.mesh);

    progress(0.4, 'Growing vegetation');
    await nextFrame();
    this.scatter = new ScatterRenderer(this.quality);
    this.rescatter();
    this.root.add(this.scatter.root);

    progress(0.75, 'Building collision');
    await nextFrame();
    this.world = new this.R.World({ x: 0, y: -9.81, z: 0 });
    this.world.createCollider(rapierHeightfieldDesc(this.R, this.hf));
    this.buildProxies();
    const spawn = d.spawn.position;
    const sy = sampleHeight(this.hf, spawn[0], spawn[2]);
    this.player = new PlayerController(this.R, this.world, {
      spawn: [spawn[0], sy + 0.1, spawn[2]],
      yaw: d.spawn.yaw,
      walkRadius: d.bounds.walkRadius,
      settings,
      groundHeight: (x, z) => sampleHeight(this.hf, x, z),
    });
    this.world.step();

    progress(0.9, 'Lighting');
    await nextFrame();
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.root.add(this.sun, this.sun.target, this.hemi, this.sky.mesh);
    this.moods = new MoodBlender(this.mood(d.defaultMood));
    this.applyQuality(this.quality);
  }

  mood(id: string): MoodDef {
    return this.def.moods.find((m) => m.id === id) ?? this.def.moods[0]!;
  }

  rescatter(): void {
    this.results = scatterAll(this.def.scatter, this.hf, {
      seed: this.seed,
      vegetationDensity: this.quality.vegetationDensity,
      radius: this.def.terrain.size / 2 - 3,
      layerWeight: (layer, x, z) => this.terrain.splat.weight(layer, x, z),
    });
    this.scatter.build(this.results);
  }

  private buildProxies(): void {
    for (const rule of this.def.scatter) {
      if (!rule.collision || rule.collision === 'none') continue;
      const sp = this.scatter.speciesInfo(rule.mesh);
      this.scatter.forEachInstance(rule.id, this.results, (x, y, z, s) => {
        const desc =
          rule.collision === 'sphere'
            ? this.R.ColliderDesc.ball(sp.radius * s * 0.9).setTranslation(
                x,
                y + sp.height * s * 0.3,
                z,
              )
            : this.R.ColliderDesc.cylinder(1.5, sp.radius * s).setTranslation(x, y + 1.5, z);
        this.world.createCollider(desc);
      });
    }
  }

  applyQuality(q: QualitySettings): void {
    const densityChanged = q.vegetationDensity !== this.quality.vegetationDensity;
    this.quality = q;
    this.scatter.setQuality(q);
    if (densityChanged) this.rescatter();
    this.terrain.setAnisotropy(q.anisotropy);
    const s = this.sun.shadow;
    this.sun.castShadow = q.shadows.enabled;
    if (q.shadows.enabled && s.mapSize.x !== q.shadows.mapSize) {
      s.mapSize.set(q.shadows.mapSize, q.shadows.mapSize);
      s.map?.dispose();
      s.map = null as unknown as THREE.WebGLRenderTarget;
    }
    const cam = s.camera;
    const r = Math.max(5, q.shadows.distance);
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
  }

  setMood(id: string, seconds = 3): void {
    this.moods.go(this.mood(id), seconds);
    this.envAge = Infinity;
  }

  /** Apply the blended mood to lights, sky, fog uniforms and IBL. */
  private applyMood(
    s: MoodState,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    pmrem: THREE.PMREMGenerator,
    dt: number,
  ): void {
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
    // Fade the sun out as it dips below the horizon.
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
    // IBL from the analytic sky; refreshed when the mood changes (throttled during cross-fades).
    this.envAge += dt;
    if (this.envAge > (this.moods.blending ? 0.4 : Infinity) || !this.envRT) {
      this.envAge = 0;
      const prev = this.envRT;
      this.envRT = pmrem.fromScene(this.envScene, 0, 0.1, 200);
      scene.environment = this.envRT.texture;
      scene.environmentIntensity = 0.55;
      prev?.dispose();
    }
    void renderer;
  }

  update(
    dt: number,
    input: InputFrame | null,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    pmrem: THREE.PMREMGenerator,
  ): void {
    if (input) {
      this.player.update(dt, input, camera);
      this.world.step();
    }
    this.moods.update(dt);
    this.applyMood(this.moods.state, renderer, scene, pmrem, dt);
    this.sky.update(camera);
    this.scatter.update(camera);
    this.updateShadowFrustum(camera);
  }

  /** Centre the shadow box on the camera, snapped to shadow texels to avoid shimmering. */
  private updateShadowFrustum(camera: THREE.Camera): void {
    if (!this.sun.castShadow) return;
    const q = this.quality;
    const dir = this.moods.state.sunDir;
    const r = Math.max(5, q.shadows.distance);
    const texel = (2 * r) / q.shadows.mapSize;
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    // Bias the box forward: what you look at matters more than what is behind you.
    const center = camera.position.clone().addScaledVector(fwd, r * 0.45);
    // Snap in light space.
    const lightRot = new THREE.Matrix4().lookAt(
      new THREE.Vector3(),
      dir.clone().negate(),
      new THREE.Vector3(0, 1, 0),
    );
    const inv = lightRot.clone().invert();
    center.applyMatrix4(inv);
    center.x = Math.round(center.x / texel) * texel;
    center.y = Math.round(center.y / texel) * texel;
    center.applyMatrix4(lightRot);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(dir, 150);
    this.sun.target.updateMatrixWorld();
  }

  groundHeight(x: number, z: number): number {
    return sampleHeight(this.hf, x, z);
  }

  dispose(scene: THREE.Scene): void {
    this.player?.dispose();
    this.world?.free();
    this.scatter?.dispose();
    this.terrain?.dispose();
    this.sky.dispose();
    this.sun.shadow.map?.dispose();
    this.sun.dispose();
    this.envRT?.dispose();
    if (scene.environment === this.envRT?.texture) scene.environment = null;
    this.envRT = null;
    this.root.removeFromParent();
    this.root.clear();
  }
}
