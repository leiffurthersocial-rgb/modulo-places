// Composition root: sim (20 Hz fixed tick) + render interpolation + input + audio + UI + day flow.
import * as THREE from 'three';
import { AudioEngine, type SoundKind } from './audio/audio';
import {
  BenchCameraPath,
  type BenchOptions,
  type BenchResult,
  showBenchPanel,
  summarizeFrames,
} from './bench';
import { type Action, InputManager } from './input/input';
import { DeviceView } from './render/device';
import { estimateGpuMemory } from './render/memory';
import { RoomView } from './render/scene';
import { loadRecord, saveRecord, hasSave, clearSave } from './save/save';
import { Bot, type BotStyle } from './sim/bots';
import { SimClock, TICK_DT } from './sim/clock';
import { CAST, CHALLENGES, LESSONS, NOTES, PLAYABLE_LESSON_TYPES, TEACHERS } from './sim/data';
import { dist2, yawDir } from './sim/geom';
import { EYE_HEIGHT } from './sim/perception';
import { interactables } from './sim/player';
import {
  callHomeText,
  endLesson,
  gradeAverage,
  letter,
  newRecord,
  startNewDay,
  type StudentRecord,
} from './sim/record';
import { hashString, parseSeed, Rng } from './sim/rng';
import { idleCommand, type PlayerCommand, type SimEvent } from './sim/types';
import { type Interactable, World } from './sim/world';
import { esc, UI } from './ui/ui';
import {
  FrameWatch,
  loadSettings,
  PRESET_ORDER,
  PRESETS,
  resolveQuality,
  saveSettings,
  type Settings,
} from './quality';

export interface ShotOptions {
  frames: number;
  lesson: string;
  teacher: string;
  seed: number;
  preSeconds: number;
  bot: BotStyle | null;
  cam: string;
  debug: boolean;
  hud: boolean;
  device: 'phone' | 'laptop' | null;
  preset: string | null;
}

type Mode = 'title' | 'play' | 'menu' | 'summary';

const SOUND_FOR_NOISE: Record<string, SoundKind> = {
  chair: 'chair',
  thud: 'thud',
  door: 'door',
  knock: 'knock',
  paper: 'paper',
  buzz: 'buzz',
  gust: 'gust',
  wobble: 'wobble',
  sharpen: 'sharpen',
  plane: 'plane',
  cough: 'cough',
  sneeze: 'sneeze',
  whisper: 'whisper',
  laugh: 'laugh',
  drop: 'thud',
};

export class ClassroomApp {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(72, 1, 0.03, 60);
  readonly settings: Settings;
  readonly input: InputManager;
  readonly audio = new AudioEngine(24);
  readonly ui = new UI();
  record: StudentRecord;
  world: World | null = null;
  view: RoomView | null = null;
  device = new DeviceView();
  private clock = new SimClock();
  private mode: Mode = 'title';
  private yaw = 0;
  private pitch = -0.08;
  private lean = 0;
  private eyeY = 1.15;
  private prevP = { x: 0, z: 0 };
  private curP = { x: 0, z: 0 };
  private pending: Partial<PlayerCommand> = {};
  private verbIndex = 0;
  private target: Interactable | null = null;
  private throwCharge: number | null = null;
  private crouch = false;
  private debug = false;
  private freecam = false;
  private debugEl: HTMLDivElement | null = null;
  private lastFrame = 0;
  private watch = new FrameWatch();
  private shot: ShotOptions | null;
  private shotFrames = 0;
  private bot: Bot | null = null;
  private lessonCfg = { lesson: 'random', teacher: 'random', seed: '1', cheatSheet: false };
  private hidden = false;
  private footCueT = 0;
  private lastTeacherDist = 99;
  private batteryHinted = false;
  private host: HTMLElement;
  private frameIdx = 0;
  private bench: BenchOptions | null;
  private benchPath: BenchCameraPath | null = null;
  private benchStart = -1;
  private benchLast = 0;
  private benchTimes: number[] = [];
  private benchDone = false;
  private benchSimMs = 0;
  private benchSimTicks = 0;
  private gpuMB = 0;

  constructor(host: HTMLElement, shot: ShotOptions | null, bench: BenchOptions | null = null) {
    this.host = host;
    this.shot = shot;
    this.bench = bench;
    this.settings = loadSettings();
    const presetOverride = shot?.preset ?? bench?.preset;
    if (presetOverride && presetOverride in PRESETS)
      this.settings.preset = presetOverride as Settings['preset'];
    this.record = shot || bench ? newRecord() : loadRecord();
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: !!shot,
    });
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ui.toast(
        'Graphics context lost. Reload the page to continue (your record is saved).',
        10000,
      );
    });
    this.input = new InputManager(this.renderer.domElement, this.settings);
    this.input.km.onWheel = (d) => (this.verbIndex += d);
    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      if (this.hidden) this.audio.suspend();
      else if (this.mode === 'play') this.audio.resume();
    });
    this.resize();
    if (import.meta.env.DEV || new URLSearchParams(location.search).has('test'))
      (window as unknown as { __game: unknown }).__game = this;
  }

  // ------------------------------------------------------------------------------------------
  // Boot / flow

  boot(): void {
    if (this.bench) {
      this.startLesson({
        lesson: this.bench.lesson,
        teacher: this.bench.teacher,
        seed: String(this.bench.seed),
        cheatSheet: false,
      });
      const w = this.world!;
      this.bot = new Bot('sneaky', new Rng(this.bench.seed ^ 0x5eed));
      this.benchPath = new BenchCameraPath(w.layout.room.size, () => w.teacher.pos);
      this.ui.setHudVisible(false);
      this.input.setTouchVisible(false);
      this.mode = 'play';
      requestAnimationFrame((t) => this.frame(t));
      return;
    }
    if (this.shot) {
      this.startLesson({
        lesson: this.shot.lesson,
        teacher: this.shot.teacher,
        seed: String(this.shot.seed),
        cheatSheet: false,
      });
      const w = this.world!;
      if (this.shot.bot) this.bot = new Bot(this.shot.bot, new Rng(this.shot.seed ^ 0x5eed));
      const n = Math.round(this.shot.preSeconds / TICK_DT);
      for (let i = 0; i < n && !w.over; i++)
        this.tickSim(this.bot ? this.bot.command(w) : idleCommand(this.yaw, this.pitch), true);
      if (this.shot.device && w.ps.device.kind !== this.shot.device)
        w.step({ ...idleCommand(this.yaw, this.pitch), device: this.shot.device });
      if (this.shot.device === 'phone' && w.ps.device.mode === 'decoy')
        w.step({ ...idleCommand(this.yaw, this.pitch), device: 'switch' });
      this.bot = this.shot.device ? null : this.bot;
      if (this.shot.device === 'laptop')
        w.step({ ...idleCommand(this.yaw, this.pitch), device: 'switch' });
      this.syncPlayerFromWorld(true);
      this.debug = this.shot.debug;
      this.view!.debug = this.debug;
      this.ui.setHudVisible(this.shot.hud);
      this.input.setTouchVisible(false);
      this.mode = 'play';
      requestAnimationFrame((t) => this.frame(t));
      return;
    }
    this.showTitle();
    requestAnimationFrame((t) => this.frame(t));
  }

  private showTitle(): void {
    this.mode = 'title';
    this.ui.setHudVisible(false);
    this.input.setTouchVisible(false);
    this.input.km.unlock();
    if (!this.world)
      this.startLesson(
        { lesson: 'lecture', teacher: 'strict', seed: '1', cheatSheet: false },
        true,
      );
    this.ui.title({
      record: this.record,
      hasSave: hasSave(),
      detention: this.record.detentionPending,
      seed: String(parseSeed(this.lessonCfg.seed) + 1),
      onStart: (cfg) => {
        void this.audio.unlock();
        this.record.wishlist.active = cfg.wishlist;
        this.startLesson(cfg);
      },
      onReset: () => {
        clearSave();
        this.record = newRecord();
        this.showTitle();
      },
      onSettings: () =>
        this.ui.settings(
          this.settings,
          (s) => this.onSettings(s),
          () => this.showTitle(),
        ),
      onCredits: () => this.ui.credits(() => this.showTitle()),
    });
  }

  startLesson(
    cfg: { lesson: string; teacher: string; seed: string; cheatSheet: boolean },
    background = false,
  ): void {
    this.lessonCfg = cfg;
    const seed = parseSeed(cfg.seed, 1);
    const pick = new Rng(seed ^ 0xc1a55);
    let lesson = cfg.lesson === 'random' ? pick.pick(PLAYABLE_LESSON_TYPES) : cfg.lesson;
    let teacher =
      cfg.teacher === 'random'
        ? pick.pick(['strict', 'strict', 'lazy', 'distracted', 'hawk', 'hawk', 'substitute'])
        : cfg.teacher;
    let absent: string[] = [];
    if (this.record.detentionPending && !background && !this.shot) {
      lesson = 'detention';
      teacher = 'strict';
      absent = CAST.students.filter((_, i) => i % 4 !== 1).map((s) => s.id);
      this.record.detentionPending = false;
    }
    this.record.counters.lessonSeed = seed;
    this.disposeLesson();
    this.record.lessonsPerDay = this.record.lessonsPerDay || 3;
    const w = new World({ seed, lessonType: lesson, teacher, record: this.record, absent });
    w.player.name = this.settings.playerName;
    w.ps.hasCheatSheet = cfg.cheatSheet;
    this.world = w;
    this.view = new RoomView(w);
    this.view.applyQuality(resolveQuality(this.settings));
    this.view.debug = this.debug;
    this.view.scene.add(this.camera);
    this.camera.add(this.device.phone);
    this.device.phone.position.set(0.05, -0.17, -0.3);
    this.device.phone.rotation.set(-0.55, 0.12, 0.04);
    this.view.scene.add(this.device.laptop);
    this.device.game.reset();
    this.clock = new SimClock();
    this.syncPlayerFromWorld(true);
    this.crouch = false;
    if (background) return;
    this.mode = 'play';
    this.ui.closeMenu();
    this.ui.setHudVisible(true);
    this.input.setTouchVisible(true);
    this.audio.setAmbience(true);
    this.audio.resume();
    const L = LESSONS.types[lesson]!;
    this.ui.showBanner(`${L.label} · ${w.profile.name}`);
    this.audio.play('bell');
    if (lesson === 'detention')
      this.ui.toast('Detention: stay seated, stay silent. (Good luck.)', 5000);
  }

  private disposeLesson(): void {
    if (this.view) {
      this.view.scene.remove(this.camera);
      this.view.dispose();
    }
    this.view = null;
    this.world = null;
  }

  private syncPlayerFromWorld(snap: boolean): void {
    const w = this.world;
    if (!w) return;
    const p = w.player;
    if (snap) {
      this.yaw = p.yaw;
      this.pitch = -0.04;
      this.eyeY = EYE_HEIGHT[p.stance];
    }
    this.prevP = { ...p.pos };
    this.curP = { ...p.pos };
  }

  // ------------------------------------------------------------------------------------------
  // Settings / quality

  private onSettings(s: Settings): void {
    saveSettings(s);
    this.applySettings();
  }

  private applySettings(): void {
    const q = resolveQuality(this.settings);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.view?.applyQuality(q);
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    this.ui.setScale(this.settings.uiScale);
    this.ui.subtitlesOn = this.settings.subtitles;
    this.audio.setVolume(this.settings.volume);
    this.input.applySettings(this.settings);
    this.resize();
  }

  private resize(): void {
    const w = this.host.clientWidth || window.innerWidth;
    const h = this.host.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------------------------------
  // Loop

  private frame(now: number): void {
    requestAnimationFrame((t) => this.frame(t));
    if (this.hidden) return;
    const q = resolveQuality(this.settings);
    const minDt = 1000 / q.fpsCap - 2;
    if (!this.shot && now - this.lastFrame < minDt) return;
    const realDt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
    if (!this.shot && this.lastFrame) {
      if (
        this.settings.watchdog &&
        this.mode === 'play' &&
        !this.bench &&
        this.watch.push(now - this.lastFrame, now, 1000 / q.fpsCap) === 'slow'
      )
        this.stepDownQuality();
      else if (!this.settings.watchdog) this.watch.push(now - this.lastFrame, now, 1000 / q.fpsCap);
    }
    this.lastFrame = now;
    this.frameIdx++;
    const w = this.world;
    if (!w || !this.view) return;
    if (this.bench) {
      this.benchFrame(now, realDt, w);
      return;
    }

    if (this.shot) {
      if (this.shotFrames >= this.shot.frames) return;
      this.tickSim(this.bot ? this.bot.command(w) : idleCommand(this.yaw, this.pitch), false);
      this.renderWorld(TICK_DT, 1);
      this.shotFrames++;
      const info = this.info();
      (window as unknown as { __info: unknown }).__info = info;
      if (this.shotFrames >= this.shot.frames)
        (window as unknown as { __shotReady: boolean }).__shotReady = true;
      return;
    }

    const f = this.input.poll();
    this.handleGlobalInput(f.pressed);
    if (this.mode === 'play') {
      this.handlePlayInput(f, realDt);
      const n = this.clock.advance(realDt);
      for (let i = 0; i < n; i++) {
        this.tickSim(this.buildCommand(f), false);
        if (this.world !== w) return; // lesson ended and rebuilt
      }
    }
    this.renderWorld(realDt, this.mode === 'play' ? this.clock.alpha : 1);
    if (this.debug) this.updateDebug(now);
    this.maybeSuggestBattery();
  }

  private benchElapsed(): number {
    return this.benchStart < 0 ? 0 : (this.benchLast - this.benchStart) / 1000;
  }

  /** Benchmark frame: real rAF timing (FPS cap already applied), bot-driven sim, scripted camera. */
  private benchFrame(now: number, realDt: number, w: World): void {
    const b = this.bench!;
    if (this.benchDone) return;
    if (this.benchStart < 0) this.benchStart = now;
    else this.benchTimes.push(now - this.benchLast);
    this.benchLast = now;
    if (this.benchElapsed() >= b.seconds) {
      this.finishBench();
      return;
    }
    const n = this.clock.advance(realDt);
    for (let i = 0; i < n && !w.over; i++) this.tickSim(this.bot!.command(w), true);
    this.renderWorld(realDt, this.clock.alpha);
  }

  private finishBench(): void {
    const b = this.bench!;
    this.benchDone = true;
    const info = this.renderer.info;
    const stats = summarizeFrames(this.benchTimes);
    const result: BenchResult = {
      preset: this.settings.preset,
      seconds: b.seconds,
      frames: this.benchTimes.length,
      ...stats,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      estGpuMB: estimateGpuMemory(this.view!.scene, this.renderer).totalMB,
      simTickMsAvg: this.benchSimTicks ? this.benchSimMs / this.benchSimTicks : 0,
      userAgent: navigator.userAgent,
    };
    (window as unknown as { __bench: BenchResult }).__bench = result;
    showBenchPanel(result);
  }

  private tickSim(cmd: PlayerCommand, silent: boolean): void {
    const w = this.world!;
    this.prevP = { ...this.curP };
    const t0 = this.bench ? performance.now() : 0;
    w.step(cmd);
    if (this.bench) {
      this.benchSimMs += performance.now() - t0;
      this.benchSimTicks++;
    }
    this.curP = { ...w.player.pos };
    this.view?.onTick(w);
    const ev = w.drainEvents();
    this.bot?.observe(ev);
    if (!silent) for (const e of ev) this.onEvent(e);
    if (w.over && !this.shot && !this.bench && this.mode === 'play') {
      this.mode = 'summary';
      setTimeout(() => this.lessonSummary(), 1200);
    }
  }

  private buildCommand(f: ReturnType<InputManager['poll']>): PlayerCommand {
    const w = this.world!;
    const cmd = idleCommand(this.yaw, this.pitch);
    const dev = w.ps.device;
    let mx = f.move.x;
    const my = f.move.y;
    // While playing Block Drop, left/right steer the paddle instead of walking.
    if (dev.kind && dev.mode === 'game') mx = 0;
    if (w.player.sittingIn && dev.kind && dev.mode === 'game' && Math.abs(my) < 0.6) {
      /* stay seated */
    }
    const fwd = yawDir(this.yaw);
    const right = { x: -fwd.z, z: fwd.x };
    cmd.move = { x: right.x * mx + fwd.x * my, z: right.z * mx + fwd.z * my };
    if (w.player.sittingIn && dev.kind && dev.mode === 'game') cmd.move = { x: 0, z: 0 };
    cmd.sprint = f.held.has('sprint');
    cmd.crouch = this.crouch;
    cmd.lean = this.lean;
    cmd.work = f.held.has('work');
    cmd.peek = f.held.has('peek');
    cmd.cheat = f.held.has('cheat');
    Object.assign(cmd, this.pending);
    this.pending = {};
    if (this.frameIdx % 20 === 0) cmd.gameScore = this.device.game.best;
    return cmd;
  }

  private handleGlobalInput(pressed: Set<Action>): void {
    if (pressed.has('debug')) {
      this.debug = !this.debug;
      if (this.view) this.view.debug = this.debug;
      if (!this.debug) {
        this.debugEl?.remove();
        this.debugEl = null;
      }
    }
    if (pressed.has('pause')) {
      if (this.mode === 'play') this.openPause();
      else if (this.mode === 'menu') this.resumePlay();
    }
  }

  private resumePlay(): void {
    this.ui.closeMenu();
    this.mode = 'play';
    this.lastFrame = 0;
    this.audio.resume();
    this.input.setTouchVisible(true);
  }

  private openMenu(): void {
    this.mode = 'menu';
    this.input.km.unlock();
    this.audio.suspend();
    this.input.setTouchVisible(false);
  }

  private openPause(): void {
    this.openMenu();
    const w = this.world!;
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('lesson', w.lessonType);
    url.searchParams.set('teacher', w.profile.id);
    url.searchParams.set('seed', String(w.seed));
    const wl = this.wishlistHtml();
    this.ui.pause({
      seedLink: url.toString(),
      wishlist: wl,
      onResume: () => this.resumePlay(),
      onNotebook: () => this.ui.notebook(this.record, this.debug, () => this.openPause()),
      onSettings: () =>
        this.ui.settings(
          this.settings,
          (s) => this.onSettings(s),
          () => this.openPause(),
        ),
      onControls: () => this.ui.controls(() => this.openPause()),
      onCredits: () => this.ui.credits(() => this.openPause()),
      onEnd: () => {
        saveRecord(this.record);
        this.showTitle();
      },
    });
  }

  private wishlistHtml(): string {
    const act = this.record.wishlist.active;
    if (!act.length)
      return '<p class="sub2">No wishes picked. (Choose some on the title screen.)</p>';
    return act
      .map((id) => {
        const c = CHALLENGES.find((x) => x.id === id);
        if (!c) return '';
        const v = this.counter(c.counter);
        return `<div class="row"><span style="flex:1">${esc(c.text)}</span><b>${Math.min(v, c.goal).toFixed(0)}/${c.goal}${v >= c.goal ? ' ✓' : ''}</b></div>`;
      })
      .join('');
  }

  private counter(k: string): number {
    const r = this.record;
    const w = this.world;
    const live = w && !w.over;
    switch (k) {
      case 'bestScore':
        return Math.max(r.counters.bestScore ?? 0, live ? w.stats.bestScore : 0);
      case 'videoSeconds':
        return (r.counters.videoSeconds ?? 0) + (live ? w.stats.videoSeconds : 0);
      case 'sneakSeconds':
        return (r.counters.sneakSeconds ?? 0) + (live ? w.stats.sneakSeconds : 0);
      case 'notesDeliveredUnique': {
        const set = new Set(
          Object.keys(r.counters)
            .filter((x) => x.startsWith('nd:'))
            .map((x) => x.slice(3)),
        );
        if (live) w.stats.notesDelivered.forEach((x) => set.add(x));
        return set.size;
      }
      case 'friends':
        return Object.values(r.affinity).filter((a) => a >= 50).length;
      default:
        return r.counters[k] ?? 0;
    }
  }

  private handlePlayInput(f: ReturnType<InputManager['poll']>, dt: number): void {
    const w = this.world!;
    const p = w.player;
    // Look
    if (this.freecam) {
      this.yaw -= f.look.dx;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - f.look.dy));
      const d = yawDir(this.yaw);
      const sp = (f.held.has('sprint') ? 6 : 2.5) * dt;
      this.camera.position.x += (d.x * f.move.y + -d.z * f.move.x) * sp;
      this.camera.position.z += (d.z * f.move.y + d.x * f.move.x) * sp;
      if (f.held.has('sit')) this.camera.position.y += sp;
      if (f.held.has('crouch')) this.camera.position.y -= sp;
    } else {
      this.yaw -= f.look.dx;
      this.pitch = Math.max(-1.35, Math.min(1.2, this.pitch - f.look.dy));
    }
    const pr = f.pressed;
    if (pr.has('freecam') && this.debug) this.freecam = !this.freecam;
    if (this.freecam) return;
    const leanTarget = (f.held.has('leanLeft') ? -1 : 0) + (f.held.has('leanRight') ? 1 : 0);
    this.lean += (leanTarget - this.lean) * Math.min(1, dt * 8);
    if (pr.has('crouch')) this.crouch = !this.crouch;
    if (p.sittingIn) this.crouch = false;
    const dev = w.ps.device;
    if (pr.has('phone')) this.pending.device = 'phone';
    if (pr.has('laptop')) this.pending.device = 'laptop';
    if (pr.has('switch')) this.pending.device = 'switch';
    if (pr.has('content')) this.pending.device = 'content';
    if (pr.has('earbud')) this.pending.device = 'earbud';
    if (pr.has('brightUp')) this.pending.device = 'bright-up';
    if (pr.has('brightDown')) this.pending.device = 'bright-down';
    if (pr.has('raiseHand')) this.pending.raiseHand = true;
    if (pr.has('paper')) this.pending.make = 'paper-ball';
    if (pr.has('plane')) this.pending.make = 'paper-plane';
    if (pr.has('throw') && p.holding) this.throwCharge = 0;
    if (this.throwCharge !== null) {
      this.throwCharge = Math.min(1, this.throwCharge + dt / 1.1);
      if (f.released.has('throw') || !f.held.has('throw')) {
        this.pending.throwPower = this.throwCharge;
        this.throwCharge = null;
      }
    }
    if (pr.has('note')) {
      if (!p.sittingIn) this.ui.toast('Sit down to pass a note.');
      else {
        this.openMenu();
        const studs = w.students
          .filter((s) => s.agent.present)
          .map((s) => ({ id: s.agent.id, name: s.def.name }));
        this.ui.noteComposer(
          studs,
          (tpl, to) => {
            this.pending.note = { template: tpl, to };
            this.resumePlay();
          },
          () => this.resumePlay(),
        );
        return;
      }
    }
    if (pr.has('notebook')) {
      this.openMenu();
      this.ui.notebook(this.record, this.debug, () => this.resumePlay());
      return;
    }
    if (pr.has('nextVerb')) this.verbIndex++;
    // Interaction target: the interactable closest to the view direction within reach.
    this.target = this.pickTarget();
    if (pr.has('interact') && this.target) {
      const v =
        this.target.verbs[
          ((this.verbIndex % this.target.verbs.length) + this.target.verbs.length) %
            this.target.verbs.length
        ]!;
      this.pending.interact = { target: this.target.id, verb: v.verb };
      this.audio.play('ui');
    }
    if (pr.has('sit')) {
      if (p.sittingIn) this.pending.interact = { target: p.sittingIn, verb: 'stand' };
      else {
        const seat = interactables(w)
          .filter((i) => i.kind === 'seat' && i.verbs.some((v) => v.verb === 'sit'))
          .sort((a, b) => dist2(a.pos, p.pos) - dist2(b.pos, p.pos))[0];
        if (seat && dist2(seat.pos, p.pos) < 1.2)
          this.pending.interact = { target: seat.id, verb: 'sit' };
        else this.ui.toast('No free chair close enough.');
      }
    }
    // Mini-game paddle
    const gameDir = dev.kind && dev.mode === 'game' ? f.move.x : 0;
    this.device.update(
      dt,
      dev.mode === 'off' ? 'decoy' : (dev.mode as 'game' | 'video' | 'decoy'),
      gameDir,
      dev.brightness,
      dev.earbud,
      dev.kind,
    );
  }

  private pickTarget(): Interactable | null {
    const w = this.world!;
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    let best: Interactable | null = null;
    let bestScore = Infinity;
    for (const it of interactables(w)) {
      if (it.verbs.length === 0) continue;
      const d = dist2(it.pos, w.player.pos);
      if (d > it.reach) continue;
      if (it.kind === 'seat' && it.id === w.player.sittingIn) continue;
      const to = new THREE.Vector3(it.pos.x - eye.x, it.y - eye.y, it.pos.z - eye.z);
      const ang = fwd.angleTo(to);
      const limit = it.kind === 'seat' ? 0.6 : 0.42;
      if (ang > limit) continue;
      const score = ang + d * 0.05;
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }
    if (best?.id !== this.target?.id) this.verbIndex = 0;
    return best;
  }

  // ------------------------------------------------------------------------------------------
  // Rendering

  private renderWorld(dt: number, alpha: number): void {
    const w = this.world!;
    const view = this.view!;
    const p = w.player;
    if (!this.freecam) {
      const shotCam = this.shot?.cam ?? 'seat';
      if (this.benchPath) this.benchPath.place(this.camera, this.benchElapsed());
      else if (shotCam === 'seat' || !this.shot) {
        const x = this.prevP.x + (this.curP.x - this.prevP.x) * alpha;
        const z = this.prevP.z + (this.curP.z - this.prevP.z) * alpha;
        this.eyeY += (EYE_HEIGHT[p.stance] - this.eyeY) * Math.min(1, dt * 10);
        const fwd = yawDir(this.yaw);
        const right = { x: -fwd.z, z: fwd.x };
        const leanOff = this.lean * 0.28;
        const bob = p.moving && !this.settings.reducedMotion ? Math.sin(w.t * 9) * 0.025 : 0;
        this.camera.position.set(
          x + right.x * leanOff,
          this.eyeY + bob - Math.abs(this.lean) * 0.05,
          z + right.z * leanOff,
        );
        this.camera.rotation.set(
          this.pitch,
          this.yaw,
          this.settings.reducedMotion ? 0 : -this.lean * 0.12,
          'YXZ',
        );
      } else this.placeShotCamera(shotCam);
    }
    view.sync(w, alpha, this.camera.position);
    // Device visuals
    const dev = w.ps.device;
    this.device.phone.visible = dev.kind === 'phone' && (!this.shot || this.shot.cam === 'seat');
    this.device.laptop.visible = dev.kind === 'laptop';
    if (dev.kind === 'laptop') {
      const spot = w.laptopSpot(p);
      if (spot) {
        this.device.laptop.position.set(spot.x, 0.73, spot.z);
        this.device.laptop.rotation.y = p.yaw;
      }
    }
    if (this.shot && dev.kind)
      this.device.update(
        dt,
        dev.mode === 'off' ? 'decoy' : (dev.mode as 'game' | 'video' | 'decoy'),
        0.3,
        dev.brightness,
        dev.earbud,
        dev.kind,
      );
    const q = resolveQuality(this.settings);
    if (dev.kind && q.glowLights > 0) {
      const gp = new THREE.Vector3();
      (dev.kind === 'phone' ? this.device.phone : this.device.laptop).getWorldPosition(gp);
      if (dev.kind === 'laptop') gp.y += 0.15;
      view.setGlow(
        gp,
        this.device.glowColor,
        0.8 * dev.brightness * (w.objects.lightsDim ? 1.6 : 1),
      );
    } else view.setGlow(null, 0, 0);
    this.renderer.render(view.scene, this.camera);
    if (!this.bench && (!this.shot || this.shot.hud)) this.updateHud();
    this.updateAudio();
  }

  private placeShotCamera(cam: string): void {
    const w = this.world!;
    const [W, , D] = w.layout.room.size;
    const T = w.teacher;
    switch (cam) {
      case 'overview':
        this.camera.position.set(0.5, 2.35, D - 0.4);
        this.camera.lookAt(W * 0.62, 0.55, D * 0.3);
        break;
      case 'front':
        this.camera.position.set(W - 0.5, 2.4, 0.4);
        this.camera.lookAt(W * 0.35, 0.6, D * 0.7);
        break;
      case 'teacher': {
        const d = yawDir(T.headYaw);
        this.camera.position.set(T.pos.x - d.x * 0.6, 1.9, T.pos.z - d.z * 0.6);
        this.camera.lookAt(T.pos.x + d.x * 4, 0.9, T.pos.z + d.z * 4);
        break;
      }
      case 'top':
        this.camera.position.set(W / 2, 9.5, D / 2 + 0.01);
        this.camera.lookAt(W / 2, 0, D / 2);
        break;
    }
  }

  private updateHud(): void {
    const w = this.world!;
    const ps = w.ps;
    const mins = 8 * 60 + w.clockMinutes();
    const clock = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.floor(mins % 60)).padStart(2, '0')}`;
    const chips: string[] = [];
    const d = ps.device;
    if (ps.phoneConfiscated) chips.push('📵 Phone confiscated');
    if (d.kind)
      chips.push(
        `${d.kind === 'phone' ? '📱' : '💻'} ${d.mode === 'decoy' ? 'Notes (decoy)' : d.mode === 'game' ? `Block Drop · ${this.device.game.score}` : 'Video'}${d.earbud ? ' · 🎧' : ''} · ☀ ${Math.round(d.brightness * 100)}%`,
      );
    const held = w.items.find((i) => i.id === w.player.holding);
    if (held)
      chips.push(
        `✋ ${held.kind === 'paper-ball' ? 'Paper ball' : held.kind === 'paper-plane' ? 'Paper plane' : held.kind} (hold T to throw)`,
      );
    if (ps.cover && w.t < ps.cover.until)
      chips.push(`🛈 Cover: ${ps.cover.reason} (${Math.ceil(ps.cover.until - w.t)} s)`);
    if (ps.action)
      chips.push(
        `⏳ ${ps.action.kind === 'prank' ? 'Setting up prank' : ps.action.kind}… ${Math.round((ps.action.t / ps.action.dur) * 100)}%`,
      );
    if (ps.working) chips.push('✎ Working');
    if (ps.peeking) chips.push(`👀 Peeking at ${w.agent(ps.peeking)?.name}`);
    if (ps.handRaised) chips.push('✋ Hand raised');
    if (!w.player.sittingIn && !w.rules().break && !w.rules().seatFree)
      chips.push('⚠ Out of your seat');
    if (w.player.sittingIn && w.player.sittingIn !== w.player.seat && w.player.seat === 's-front')
      chips.push('⚠ Your seat is now the front seat');
    const t = this.target;
    let prompt = null;
    if (t) {
      const v = t.verbs[((this.verbIndex % t.verbs.length) + t.verbs.length) % t.verbs.length]!;
      prompt = { label: v.label, risk: v.risk, more: t.verbs.length, key: 'E' };
    }
    const r = w.rules();
    this.ui.update({
      clock,
      phase: w.phase().label,
      lesson: LESSONS.types[w.lessonType]!.label,
      teacher: w.profile.name,
      prompt,
      chips,
      test: r.test ? ps.test.progress : null,
      charge: this.throwCharge,
      showCross: !this.shot,
    });
  }

  private updateAudio(): void {
    const w = this.world!;
    if (!this.audio.ready) return;
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    this.audio.setListener(eye, this.yaw);
    const T = w.teacher;
    this.audio.setTeacherSpeech(T.present && w.brain.speaking && this.mode === 'play', {
      x: T.pos.x,
      y: 1.6,
      z: T.pos.z,
    });
    const d = w.ps.device;
    const mode =
      d.kind && (d.mode === 'game' || d.mode === 'video') && this.mode === 'play' ? d.mode : 'off';
    this.audio.setDeviceAudio(mode, d.earbud, { x: w.player.pos.x, y: 0.8, z: w.player.pos.z });
    this.audio.setEarbud(d.earbud && !!d.kind);
    // Accessibility cue: footsteps approaching
    const dist = T.present ? dist2(T.pos, w.player.pos) : 99;
    if (T.moving && dist < 4 && dist < this.lastTeacherDist - 0.02 && w.t > this.footCueT) {
      this.footCueT = w.t + 6;
      this.ui.subtitle('', '[footsteps approaching]', true);
    }
    this.lastTeacherDist = dist;
  }

  // ------------------------------------------------------------------------------------------
  // Events → audio/UI

  private onEvent(e: SimEvent): void {
    const w = this.world!;
    const pos3 = (x: number, z: number, y = 1) => ({ x, y, z });
    const who = e.who ? w.agent(e.who) : undefined;
    switch (e.type) {
      case 'bark': {
        const name = e.who === 'teacher' ? w.profile.name : (who?.name ?? '');
        if (e.text) this.ui.subtitle(name, e.text);
        if (
          who &&
          (e.kind === 'cough' ||
            e.kind === 'sneeze' ||
            e.kind === 'yawn' ||
            e.kind === 'laugh' ||
            e.kind === 'warnPlayer')
        )
          this.audio.play(
            e.kind === 'warnPlayer' ? 'cough' : (e.kind as SoundKind),
            pos3(who.pos.x, who.pos.z, 1.1),
          );
        break;
      }
      case 'noise': {
        if (e.pos) this.view?.addNoiseRing(e.pos.x, e.pos.z, e.radius ?? 1, w.t);
        const s = SOUND_FOR_NOISE[e.kind ?? ''];
        if (s && e.pos && !(e.kind === 'cough' || e.kind === 'sneeze' || e.kind === 'laugh'))
          this.audio.play(s, pos3(e.pos.x, e.pos.z, 0.6));
        if (e.kind === 'buzz' && e.who !== 'player')
          this.ui.subtitle('', '[a phone buzzes somewhere]', true);
        if (e.kind === 'knock') this.ui.subtitle('', '[the radiator clanks]', true);
        break;
      }
      case 'step':
        if (e.who === 'teacher')
          this.audio.play('step-carpet', pos3(w.teacher.pos.x, w.teacher.pos.z, 0.1), {
            volume: 1.2,
          });
        else if (e.who === 'player')
          this.audio.play(e.kind === 'hard' ? 'step-hard' : 'step-carpet', undefined, {
            volume: 0.35 * (e.value ?? 1),
          });
        break;
      case 'writing':
        this.audio.play('writing', pos3(4.5, 1.5, 0.1));
        break;
      case 'glance-soon':
        if (e.kind === 'board') this.ui.subtitle('', '[the marker stops squeaking]', true);
        break;
      case 'telegraph':
        if (e.target === 'player') {
          this.audio.play('telegraph');
          this.ui.subtitle('', '[the teacher’s voice trails off]', true);
        }
        break;
      case 'caught': {
        this.audio.play('caught');
        const card = w.stats.caughtCards[w.stats.caughtCards.length - 1];
        if (card) this.ui.caught(card);
        break;
      }
      case 'penalty':
        if (e.kind === 'written')
          this.ui.toast('Your seat is now the front seat (next to the board).', 4000);
        break;
      case 'hint':
        if (e.text) this.ui.toast(e.text);
        break;
      case 'cover':
        this.ui.toast(`Cover: ${e.kind} (${e.value} s)`);
        break;
      case 'note-sent':
        if (e.who === 'player')
          this.ui.toast(`Note on its way to ${w.agent(e.target ?? '')?.name}…`);
        break;
      case 'note-delivered':
        if (e.who === 'player')
          this.ui.toast(`✉ Note delivered to ${w.agent(e.target ?? '')?.name}.`);
        break;
      case 'note-lost':
        this.ui.toast('A note got stuck somewhere along the chain.');
        break;
      case 'note-intercepted':
        this.ui.toast(`The teacher took a note (${e.text}).`);
        break;
      case 'note-received':
        this.ui.toast(
          `✉ From ${w.agent(e.who ?? '')?.name}: “${NOTES.find((n) => n.id === e.kind)?.text ?? ''}”`,
          4500,
        );
        break;
      case 'phase':
        this.ui.showBanner(e.text ?? '');
        if (e.kind === 'break') this.audio.play('bell');
        break;
      case 'lesson-end':
        this.audio.play('bell');
        this.ui.showBanner('Lesson over');
        break;
      case 'test-graded':
        this.ui.toast(`Test graded: ${e.value}% (${letter(e.value ?? 0)})`, 4000);
        break;
      case 'prank':
        this.ui.toast(`Prank set: ${e.text}`);
        break;
      case 'prank-resolved':
        this.ui.toast(e.value ? 'Nobody told. Clean prank.' : 'Someone told on your prank…', 3500);
        break;
      case 'pop-question':
        if (e.target === 'player')
          this.ui.subtitle(
            '',
            '[you’re being asked a question: keep working or raise your hand]',
            true,
          );
        break;
      case 'warned-by-friend':
        this.ui.subtitle('', `[${who?.name ?? 'Someone'} coughs pointedly]`, true);
        break;
      case 'affinity':
        if (Math.abs(e.value ?? 0) >= 3)
          this.ui.toast(
            `${(e.value ?? 0) > 0 ? '↑' : '↓'} ${w.agent(e.who ?? '')?.name} ${e.text}`,
          );
        break;
      case 'teacher-left':
        this.ui.subtitle('', '[the door clicks shut: the teacher has left]', true);
        break;
      case 'teacher-back':
        this.ui.subtitle('', '[the door opens: the teacher is back]', true);
        break;
      case 'device':
        if (e.kind === 'confiscated')
          this.ui.toast('Phone confiscated until the end of the lesson.', 3500);
        this.audio.play('ui');
        break;
      case 'throw':
        this.audio.play('paper');
        break;
      case 'gust':
        this.ui.subtitle('', '[a gust of wind: papers everywhere]', true);
        break;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Lesson summary / day report

  private lessonSummary(): void {
    const w = this.world!;
    const r = this.record;
    const st = w.stats;
    r.counters.videoSeconds = (r.counters.videoSeconds ?? 0) + st.videoSeconds;
    r.counters.bestScore = Math.max(r.counters.bestScore ?? 0, st.bestScore);
    r.counters.sneakSeconds = (r.counters.sneakSeconds ?? 0) + st.sneakSeconds;
    r.counters.study = (r.counters.study ?? 0) + st.workSeconds;
    for (const id of st.notesDelivered) r.counters[`nd:${id}`] = 1;
    r.bestScore = Math.max(r.bestScore, st.bestScore);
    for (const p of w.pranks)
      if (!p.resolved && !w.stats.pranks.some((x) => x.id === p.id))
        st.pranks.push({ id: p.id, clean: true });
    const real = st.offenses.filter((o) => o.penalty !== 'letoff');
    if (!w.lessonType.startsWith('detention') && st.workSeconds > 60 && st.testScore === null)
      r.grades.push({
        day: r.day,
        label: `${LESSONS.types[w.lessonType]!.label} participation`,
        value: Math.min(100, 50 + st.workSeconds / 6),
      });
    endLesson(r, real.length === 0, w.profile.id);
    for (const id of r.wishlist.active) {
      const c = CHALLENGES.find((x) => x.id === id);
      if (c && this.counter(c.counter) >= c.goal && !r.wishlist.done.includes(id))
        r.wishlist.done.push(id);
    }
    saveRecord(r);
    const rel = w.students
      .map((s) => ({
        name: s.def.name,
        d: w.relations.toPlayer(s.def.id) - (st.affinityStart[s.def.id] ?? 0),
      }))
      .filter((x) => Math.abs(x.d) >= 1)
      .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
      .slice(0, 5);
    const html = `<h1>${esc(LESSONS.types[w.lessonType]!.label)} — over</h1>
      <p class="sub2">${esc(w.profile.name)} · seed ${w.seed}</p>
      <h2>What got noticed</h2>
      ${st.caughtCards.length ? st.caughtCards.map((c) => `<p>• <b>${esc(c.title)}</b><br><span class="sub2">${c.lines.map(esc).join(' ')}</span></p>`).join('') : '<p>Nothing. Not a thing. Suspiciously clean.</p>'}
      <h2>Your lesson</h2>
      <div class="kv">
        <span>Real work done</span><b>${Math.round(st.workSeconds)} s</b>
        <span>Block Drop best</span><b>${st.bestScore}</b>
        <span>Video watched</span><b>${Math.round(st.videoSeconds)} s</b>
        <span>Notes delivered</span><b>${st.notesDelivered.length}</b>
        <span>Pranks</span><b>${st.pranks.filter((p) => p.clean).length} clean / ${st.pranks.length}</b>
        <span>Unnoticed time out of seat</span><b>${Math.round(st.sneakSeconds)} s</b>
        ${st.testScore !== null ? `<span>Test</span><b>${st.testScore}% (${letter(st.testScore)})${st.cheated ? ' · copied' : ''}</b>` : ''}
        <span>Strikes on record</span><b>${r.strikes}</b>
      </div>
      ${rel.length ? `<h2>Relationships</h2>${rel.map((x) => `<p>${x.d > 0 ? '↑' : '↓'} ${esc(x.name)} (${x.d > 0 ? '+' : ''}${x.d.toFixed(0)})</p>`).join('')}` : ''}`;
    const callHome = real.some((o) => o.penalty === 'callhome');
    const dayOver = r.lessonInDay >= r.lessonsPerDay;
    const next = () => {
      if (callHome) return this.showCallHome(dayOver);
      if (dayOver) return this.dayReport();
      this.nextLesson();
    };
    this.openMenu();
    this.mode = 'summary';
    this.ui.summary(html, [
      [callHome ? 'Uh oh…' : dayOver ? 'End of day' : 'Next lesson', next],
      ['Title screen', () => this.showTitle(), true],
    ]);
  }

  private showCallHome(dayOver: boolean): void {
    const w = this.world!;
    const rng = new Rng(w.seed ^ 0xca11);
    this.ui.summary(
      `<h1>☎ A call home</h1><p>${esc(callHomeText(this.record, w.profile.name, () => rng.next()))}</p><p class="sub2">Grade drop recorded. Strikes eased back to 2. Tomorrow is another day.</p>`,
      [
        [
          dayOver ? 'End of day' : 'Next lesson',
          () => (dayOver ? this.dayReport() : this.nextLesson()),
        ],
      ],
    );
  }

  private dayReport(): void {
    const r = this.record;
    const today = r.offenses.filter((o) => o.day === r.day);
    const grades = r.grades.filter((g) => g.day === r.day);
    const avg = gradeAverage(r);
    const mem = r.memories.filter((m) => m.day === r.day);
    const byWho = new Map<string, number>();
    for (const m of mem) byWho.set(m.who, (byWho.get(m.who) ?? 0) + m.delta);
    const rel = [...byWho.entries()].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 6);
    const name = (id: string) => CAST.students.find((s) => s.id === id)?.name ?? id;
    const done = r.wishlist.done;
    const html = `<h1>End of day ${r.day}</h1>
      <p class="sub2">The bell rings. Backpacks. Freedom (temporary).</p>
      <h2>Noticed</h2>${today.length ? today.map((o) => `<p>• ${esc(o.summary)} → <b>${o.penalty}</b> <span class="sub2">(${esc(TEACHERS.find((t) => t.id === o.teacher)?.name ?? o.teacher)})</span></p>`).join('') : '<p>Nothing on record today. Your teachers are confused but pleased.</p>'}
      <h2>Grades</h2>${grades.length ? grades.map((g) => `<p>${esc(g.label)}: <b>${g.value.toFixed(0)}% (${letter(g.value)})</b></p>`).join('') : '<p>No grades today.</p>'}
      ${avg !== null ? `<p class="sub2">Overall average: ${avg.toFixed(0)}% (${letter(avg)})</p>` : ''}
      <h2>People</h2>${rel.length ? rel.map(([id, d]) => `<p>${d > 0 ? '↑' : '↓'} ${esc(name(id))} (${d > 0 ? '+' : ''}${d.toFixed(0)})</p>`).join('') : '<p>Nobody changed their mind about you.</p>'}
      <h2>Wishlist</h2>${done.length ? done.map((id) => `<p>✓ ${esc(CHALLENGES.find((c) => c.id === id)?.text ?? id)}</p>`).join('') : '<p class="sub2">No wishes completed (yet).</p>'}
      <p class="sub2">Record: ${r.warnings} warnings · ${r.writtenWarnings} written · ${r.detentions} detentions · ${r.callsHome} calls home · strikes ${r.strikes}${r.detentionPending ? ' · detention pending' : ''}</p>`;
    this.ui.summary(html, [
      [
        'Next day',
        () => {
          startNewDay(r);
          saveRecord(r);
          this.showTitle();
        },
      ],
    ]);
  }

  private nextLesson(): void {
    const seed = String(parseSeed(this.lessonCfg.seed) + 1);
    this.startLesson({ lesson: 'random', teacher: 'random', seed, cheatSheet: false });
  }

  // ------------------------------------------------------------------------------------------
  // Debug / perf

  private updateDebug(now: number): void {
    const w = this.world!;
    if (!this.debugEl) {
      this.debugEl = document.createElement('div');
      this.debugEl.style.cssText =
        'position:fixed;right:8px;top:8px;z-index:25;background:rgba(0,0,0,.72);color:#cfe;font:11px/1.35 ui-monospace,Menlo,monospace;padding:8px;border-radius:6px;max-width:330px;pointer-events:auto;white-space:pre';
      document.body.appendChild(this.debugEl);
      this.debugEl.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).dataset;
        if (b.ts) this.clock.timeScale = Number(b.ts);
        if (b.ev) {
          if (b.ev === 'leave') w.brain.requests.push({ kind: 'leave' });
          else if (b.ev === 'question')
            w.brain.requests.push({ kind: 'question', target: 'player', pop: true });
          else if (b.ev === 'handout') w.brain.requests.push({ kind: 'handout' });
          else if (b.ev === 'drop')
            w.noise(w.students[0]!.agent.pos, 4.5, 'drop', w.students[0]!.agent.id);
          else if (b.ev === 'skip') w.lesson.gameMinutes += 5;
        }
      });
    }
    if (this.frameIdx % 10 !== 0) return;
    const info = this.renderer.info;
    const sus = [...w.suspicion.entries()]
      .filter(([, s]) => s.s > 0.01 || s.heat > 0)
      .sort((a, b) => b[1].s - a[1].s)
      .slice(0, 6)
      .map(
        ([id, s]) =>
          `${id.padEnd(8)} ${s.s.toFixed(2)} heat ${s.heat.toFixed(2)} ${s.lastEvidence?.kind ?? ''}`,
      )
      .join('\n');
    if (this.frameIdx % 60 === 0 || !this.gpuMB)
      this.gpuMB = estimateGpuMemory(this.view!.scene, this.renderer).totalMB;
    const t0 = performance.now();
    const probe = new World({ seed: 1, lessonType: w.lessonType, teacher: w.profile.id });
    probe.step(idleCommand());
    const tickMs = performance.now() - t0;
    void now;
    this.debugEl.innerHTML =
      `FPS ~${(1000 / Math.max(1, this.watch.avg())).toFixed(0)}  frame ${this.watch.avg().toFixed(1)} ms\n` +
      `draw calls ${info.render.calls}  tris ${info.render.triangles}\n` +
      `geo ${info.memory.geometries}  tex ${info.memory.textures}  est. GPU ${this.gpuMB.toFixed(1)} MB\n` +
      `sim t ${w.t.toFixed(1)} s  tick ${w.tick}  probe tick ${tickMs.toFixed(2)} ms\n` +
      `phase ${w.phase().id}  clock ${w.clockMinutes().toFixed(1)} min\n` +
      `teacher ${w.brain.state} → ${w.brain.target ?? '-'}  ${w.brain.distracted ? '(distracted)' : ''}\n` +
      `suspicion:\n${sus || '  (none)'}\n` +
      `seed ${w.seed}  hash ${w.eventHash.toString(16)}\n` +
      `<span style="color:#ffd">time:</span> <a data-ts="0.25">¼×</a> <a data-ts="1">1×</a> <a data-ts="4">4×</a>\n` +
      `<span style="color:#ffd">force:</span> <a data-ev="question">pop-question</a> <a data-ev="handout">handout</a> <a data-ev="leave">leave</a> <a data-ev="drop">drop</a> <a data-ev="skip">+5 min</a>\n` +
      `F4 free camera ${this.freecam ? 'ON' : 'off'}`;
    this.debugEl
      .querySelectorAll('a')
      .forEach(
        (a) =>
          ((a as HTMLElement).style.cssText =
            'color:#8cf;cursor:pointer;text-decoration:underline'),
      );
  }

  private stepDownQuality(): void {
    const i = PRESET_ORDER.indexOf(this.settings.preset as (typeof PRESET_ORDER)[number]);
    if (i < 0 || i >= PRESET_ORDER.length - 1) return;
    this.settings.preset = PRESET_ORDER[i + 1]!;
    saveSettings(this.settings);
    this.applySettings();
    this.ui.toast(`Frames were slow: quality lowered to ${this.settings.preset}.`, 4000);
  }

  private maybeSuggestBattery(): void {
    if (this.batteryHinted || this.mode !== 'play' || this.settings.preset === 'battery') return;
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{ charging: boolean; level: number }>;
    };
    if (this.frameIdx === 600 && nav.getBattery) {
      void nav
        .getBattery()
        .then((b) => {
          if (!b.charging && b.level < 0.3 && !this.batteryHinted) {
            this.batteryHinted = true;
            this.ui.toast('Battery is low: Battery Saver is in Settings.', 5000);
          }
        })
        .catch(() => undefined);
    }
    if (this.frameIdx > 1200 && this.watch.avg() > 40) {
      this.batteryHinted = true;
      this.ui.toast('Running slowly. Try Low or Battery Saver in Settings.', 5000);
    }
  }

  info(): Record<string, unknown> {
    const w = this.world;
    const gl = this.renderer.getContext();
    return {
      app: 'classroom',
      webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
      seed: w?.seed,
      tick: w?.tick,
      lesson: w?.lessonType,
      teacher: w?.profile.id,
      teacherState: w?.brain.state,
      phase: w?.phase().id,
      hash: w?.eventHash,
      offenses: w?.stats.offenses.length,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      textures: this.renderer.info.memory.textures,
      geometries: this.renderer.info.memory.geometries,
    };
  }

  /** Test hook: one-shot command on the next tick. */
  queue(cmd: Partial<PlayerCommand>): void {
    Object.assign(this.pending, cmd);
  }

  /** Test hook: start without menus. */
  quickStart(lesson = 'lecture', teacher = 'strict', seed = '1'): void {
    this.startLesson({ lesson, teacher, seed, cheatSheet: false });
  }
}

export { hashString };
