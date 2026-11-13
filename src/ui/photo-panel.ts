import type { FilmLook, PhotoParams } from '../engine/types';
import { chips, slider, toggle, type Control } from './controls';
import { button, clear, el } from './dom';
import {
  APERTURE_STEPS,
  FILM_LOOK_LABELS,
  FOCUS_MAX,
  FOCUS_MIN,
  apertureFromIndex,
  apertureToIndex,
  focalFromSlider,
  focalToSlider,
  focusFromSlider,
  focusToSlider,
  formatAperture,
  formatDegrees,
  formatDistance,
  formatEv,
  formatFocal,
  formatSigned,
} from './format';
import type { UIHost } from './types';

type NumKey = {
  [K in keyof PhotoParams]: PhotoParams[K] extends number ? K : never;
}[keyof PhotoParams];
type BoolKey = {
  [K in keyof PhotoParams]: PhotoParams[K] extends boolean ? K : never;
}[keyof PhotoParams];

export class PhotoPanel {
  readonly root: HTMLElement;
  private controls: Control[] = [];
  private body = el('div', 'mp-photo-body');
  private head: HTMLButtonElement;
  private captureRow = el('div', 'mp-capture-row');

  constructor(private host: UIHost) {
    const a = host.actions;
    const params = (): PhotoParams => a.getPhotoParams();
    const set = (p: Partial<PhotoParams>): void => a.setPhotoParams(p);
    const add = (parent: HTMLElement, c: Control): void => {
      this.controls.push(c);
      parent.append(c.el);
    };
    const num = (parent: HTMLElement, label: string, key: NumKey, min: number, max: number, step: number, fmt: (v: number) => string): void =>
      add(parent, slider({ label, min, max, step, get: () => params()[key], set: (v) => set({ [key]: v }), format: fmt }));
    const flag = (parent: HTMLElement, label: string, key: BoolKey): void =>
      add(parent, toggle({ label, get: () => params()[key], set: (v) => set({ [key]: v }) }));
    const group = (title: string): HTMLElement => {
      const g = el('section', 'mp-group', {}, [el('h3', 'mp-h3', {}, [title])]);
      this.body.append(g);
      return g;
    };

    this.body.append(el('p', 'mp-hint-line', {}, ['WASD/QE fly · drag to look · click Pick focus then tap subject']));

    const lens = group('Lens');
    add(lens, slider({ label: 'Focal length', min: 0, max: 1, step: 0.001, get: () => params().focalLength, set: (v) => set({ focalLength: v }), format: formatFocal, toSlider: focalToSlider, fromSlider: focalFromSlider }));
    add(lens, slider({ label: 'Aperture', min: 0, max: APERTURE_STEPS, step: 1, get: () => params().aperture, set: (v) => set({ aperture: v }), format: formatAperture, toSlider: apertureToIndex, fromSlider: apertureFromIndex }));
    flag(lens, 'Depth of field', 'dof');
    add(lens, slider({ label: 'Focus distance', min: 0, max: 1, step: 0.001, get: () => clampFocus(params().focusDistance), set: (v) => set({ focusDistance: v }), format: formatDistance, toSlider: focusToSlider, fromSlider: focusFromSlider }));
    lens.append(el('div', 'mp-actions', {}, [button('Pick focus', '', () => a.armFocusPick())]));
    num(lens, 'Roll', 'roll', -45, 45, 0.5, formatDegrees);

    const light = group('Exposure and colour');
    num(light, 'Exposure', 'exposure', -3, 3, 0.1, formatEv);
    num(light, 'White balance', 'temperature', -1, 1, 0.01, formatSigned);
    num(light, 'Tint', 'tint', -1, 1, 0.01, formatSigned);
    num(light, 'Contrast', 'contrast', -1, 1, 0.01, formatSigned);
    num(light, 'Saturation', 'saturation', -1, 1, 0.01, formatSigned);
    add(
      light,
      chips({
        label: 'Film look',
        options: (Object.keys(FILM_LOOK_LABELS) as FilmLook[]).map((k) => ({ value: k, label: FILM_LOOK_LABELS[k] })),
        get: () => params().look,
        set: (v) => set({ look: v as FilmLook }),
      }),
    );

    const fx = group('Effects');
    const pct = (v: number): string => v.toFixed(2);
    num(fx, 'Vignette', 'vignette', 0, 1, 0.01, pct);
    num(fx, 'Grain', 'grain', 0, 1, 0.01, pct);
    num(fx, 'Bloom', 'bloom', 0, 3, 0.05, pct);
    num(fx, 'Chromatic aberration', 'chromaticAberration', 0, 1, 0.01, pct);
    flag(fx, 'Lens flare', 'lensFlare');

    const comp = group('Composition');
    flag(comp, 'Rule-of-thirds grid', 'grid');
    flag(comp, 'Horizon level', 'horizon');
    flag(comp, 'Metadata overlay', 'metadataOverlay');
    flag(comp, 'Pause motion', 'pauseMotion');

    const footer = el('footer', 'mp-photo-foot', {}, [
      button('Reset', '', () => {
        a.resetPhotoParams();
        this.sync();
      }),
      this.captureRow,
    ]);
    this.head = el('button', 'mp-photo-head', { type: 'button', 'aria-expanded': 'true', 'aria-controls': 'mp-photo-body' }, [
      el('span', 'mp-h2', {}, ['Photo mode']),
      el('span', 'mp-chevron', { 'aria-hidden': 'true' }),
    ]);
    this.body.id = 'mp-photo-body';
    this.head.addEventListener('click', () => this.setCollapsed(this.root.classList.toggle('is-collapsed') ? true : false));
    this.root = el('aside', 'mp-photo', { hidden: '', 'aria-label': 'Photo controls' }, [this.head, this.body, footer]);
    this.buildCaptureButtons();
  }

  private setCollapsed(c: boolean): void {
    this.root.classList.toggle('is-collapsed', c);
    this.head.setAttribute('aria-expanded', String(!c));
  }

  private buildCaptureButtons(): void {
    clear(this.captureRow);
    const max = this.host.maxCaptureScale();
    this.captureRow.append(el('span', 'mp-label', {}, ['Capture']));
    for (const s of [1, 2, 4] as const) {
      const b = button(`${s}x`, 'mp-btn-primary', () => this.host.actions.capture(s));
      b.disabled = s > max;
      b.setAttribute('aria-label', `Capture at ${s}x resolution`);
      if (s > max) b.title = 'Not supported on this device';
      this.captureRow.append(b);
    }
  }

  sync(): void {
    for (const c of this.controls) c.sync();
  }

  setActive(active: boolean): void {
    this.root.hidden = !active;
    if (active) {
      this.buildCaptureButtons();
      this.sync();
    }
  }
}

function clampFocus(m: number): number {
  return Math.min(FOCUS_MAX, Math.max(FOCUS_MIN, Number.isFinite(m) ? m : FOCUS_MAX));
}
