/**
 * Procedural Web Audio engine for the classroom sandbox (greybox: no asset files).
 * Everything is synthesized from oscillators, a shared noise buffer, filters and envelopes.
 * All public methods are safe no-ops until unlock() succeeds, and never throw.
 */

export type SoundKind =
  | 'step-carpet'
  | 'step-hard'
  | 'chair'
  | 'writing'
  | 'whisper'
  | 'cough'
  | 'sneeze'
  | 'yawn'
  | 'laugh'
  | 'thud'
  | 'paper'
  | 'door'
  | 'knock'
  | 'bell'
  | 'buzz'
  | 'game-beep'
  | 'gust'
  | 'wobble'
  | 'sharpen'
  | 'plane'
  | 'telegraph'
  | 'caught'
  | 'ui';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

type DeviceMode = 'off' | 'game' | 'video';

const FLOOR = 0.0001;
/** Kinds that are always non-positional (UI / tension cues). */
const FLAT_KINDS: ReadonlySet<SoundKind> = new Set<SoundKind>(['telegraph', 'caught', 'ui']);

/** Builder for one one-shot sound: tracks every node so they can be stopped and disconnected. */
class Voice {
  readonly nodes: AudioNode[] = [];
  private readonly srcs: AudioScheduledSourceNode[] = [];
  private pending = 0;
  private done = false;
  /** Everything in the voice feeds this gain, which feeds the destination. */
  readonly out: GainNode;
  onDone: (() => void) | null = null;

  constructor(
    readonly ctx: AudioContext,
    readonly t: number,
    private readonly noiseBuf: AudioBuffer,
    volume: number,
  ) {
    this.out = this.add(ctx.createGain());
    this.out.gain.value = volume;
  }

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  osc(type: OscillatorType, freq: number): OscillatorNode {
    const o = this.add(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    o.start(this.t);
    this.srcs.push(o);
    return o;
  }

  noise(): AudioBufferSourceNode {
    const s = this.add(this.ctx.createBufferSource());
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.start(this.t, Math.random() * (this.noiseBuf.duration - 0.1));
    this.srcs.push(s);
    return s;
  }

  filter(type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
    const f = this.add(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  gain(v = 0): GainNode {
    const g = this.add(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  /** Connect a chain of nodes; the last one goes to the voice output. */
  chain(...ns: AudioNode[]): void {
    for (let i = 0; i < ns.length - 1; i++) ns[i]!.connect(ns[i + 1]!);
    ns[ns.length - 1]!.connect(this.out);
  }

  /** Percussive envelope on a gain: start (relative seconds), attack, peak, total decay time. */
  env(g: GainNode, start: number, attack: number, peak: number, decay: number): void {
    const p = g.gain,
      a = this.t + start;
    p.setValueAtTime(FLOOR, a);
    p.exponentialRampToValueAtTime(Math.max(peak, FLOOR * 2), a + Math.max(attack, 0.002));
    p.exponentialRampToValueAtTime(FLOOR, a + attack + decay);
  }

  /** Noise burst: noise -> filter -> enveloped gain -> out. Optional filter sweep f0 -> f1. */
  burst(
    type: BiquadFilterType,
    f0: number,
    q: number,
    start: number,
    dur: number,
    peak: number,
    f1 = f0,
  ): void {
    const n = this.noise(),
      f = this.filter(type, f0, q),
      g = this.gain(FLOOR);
    if (f1 !== f0) {
      f.frequency.setValueAtTime(f0, this.t + start);
      f.frequency.linearRampToValueAtTime(f1, this.t + start + dur);
    }
    this.env(g, start, Math.min(0.01, dur / 3), peak, dur);
    this.chain(n, f, g);
  }

  /** Enveloped tone: osc -> gain -> out, with optional glide f0 -> f1. */
  tone(
    type: OscillatorType,
    f0: number,
    start: number,
    dur: number,
    peak: number,
    f1 = f0,
    filt?: BiquadFilterNode,
  ): OscillatorNode {
    const o = this.osc(type, f0),
      g = this.gain(FLOOR);
    if (f1 !== f0) {
      o.frequency.setValueAtTime(f0, this.t + start);
      o.frequency.exponentialRampToValueAtTime(f1, this.t + start + dur);
    }
    this.env(g, start, Math.min(0.012, dur / 3), peak, dur);
    if (filt) this.chain(o, filt, g);
    else this.chain(o, g);
    return o;
  }

  /** Schedule stop of all sources and clean up when every one has ended. */
  end(dur: number): void {
    const stopAt = this.t + dur + 0.05;
    this.pending = this.srcs.length;
    if (this.pending === 0) {
      this.cleanup();
      return;
    }
    for (const s of this.srcs) {
      s.onended = () => {
        if (--this.pending <= 0) this.cleanup();
      };
      try {
        s.stop(stopAt);
      } catch {
        this.pending--;
      }
    }
  }

  /** Immediately silence (used for stealing). */
  kill(): void {
    for (const s of this.srcs) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.done) return;
    this.done = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.onDone?.();
  }
}

/** Sound recipes: build into the voice starting at v.t, return duration in seconds. */
const RECIPES: Record<SoundKind, (v: Voice) => number> = {
  'step-carpet': (v) => {
    v.burst('lowpass', 400, 0.7, 0, 0.06, 0.35);
    return 0.08;
  },
  'step-hard': (v) => {
    v.burst('highpass', 2500, 0.7, 0, 0.015, 0.25);
    v.burst('lowpass', 900, 0.7, 0, 0.07, 0.4);
    v.tone('sine', 140, 0, 0.07, 0.25, 70);
    return 0.1;
  },
  chair: (v) => {
    const o = v.tone('sine', 500, 0, 0.18, 0.12, 850);
    const lfo = v.osc('sine', 28),
      d = v.gain(30);
    lfo.connect(d);
    d.connect(o.frequency);
    return 0.2;
  },
  writing: (v) => {
    [0, 0.09, 0.19].forEach((t, i) =>
      v.burst('bandpass', 2800 + i * 150, 8, t, 0.06, 0.18, 3300 + i * 100),
    );
    return 0.28;
  },
  whisper: (v) => {
    [0, 0.14, 0.27].forEach((t, i) => v.burst('highpass', 2600 + i * 400, 0.8, t, 0.13, 0.14));
    return 0.42;
  },
  cough: (v) => {
    [0, 0.17].forEach((t, i) => {
      v.burst('bandpass', 900, 1.2, t, 0.1, 0.35 - i * 0.08);
      v.tone('sawtooth', 150 - i * 10, t, 0.09, 0.12, 110, v.filter('bandpass', 700, 2));
    });
    return 0.35;
  },
  sneeze: (v) => {
    v.burst('highpass', 1500, 0.7, 0, 0.25, 0.08, 4000); // inhale "ah-"
    v.burst('bandpass', 2400, 0.8, 0.27, 0.13, 0.45, 1600); // "-choo"
    v.tone('triangle', 420, 0.27, 0.12, 0.1, 260);
    return 0.5;
  },
  yawn: (v) => {
    v.tone('triangle', 230, 0, 1.2, 0.12, 150, v.filter('bandpass', 700, 2));
    v.burst('bandpass', 1100, 0.6, 0, 1.1, 0.05);
    return 1.25;
  },
  laugh: (v) => {
    for (let i = 0; i < 4; i++) {
      const t = i * 0.14;
      v.tone('sawtooth', 300 - i * 25, t, 0.1, 0.14, 240 - i * 25, v.filter('bandpass', 900, 2));
      v.burst('highpass', 3000, 0.7, t, 0.07, 0.05);
    }
    return 0.65;
  },
  thud: (v) => {
    v.tone('sine', 70, 0, 0.28, 0.6, 38);
    v.burst('lowpass', 500, 0.7, 0, 0.1, 0.35);
    return 0.32;
  },
  paper: (v) => {
    for (let i = 0; i < 6; i++)
      v.burst(
        'highpass',
        3000 + Math.random() * 2500,
        0.8,
        i * 0.06 + Math.random() * 0.03,
        0.03 + Math.random() * 0.03,
        0.12 + Math.random() * 0.1,
      );
    return 0.45;
  },
  door: (v) => {
    v.tone('sawtooth', 90, 0, 0.7, 0.2, 60, v.filter('bandpass', 220, 3));
    v.burst('highpass', 3000, 0.8, 0.74, 0.02, 0.3);
    v.tone('square', 1700, 0.74, 0.02, 0.05);
    return 0.82;
  },
  knock: (v) => {
    [0, 0.22].forEach((t, k) =>
      [220, 347, 510].forEach((f, i) =>
        v.tone('sine', f, t, 0.5, (0.3 - i * 0.07) * (1 - k * 0.35)),
      ),
    );
    return 0.75;
  },
  bell: (v) => {
    for (let s = 0; s < 3; s++) {
      [1, 2.76, 5.4, 8.93, 1.5].forEach((m, i) =>
        v.tone('sine', 520 * m, s * 0.22, 1.0, 0.16 / (1 + i * 0.7)),
      );
    }
    return 1.5;
  },
  buzz: (v) => {
    const lp = v.filter('lowpass', 700, 0.7);
    for (let i = 0; i < 3; i++) v.tone('square', 160, i * 0.2, 0.12, 0.2, 160, lp);
    return 0.6;
  },
  'game-beep': (v) => {
    v.tone('square', 880, 0, 0.06, 0.14);
    v.tone('square', 1320, 0.07, 0.07, 0.14);
    return 0.16;
  },
  gust: (v) => {
    const n = v.noise(),
      f = v.filter('bandpass', 300, 0.7),
      g = v.gain(FLOOR);
    f.frequency.setValueAtTime(300, v.t);
    f.frequency.linearRampToValueAtTime(900, v.t + 1.5);
    g.gain.setValueAtTime(FLOOR, v.t);
    g.gain.exponentialRampToValueAtTime(0.25, v.t + 0.9);
    g.gain.exponentialRampToValueAtTime(FLOOR, v.t + 1.5);
    v.chain(n, f, g);
    return 1.5;
  },
  wobble: (v) => {
    const o = v.osc('sawtooth', 95),
      am = v.osc('square', 18),
      amg = v.gain(0.5),
      g = v.gain(0.5),
      lp = v.filter('lowpass', 500);
    am.connect(amg);
    amg.connect(g.gain);
    const e = v.gain(FLOOR);
    v.env(e, 0, 0.05, 0.3, 0.55);
    o.connect(lp);
    lp.connect(g);
    g.connect(e);
    e.connect(v.out);
    v.burst('bandpass', 1200, 4, 0, 0.5, 0.05);
    v.tone('sine', 650, 0.12, 0.08, 0.06, 800);
    return 0.65;
  },
  sharpen: (v) => {
    const n = v.noise(),
      f = v.filter('bandpass', 2000, 2),
      g = v.gain(0.5),
      am = v.osc('sawtooth', 38),
      amg = v.gain(0.5),
      e = v.gain(FLOOR);
    f.frequency.setValueAtTime(2000, v.t);
    f.frequency.linearRampToValueAtTime(3200, v.t + 1);
    am.connect(amg);
    amg.connect(g.gain);
    v.env(e, 0, 0.1, 0.2, 0.9);
    n.connect(f);
    f.connect(g);
    g.connect(e);
    e.connect(v.out);
    return 1.0;
  },
  plane: (v) => {
    v.burst('bandpass', 400, 0.8, 0, 0.7, 0.1, 1200);
    v.burst('bandpass', 1200, 0.8, 0.3, 0.4, 0.05, 500);
    return 0.75;
  },
  telegraph: (v) => {
    [55, 82].forEach((f) => {
      const o = v.osc('sine', f),
        g = v.gain(FLOOR);
      g.gain.setValueAtTime(FLOOR, v.t);
      g.gain.exponentialRampToValueAtTime(0.05, v.t + 1.0);
      g.gain.exponentialRampToValueAtTime(FLOOR, v.t + 1.7);
      v.chain(o, g);
    });
    return 1.7;
  },
  caught: (v) => {
    const lp = v.filter('lowpass', 1800, 0.7),
      lp2 = v.filter('lowpass', 1800, 0.7);
    v.tone('sawtooth', 440, 0, 0.3, 0.2, 430, lp);
    v.tone('sawtooth', 311, 0.24, 0.45, 0.22, 290, lp2);
    return 0.75;
  },
  ui: (v) => {
    v.tone('sine', 1200, 0, 0.03, 0.12);
    v.burst('highpass', 4000, 0.7, 0, 0.008, 0.1);
    return 0.05;
  },
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private master!: GainNode;
  private roomBus!: GainNode;
  private roomLP!: BiquadFilterNode;
  private flatBus!: GainNode;
  private voices: Voice[] = [];

  // Persistent state, remembered before unlock and applied afterwards.
  private volume = 0.8;
  private earbud = false;
  private listenerPos: V3 = { x: 0, y: 0, z: 0 };
  private listenerYaw = 0;
  private suspended = false;

  // Teacher speech.
  private speechActive = false;
  private speechPos: V3 | null = null;
  private speechGain: GainNode | null = null;
  private speechPan: PannerNode | null = null;
  private speechNodes: AudioNode[] = [];

  // Device audio.
  private devMode: DeviceMode = 'off';
  private devPos: V3 | null = null;
  private devIn: GainNode | null = null;
  private devPanGain: GainNode | null = null;
  private devPan: PannerNode | null = null;
  private devDirect: GainNode | null = null;
  private devTimer: ReturnType<typeof setTimeout> | null = null;
  private devStep = 0;

  // Ambience.
  private ambOn = false;
  private ambGain: GainNode | null = null;
  private ambNodes: AudioNode[] = [];

  constructor(private readonly maxVoices = 24) {}

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state !== 'closed';
  }

  /** Create (if needed) and resume the context. Call from a user-gesture handler. */
  async unlock(): Promise<void> {
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext | undefined =
          typeof window === 'undefined'
            ? undefined
            : (window.AudioContext ??
              (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext);
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.buildGraph();
        this.applyAll();
      }
      if (this.ctx.state === 'suspended' && !this.suspended) await this.ctx.resume();
    } catch {
      /* audio unavailable: stay silent */
    }
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    this.safe(() => {
      if (this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
    });
  }

  setListener(pos: V3, yaw: number): void {
    this.listenerPos = { ...pos };
    this.listenerYaw = yaw;
    this.safe(() => this.applyListener());
  }

  setEarbud(on: boolean): void {
    this.earbud = on;
    this.safe(() => {
      this.applyEarbud();
      this.applyDeviceRouting();
    });
  }

  play(kind: SoundKind, pos?: V3, opts?: { volume?: number }): void {
    this.safe(() => {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running' || !this.noiseBuf) return;
      const positional = !!pos && !FLAT_KINDS.has(kind);
      this.spawn(
        kind,
        positional ? pos! : null,
        opts?.volume ?? 1,
        positional ? this.roomBus : this.flatBus,
      );
    });
  }

  setTeacherSpeech(active: boolean, pos: V3 | null): void {
    this.speechActive = active;
    if (pos) this.speechPos = { ...pos };
    this.safe(() => this.applySpeech());
  }

  setDeviceAudio(mode: DeviceMode, earbud: boolean, pos: V3 | null): void {
    const changed = mode !== this.devMode;
    this.devMode = mode;
    this.earbud = earbud;
    if (pos) this.devPos = { ...pos };
    this.safe(() => {
      this.applyEarbud();
      this.applyDeviceRouting();
      if (changed) this.restartDeviceLoop();
    });
  }

  setAmbience(on: boolean): void {
    this.ambOn = on;
    this.safe(() => this.applyAmbience());
  }

  suspend(): void {
    this.suspended = true;
    this.safe(() => {
      void this.ctx?.suspend().catch(() => undefined);
    });
  }

  resume(): void {
    this.suspended = false;
    this.safe(() => {
      void this.ctx?.resume().catch(() => undefined);
    });
  }

  dispose(): void {
    this.safe(() => {
      if (this.devTimer) clearTimeout(this.devTimer);
      this.devTimer = null;
      for (const v of [...this.voices]) v.kill();
      const c = this.ctx;
      this.ctx = null;
      this.noiseBuf = null;
      this.speechGain = null;
      this.devIn = null;
      this.ambGain = null;
      void c?.close().catch(() => undefined);
    });
  }

  // ---------------------------------------------------------------- internals

  private safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* never throw */
    }
  }

  private buildGraph(): void {
    const ctx = this.ctx!;
    // Shared 2 s white-noise buffer.
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // Room bus: everything the player hears "in the room"; earbud muffles it.
    this.roomLP = ctx.createBiquadFilter();
    this.roomLP.type = 'lowpass';
    this.roomLP.frequency.value = 20000;
    this.roomBus = ctx.createGain();
    this.roomBus.connect(this.roomLP);
    this.roomLP.connect(this.master);

    // Flat bus: non-positional UI / tension sounds, unaffected by earbud.
    this.flatBus = ctx.createGain();
    this.flatBus.connect(this.master);
  }

  private applyAll(): void {
    this.applyListener();
    this.applyEarbud();
    this.applySpeech();
    this.applyDeviceRouting();
    this.restartDeviceLoop();
    this.applyAmbience();
  }

  private setPannerPos(p: PannerNode, pos: V3): void {
    if (p.positionX) {
      p.positionX.value = pos.x;
      p.positionY.value = pos.y;
      p.positionZ.value = pos.z;
    } else
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(
        pos.x,
        pos.y,
        pos.z,
      );
  }

  private makePanner(pos: V3): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1;
    p.rolloffFactor = 1.2;
    p.maxDistance = 10000;
    this.setPannerPos(p, pos);
    return p;
  }

  private applyListener(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener,
      p = this.listenerPos,
      y = this.listenerYaw;
    const fx = -Math.sin(y),
      fz = -Math.cos(y);
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = fx;
      l.forwardY.value = 0;
      l.forwardZ.value = fz;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    } else {
      const old = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(...a: number[]): void;
      };
      old.setPosition(p.x, p.y, p.z);
      old.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  private applyEarbud(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.roomLP.frequency.setTargetAtTime(this.earbud ? 1200 : 20000, t, 0.08);
    this.roomBus.gain.setTargetAtTime(this.earbud ? 0.45 : 1, t, 0.08);
  }

  /** Create one voice, wire it to dest (via a panner if pos given), enforce voice budget. */
  private spawn(kind: SoundKind, pos: V3 | null, volume: number, dest: AudioNode): void {
    const ctx = this.ctx!;
    if (this.voices.length >= this.maxVoices) this.voices[0]!.kill(); // steal oldest
    const v = new Voice(ctx, ctx.currentTime + 0.005, this.noiseBuf!, volume);
    let panner: PannerNode | null = null;
    if (pos) {
      panner = v.add(this.makePanner(pos));
      v.out.connect(panner);
      panner.connect(dest);
    } else v.out.connect(dest);
    v.onDone = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
    };
    this.voices.push(v);
    v.end(RECIPES[kind](v));
  }

  // ------------------------------------------------------------ teacher speech

  private buildSpeech(): void {
    const ctx = this.ctx!,
      keep = (n: AudioNode) => {
        this.speechNodes.push(n);
        return n;
      };
    const start = (o: OscillatorNode) => {
      o.start();
      return o;
    };
    // Voice source: sawtooth with slowly wandering pitch (~110-180 Hz).
    const src = keep(start(ctx.createOscillator())) as OscillatorNode;
    src.type = 'sawtooth';
    src.frequency.value = 145;
    for (const [rate, depth] of [
      [0.31, 20],
      [0.83, 13],
    ] as const) {
      const l = keep(start(ctx.createOscillator())) as OscillatorNode,
        g = keep(ctx.createGain()) as GainNode;
      l.frequency.value = rate;
      g.gain.value = depth;
      l.connect(g);
      g.connect(src.frequency);
    }
    // Two formant bandpass filters, in parallel.
    const f1 = keep(ctx.createBiquadFilter()) as BiquadFilterNode,
      f2 = keep(ctx.createBiquadFilter()) as BiquadFilterNode;
    f1.type = f2.type = 'bandpass';
    f1.frequency.value = 650;
    f2.frequency.value = 1150;
    f1.Q.value = 4;
    f2.Q.value = 5;
    const fl = keep(start(ctx.createOscillator())) as OscillatorNode,
      fg = keep(ctx.createGain()) as GainNode;
    fl.frequency.value = 0.6;
    fg.gain.value = 180;
    fl.connect(fg);
    fg.connect(f1.frequency);
    const mix = keep(ctx.createGain()) as GainNode;
    mix.gain.value = 0.8;
    src.connect(f1);
    src.connect(f2);
    f1.connect(mix);
    f2.connect(mix);
    // Syllable gating at ~5 Hz.
    const gate = keep(ctx.createGain()) as GainNode;
    gate.gain.value = 0.5;
    const gl = keep(start(ctx.createOscillator())) as OscillatorNode,
      gg = keep(ctx.createGain()) as GainNode;
    gl.frequency.value = 4.8;
    gg.gain.value = 0.45;
    gl.connect(gg);
    gg.connect(gate.gain);
    mix.connect(gate);
    this.speechGain = keep(ctx.createGain()) as GainNode;
    this.speechGain.gain.value = 0;
    gate.connect(this.speechGain);
    this.speechPan = keep(this.makePanner(this.speechPos ?? { x: 0, y: 1.5, z: -3 })) as PannerNode;
    this.speechGain.connect(this.speechPan);
    this.speechPan.connect(this.roomBus);
  }

  private applySpeech(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.speechGain) {
      if (!this.speechActive) return; // build lazily
      this.buildSpeech();
    }
    if (this.speechPos && this.speechPan) this.setPannerPos(this.speechPan, this.speechPos);
    // ~0.4 s fade: time constant 0.1 s.
    this.speechGain!.gain.setTargetAtTime(
      this.speechActive && this.speechPos ? 0.22 : 0,
      ctx.currentTime,
      0.1,
    );
  }

  // ------------------------------------------------------------- device audio

  private applyDeviceRouting(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.devIn) {
      this.devIn = ctx.createGain();
      this.devPanGain = ctx.createGain();
      this.devDirect = ctx.createGain();
      this.devPan = this.makePanner(this.devPos ?? { x: 0, y: 0.8, z: 0 });
      this.devIn.connect(this.devPanGain);
      this.devPanGain.connect(this.devPan);
      this.devPan.connect(this.roomBus);
      this.devIn.connect(this.devDirect);
      this.devDirect.connect(this.master);
    }
    if (this.devPos) this.setPannerPos(this.devPan!, this.devPos);
    const t = ctx.currentTime;
    // Speaker: positional through the room bus. Earbud: dry, centred, louder, bypasses the room filter.
    this.devIn.gain.setTargetAtTime(this.devMode === 'off' ? 0 : this.earbud ? 1.6 : 0.8, t, 0.1);
    this.devPanGain!.gain.setTargetAtTime(this.earbud || !this.devPos ? 0 : 1, t, 0.05);
    this.devDirect!.gain.setTargetAtTime(this.earbud || !this.devPos ? 1 : 0, t, 0.05);
  }

  private restartDeviceLoop(): void {
    if (this.devTimer) clearTimeout(this.devTimer);
    this.devTimer = null;
    this.devStep = 0;
    if (this.devMode !== 'off' && this.ctx) this.deviceTick();
  }

  /** One scheduling step of the game/video loop; reschedules itself while the mode is active. */
  private deviceTick(): void {
    const ctx = this.ctx;
    if (!ctx || this.devMode === 'off' || !this.devIn) return;
    this.safe(() => {
      if (this.suspended || ctx.state !== 'running') return;
      if (this.voices.length >= this.maxVoices) return;
      const v = new Voice(ctx, ctx.currentTime + 0.005, this.noiseBuf!, 1);
      v.out.connect(this.devIn!);
      v.onDone = () => {
        const i = this.voices.indexOf(v);
        if (i >= 0) this.voices.splice(i, 1);
      };
      this.voices.push(v);
      v.end(this.devMode === 'game' ? this.gameBlips(v) : this.videoBed(v));
    });
    const next = this.devMode === 'game' ? 900 + Math.random() * 2200 : 480;
    this.devTimer = setTimeout(() => this.deviceTick(), next);
  }

  /** A few quiet chiptune blips. */
  private gameBlips(v: Voice): number {
    const scale = [523, 587, 659, 784, 880, 1047];
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++)
      v.tone('square', scale[Math.floor(Math.random() * scale.length)]!, i * 0.07, 0.06, 0.07);
    return n * 0.07 + 0.08;
  }

  /** One 0.48 s slice of a soft music bed: pentatonic pluck over a pad, with an occasional voice-ish vowel. */
  private videoBed(v: Voice): number {
    const penta = [220, 247, 293, 330, 392, 440, 494, 587];
    const s = this.devStep++;
    const note = penta[(s * 3 + (s >> 2)) % penta.length]!;
    v.tone('triangle', note, 0, 0.7, 0.1);
    v.tone('sine', note / 2, 0, 0.9, 0.07);
    if (s % 8 === 0) {
      const root = [110, 130, 147, 98][(s >> 3) % 4]!;
      v.tone('sine', root, 0, 3.0, 0.08);
      v.tone('triangle', root * 1.5, 0, 3.0, 0.04);
    }
    if (s % 4 === 2)
      v.tone(
        'sawtooth',
        170 + Math.random() * 40,
        0,
        0.35,
        0.05,
        150,
        v.filter('bandpass', 800 + Math.random() * 400, 4),
      );
    return s % 8 === 0 ? 3.1 : 0.95;
  }

  // ---------------------------------------------------------------- ambience

  private applyAmbience(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.ambGain) {
      if (!this.ambOn) return;
      const keep = <T extends AudioNode>(n: T): T => {
        this.ambNodes.push(n);
        return n;
      };
      this.ambGain = keep(ctx.createGain());
      this.ambGain.gain.value = 0;
      // Room tone: brown-ish noise (heavily lowpassed white noise).
      const n1 = keep(ctx.createBufferSource());
      n1.buffer = this.noiseBuf;
      n1.loop = true;
      n1.start();
      const lp = keep(ctx.createBiquadFilter());
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      const g1 = keep(ctx.createGain());
      g1.gain.value = 0.35;
      n1.connect(lp);
      lp.connect(g1);
      g1.connect(this.ambGain);
      // Very faint distant outdoor hum.
      const n2 = keep(ctx.createBufferSource());
      n2.buffer = this.noiseBuf;
      n2.loop = true;
      n2.start(0, 0.7);
      const bp = keep(ctx.createBiquadFilter());
      bp.type = 'bandpass';
      bp.frequency.value = 480;
      bp.Q.value = 1.5;
      const g2 = keep(ctx.createGain());
      g2.gain.value = 0.05;
      n2.connect(bp);
      bp.connect(g2);
      g2.connect(this.ambGain);
      const hum = keep(ctx.createOscillator());
      hum.type = 'sine';
      hum.frequency.value = 62;
      hum.start();
      const g3 = keep(ctx.createGain());
      g3.gain.value = 0.015;
      hum.connect(g3);
      g3.connect(this.ambGain);
      this.ambGain.connect(this.roomBus);
    }
    this.ambGain.gain.setTargetAtTime(this.ambOn ? 0.12 : 0, ctx.currentTime, 0.4);
  }
}
