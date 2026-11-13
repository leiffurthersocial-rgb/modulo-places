// Pure helpers for the UI layer (no DOM access) so they can be unit-tested.
import type { Action, KeyBindings } from '../engine/types';

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Map t in 0..1 onto [min, max] logarithmically. */
export function logMap(t: number, min: number, max: number): number {
  return min * Math.pow(max / min, clamp(t, 0, 1));
}

/** Inverse of logMap. */
export function logUnmap(v: number, min: number, max: number): number {
  return clamp(Math.log(clamp(v, min, max) / min) / Math.log(max / min), 0, 1);
}

export const FOCAL_MIN = 14;
export const FOCAL_MAX = 200;
export const FOCUS_MIN = 0.3;
export const FOCUS_MAX = 100;

export function focalFromSlider(t: number): number {
  return clamp(Math.round(logMap(t, FOCAL_MIN, FOCAL_MAX)), FOCAL_MIN, FOCAL_MAX);
}
export function focalToSlider(mm: number): number {
  return logUnmap(mm, FOCAL_MIN, FOCAL_MAX);
}
export function formatFocal(mm: number): string {
  return `${Math.round(mm)} mm`;
}

export function focusFromSlider(t: number): number {
  return Math.round(logMap(t, FOCUS_MIN, FOCUS_MAX) * 100) / 100;
}
export function focusToSlider(m: number): number {
  return logUnmap(m, FOCUS_MIN, FOCUS_MAX);
}
export function formatDistance(m: number): string {
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

/** Aperture slider works in 1/3-stop indices from f/1.4 (0) to f/22 (12). */
export const APERTURE_MIN = 1.4;
export const APERTURE_MAX = 22;
export const APERTURE_STEPS = 12;

export function apertureFromIndex(i: number): number {
  const c = clamp(Math.round(i), 0, APERTURE_STEPS);
  return Math.min(APERTURE_MAX, Math.round(APERTURE_MIN * Math.pow(2, c / 3) * 10) / 10);
}
export function apertureToIndex(f: number): number {
  const i = Math.round(3 * Math.log2(clamp(f, APERTURE_MIN, APERTURE_MAX) / APERTURE_MIN));
  return clamp(i, 0, APERTURE_STEPS);
}
export function formatAperture(f: number): string {
  return `f/${f < 10 ? f.toFixed(1) : String(Math.round(f))}`;
}

export function formatEv(v: number): string {
  const r = Math.round(v * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '-' : ''}${Math.abs(r).toFixed(1)} EV`;
}
export function formatSigned(v: number, digits = 2): string {
  const r = Number(v.toFixed(digits));
  return `${r > 0 ? '+' : ''}${r.toFixed(digits)}`;
}
export function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}
export function formatDegrees(v: number): string {
  return `${v.toFixed(1)}°`;
}

export const FILM_LOOK_LABELS = {
  neutral: 'Neutral',
  filmic: 'Filmic',
  moody: 'Moody',
  vintage: 'Vintage',
  bw: 'High-contrast B&W',
  pastel: 'Soft pastel',
} as const;

export const ACTION_ORDER: Action[] = [
  'forward',
  'back',
  'left',
  'right',
  'sprint',
  'slow',
  'crouch',
  'up',
  'down',
  'photoMode',
  'capture',
  'cycleMood',
  'debug',
  'hideUI',
  'menu',
];

export const ACTION_LABELS: Record<Action, string> = {
  forward: 'Move forward',
  back: 'Move back',
  left: 'Strafe left',
  right: 'Strafe right',
  sprint: 'Sprint',
  slow: 'Walk slowly',
  crouch: 'Crouch',
  up: 'Up / jump',
  down: 'Down',
  photoMode: 'Photo mode',
  capture: 'Take photo',
  cycleMood: 'Next lighting mood',
  debug: 'Performance overlay',
  hideUI: 'Hide interface',
  menu: 'Menu',
};

/** Human label for a KeyboardEvent.code value. */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return `Num ${code.slice(6)}`;
  const named: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    Escape: 'Esc',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    MetaLeft: 'Left Cmd',
    MetaRight: 'Right Cmd',
  };
  return named[code] ?? code;
}

/** Other actions that already use `code`. */
export function findBindingConflicts(bindings: KeyBindings, action: Action, code: string): Action[] {
  return ACTION_ORDER.filter((a) => a !== action && (bindings[a] ?? []).includes(code));
}

/** For a row: every other action sharing any of this action's keys. */
export function conflictsForAction(bindings: KeyBindings, action: Action): Action[] {
  const out = new Set<Action>();
  for (const code of bindings[action] ?? []) for (const a of findBindingConflicts(bindings, action, code)) out.add(a);
  return [...out];
}

/** Deterministic tasteful gradient for scene cards without a preview image. */
export function placeholderGradient(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const hue = Math.abs(h) % 360;
  const hue2 = (hue + 40) % 360;
  return (
    `radial-gradient(circle at 70% 25%, hsl(${hue2} 55% 62% / 0.55), transparent 45%), ` +
    `linear-gradient(160deg, hsl(${hue} 28% 26%), hsl(${hue2} 32% 11%))`
  );
}
