import { DEFAULT_BINDINGS, resolveQuality } from '../engine/core/settings';
import type { Action, PresetId, QualitySettings, UserSettings } from '../engine/types';
import { PRESET_LABELS, PRESET_ORDER } from '../data/quality-presets';
import { select, slider, toggle, type Control } from './controls';
import { button, clear, el } from './dom';
import {
  ACTION_LABELS,
  ACTION_ORDER,
  conflictsForAction,
  formatDegrees,
  formatPercent,
  keyLabel,
} from './format';
import type { UIHost } from './types';

const TIERS = [512, 1024, 2048, 4096] as const;
const TABS = ['Graphics', 'Controls', 'Accessibility', 'Audio', 'Debug'] as const;
type Tab = (typeof TABS)[number];

export class SettingsPanel {
  readonly root: HTMLElement;
  private controls: Control[] = [];
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private tabPanels = new Map<Tab, HTMLElement>();
  private keyHost = el('div', 'mp-keys');
  private capturing: { action: Action; onKey: (e: KeyboardEvent) => void } | null = null;
  private refocus: Action | null = null;
  private seedStatus = el('p', 'mp-note');
  private seedInput = el('input', 'mp-input', {
    type: 'number',
    step: '1',
    placeholder: 'Scene default',
    'aria-label': 'Seed',
  });
  private opener: Element | null = null;

  constructor(
    private host: UIHost,
    private onClose: () => void,
  ) {
    const body = el('div', 'mp-tabbody');
    const tablist = el('div', 'mp-tabs', { role: 'tablist', 'aria-label': 'Settings sections' });
    for (const t of TABS) {
      const b = el('button', 'mp-tab', { type: 'button', role: 'tab', 'aria-selected': 'false' }, [
        t,
      ]);
      b.addEventListener('click', () => this.selectTab(t));
      tablist.append(b);
      this.tabButtons.set(t, b);
      const p = el('div', 'mp-tabpanel', { role: 'tabpanel', hidden: '' });
      this.tabPanels.set(t, p);
      body.append(p);
    }
    this.buildGraphics(this.panel('Graphics'));
    this.buildControls(this.panel('Controls'));
    this.buildAccessibility(this.panel('Accessibility'));
    this.buildAudio(this.panel('Audio'));
    this.buildDebug(this.panel('Debug'));

    const close = button('Close', 'mp-btn-primary', () => this.close());
    const dialog = el(
      'div',
      'mp-dialog mp-settings-dialog',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings', tabindex: '-1' },
      [
        el('header', 'mp-dialog-head', {}, [el('h2', 'mp-h2', {}, ['Settings']), close]),
        tablist,
        body,
      ],
    );
    this.root = el('div', 'mp-screen mp-modal', { hidden: '' }, [dialog]);
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.capturing) {
        e.stopPropagation();
        this.close();
      }
    });
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
    this.selectTab('Graphics');
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.opener = document.activeElement;
    this.root.hidden = false;
    this.sync();
    this.root.querySelector<HTMLElement>('.mp-dialog')?.focus();
  }

  close(): void {
    if (this.root.hidden) return;
    this.stopCapture();
    this.root.hidden = true;
    if (this.opener instanceof HTMLElement) this.opener.focus();
    this.opener = null;
    this.onClose();
  }

  sync(): void {
    for (const c of this.controls) c.sync();
  }

  dispose(): void {
    this.stopCapture();
    this.root.remove();
  }

  // -------------------------------------------------------------------------------------------

  private panel(t: Tab): HTMLElement {
    const p = this.tabPanels.get(t);
    if (!p) throw new Error(`no panel ${t}`);
    return p;
  }

  private selectTab(t: Tab): void {
    for (const [name, b] of this.tabButtons) {
      b.setAttribute('aria-selected', String(name === t));
      b.tabIndex = name === t ? 0 : -1;
      const p = this.tabPanels.get(name);
      if (p) p.hidden = name !== t;
    }
  }

  private add(parent: HTMLElement, c: Control): void {
    this.controls.push(c);
    parent.append(c.el);
  }

  private get s(): Readonly<UserSettings> {
    return this.host.settings.get();
  }

  private patch(p: Partial<UserSettings>): void {
    this.host.settings.update(p);
  }

  // -------------------------------------------------------------------------------------------
  // Graphics

  private buildGraphics(p: HTMLElement): void {
    const isCustom = (): boolean => this.s.preset === 'custom';
    const q = (): QualitySettings => resolveQuality(this.s);
    const setQ = (fn: (c: QualitySettings) => QualitySettings): void => {
      if (!isCustom()) return;
      this.patch({ custom: fn(structuredClone(this.s.custom)) });
    };
    const ro = (): boolean => !isCustom();

    p.append(el('h3', 'mp-h3', {}, ['Quality']));
    this.add(
      p,
      select({
        label: 'Preset',
        options: [...PRESET_ORDER, 'custom' as const].map((id) => ({
          value: id,
          label: PRESET_LABELS[id],
        })),
        get: () => this.s.preset,
        set: (v) => {
          const id = v as PresetId;
          if (id === 'custom')
            this.patch({ preset: 'custom', custom: structuredClone(resolveQuality(this.s)) });
          else this.patch({ preset: id });
        },
      }),
    );
    p.append(
      el('p', 'mp-note', {}, [
        'Presets are read-only. Choose Custom to start from the current preset and edit every value.',
      ]),
    );
    this.add(
      p,
      toggle({
        label: 'Auto-lower quality if frame rate drops',
        get: () => this.s.watchdog,
        set: (v) => this.patch({ watchdog: v }),
      }),
    );

    p.append(el('h3', 'mp-h3', {}, ['Rendering']));
    const num = (
      label: string,
      min: number,
      max: number,
      step: number,
      get: () => number,
      set: (c: QualitySettings, v: number) => void,
      fmt: (v: number) => string,
    ): void =>
      this.add(
        p,
        slider({
          label,
          min,
          max,
          step,
          get,
          set: (v) => setQ((c) => (set(c, v), c)),
          format: fmt,
          disabled: ro,
        }),
      );
    const opts = <T extends string | number>(
      label: string,
      values: { value: T; label: string }[],
      get: () => T,
      set: (c: QualitySettings, v: T) => void,
    ): void =>
      this.add(
        p,
        select({
          label,
          options: values.map((o) => ({ value: String(o.value), label: o.label })),
          get: () => String(get()),
          set: (v) => {
            const found = values.find((o) => String(o.value) === v);
            if (found) setQ((c) => (set(c, found.value), c));
          },
          disabled: ro,
        }),
      );
    const flag = (
      label: string,
      get: () => boolean,
      set: (c: QualitySettings, v: boolean) => void,
    ): void =>
      this.add(p, toggle({ label, get, set: (v) => setQ((c) => (set(c, v), c)), disabled: ro }));
    const x = (v: number): string => `${v.toFixed(2)}x`;
    const level = <T extends string>(...ids: T[]): { value: T; label: string }[] =>
      ids.map((id) => ({ value: id, label: id[0]?.toUpperCase() + id.slice(1) }));

    num(
      'Render scale',
      0.4,
      2,
      0.05,
      () => q().renderScale,
      (c, v) => (c.renderScale = v),
      x,
    );
    num(
      'Max pixel ratio',
      0.5,
      3,
      0.25,
      () => q().maxDpr,
      (c, v) => (c.maxDpr = v),
      x,
    );
    opts(
      'Frame rate cap',
      [
        { value: 30, label: '30 fps' },
        { value: 60, label: '60 fps' },
      ],
      () => q().fpsCap,
      (c, v) => (c.fpsCap = v),
    );
    opts(
      'Anti-aliasing',
      [
        { value: 'none', label: 'None' },
        { value: 'fxaa', label: 'FXAA' },
        { value: 'smaa', label: 'SMAA' },
        { value: 'msaa', label: 'MSAA' },
        { value: 'msaa+smaa', label: 'MSAA + SMAA' },
      ],
      () => q().aa,
      (c, v) => (c.aa = v),
    );
    opts(
      'Texture quality',
      TIERS.map((v) => ({ value: v, label: `${v}px` })),
      () => q().textureTier,
      (c, v) => (c.textureTier = v),
    );
    opts(
      'Anisotropic filtering',
      [1, 2, 4, 8, 16].map((v) => ({ value: v, label: `${v}x` })),
      () => q().anisotropy,
      (c, v) => (c.anisotropy = v),
    );

    p.append(el('h3', 'mp-h3', {}, ['Light and shadow']));
    flag(
      'Shadows',
      () => q().shadows.enabled,
      (c, v) => {
        c.shadows.enabled = v;
        if (v && c.shadows.distance <= 0) c.shadows.distance = 25;
      },
    );
    opts(
      'Shadow map size',
      TIERS.map((v) => ({ value: v, label: `${v}` })),
      () => q().shadows.mapSize,
      (c, v) => (c.shadows.mapSize = v),
    );
    num(
      'Shadow distance',
      0,
      500,
      5,
      () => q().shadows.distance,
      (c, v) => (c.shadows.distance = c.shadows.enabled ? Math.max(5, v) : v),
      (v) => `${Math.round(v)} m`,
    );
    opts(
      'Ambient occlusion',
      level('off', 'performance', 'medium', 'high'),
      () => q().ao,
      (c, v) => (c.ao = v),
    );
    flag(
      'Half-resolution AO',
      () => q().aoHalfRes,
      (c, v) => (c.aoHalfRes = v),
    );
    opts(
      'Light shafts',
      level('off', 'cards', 'radial'),
      () => q().lightShafts,
      (c, v) => (c.lightShafts = v),
    );

    p.append(el('h3', 'mp-h3', {}, ['Effects']));
    flag(
      'Bloom',
      () => q().bloom,
      (c, v) => (c.bloom = v),
    );
    flag(
      'Colour grading',
      () => q().grade,
      (c, v) => (c.grade = v),
    );
    flag(
      'Lens effects (vignette, grain, aberration)',
      () => q().lensFx,
      (c, v) => (c.lensFx = v),
    );
    flag(
      'Live depth of field',
      () => q().liveDof,
      (c, v) => (c.liveDof = v),
    );
    opts(
      'Water',
      level('simple', 'reflect', 'refract'),
      () => q().water,
      (c, v) => (c.water = v),
    );
    num(
      'Particles',
      0,
      1,
      0.05,
      () => q().particles,
      (c, v) => (c.particles = v),
      formatPercent,
    );

    p.append(el('h3', 'mp-h3', {}, ['World']));
    num(
      'Vegetation density',
      0,
      1,
      0.05,
      () => q().vegetationDensity,
      (c, v) => (c.vegetationDensity = v),
      formatPercent,
    );
    num(
      'Draw distance',
      20,
      1000,
      10,
      () => q().drawDistance,
      (c, v) => (c.drawDistance = v),
      (v) => `${Math.round(v)} m`,
    );
    num(
      'LOD bias',
      0.25,
      4,
      0.05,
      () => q().lodBias,
      (c, v) => (c.lodBias = v),
      x,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Controls

  private buildControls(p: HTMLElement): void {
    this.add(
      p,
      slider({
        label: 'Field of view',
        min: 50,
        max: 90,
        step: 1,
        get: () => this.s.fov,
        set: (v) => this.patch({ fov: v }),
        format: formatDegrees,
      }),
    );
    this.add(
      p,
      slider({
        label: 'Look sensitivity',
        min: 0.2,
        max: 3,
        step: 0.05,
        get: () => this.s.lookSensitivity,
        set: (v) => this.patch({ lookSensitivity: v }),
        format: (v) => `${v.toFixed(2)}x`,
      }),
    );
    this.add(
      p,
      toggle({
        label: 'Invert vertical look',
        get: () => this.s.invertY,
        set: (v) => this.patch({ invertY: v }),
      }),
    );
    this.add(
      p,
      toggle({
        label: 'Head bob',
        get: () => this.s.headBob,
        set: (v) => this.patch({ headBob: v }),
      }),
    );
    this.add(
      p,
      select({
        label: 'Touch controls',
        options: [
          { value: 'auto', label: 'Auto' },
          { value: 'on', label: 'Always on' },
          { value: 'off', label: 'Off' },
        ],
        get: () => this.s.touchControls,
        set: (v) => this.patch({ touchControls: v as UserSettings['touchControls'] }),
      }),
    );

    p.append(el('h3', 'mp-h3', {}, ['Key bindings']));
    p.append(
      el('p', 'mp-note', {}, [
        'Choose Change, then press a key. Escape cancels. A new key replaces the existing ones for that action.',
      ]),
    );
    p.append(this.keyHost);
    p.append(
      el('div', 'mp-actions', {}, [
        button('Reset bindings', '', () =>
          this.patch({ bindings: structuredClone(DEFAULT_BINDINGS) }),
        ),
      ]),
    );
    this.controls.push({ el: this.keyHost, sync: () => this.renderKeys() });
    this.renderKeys();
  }

  private renderKeys(): void {
    clear(this.keyHost);
    const b = this.s.bindings;
    let toFocus: HTMLElement | null = null;
    for (const action of ACTION_ORDER) {
      const conflicts = conflictsForAction(b, action);
      const active = this.capturing?.action === action;
      const keys = el(
        'span',
        'mp-keycaps',
        {},
        (b[action] ?? []).map((c) => el('kbd', 'mp-kbd', {}, [keyLabel(c)])),
      );
      if (!(b[action] ?? []).length) keys.append(el('span', 'mp-dim', {}, ['Unbound']));
      const change = el(
        'button',
        'mp-btn mp-btn-small',
        { type: 'button', 'aria-label': `Change key for ${ACTION_LABELS[action]}` },
        [active ? 'Press a key…' : 'Change'],
      );
      change.addEventListener('click', () =>
        active ? this.stopCapture() : this.startCapture(action),
      );
      if (this.refocus === action) toFocus = change;
      const row = el(
        'div',
        `mp-keyrow${conflicts.length ? ' has-conflict' : ''}${active ? ' is-capturing' : ''}`,
        {},
        [el('span', 'mp-keyname', {}, [ACTION_LABELS[action]]), keys, change],
      );
      if (conflicts.length)
        row.append(
          el('span', 'mp-conflict', { role: 'status' }, [
            `Also used by ${conflicts.map((a) => ACTION_LABELS[a]).join(', ')}`,
          ]),
        );
      this.keyHost.append(row);
    }
    if (toFocus) {
      toFocus.focus();
      this.refocus = null;
    }
  }

  private startCapture(action: Action): void {
    this.stopCapture(false);
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      this.refocus = action;
      if (e.code !== 'Escape') {
        this.patch({ bindings: { ...this.s.bindings, [action]: [e.code] } });
      }
      this.stopCapture();
    };
    window.addEventListener('keydown', onKey, true);
    this.capturing = { action, onKey };
    this.renderKeys();
  }

  private stopCapture(render = true): void {
    if (!this.capturing) return;
    window.removeEventListener('keydown', this.capturing.onKey, true);
    this.capturing = null;
    if (render) this.renderKeys();
  }

  // -------------------------------------------------------------------------------------------

  private buildAccessibility(p: HTMLElement): void {
    this.add(
      p,
      toggle({
        label: 'Reduce motion',
        get: () => this.s.reduceMotion,
        set: (v) => this.patch({ reduceMotion: v }),
      }),
    );
    p.append(
      el('p', 'mp-note', {}, ['Disables interface animation and view effects such as head bob.']),
    );
    this.add(
      p,
      slider({
        label: 'Interface size',
        min: 0.8,
        max: 1.5,
        step: 0.05,
        get: () => this.s.uiScale,
        set: (v) => this.patch({ uiScale: v }),
        format: formatPercent,
      }),
    );
  }

  private buildAudio(p: HTMLElement): void {
    this.add(
      p,
      slider({
        label: 'Master volume',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => this.s.masterVolume,
        set: (v) => this.patch({ masterVolume: v }),
        format: formatPercent,
      }),
    );
  }

  private buildDebug(p: HTMLElement): void {
    p.append(el('p', 'mp-note', {}, ['F3 toggles the performance overlay.']));
    p.append(el('h3', 'mp-h3', {}, ['Seed override']));
    p.append(
      el('p', 'mp-note', {}, [
        'Regenerates scatter and terrain details from a different seed. Leave empty for the scene default.',
      ]),
    );
    const apply = button('Apply', 'mp-btn-primary', () => {
      const n = Number(this.seedInput.value);
      if (this.seedInput.value.trim() === '' || !Number.isFinite(n)) {
        this.seedStatus.textContent = 'Enter a whole number.';
        return;
      }
      const seed = Math.trunc(n);
      this.host.actions.setSeed(seed);
      this.seedStatus.textContent = `Seed ${seed} applied.`;
    });
    const reset = button('Reset', '', () => {
      this.seedInput.value = '';
      this.host.actions.setSeed(null);
      this.seedStatus.textContent = 'Using the scene default seed.';
    });
    p.append(el('div', 'mp-seedrow', {}, [this.seedInput, apply, reset]), this.seedStatus);
  }
}
