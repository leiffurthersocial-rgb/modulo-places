// One loaded scene: terrain, scatter, physics, lights, sky and moods. Owns every GPU and physics
// resource it creates and releases them in dispose() (verified by the enter/exit leak test).
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { AssetLoader, loadPackManifest, type Tier } from '../assets/AssetLoader';
import { ParticleField, type ParticlePreset } from '../atmosphere/particles/Particles';
import { findHdriSun, Sky } from '../atmosphere/sky';
import { bakeImpostor, type Impostor } from '../scatter/impostor/Impostor';
import { type Species, speciesFromGltf } from '../scatter/species';
import type { TerrainLayerMaps } from '../terrain/terrainMaterial';
import { Creek } from '../water/Creek';
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
  assets: AssetLoader | null = null;
  particles: ParticleField | null = null;
  creek: Creek | null = null;
  private modelSpecies = new Map<string, Species>();
  private impostors: Impostor[] = [];
  private hdris = new Map<string, Promise<{ tex: THREE.DataTexture; sunAz: number } | null>>();

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

  async load(
    settings: SettingsStore,
    progress: Progress,
    renderer: THREE.WebGLRenderer,
  ): Promise<void> {
    const d = this.def;
    const q = this.quality;
    progress(0.03, 'Reading asset manifest');
    const manifest = await loadPackManifest();
    if (manifest) this.assets = new AssetLoader(renderer, manifest);
    progress(0.05, 'Shaping terrain');
    await nextFrame();
    this.hf = generateHeightfield(d.terrain, this.seed);

    progress(0.12, 'Loading ground materials');
    let layerMaps: (TerrainLayerMaps | null)[] | null = null;
    if (this.assets) {
      layerMaps = await Promise.all(
        d.terrain.layers.slice(0, 4).map(async (l) => {
          const maps = await this.assets!.material(l.material, q.textureTier as Tier, q.anisotropy);
          return maps ? { maps, scale: l.scale ?? 2.5, triplanar: !!l.triplanar } : null;
        }),
      );
    }
    progress(0.3, 'Painting ground');
    await nextFrame();
    this.terrain = new TerrainMesh(this.hf, d.terrain, this.seed, {
      anisotropy: q.anisotropy,
      layerMaps,
      antiTiling: q.textureTier >= 1024,
    });
    this.root.add(this.terrain.mesh);

    if (d.terrain.creek) {
      const c = d.terrain.creek;
      const bed =
        c.bedMaterial && this.assets
          ? await this.assets.material(
              c.bedMaterial,
              Math.min(q.textureTier, 1024) as Tier,
              q.anisotropy,
            )
          : null;
      this.creek = new Creek({
        points: c.points,
        width: c.width,
        groundHeight: (x, z) => sampleHeight(this.hf, x, z),
        bed,
        quality: q.water,
      });
      this.root.add(this.creek.root);
    }

    progress(0.35, 'Loading plants and rocks');
    await this.loadModelSpecies(renderer, progress);
    progress(0.6, 'Growing vegetation');
    await nextFrame();
    this.scatter = new ScatterRenderer(q, (id) => this.modelSpecies.get(id) ?? null);
    this.rescatter();
    this.root.add(this.scatter.root);

    // Atmosphere particles: every preset any mood uses; intensities follow the mood.
    const presets = new Set<ParticlePreset>();
    for (const m of d.moods) for (const p of m.particles ?? []) presets.add(p as ParticlePreset);
    if (presets.size > 0 && q.particles > 0) {
      this.particles = new ParticleField({ groundHeight: (x, z) => sampleHeight(this.hf, x, z) });
      const spec: Record<
        ParticlePreset,
        { count: number; radius: number; height: [number, number] }
      > = {
        pollen: { count: 1400, radius: 18, height: [0.3, 6] },
        dust: { count: 900, radius: 14, height: [0.3, 5] },
        mist: { count: 70, radius: 45, height: [0, 3] },
        leaves: { count: 160, radius: 22, height: [0, 14] },
        rain: { count: 6000, radius: 18, height: [0, 14] },
        snow: { count: 4000, radius: 22, height: [0, 14] },
      };
      this.particles.setLayers([...presets].map((p) => ({ preset: p, ...spec[p] })));
      this.particles.setDensityScale(q.particles);
      this.root.add(this.particles.root);
    }

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

  /** Load every model referenced by scatter rules ("model:<pack key>") and build species. */
  private async loadModelSpecies(renderer: THREE.WebGLRenderer, progress: Progress): Promise<void> {
    if (!this.assets) return;
    const rules = this.def.scatter.filter((r) => r.mesh.startsWith('model:'));
    const keys = [...new Set(rules.map((r) => r.mesh))];
    let done = 0;
    const msaa = this.quality.aa === 'msaa' || this.quality.aa === 'msaa+smaa';
    await Promise.all(
      keys.map(async (meshId) => {
        const key = meshId.slice('model:'.length);
        const gltf = await this.assets!.model(key).catch((e: unknown) => {
          console.warn(`model ${key} failed`, e);
          return null;
        });
        progress(0.35 + (0.25 * ++done) / keys.length, 'Loading plants and rocks');
        if (!gltf) return;
        const rule = rules.find((r) => r.mesh === meshId)!;
        const sp = speciesFromGltf(gltf.scene, {
          wind: rule.wind ?? 0,
          flutter: rule.flutter ?? 0,
          alphaToCoverage: msaa,
        });
        if (rule.impostor && this.quality.drawDistance > 60) {
          const src = new THREE.Group();
          for (const part of sp.variants[0]![0]!)
            src.add(new THREE.Mesh(part.geometry, part.material));
          const imp = bakeImpostor(renderer, src, {
            views: 12,
            resolution: this.quality.textureTier >= 2048 ? 512 : 256,
          });
          this.impostors.push(imp);
          sp.impostor = [{ geometry: imp.geometry, material: imp.material, castShadow: false }];
        }
        this.modelSpecies.set(meshId, sp);
      }),
    );
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
            : this.R.ColliderDesc.cylinder(
                1.5,
                (rule.collisionRadius ?? sp.radius * 0.12) * s,
              ).setTranslation(x, y + 1.5, z);
        this.world.createCollider(desc);
      });
    }
  }

  applyQuality(q: QualitySettings): void {
    const densityChanged = q.vegetationDensity !== this.quality.vegetationDensity;
    this.quality = q;
    this.scatter.setQuality(q);
    if (densityChanged) this.rescatter();
    this.particles?.setDensityScale(q.particles);
    this.creek?.setQuality(q.water);
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

  private hdri(key: string) {
    let p = this.hdris.get(key);
    if (!p) {
      const res = this.quality.textureTier >= 2048 ? '2k' : '1k';
      p = (this.assets?.hdri(key, res) ?? Promise.resolve(null)).then((tex) => {
        if (!tex) return null;
        return { tex, sunAz: findHdriSun(tex).azimuth };
      });
      this.hdris.set(key, p);
    }
    return p;
  }

  /** Preload the HDRIs of all moods (so mood switches cross-fade without a pop). */
  async preloadSkies(): Promise<void> {
    await Promise.all(this.def.moods.filter((m) => m.sky.hdri).map((m) => this.hdri(m.sky.hdri!)));
  }

  setMood(id: string, seconds = 3): void {
    const m = this.mood(id);
    this.moods.go(m, seconds);
    const key = m.sky.hdri;
    if (key) {
      void this.hdri(key).then((h) => {
        if (this.moods.current !== m) return; // superseded
        const moodAz = THREE.MathUtils.degToRad(m.sun.azimuth);
        this.sky.setHdri(
          h?.tex ?? null,
          h ? moodAz - h.sunAz : 0,
          m.sky.hdriIntensity ?? 1,
          seconds,
        );
        this.envAge = Infinity;
      });
    } else this.sky.setHdri(null, 0, 1, seconds);
    this.envAge = Infinity;
    if (this.particles) {
      for (const p of ['pollen', 'dust', 'mist', 'leaves', 'rain', 'snow'] as const) {
        this.particles.setIntensity(p, m.particles?.includes(p) ? 1 : 0, seconds);
      }
    }
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
    const ambient = s.ambSky.clone().multiplyScalar(s.ambIntensity);
    this.particles?.setLight(
      s.sunDir,
      this.sun.color.clone().multiplyScalar(this.sun.intensity / 3),
      ambient,
    );
    for (const imp of this.impostors) {
      imp.setLighting(
        s.sunDir,
        this.sun.color.clone().multiplyScalar(this.sun.intensity),
        this.hemi.color.clone().multiplyScalar(this.hemi.intensity),
        this.hemi.groundColor.clone().multiplyScalar(this.hemi.intensity),
      );
    }
    // IBL from the analytic sky; refreshed when the mood changes (throttled during cross-fades).
    this.envAge += dt;
    if (this.envAge > (this.moods.blending || this.sky.fading ? 0.4 : Infinity) || !this.envRT) {
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
    this.sky.update(camera, dt);
    this.scatter.update(camera);
    this.particles?.update(
      camera,
      dt,
      sharedUniforms.uWindDir.value,
      sharedUniforms.uWindStrength.value,
    );
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

  /** Dominant terrain layer's footstep surface at (x, z) (creek banks → gravel). */
  surfaceAt(
    x: number,
    z: number,
  ): 'leaves' | 'dirt' | 'moss' | 'rock' | 'gravel' | 'snow' | 'wood' {
    if (this.terrain.splat.wetness(x, z) > 0.6) return 'gravel';
    let best = this.def.terrain.layers[0];
    let bw = -1;
    for (const l of this.def.terrain.layers) {
      const w = this.terrain.splat.weight(l.id, x, z);
      if (w > bw) {
        bw = w;
        best = l;
      }
    }
    return best?.surface ?? 'leaves';
  }

  groundHeight(x: number, z: number): number {
    return sampleHeight(this.hf, x, z);
  }

  dispose(scene: THREE.Scene): void {
    this.player?.dispose();
    this.world?.free();
    this.scatter?.dispose();
    this.particles?.dispose();
    this.creek?.dispose();
    for (const imp of this.impostors) imp.dispose();
    this.assets?.dispose();
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
