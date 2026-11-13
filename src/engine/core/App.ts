// Application shell: owns renderer/pipeline, UI, input and the active SceneRuntime; runs the loop.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PRESET_ORDER } from '../../data/quality-presets';
import { SCENES } from '../../scenes';
import { UI } from '../../ui/UI';
import { AMBIENCE_PRESETS, AudioEngine } from '../audio/AudioEngine';
import { DebugOverlay, estimateMemory, FrameTimer } from '../debug/DebugOverlay';
import { InputManager } from '../input/InputManager';
import { capture, PhotoMode } from '../photo/PhotoMode';
import { dofFromLens, maxCaptureScale } from '../photo/lens';
import { FILM_LOOKS } from '../render/grade';
import { installFogChunks, sharedUniforms } from '../render/materials';
import { type GradeInputs, RenderPipeline } from '../render/pipeline';
import type { InputFrame, PhotoParams, PresetId, QualitySettings } from '../types';
import { EventBus } from './events';
import { SceneRuntime } from './SceneRuntime';
import { isLikelyIPad, isTouchDevice, resolveQuality, SettingsStore } from './settings';

type Rapier = typeof RAPIER_NS;

let rapierPromise: Promise<Rapier> | null = null;
function loadRapier(): Promise<Rapier> {
  rapierPromise ??= import('@dimforge/rapier3d-compat').then(async (m) => {
    await m.default.init();
    return m.default;
  });
  return rapierPromise;
}

export interface AppOptions {
  /** Deterministic screenshot/benchmark run: no menu, fixed camera, N frames. */
  shot?: {
    scene: string;
    mood?: string;
    camera?: string;
    frames: number;
    preset?: PresetId;
    photo?: Partial<PhotoParams>;
  };
  bench?: { scene: string; mood?: string; preset?: PresetId; seconds: number };
  /** Force a preset without persisting it (QA). */
  preset?: PresetId;
}

export class App {
  readonly events = new EventBus();
  readonly settings = new SettingsStore(this.events);
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 0.1, 1200);
  readonly pipeline: RenderPipeline;
  readonly ui: UI;
  readonly input: InputManager;
  readonly debug: DebugOverlay;
  readonly photo = new PhotoMode();
  readonly audio: AudioEngine;
  private strideAcc = 0;
  private lastFeet = new THREE.Vector3();
  private pmrem: THREE.PMREMGenerator;
  private runtime: SceneRuntime | null = null;
  private quality: QualitySettings;
  private timer = new FrameTimer();
  private lastFrame = 0;
  private lastRender = 0;
  private running = false;
  private seedOverride: number | null = null;
  private focusArmed = false;
  private loading = false;
  private motionTime = 0;
  private watchdogBad = 0;
  private captureBusy = false;
  private presetOverride: PresetId | null = null;

  constructor(
    private container: HTMLElement,
    private opts: AppOptions = {},
  ) {
    installFogChunks();
    // A FogExp2 placeholder enables USE_FOG; actual fog is the height fog in our chunks.
    this.scene.fog = new THREE.FogExp2(0x000000, 0);
    this.pipeline = new RenderPipeline(container, this.scene, this.camera);
    this.pmrem = new THREE.PMREMGenerator(this.pipeline.renderer);
    const presetParam = opts.shot?.preset ?? opts.bench?.preset ?? opts.preset ?? null;
    this.presetOverride = presetParam;
    this.quality = this.resolveQuality();

    const uiRoot = document.getElementById('ui') ?? container;
    const hudRoot = document.getElementById('hud') ?? container;
    this.input = new InputManager({
      element: this.pipeline.domElement,
      hudRoot,
      settings: this.settings,
      events: this.events,
    });
    this.debug = new DebugOverlay(document.body);
    this.ui = new UI(uiRoot, {
      events: this.events,
      settings: this.settings,
      scenes: SCENES.filter((s) => !s.hidden).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        moods: s.moods,
        available: s.available,
      })),
      isTouch: () => this.input.usingTouch || isTouchDevice(),
      maxCaptureScale: () => this.maxScale(),
      actions: {
        enterScene: (id, mood) => void this.enterScene(id, mood),
        exitToMenu: () => this.exitToMenu(),
        resume: () => this.resume(),
        setMood: (id) => this.setMood(id),
        togglePhoto: (on) => this.togglePhoto(on),
        setPhotoParams: (p) => {
          Object.assign(this.photo.params, p);
          this.events.emit('photo:params', this.photo.params);
        },
        getPhotoParams: () => this.photo.params,
        resetPhotoParams: () => {
          this.photo.reset();
          this.events.emit('photo:params', this.photo.params);
        },
        armFocusPick: () => {
          this.focusArmed = true;
          this.events.emit('toast', { text: 'Tap or click the subject to focus' });
        },
        capture: (s) => void this.capture(s),
        setSeed: (seed) => {
          this.seedOverride = seed;
          if (this.runtime)
            void this.enterScene(this.runtime.def.id, this.runtime.moods.current.id);
        },
      },
    });

    this.audio = new AudioEngine({ masterVolume: this.settings.get().masterVolume });
    // iOS/Safari only allow audio after a user gesture.
    const unlock = () => {
      void this.audio.unlock();
      if (this.audio.unlocked)
        for (const t of ['pointerdown', 'keydown', 'touchend'])
          removeEventListener(t, unlock, true);
    };
    for (const t of ['pointerdown', 'keydown', 'touchend']) addEventListener(t, unlock, true);
    this.events.on('settings:changed', () => this.onSettings());
    this.input.onCanvasTap((x, y) => this.onTap(x, y));
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop();
      else this.start();
    });
    this.onSettings();
  }

  private resolveQuality(): QualitySettings {
    const s = this.settings.get();
    if (this.presetOverride && this.presetOverride !== 'custom')
      return resolveQuality({ ...s, preset: this.presetOverride });
    return resolveQuality(s);
  }

  private maxScale(): 1 | 2 | 4 {
    const { width, height } = this.pipeline.bufferSize;
    // iOS canvases have a much smaller area limit; keep the final PNG ≲ 16 MP there.
    return maxCaptureScale(width, height, isLikelyIPad() ? 16_000_000 : 64_000_000);
  }

  private onSettings(): void {
    const s = this.settings.get();
    this.quality = this.resolveQuality();
    this.pipeline.setQuality(this.quality);
    this.runtime?.applyQuality(this.quality);
    if (!this.photo.active) {
      this.camera.fov = s.fov;
      this.camera.updateProjectionMatrix();
    }
    document.documentElement.style.setProperty('--ui-scale', String(s.uiScale));
    this.audio?.setMasterVolume(s.masterVolume);
    this.events.emit('quality:applied', { preset: s.preset, settings: this.quality });
  }

  private resize(): void {
    this.pipeline.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  async boot(): Promise<void> {
    if (this.opts.shot) {
      document.body.classList.add('shot-mode');
      await this.enterScene(this.opts.shot.scene, this.opts.shot.mood);
      await this.runShot();
      return;
    }
    if (this.opts.bench) {
      await this.enterScene(this.opts.bench.scene, this.opts.bench.mood);
      this.runBench();
      return;
    }
    this.ui.showMainMenu();
    this.input.setMode('ui');
    this.renderMenuBackdrop();
    void loadRapier(); // warm up while the user picks a scene
  }

  private renderMenuBackdrop(): void {
    this.pipeline.renderer.setClearColor(0x0b0d10, 1);
    this.pipeline.renderer.clear();
  }

  async enterScene(id: string, moodId?: string): Promise<void> {
    if (this.loading) return;
    const entry = SCENES.find((s) => s.id === id);
    if (!entry?.load) return;
    this.loading = true;
    this.stop();
    if (this.photo.active) this.togglePhoto(false);
    this.disposeRuntime();
    this.ui.hideMenus();
    this.ui.showLoading(entry.name);
    const progress = (p: number, label: string) =>
      this.events.emit('scene:loading', { id, progress: p, label });
    try {
      progress(0.01, 'Loading physics');
      const [R, def] = await Promise.all([loadRapier(), entry.load()]);
      const rt = new SceneRuntime(R, def, this.quality, this.seedOverride);
      await rt.load(this.settings, progress, this.pipeline.renderer);
      this.runtime = rt;
      this.scene.add(rt.root);
      const mood = moodId && def.moods.some((m) => m.id === moodId) ? moodId : def.defaultMood;
      progress(0.93, 'Loading sky');
      await rt.preloadSkies();
      rt.setMood(mood, 0);
      this.applyAudioMood(mood, 0.5);
      this.audio.setEmitters(
        rt.creek ? [{ id: 'creek', kind: 'creek', points: rt.creek.centerline, level: 1 }] : [],
      );
      this.lastFeet.copy(rt.player.feet);
      this.events.emit('mood:changed', { id: mood, name: rt.mood(mood).name });
      progress(0.97, 'Compiling shaders');
      rt.update(0, null, this.camera, this.pipeline.renderer, this.scene, this.pmrem);
      this.placeCamera();
      this.pipeline.configure(this.gradeInputs(), false);
      await this.pipeline.renderer.compileAsync(this.scene, this.camera);
      progress(1, 'Ready');
      this.ui.hideLoading();
      this.input.setMode('walk');
      this.events.emit('scene:ready', { id });
      if (!this.settings.get().seenTutorial && !this.opts.shot && !this.opts.bench) {
        this.ui.showHint(
          this.input.usingTouch || isTouchDevice()
            ? 'Left thumb to walk, right thumb to look. Camera button for photo mode.'
            : 'WASD to walk, mouse to look, Shift to run, P for photo mode, M to change the light, Esc for menu.',
          9000,
        );
        this.settings.update({ seenTutorial: true });
      }
    } finally {
      this.loading = false;
    }
    this.start();
  }

  private placeCamera(): void {
    const rt = this.runtime;
    if (!rt) return;
    const camId = this.opts.shot?.camera;
    const cam = camId ? rt.def.cameras.find((c) => c.id === camId) : undefined;
    if (cam) {
      // Review camera heights are relative to the terrain under them.
      const [x, y, z] = cam.position;
      this.camera.position.set(x, rt.groundHeight(x, z) + y, z);
      const [tx, ty, tz] = cam.target;
      this.camera.lookAt(tx, rt.groundHeight(tx, tz) + ty, tz);
      if (cam.fov) {
        this.camera.fov = cam.fov;
        this.camera.updateProjectionMatrix();
      }
      return;
    }
    // Player camera from spawn.
    rt.player.update(
      0,
      {
        move: { x: 0, y: 0 },
        lift: 0,
        look: { x: 0, y: 0 },
        sprint: false,
        slow: false,
        crouch: false,
        pressed: new Set(),
      },
      this.camera,
    );
  }

  exitToMenu(): void {
    this.stop();
    if (this.photo.active) this.togglePhoto(false);
    const id = this.runtime?.def.id;
    this.disposeRuntime();
    this.audio.setEmitters([]);
    this.renderMenuBackdrop();
    this.ui.showMainMenu();
    this.input.setMode('ui');
    if (id) this.events.emit('scene:exited', { id });
  }

  private disposeRuntime(): void {
    if (!this.runtime) return;
    this.runtime.dispose(this.scene);
    this.runtime = null;
    this.scene.environment = null;
  }

  private resume(): void {
    this.ui.hideMenus();
    this.input.setMode(this.photo.active ? 'photo' : 'walk');
    this.start();
  }

  setMood(id: string): void {
    const rt = this.runtime;
    if (!rt) return;
    rt.setMood(id, this.settings.get().reduceMotion ? 0.5 : 3);
    this.applyAudioMood(id, 4);
    this.events.emit('mood:changed', { id, name: rt.mood(id).name });
  }

  private applyAudioMood(id: string, seconds: number): void {
    const key = this.runtime?.mood(id).audio;
    const preset = key ? AMBIENCE_PRESETS[key] : undefined;
    if (preset) this.audio.setMix(preset, seconds);
  }

  private cycleMood(): void {
    const rt = this.runtime;
    if (!rt) return;
    const ids = rt.def.moods.map((m) => m.id);
    const next = ids[(ids.indexOf(rt.moods.current.id) + 1) % ids.length]!;
    this.setMood(next);
    this.events.emit('toast', { text: rt.mood(next).name });
  }

  togglePhoto(on = !this.photo.active): void {
    if (!this.runtime || on === this.photo.active) return;
    if (on) {
      const p = this.runtime.player;
      this.photo.enter(this.camera, p.yaw, p.pitch);
      this.input.setMode('photo');
    } else {
      this.photo.exit(this.camera);
      this.camera.fov = this.settings.get().fov;
      this.camera.updateProjectionMatrix();
      this.input.setMode('walk');
    }
    this.ui.setPhotoMode(on);
    this.events.emit('photo:toggled', { active: on });
    this.events.emit('photo:params', this.photo.params);
  }

  private onTap(ndcX: number, ndcY: number): void {
    if (!this.focusArmed || !this.runtime) return;
    this.focusArmed = false;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    ray.far = 500;
    const targets: THREE.Object3D[] = [this.runtime.terrain.mesh];
    this.runtime.scatter.root.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh && o.visible) targets.push(o);
    });
    const hit = ray.intersectObjects(targets, false)[0];
    if (hit) {
      this.photo.params.focusDistance = Number(hit.distance.toFixed(2));
      this.photo.params.dof = true;
      this.events.emit('photo:params', this.photo.params);
      this.events.emit('toast', { text: `Focus ${hit.distance.toFixed(1)} m` });
    }
  }

  // ---- frame ------------------------------------------------------------------------------------

  private gradeInputs(forCapture = false): GradeInputs {
    const rt = this.runtime;
    const m = rt?.moods.state;
    const ph = this.photo.active ? this.photo.params : null;
    const q = this.quality;
    const lens = dofFromLens(ph?.focalLength ?? 35, ph?.aperture ?? 8, ph?.focusDistance ?? 10);
    const liveLensFx = q.lensFx || (!!ph && this.settings.get().preset !== 'saver');
    return {
      exposure: (m?.exposure ?? 0) + (ph?.exposure ?? 0),
      temperature: (m?.temperature ?? 0) + (ph?.temperature ?? 0),
      tint: (m?.tint ?? 0) + (ph?.tint ?? 0),
      contrast: (m?.contrast ?? 0) + (ph?.contrast ?? 0),
      saturation: (m?.saturation ?? 0) + (ph?.saturation ?? 0),
      bloom: (m?.bloom ?? 0.5) * (ph ? ph.bloom : 1),
      vignette: ph ? ph.vignette : (m?.vignette ?? 0.3),
      grain: ph ? ph.grain : q.lensFx ? 0.06 : 0,
      chromaticAberration: ph?.chromaticAberration ?? 0,
      look: FILM_LOOKS[ph?.look ?? 'neutral'],
      dof: { enabled: !!ph?.dof, focusDistance: ph?.focusDistance ?? 10, ...lens },
      lensFx: forCapture || liveLensFx,
    };
  }

  private handlePresses(f: InputFrame): void {
    const p = f.pressed;
    if (p.has('debug')) {
      this.debug.toggle();
      this.events.emit('debug:toggled', { visible: this.debug.visible });
    }
    if (p.has('hideUI')) {
      const hidden = !document.body.classList.contains('ui-hidden');
      this.ui.setHidden(hidden);
      this.events.emit('ui:hidden', { hidden });
    }
    if (p.has('menu')) {
      if (this.ui.menuOpen) this.resume();
      else if (this.runtime) {
        this.input.setMode('ui');
        this.ui.showPauseMenu(
          this.runtime.def.id,
          this.runtime.def.moods.map((m) => ({ id: m.id, name: m.name })),
          this.runtime.moods.current.id,
        );
        // Render pauses while the menu is open (battery); the last frame stays on screen.
        this.stop();
      }
      return;
    }
    if (this.ui.menuOpen) return;
    if (p.has('photoMode')) this.togglePhoto();
    if (p.has('cycleMood')) this.cycleMood();
    if (p.has('capture') && this.photo.active) void this.capture(1);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const cap = this.quality.fpsCap;
    if (cap === 30 && now - this.lastRender < 1000 / 30 - 3) return;
    const dt = Math.min(0.1, this.lastFrame ? (now - this.lastFrame) / 1000 : 1 / 60);
    this.lastFrame = now;
    this.lastRender = now;
    this.step(dt, now);
  };

  private step(dt: number, now: number): void {
    const rt = this.runtime;
    const f = this.input.poll(dt);
    this.handlePresses(f);
    if (!this.running || !rt) return;
    const s = this.settings.get();
    const motion =
      (this.photo.active && this.photo.params.pauseMotion ? 0 : 1) * (s.reduceMotion ? 0.4 : 1);
    this.motionTime += dt * motion;
    sharedUniforms.uTime.value = this.motionTime;

    if (this.photo.active) {
      this.photo.update(dt, f, this.camera, {
        halfExtent: rt.def.bounds.photoHalfExtent,
        maxHeight: rt.def.bounds.photoMaxHeight,
        groundHeight: (x, z) => rt.groundHeight(x, z),
      });
      rt.update(dt, null, this.camera, this.pipeline.renderer, this.scene, this.pmrem);
    } else {
      rt.update(
        dt,
        this.ui.menuOpen ? null : f,
        this.camera,
        this.pipeline.renderer,
        this.scene,
        this.pmrem,
      );
    }
    this.positionSunSprite();
    this.pipeline.configure(this.gradeInputs(), this.quality.liveDof);
    this.pipeline.render(dt);
    this.updateAudio(dt);
    this.timer.tick(now);
    this.watchdog();
    this.debug.update(
      this.timer,
      this.pipeline.renderer,
      this.scene,
      {
        preset: this.presetOverride ?? s.preset,
        mood: rt.moods.current.id,
        seed: rt.seed,
        instances: rt.scatter.stats.instances,
        visibleInstances: rt.scatter.stats.visibleInstances,
        scatterMeshes: rt.scatter.stats.visibleMeshes,
        position: this.camera.position,
      },
      now,
    );
  }

  private updateAudio(dt: number): void {
    const rt = this.runtime;
    if (!rt) return;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    this.audio.update({ position: this.camera.position, forward: fwd }, dt);
    if (this.photo.active) return;
    const p = rt.player;
    const moved = Math.hypot(p.feet.x - this.lastFeet.x, p.feet.z - this.lastFeet.z);
    this.lastFeet.copy(p.feet);
    if (p.speed < 0.3 || moved > 2) return;
    this.strideAcc += moved;
    const stride = p.speed > 3 ? 1.15 : p.crouching ? 0.55 : 0.78;
    if (this.strideAcc >= stride) {
      this.strideAcc = 0;
      const intensity = Math.min(1, 0.25 + p.speed / 4.5) * (p.crouching ? 0.5 : 1);
      this.audio.footstep(rt.surfaceAt(p.feet.x, p.feet.z), intensity);
    }
  }

  private positionSunSprite(): void {
    const rt = this.runtime;
    if (!rt) return;
    const sp = this.pipeline.sunSprite;
    const dir = rt.moods.state.sunDir;
    sp.position.copy(this.camera.position).addScaledVector(dir, 600);
    sp.scale.setScalar(14);
    (sp.material as THREE.MeshBasicMaterial).color.copy(rt.moods.state.sunColor);
    sp.visible = dir.y > -0.03;
    sp.updateMatrixWorld();
  }

  private watchdog(): void {
    const s = this.settings.get();
    if (!s.watchdog || s.preset === 'custom' || s.preset === 'saver' || this.timer.fps === 0)
      return;
    const budget = (1000 / this.quality.fpsCap) * 1.3;
    if (this.timer.p95 > budget) this.watchdogBad++;
    else this.watchdogBad = Math.max(0, this.watchdogBad - 2);
    if (this.watchdogBad > 300) {
      this.watchdogBad = 0;
      const i = PRESET_ORDER.indexOf(s.preset as (typeof PRESET_ORDER)[number]);
      const to = PRESET_ORDER[Math.min(PRESET_ORDER.length - 1, i + 1)]!;
      this.settings.update({ preset: to });
      this.events.emit('watchdog:downgrade', { from: s.preset, to });
    }
  }

  start(): void {
    if (this.running || !this.runtime || this.loading || this.ui.menuOpen) return;
    this.running = true;
    this.lastFrame = 0;
    this.audio.resume();
    requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    this.audio?.suspend();
  }

  // ---- capture ----------------------------------------------------------------------------------

  async capture(scale: 1 | 2 | 4): Promise<void> {
    const rt = this.runtime;
    if (!rt || this.captureBusy) return;
    this.captureBusy = true;
    const s = Math.min(scale, this.maxScale()) as 1 | 2 | 4;
    const wasRunning = this.running;
    this.stop();
    try {
      const result = await capture(
        {
          renderer: this.pipeline.renderer,
          camera: this.camera,
          renderFrame: (lensFx) => {
            // Heavy effects (DOF) are always enabled for the final capture, even on Battery Saver.
            const g = this.gradeInputs(lensFx);
            g.lensFx = lensFx;
            this.pipeline.configure(g, true);
            this.pipeline.render(0);
          },
          vignette: this.gradeInputs().vignette,
          grain: this.gradeInputs().grain,
        },
        s,
      );
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `modulo-${rt.def.id}-${rt.moods.current.id}-${ts}.png`;
      this.events.emit('photo:captured', { ...result, filename });
    } catch (e) {
      this.events.emit('toast', { text: `Capture failed: ${(e as Error).message}` });
    } finally {
      this.captureBusy = false;
      this.pipeline.configure(this.gradeInputs(), this.quality.liveDof);
      if (wasRunning) this.start();
    }
  }

  // ---- automation (screenshots, benchmark, leak tests) -------------------------------------------

  private async runShot(): Promise<void> {
    const shot = this.opts.shot!;
    const rt = this.runtime!;
    if (shot.photo) {
      this.togglePhoto(true);
      Object.assign(this.photo.params, shot.photo);
      this.placeCamera();
      this.photo.position.copy(this.camera.position);
      const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      this.photo.yaw = e.y;
      this.photo.pitch = e.x;
    }
    this.stop();
    for (let i = 0; i < shot.frames; i++) {
      this.motionTime += 1 / 60;
      sharedUniforms.uTime.value = this.motionTime;
      rt.update(1 / 60, null, this.camera, this.pipeline.renderer, this.scene, this.pmrem);
      this.positionSunSprite();
      this.pipeline.configure(this.gradeInputs(), shot.photo?.dof ? true : this.quality.liveDof);
      this.pipeline.render(1 / 60);
      await new Promise((r) => setTimeout(r, 0));
    }
    const info = this.pipeline.renderer.info;
    window.__info = {
      scene: rt.def.id,
      mood: rt.moods.current.id,
      calls: info.render.calls,
      triangles: info.render.triangles,
      instances: rt.scatter.stats.instances,
      visibleInstances: rt.scatter.stats.visibleInstances,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      memoryMB: Object.fromEntries(
        Object.entries(estimateMemory(this.scene)).map(([k, v]) => [k, +(v / 1048576).toFixed(1)]),
      ),
      buffer: this.pipeline.bufferSize,
    };
    window.__shotReady = true;
  }

  private runBench(): void {
    const b = this.opts.bench!;
    const rt = this.runtime!;
    const cams = rt.def.cameras.filter((c) => c.id !== 'aerial');
    const times: number[] = [];
    let calls = 0;
    let tris = 0;
    const start = performance.now();
    let last = start;
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      const dt = (now - last) / 1000;
      if (now !== last) times.push(now - last);
      last = now;
      // Catmull-like walk through review cameras.
      const u = (t / b.seconds) * (cams.length - 1);
      const i = Math.min(cams.length - 2, Math.floor(u));
      const k = u - i;
      const a = cams[i]!;
      const c = cams[i + 1]!;
      const p = new THREE.Vector3(...a.position).lerp(new THREE.Vector3(...c.position), k);
      p.y = Math.max(p.y, rt.groundHeight(p.x, p.z) + 1.6);
      this.camera.position.copy(p);
      this.camera.lookAt(new THREE.Vector3(...a.target).lerp(new THREE.Vector3(...c.target), k));
      this.motionTime += dt;
      sharedUniforms.uTime.value = this.motionTime;
      rt.update(dt, null, this.camera, this.pipeline.renderer, this.scene, this.pmrem);
      this.positionSunSprite();
      this.pipeline.configure(this.gradeInputs(), false);
      this.pipeline.render(dt);
      calls = Math.max(calls, this.pipeline.renderer.info.render.calls);
      tris = Math.max(tris, this.pipeline.renderer.info.render.triangles);
      if (t < b.seconds) requestAnimationFrame(tick);
      else {
        const sorted = times.slice(5).sort((x, y) => x - y);
        const avg = sorted.reduce((s, x) => s + x, 0) / Math.max(1, sorted.length);
        const result = {
          scene: rt.def.id,
          preset: this.presetOverride ?? this.settings.get().preset,
          frames: sorted.length,
          avgMs: +avg.toFixed(2),
          p95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2),
          fps: +(1000 / avg).toFixed(1),
          maxDrawCalls: calls,
          maxTriangles: tris,
          instances: rt.scatter.stats.instances,
          renderer: this.gpuName(),
          viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
        };
        window.__bench = result;
        console.info('[bench]', JSON.stringify(result));
        this.events.emit('toast', { text: `Bench: ${result.fps} fps avg, p95 ${result.p95Ms} ms` });
        this.debug.toggle(true);
        this.debug.el.textContent = JSON.stringify(result, null, 2);
      }
    };
    requestAnimationFrame(tick);
  }

  gpuName(): string {
    const gl = this.pipeline.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
  }

  /** Test hook: renderer memory counters. */
  memory(): { geometries: number; textures: number; programs: number } {
    const i = this.pipeline.renderer.info;
    return {
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      programs: i.programs?.length ?? 0,
    };
  }

  get activeRuntime(): SceneRuntime | null {
    return this.runtime;
  }
}
