// Small reusable form controls. Each returns an element plus sync() which re-reads the live value
// (so panels can reflect external changes without being rebuilt mid-drag).
import { el } from './dom';

export interface Control {
  el: HTMLElement;
  sync(): void;
}

let uid = 0;
const nextId = (): string => `mp-c-${++uid}`;

export interface SliderOpts {
  label: string;
  /** Slider-space range (differs from value space when toSlider/fromSlider are given). */
  min: number;
  max: number;
  step: number;
  get(): number;
  set(v: number): void;
  format(v: number): string;
  toSlider?(v: number): number;
  fromSlider?(t: number): number;
  disabled?(): boolean;
}

export function slider(o: SliderOpts): Control {
  const id = nextId();
  const input = el('input', 'mp-range', {
    type: 'range',
    id,
    min: String(o.min),
    max: String(o.max),
    step: String(o.step),
  });
  const out = el('output', 'mp-value', { for: id });
  const row = el('div', 'mp-row mp-row-slider', {}, [el('label', 'mp-label', { for: id }, [o.label]), out, input]);
  const toS = o.toSlider ?? ((v: number) => v);
  const fromS = o.fromSlider ?? ((v: number) => v);
  input.addEventListener('input', () => {
    const v = fromS(Number(input.value));
    out.textContent = o.format(v);
    o.set(v);
  });
  const sync = (): void => {
    const v = o.get();
    if (document.activeElement !== input) input.value = String(toS(v));
    out.textContent = o.format(v);
    input.disabled = o.disabled?.() ?? false;
    row.classList.toggle('is-disabled', input.disabled);
  };
  sync();
  return { el: row, sync };
}

export interface ToggleOpts {
  label: string;
  get(): boolean;
  set(v: boolean): void;
  disabled?(): boolean;
}

export function toggle(o: ToggleOpts): Control {
  const id = nextId();
  const input = el('input', 'mp-switch', { type: 'checkbox', role: 'switch', id });
  const row = el('div', 'mp-row mp-row-toggle', {}, [el('label', 'mp-label', { for: id }, [o.label]), input]);
  input.addEventListener('change', () => o.set(input.checked));
  const sync = (): void => {
    input.checked = o.get();
    input.disabled = o.disabled?.() ?? false;
    row.classList.toggle('is-disabled', input.disabled);
  };
  sync();
  return { el: row, sync };
}

export interface SelectOpts {
  label: string;
  options: { value: string; label: string }[];
  get(): string;
  set(v: string): void;
  disabled?(): boolean;
}

export function select(o: SelectOpts): Control {
  const id = nextId();
  const input = el('select', 'mp-select', { id });
  for (const opt of o.options) input.append(el('option', '', { value: opt.value }, [opt.label]));
  const row = el('div', 'mp-row mp-row-select', {}, [el('label', 'mp-label', { for: id }, [o.label]), input]);
  input.addEventListener('change', () => o.set(input.value));
  const sync = (): void => {
    input.value = o.get();
    input.disabled = o.disabled?.() ?? false;
    row.classList.toggle('is-disabled', input.disabled);
  };
  sync();
  return { el: row, sync };
}

export interface ChipsOpts {
  label: string;
  options: { value: string; label: string }[];
  get(): string;
  set(v: string): void;
}

export function chips(o: ChipsOpts): Control {
  const group = el('div', 'mp-chips', { role: 'group', 'aria-label': o.label });
  const buttons = o.options.map((opt) => {
    const b = el('button', 'mp-chip', { type: 'button', 'aria-pressed': 'false' }, [opt.label]);
    b.addEventListener('click', () => o.set(opt.value));
    group.append(b);
    return { b, value: opt.value };
  });
  const row = el('div', 'mp-row mp-row-chips', {}, [el('span', 'mp-label', {}, [o.label]), group]);
  const sync = (): void => {
    const cur = o.get();
    for (const { b, value } of buttons) b.setAttribute('aria-pressed', String(value === cur));
  };
  sync();
  return { el: row, sync };
}
