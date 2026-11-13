import { QUALITY_PRESETS } from '../../data/quality-presets';
import type { KeyBindings, QualitySettings, UserSettings } from '../types';
import type { EventBus } from './events';

const KEY = 'modulo-places:settings:v1';

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  slow: ['AltLeft', 'AltRight'],
  crouch: ['KeyC', 'ControlLeft'],
  up: ['KeyE', 'Space'],
  down: ['KeyQ'],
  photoMode: ['KeyP'],
  capture: ['Enter'],
  cycleMood: ['KeyM'],
  debug: ['F3', 'Backquote'],
  hideUI: ['KeyH', 'F1'],
  menu: ['Escape', 'Tab'],
};

export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
}

/** iPad Safari reports itself as Macintosh; touch points disambiguate. */
export function isLikelyIPad(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function defaultSettings(): UserSettings {
  const tablet = isLikelyIPad() || isTouchDevice();
  return {
    version: 1,
    preset: tablet ? 'medium' : 'high',
    custom: structuredClone(QUALITY_PRESETS.high),
    fov: 65,
    lookSensitivity: 1,
    invertY: false,
    headBob: true,
    reduceMotion: false,
    uiScale: 1,
    touchControls: 'auto',
    watchdog: false,
    bindings: structuredClone(DEFAULT_BINDINGS),
    masterVolume: 0.8,
    seenTutorial: false,
  };
}

export function resolveQuality(s: UserSettings): QualitySettings {
  return s.preset === 'custom' ? s.custom : QUALITY_PRESETS[s.preset];
}

export class SettingsStore {
  private value: UserSettings;

  constructor(private events: EventBus) {
    this.value = SettingsStore.load();
  }

  static load(): UserSettings {
    const d = defaultSettings();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return d;
      const parsed = JSON.parse(raw) as Partial<UserSettings>;
      if (parsed.version !== 1) return d;
      return { ...d, ...parsed, bindings: { ...d.bindings, ...(parsed.bindings ?? {}) } };
    } catch {
      return d;
    }
  }

  get(): Readonly<UserSettings> {
    return this.value;
  }

  update(patch: Partial<UserSettings>): void {
    this.value = { ...this.value, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(this.value));
    } catch {
      /* storage unavailable (private mode) — settings stay in memory */
    }
    this.events.emit('settings:changed', this.value);
  }

  reset(): void {
    this.update(defaultSettings());
  }
}
