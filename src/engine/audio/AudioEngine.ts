/**
 * Procedural ambience engine (Web Audio, no samples). No AudioContext is created until unlock().
 * Graph: layer gains -> master gain -> compressor -> destination.
 */
import {
  clamp,
  densityToMeanInterval,
  mergeMix,
  mulberry32,
  nearestPointOnPolyline,
  poissonInterval,
  randomWalk,
  SILENT_MIX,
} from './math';
import type { AmbienceMix, Vec3 } from './math';

export type { AmbienceMix } from './math';
export { AMBIENCE_PRESETS } from './presets';

export interface Emitter {
  id: string;
  kind: 'creek';
  points: [number, number, number][];
  level: number;
}
export type Surface = 'leaves' | 'dirt' | 'moss' | 'rock' | 'gravel' | 'snow' | 'wood';

interface Listener {
  position: Vec3;
  forward: Vec3;
}

interface CreekVoice {
  id: string;
  points: [number, number, number][];
  level: number;
  out: GainNode;
  panner: PannerNode;
  srcs: AudioScheduledSourceNode[];
  nextPlip: number;
  dist: number;
}

interface Cricket {
  gain: GainNode;
  pan: StereoPannerNode;
  next: number;
  period: number;
}

const LOOKAHEAD = 0.25;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterVolume: number;
  private mix: AmbienceMix = { ...SILENT_MIX };
  private fade = 2;
  private emitters: Emitter[] = [];
  private userSuspended = false;
  private rand = mulberry32((Math.random() * 4294967296) >>> 0);
  private disposed = false;
  private unlocking: Promise<void> | null = null;

  // graph
  private master!: GainNode;
  private buses!: Record<
    'wind' | 'birds' | 'insects' | 'creek' | 'rain' | 'night' | 'foot',
    GainNode
  >;
  private pink!: AudioBuffer;
  private white!: AudioBuffer;
  private echoIn!: GainNode;
  private srcs: AudioScheduledSourceNode[] = [];
  private creeks = new Map<string, CreekVoice>();
  private crickets: Cricket[] = [];

  // wind
  private windMod!: GainNode;
  private windLp!: BiquadFilterNode;
  private windBp!: BiquadFilterNode;
  private rustle!: GainNode;
  private gust = 0.4;
  private nextGust = 0;
  // schedulers
  private nextBird = 0;
  private nextOwl = 0;
  private nextDrop = 0;
  private nextInsectSwell = 0;
  private insectSwell!: GainNode;
  private insectLayers: GainNode[] = [];

  constructor(opts: { masterVolume: number }) {
    this.masterVolume = clamp(opts.masterVolume, 0, 1);
  }

  get unlocked(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (this.unlocking) return this.unlocking;
    this.unlocking = this.doUnlock().finally(() => {
      this.unlocking = null;
    });
    return this.unlocking;
  }

  private async doUnlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ latencyHint: 'playback' });
        this.build(this.ctx);
      } catch {
        this.ctx = null;
        return;
      }
    }
    try {
      if (this.ctx.state !== 'running' && !this.userSuspended) await this.ctx.resume();
    } catch {
      /* ignore */
    }
    if (this.ctx.state === 'running') {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.masterVolume, t, 0.6);
      this.applyMix(3);
    }
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    if (this.ctx && this.master && this.unlocked) {
      this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.08);
    }
  }

  setMix(mix: Partial<AmbienceMix>, crossfadeSeconds = 2): void {
    this.mix = mergeMix(this.mix, mix);
    this.fade = Math.max(0.01, crossfadeSeconds);
    this.applyMix(this.fade);
  }

  setEmitters(list: Emitter[]): void {
    this.emitters = list.filter((e) => e.kind === 'creek' && e.points.length > 0);
    if (this.ctx) this.syncEmitters(this.ctx);
  }

  suspend(): void {
    this.userSuspended = true;
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }

  resume(): void {
    this.userSuspended = false;
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const s of this.srcs) {
      try {
        s.stop();
      } catch {
        /* */
      }
    }
    this.srcs = [];
    for (const v of this.creeks.values()) this.killCreek(v, 0);
    this.creeks.clear();
    if (this.ctx) {
      try {
        this.master.disconnect();
      } catch {
        /* */
      }
      void this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
  }

  // ------------------------------------------------------------------ per-frame

  update(listener: Listener, dt: number): void {
    void dt;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.userSuspended) return;
    const now = ctx.currentTime;
    const p = listener.position,
      f = listener.forward;
    this.setListener(ctx, p, f, now);

    // creeks
    for (const v of this.creeks.values()) {
      const np = nearestPointOnPolyline(v.points, p);
      if (!np) continue;
      v.dist = np.distance;
      const pr = v.panner;
      pr.positionX.setTargetAtTime(np.point[0], now, 0.05);
      pr.positionY.setTargetAtTime(np.point[1], now, 0.05);
      pr.positionZ.setTargetAtTime(np.point[2], now, 0.05);
      if (this.mix.creek > 0.02 && v.dist < 70) {
        const rate = (3 + 14 * v.level) * (0.4 + 0.6 * this.mix.creek);
        if (now + LOOKAHEAD >= v.nextPlip) {
          this.plip(ctx, Math.max(now, v.nextPlip), v.out);
          v.nextPlip = Math.max(now, v.nextPlip) + poissonInterval(this.rand, 1 / rate, 0.02, 1);
        }
      } else v.nextPlip = Math.max(v.nextPlip, now);
    }

    this.tickWind(ctx, now);
    this.tickBirds(ctx, now, p, f);
    this.tickInsects(ctx, now);
    this.tickNight(ctx, now);
    this.tickRain(ctx, now);
  }

  // ------------------------------------------------------------------ build

  private build(ctx: AudioContext): void {
    const sr = ctx.sampleRate;
    this.pink = this.makeNoise(ctx, 6 * sr, 'pink');
    this.white = this.makeNoise(ctx, 2 * sr, 'white');

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);

    const mk = (): GainNode => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.master);
      return g;
    };
    this.buses = {
      wind: mk(),
      birds: mk(),
      insects: mk(),
      creek: mk(),
      rain: mk(),
      night: mk(),
      foot: mk(),
    };
    this.buses.foot.gain.value = 0.6;

    this.buildWind(ctx);
    this.buildEcho(ctx);
    this.buildInsects(ctx);
    this.buildCrickets(ctx);
    this.buildRain(ctx);
    this.syncEmitters(ctx);
  }

  private makeNoise(ctx: AudioContext, len: number, kind: 'pink' | 'white'): AudioBuffer {
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let b0 = 0,
        b1 = 0,
        b2 = 0,
        b3 = 0,
        b4 = 0,
        b5 = 0,
        b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'white') {
          d[i] = w * 0.8;
          continue;
        }
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
      // seam crossfade so the loop does not click
      const n = Math.min(1024, len >> 2);
      for (let i = 0; i < n; i++) {
        const k = i / n;
        d[i] = (d[i] ?? 0) * k + (d[len - n + i] ?? 0) * (1 - k);
      }
    }
    return buf;
  }

  private loop(ctx: AudioContext, buf: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(0, this.rand() * buf.duration);
    this.srcs.push(s);
    return s;
  }

  private buildWind(ctx: AudioContext): void {
    this.windMod = ctx.createGain();
    this.windMod.gain.value = 0.6;
    this.windLp = ctx.createBiquadFilter();
    this.windLp.type = 'lowpass';
    this.windLp.frequency.value = 500;
    this.windLp.Q.value = 0.5;
    this.windBp = ctx.createBiquadFilter();
    this.windBp.type = 'bandpass';
    this.windBp.frequency.value = 600;
    this.windBp.Q.value = 0.8;
    const body = this.loop(ctx, this.pink);
    const body2 = this.loop(ctx, this.pink, 0.83);
    body.connect(this.windLp);
    body2.connect(this.windBp);
    const bpGain = ctx.createGain();
    bpGain.gain.value = 0.9;
    this.windLp.connect(this.windMod);
    this.windBp.connect(bpGain).connect(this.windMod);
    this.windMod.connect(this.buses.wind);
    // leaves rustle
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2800;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 5500;
    bp.Q.value = 0.6;
    this.rustle = ctx.createGain();
    this.rustle.gain.value = 0;
    this.loop(ctx, this.white, 0.9)
      .connect(hp)
      .connect(bp)
      .connect(this.rustle)
      .connect(this.buses.wind);
  }

  private buildEcho(ctx: AudioContext): void {
    this.echoIn = ctx.createGain();
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.23;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    const out = ctx.createGain();
    out.gain.value = 0.5;
    this.echoIn.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(out);
    out.connect(this.master);
  }

  private amLayer(
    ctx: AudioContext,
    freq: number,
    q: number,
    modHz: number,
    depth: number,
    level: number,
  ): GainNode {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const am = ctx.createGain();
    am.gain.value = 1 - depth;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = modHz;
    const lg = ctx.createGain();
    lg.gain.value = depth;
    lg.connect(am.gain);
    lfo.connect(lg);
    lfo.start();
    this.srcs.push(lfo);
    const out = ctx.createGain();
    out.gain.value = level;
    this.loop(ctx, this.pink, 1.7).connect(bp).connect(am).connect(out);
    return out;
  }

  private buildInsects(ctx: AudioContext): void {
    this.insectSwell = ctx.createGain();
    this.insectSwell.gain.value = 0.7;
    this.insectSwell.connect(this.buses.insects);
    const a = this.amLayer(ctx, 5200, 7, 62, 0.55, 1);
    const b = this.amLayer(ctx, 6600, 9, 41, 0.5, 0.7);
    const c = this.amLayer(ctx, 4100, 6, 87, 0.6, 0.6);
    for (const g of [a, b, c]) {
      g.connect(this.insectSwell);
      this.insectLayers.push(g);
    }
  }

  private buildCrickets(ctx: AudioContext): void {
    const freqs = [3900, 4250, 4600];
    freqs.forEach((fq, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = fq;
      const g = ctx.createGain();
      g.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = (i - 1) * 0.6 + (this.rand() - 0.5) * 0.2;
      o.connect(g).connect(pan).connect(this.buses.night);
      o.start();
      this.srcs.push(o);
      this.crickets.push({ gain: g, pan, next: 0, period: 0.55 + i * 0.17 });
    });
  }

  private buildRain(ctx: AudioContext): void {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9000;
    const g = ctx.createGain();
    g.gain.value = 0.6;
    this.loop(ctx, this.white, 1.1).connect(hp).connect(lp).connect(g).connect(this.buses.rain);
    const lo = ctx.createBiquadFilter();
    lo.type = 'lowpass';
    lo.frequency.value = 500;
    const lg = ctx.createGain();
    lg.gain.value = 0.35;
    this.loop(ctx, this.pink).connect(lo).connect(lg).connect(this.buses.rain);
  }

  // ------------------------------------------------------------------ mix / emitters

  private applyMix(fade: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.buses) return;
    const t = ctx.currentTime,
      tc = Math.max(0.02, fade / 3);
    const m = this.mix;
    const set = (g: GainNode, v: number): void => {
      g.gain.setTargetAtTime(v, t, tc);
    };
    set(this.buses.wind, Math.pow(m.wind, 1.4) * 0.55);
    set(this.buses.birds, clamp(m.birds + m.birdsDawnChorus * 0.5, 0, 1) * 0.7);
    set(this.buses.insects, Math.pow(m.insects, 1.5) * 0.14);
    set(this.buses.creek, Math.pow(m.creek, 1.2) * 0.9);
    set(this.buses.rain, Math.pow(m.rain, 1.3) * 0.5);
    set(this.buses.night, Math.pow(m.night, 1.2) * 0.3);
  }

  private syncEmitters(ctx: AudioContext): void {
    const ids = new Set(this.emitters.map((e) => e.id));
    for (const [id, v] of this.creeks) {
      if (!ids.has(id)) {
        this.killCreek(v, 1);
        this.creeks.delete(id);
      }
    }
    for (const e of this.emitters) {
      const ex = this.creeks.get(e.id);
      if (ex) {
        ex.points = e.points;
        ex.level = e.level;
        ex.out.gain.setTargetAtTime(clamp(e.level, 0, 1.5), ctx.currentTime, 0.3);
      } else if (this.buses) this.creeks.set(e.id, this.buildCreek(ctx, e));
    }
  }

  private buildCreek(ctx: AudioContext, e: Emitter): CreekVoice {
    const panner = ctx.createPanner();
    try {
      panner.panningModel = 'HRTF';
    } catch {
      panner.panningModel = 'equalpower';
    }
    panner.distanceModel = 'inverse';
    panner.refDistance = 3;
    panner.rolloffFactor = 1.2;
    panner.maxDistance = 80;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.setTargetAtTime(clamp(e.level, 0, 1.5), ctx.currentTime, 0.5);
    out.connect(panner).connect(this.buses.creek);
    const srcs: AudioScheduledSourceNode[] = [];
    const add = (buf: AudioBuffer, rate: number): AudioBufferSourceNode => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(0, this.rand() * buf.duration);
      srcs.push(s);
      return s;
    };
    const bpf = (f: number, q: number): BiquadFilterNode => {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass';
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    // steady wash
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4500;
    const wash = ctx.createGain();
    wash.gain.value = 0.45;
    add(this.pink, 1.2).connect(bpf(1100, 0.4)).connect(lp).connect(wash).connect(out);
    // bubbling layers with slow resonant modulation
    for (const [f, q, hz] of [
      [1500, 2.5, 0.7],
      [2400, 3, 1.3],
      [900, 2, 0.5],
    ] as const) {
      const g = ctx.createGain();
      g.gain.value = 0.3;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = hz * (0.8 + this.rand() * 0.4);
      const lg = ctx.createGain();
      lg.gain.value = 0.25;
      lg.connect(g.gain);
      lfo.connect(lg);
      lfo.start();
      srcs.push(lfo);
      add(this.white, 0.8 + this.rand() * 0.4)
        .connect(bpf(f, q))
        .connect(g)
        .connect(out);
    }
    return {
      id: e.id,
      points: e.points,
      level: e.level,
      out,
      panner,
      srcs,
      nextPlip: 0,
      dist: 999,
    };
  }

  private killCreek(v: CreekVoice, fade: number): void {
    const ctx = this.ctx;
    const stop = (): void => {
      for (const s of v.srcs) {
        try {
          s.stop();
        } catch {
          /* */
        }
      }
      try {
        v.panner.disconnect();
        v.out.disconnect();
      } catch {
        /* */
      }
    };
    if (ctx && fade > 0) {
      v.out.gain.setTargetAtTime(0, ctx.currentTime, fade / 4);
      setTimeout(stop, fade * 1000 + 300);
    } else stop();
  }

  private setListener(ctx: AudioContext, p: Vec3, f: Vec3, now: number): void {
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.setValueAtTime(p.x, now);
      l.positionY.setValueAtTime(p.y, now);
      l.positionZ.setValueAtTime(p.z, now);
      l.forwardX.setValueAtTime(f.x, now);
      l.forwardY.setValueAtTime(f.y, now);
      l.forwardZ.setValueAtTime(f.z, now);
      l.upX.setValueAtTime(0, now);
      l.upY.setValueAtTime(1, now);
      l.upZ.setValueAtTime(0, now);
    } else {
      const old = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(...a: number[]): void;
      };
      old.setPosition(p.x, p.y, p.z);
      old.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }
  }

  // ------------------------------------------------------------------ schedulers

  private tickWind(ctx: AudioContext, now: number): void {
    if (this.mix.wind < 0.01) return;
    if (now < this.nextGust) return;
    const depth = 0.25 + 0.75 * this.mix.windGust;
    const iv = 2.5 + this.rand() * 4.5;
    this.gust = randomWalk(this.gust, this.rand, 0.5, 0, 1, 0.35, 0.1);
    const w = this.gust;
    const tc = iv / 3;
    this.windMod.gain.setTargetAtTime(0.35 + depth * 0.9 * w, now, tc);
    this.windLp.frequency.setTargetAtTime(300 + (400 + 900 * depth) * w, now, tc);
    this.windBp.frequency.setTargetAtTime(450 + 700 * w, now, tc);
    this.rustle.gain.setTargetAtTime(0.28 * w * w * (0.2 + 0.8 * depth), now, tc * 0.6);
    this.nextGust = now + iv;
  }

  private tickBirds(ctx: AudioContext, now: number, p: Vec3, f: Vec3): void {
    const density = clamp(this.mix.birds * 0.6 + this.mix.birdsDawnChorus * 0.8, 0, 1);
    const mean = densityToMeanInterval(density, 22, 1.1);
    if (!Number.isFinite(mean)) {
      this.nextBird = Math.max(this.nextBird, now);
      return;
    }
    if (now + LOOKAHEAD < this.nextBird) return;
    const t = Math.max(now, this.nextBird);
    this.birdCall(ctx, t);
    this.nextBird = t + poissonInterval(this.rand, mean, 0.25, 40);
    void p;
    void f;
  }

  private birdCall(ctx: AudioContext, t: number): void {
    const r = this.rand;
    const roll = r();
    const kind = roll < 0.4 ? 'whistle' : roll < 0.62 ? 'trill' : roll < 0.88 ? 'warble' : 'cuckoo';
    const far = kind === 'cuckoo' ? 0.7 + r() * 0.3 : 0.05 + r() * 0.95;
    const voice = ctx.createGain();
    voice.gain.value = (0.9 - 0.65 * far) * (0.6 + r() * 0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = kind === 'cuckoo' ? 1400 : 9000 - 7200 * far;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (r() * 2 - 1) * 0.85;
    voice.connect(lp).connect(pan).connect(this.buses.birds);
    const send = ctx.createGain();
    send.gain.value = r() < 0.4 ? 0.1 + 0.4 * far : 0.04;
    pan.connect(send).connect(this.echoIn);

    if (kind === 'whistle') {
      const n = 2 + Math.floor(r() * 3);
      let f0 = 1900 + r() * 1700;
      let tt = t;
      const dir = r() < 0.5 ? 1 : -1;
      for (let i = 0; i < n; i++) {
        const dur = 0.1 + r() * 0.14;
        const f1 = f0 * (1 + dir * (0.08 + r() * 0.2));
        this.chirp(ctx, tt, dur, f0, f1, 0.5, voice, 'sine', 6 + r() * 4, 0.012, 0.18);
        tt += dur + 0.05 + r() * 0.1;
        f0 = f1 * (0.95 + r() * 0.1);
      }
    } else if (kind === 'trill') {
      const n = 8 + Math.floor(r() * 14);
      const base = 3200 + r() * 2200;
      const sp = 0.03 + r() * 0.015;
      for (let i = 0; i < n; i++) {
        const up = i % 2 === 0;
        const env = Math.sin((i / (n - 1)) * Math.PI) * 0.7 + 0.3;
        this.chirp(
          ctx,
          t + i * sp,
          sp * 0.85,
          base * (up ? 1 : 1.13),
          base * (up ? 1.1 : 1.02),
          0.32 * env,
          voice,
          'triangle',
          0,
          0,
          0.1,
        );
      }
    } else if (kind === 'warble') {
      const n = 5 + Math.floor(r() * 4);
      let f0 = 3600 + r() * 900;
      let tt = t;
      for (let i = 0; i < n; i++) {
        const dur = 0.06 + r() * 0.06;
        const f1 = f0 * (0.84 + r() * 0.1);
        this.chirp(ctx, tt, dur, f0 * (1 + r() * 0.05), f1, 0.42, voice, 'sine', 5, 0.01, 0.2);
        tt += dur + 0.02 + r() * 0.04;
        f0 = f1 * (0.97 + r() * 0.05);
      }
    } else {
      const f0 = 640 + r() * 120;
      this.chirp(ctx, t, 0.28, f0 * 1.12, f0 * 1.05, 0.55, voice, 'sine', 0, 0, 0.04);
      this.chirp(ctx, t + 0.4, 0.4, f0 * 0.88, f0 * 0.82, 0.55, voice, 'sine', 0, 0, 0.04);
    }
  }

  /** One bird note: sine/triangle with pitch glide, optional vibrato, soft harmonic and shaped envelope. */
  private chirp(
    ctx: AudioContext,
    t: number,
    dur: number,
    f0: number,
    f1: number,
    peak: number,
    dest: AudioNode,
    type: OscillatorType,
    vibHz: number,
    vibDepth: number,
    harm: number,
  ): void {
    const env = ctx.createGain();
    const atk = Math.min(0.012, dur * 0.25);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + atk);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(dest);
    const mult = harm > 0 ? [1, 2] : [1];
    for (const m of mult) {
      const o = ctx.createOscillator();
      o.type = m === 1 ? type : 'sine';
      o.frequency.setValueAtTime(f0 * m, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(50, f1 * m), t + dur * 0.92);
      if (vibHz > 0 && vibDepth > 0) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = vibHz;
        const lg = ctx.createGain();
        lg.gain.value = f0 * m * vibDepth;
        lg.connect(o.frequency);
        lfo.connect(lg);
        lfo.start(t);
        lfo.stop(t + dur + 0.05);
      }
      const g = ctx.createGain();
      g.gain.value = m === 1 ? 1 : harm;
      o.connect(g).connect(env);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  private tickInsects(ctx: AudioContext, now: number): void {
    if (this.mix.insects < 0.01 || now < this.nextInsectSwell) return;
    const iv = 4 + this.rand() * 6;
    this.insectSwell.gain.setTargetAtTime(0.35 + this.rand() * 0.65, now, iv / 3);
    this.nextInsectSwell = now + iv;
  }

  private tickNight(ctx: AudioContext, now: number): void {
    const n = this.mix.night;
    if (n < 0.03) return;
    for (const c of this.crickets) {
      if (now + LOOKAHEAD < c.next) continue;
      const t = Math.max(now, c.next);
      const pulses = 3 + Math.floor(this.rand() * 2);
      for (let i = 0; i < pulses; i++) {
        const s = t + i * 0.065;
        c.gain.gain.setValueAtTime(0, s);
        c.gain.gain.linearRampToValueAtTime(0.5, s + 0.006);
        c.gain.gain.linearRampToValueAtTime(0, s + 0.032);
      }
      c.next = t + c.period * (0.8 + this.rand() * 0.4);
    }
    if (n > 0.2 && now + LOOKAHEAD >= this.nextOwl) {
      if (this.nextOwl > 0) this.hoot(ctx, Math.max(now, this.nextOwl));
      this.nextOwl = Math.max(now, this.nextOwl) + 14 + this.rand() * 26;
    }
  }

  private hoot(ctx: AudioContext, t: number): void {
    const r = this.rand;
    const pan = ctx.createStereoPanner();
    pan.pan.value = (r() * 2 - 1) * 0.8;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 650;
    const g = ctx.createGain();
    g.gain.value = 0.5 * (0.5 + r() * 0.5);
    g.connect(lp).connect(pan).connect(this.buses.night);
    const send = ctx.createGain();
    send.gain.value = 0.5;
    pan.connect(send).connect(this.echoIn);
    const n = r() < 0.5 ? 2 : 3;
    const base = 330 + r() * 70;
    for (let i = 0; i < n; i++) {
      const s = t + i * (i === 0 ? 0 : 0.55) + (i === n - 1 && n === 3 ? 0.3 : 0);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(base * 1.12, s);
      o.frequency.exponentialRampToValueAtTime(base * (i === 0 ? 0.97 : 0.9), s + 0.4);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, s);
      e.gain.linearRampToValueAtTime(1, s + 0.08);
      e.gain.linearRampToValueAtTime(0.7, s + 0.25);
      e.gain.exponentialRampToValueAtTime(0.0001, s + 0.5);
      o.connect(e).connect(g);
      o.start(s);
      o.stop(s + 0.55);
    }
  }

  private tickRain(ctx: AudioContext, now: number): void {
    const rain = this.mix.rain;
    if (rain < 0.05) return;
    if (now + LOOKAHEAD < this.nextDrop) return;
    const t = Math.max(now, this.nextDrop);
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rand() * 2 - 1;
    pan.connect(this.buses.rain);
    this.burst(
      ctx,
      t,
      0.012 + this.rand() * 0.01,
      [['bandpass', 3000 + this.rand() * 5000, 10]],
      0.5 * (0.3 + this.rand() * 0.7),
      pan,
      1,
    );
    this.nextDrop = t + poissonInterval(this.rand, 0.12 - 0.1 * rain, 0.005, 0.4);
  }

  private plip(ctx: AudioContext, t: number, dest: AudioNode): void {
    const f = 600 + this.rand() * 1900;
    const dur = 0.03 + this.rand() * 0.04;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 12 + this.rand() * 10;
    bp.frequency.setValueAtTime(f, t);
    bp.frequency.exponentialRampToValueAtTime(f * (1.3 + this.rand() * 0.6), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.8 * (0.3 + this.rand() * 0.7), t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    bp.connect(g).connect(dest);
    s.connect(bp);
    s.start(t, this.rand() * (this.white.duration - 0.2), dur + 0.02);
  }

  // ------------------------------------------------------------------ footsteps

  /**
   * Noise burst through a filter chain with exponential decay.
   * `filters`: [type, freq, Q]. `pitch` scales playback rate (and thus noise colour).
   */
  private burst(
    ctx: AudioContext,
    t: number,
    dur: number,
    filters: ReadonlyArray<readonly [BiquadFilterType, number, number]>,
    peak: number,
    dest: AudioNode,
    pitch: number,
    attack = 0.003,
  ): void {
    const s = ctx.createBufferSource();
    s.buffer = this.white;
    s.playbackRate.value = pitch;
    let node: AudioNode = s;
    for (const [type, freq, q] of filters) {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = freq;
      b.Q.value = q;
      node.connect(b);
      node = b;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g).connect(dest);
    s.start(t, this.rand() * (this.white.duration - dur - 0.1), dur + 0.05);
  }

  private thud(
    ctx: AudioContext,
    t: number,
    f0: number,
    f1: number,
    dur: number,
    peak: number,
    dest: AudioNode,
  ): void {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  footstep(surface: Surface, intensity: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.userSuspended) return;
    const r = this.rand;
    const i = clamp(Number.isFinite(intensity) ? intensity : 0.5, 0, 1);
    const t = ctx.currentTime + 0.005;
    const amp = 0.2 + 0.8 * i;
    const br = 0.8 + 0.5 * i; // brightness scale
    const pitch = 0.85 + r() * 0.3; // per-step variation
    const out = ctx.createStereoPanner();
    out.pan.value = (r() - 0.5) * 0.2;
    out.connect(this.buses.foot);
    const len = 0.85 + r() * 0.3;
    switch (surface) {
      case 'leaves': {
        const dur = (0.14 + 0.1 * i) * len;
        this.burst(
          ctx,
          t,
          dur,
          [
            ['highpass', 1400 * br, 0.7],
            ['bandpass', 4200 * pitch, 0.6],
          ],
          0.7 * amp,
          out,
          pitch,
          0.008,
        );
        const n = 4 + Math.floor(r() * 5);
        for (let k = 0; k < n; k++) {
          this.burst(
            ctx,
            t + 0.01 + r() * dur,
            0.012 + r() * 0.015,
            [
              ['highpass', 3000, 0.7],
              ['bandpass', 3500 + r() * 4000, 2],
            ],
            0.6 * amp * (0.3 + r() * 0.7),
            out,
            1,
          );
        }
        break;
      }
      case 'dirt':
        this.thud(ctx, t, 120 * pitch, 55, 0.09 * len, 0.9 * amp, out);
        this.burst(
          ctx,
          t,
          0.04 * len,
          [
            ['lowpass', 1800 * br, 0.7],
            ['highpass', 300, 0.7],
          ],
          0.35 * amp,
          out,
          pitch,
        );
        this.burst(ctx, t + 0.01, 0.05 * len, [['highpass', 4000, 0.7]], 0.08 * amp, out, pitch);
        break;
      case 'moss':
        this.thud(ctx, t, 85 * pitch, 45, 0.13 * len, 0.55 * amp, out);
        this.burst(ctx, t, 0.09 * len, [['lowpass', 420 * br, 0.7]], 0.3 * amp, out, pitch, 0.01);
        break;
      case 'rock':
        this.burst(
          ctx,
          t,
          0.03 * len,
          [['bandpass', 2600 * pitch * br, 3.5]],
          0.8 * amp,
          out,
          1.2,
          0.001,
        );
        this.thud(ctx, t, 900 * pitch, 450, 0.035 * len, 0.35 * amp, out);
        this.thud(ctx, t, 160, 90, 0.06, 0.4 * amp, out);
        break;
      case 'gravel': {
        const n = 8 + Math.floor(r() * 7);
        const span = 0.17 * len;
        for (let k = 0; k < n; k++) {
          const at = t + Math.pow(r(), 1.4) * span;
          this.burst(
            ctx,
            at,
            0.01 + r() * 0.02,
            [['bandpass', (1800 + r() * 4500) * br, 2.5]],
            0.5 * amp * (0.3 + r() * 0.7),
            out,
            1,
            0.001,
          );
        }
        this.thud(ctx, t, 110, 60, 0.07, 0.3 * amp, out);
        break;
      }
      case 'snow': {
        const dur = 0.16 * len;
        this.burst(
          ctx,
          t,
          dur,
          [
            ['bandpass', 2400 * pitch * br, 0.9],
            ['highpass', 900, 0.7],
          ],
          0.75 * amp,
          out,
          pitch,
          0.012,
        );
        const sq = ctx.createOscillator();
        sq.type = 'sine';
        const sf = 1900 + r() * 700;
        sq.frequency.setValueAtTime(sf, t);
        sq.frequency.linearRampToValueAtTime(sf * (1.1 + r() * 0.2), t + dur);
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.0001, t + 0.01);
        sg.gain.linearRampToValueAtTime(0.05 * amp, t + 0.04);
        sg.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        sq.connect(sg).connect(out);
        sq.start(t);
        sq.stop(t + dur + 0.02);
        break;
      }
      case 'wood': {
        this.thud(ctx, t, 230 * pitch, 150, 0.07 * len, 0.8 * amp, out);
        this.burst(ctx, t, 0.05, [['bandpass', 380 * pitch, 9]], 0.7 * amp, out, 1, 0.001);
        this.burst(ctx, t, 0.04, [['bandpass', 760 * pitch, 9]], 0.35 * amp, out, 1, 0.001);
        break;
      }
    }
  }
}
