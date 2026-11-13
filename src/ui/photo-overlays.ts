import type { PhotoParams } from '../engine/types';
import { el } from './dom';
import { formatAperture, formatFocal } from './format';

/** Non-interactive overlays drawn over the canvas in photo mode. */
export class PhotoOverlays {
  readonly root: HTMLElement;
  private grid = el('div', 'mp-grid', { 'aria-hidden': 'true' });
  private level = el('div', 'mp-level', { 'aria-hidden': 'true' }, [el('div', 'mp-level-line'), el('div', 'mp-level-tick')]);
  private meta = el('div', 'mp-meta');
  private scene = '';
  private mood = '';
  private params: PhotoParams | null = null;

  constructor() {
    this.root = el('div', 'mp-overlays', { hidden: '' }, [this.grid, this.level, this.meta]);
  }

  setContext(scene?: string, mood?: string): void {
    if (scene !== undefined) this.scene = scene;
    if (mood !== undefined) this.mood = mood;
    this.render();
  }

  update(p: PhotoParams): void {
    this.params = p;
    this.render();
  }

  setActive(active: boolean): void {
    this.root.hidden = !active;
  }

  private render(): void {
    const p = this.params;
    if (!p) return;
    this.grid.hidden = !p.grid;
    this.level.hidden = !p.horizon;
    this.level.style.setProperty('--mp-roll', `${p.roll}deg`);
    this.level.classList.toggle('is-level', Math.abs(p.roll) < 0.5);
    this.meta.hidden = !p.metadataOverlay;
    this.meta.textContent = [this.scene, this.mood, formatFocal(p.focalLength), formatAperture(p.aperture)].filter(Boolean).join('  ·  ');
  }
}
