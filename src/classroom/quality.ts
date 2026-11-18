// Quality presets incl. Battery Saver, persisted settings, frame-time watchdog.
export type PresetId = 'ultra' | 'high' | 'medium' | 'low' | 'battery' | 'custom';

export interface QualitySettings {
  pixelRatio: number;
  fpsCap: 30 | 60;
  shadows: boolean;
  shadowSize: number;
  glowLights: number;
  labels: boolean;
  /** NPC visual update rate divider (1 = every frame). */
  npcAnimEvery: number;
  audioVoices: number;
}

export const PRESETS: Record<Exclude<PresetId, 'custom'>, QualitySettings> = {
  ultra: {
    pixelRatio: 2,
    fpsCap: 60,
    shadows: true,
    shadowSize: 2048,
    glowLights: 2,
    labels: true,
    npcAnimEvery: 1,
    audioVoices: 32,
  },
  high: {
    pixelRatio: 1.5,
    fpsCap: 60,
    shadows: true,
    shadowSize: 2048,
    glowLights: 2,
    labels: true,
    npcAnimEvery: 1,
    audioVoices: 32,
  },
  medium: {
    pixelRatio: 1.25,
    fpsCap: 60,
    shadows: true,
    shadowSize: 1024,
    glowLights: 1,
    labels: true,
    npcAnimEvery: 1,
    audioVoices: 24,
  },
  low: {
    pixelRatio: 1,
    fpsCap: 30,
    shadows: true,
    shadowSize: 512,
    glowLights: 1,
    labels: true,
    npcAnimEvery: 2,
    audioVoices: 16,
  },
  battery: {
    pixelRatio: 0.85,
    fpsCap: 30,
    shadows: false,
    shadowSize: 512,
    glowLights: 0,
    labels: true,
    npcAnimEvery: 2,
    audioVoices: 12,
  },
};

export interface Settings {
  version: 1;
  preset: PresetId;
  custom: QualitySettings;
  fov: number;
  sensitivity: number;
  invertY: boolean;
  subtitles: boolean;
  reducedMotion: boolean;
  uiScale: number;
  touchControls: 'auto' | 'on' | 'off';
  watchdog: boolean;
  volume: number;
  bindings: Record<string, string>;
  playerName: string;
}

export const DEFAULT_BINDINGS: Record<string, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  crouch: 'KeyC',
  sit: 'Space',
  interact: 'KeyE',
  nextVerb: 'KeyX',
  phone: 'Digit1',
  laptop: 'Digit2',
  switch: 'KeyQ',
  content: 'KeyV',
  earbud: 'KeyB',
  leanLeft: 'KeyZ',
  leanRight: 'KeyF',
  throw: 'KeyT',
  paper: 'KeyG',
  note: 'KeyN',
  raiseHand: 'KeyR',
  cheat: 'KeyK',
  notebook: 'KeyM',
};

const KEY = 'modulo-classroom:settings:v1';

export function isTouchDevice(): boolean {
  return (
    typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)
  );
}

export function isLikelyIPad(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export function defaultSettings(): Settings {
  const tablet = isLikelyIPad() || isTouchDevice();
  return {
    version: 1,
    preset: tablet ? 'medium' : 'high',
    custom: { ...PRESETS.high },
    fov: 72,
    sensitivity: 1,
    invertY: false,
    subtitles: true,
    reducedMotion: false,
    uiScale: 1,
    touchControls: 'auto',
    watchdog: false,
    volume: 0.8,
    bindings: { ...DEFAULT_BINDINGS },
    playerName: 'Alex',
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      ...d,
      ...s,
      bindings: { ...d.bindings, ...(s.bindings ?? {}) },
      custom: { ...d.custom, ...(s.custom ?? {}) },
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode etc. */
  }
}

export function resolveQuality(s: Settings): QualitySettings {
  return s.preset === 'custom' ? s.custom : PRESETS[s.preset];
}

export const PRESET_ORDER: PresetId[] = ['ultra', 'high', 'medium', 'low', 'battery'];

/** Rolling frame-time stats; suggests stepping down when p90 stays over budget. */
export class FrameWatch {
  private samples: number[] = [];
  private overSince = -1;

  push(ms: number, now: number, budgetMs: number): 'ok' | 'slow' {
    this.samples.push(ms);
    if (this.samples.length > 120) this.samples.shift();
    if (this.samples.length < 60) return 'ok';
    const p90 = [...this.samples].sort((a, b) => a - b)[Math.floor(this.samples.length * 0.9)]!;
    if (p90 > budgetMs * 1.35) {
      if (this.overSince < 0) this.overSince = now;
      if (now - this.overSince > 5000) {
        this.overSince = -1;
        this.samples = [];
        return 'slow';
      }
    } else this.overSince = -1;
    return 'ok';
  }

  avg(): number {
    return this.samples.length ? this.samples.reduce((a, b) => a + b, 0) / this.samples.length : 0;
  }
}
