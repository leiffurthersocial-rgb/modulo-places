import { clear, el } from './dom';
import { clamp, placeholderGradient } from './format';

export class LoadingScreen {
  readonly root: HTMLElement;
  private bg = el('div', 'mp-loading-bg');
  private name = el('h2', 'mp-loading-name');
  private label = el('p', 'mp-loading-label', { 'aria-live': 'polite' });
  private fill = el('div', 'mp-progress-fill');
  private bar = el(
    'div',
    'mp-progress',
    {
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '0',
      'aria-label': 'Loading',
    },
    [this.fill],
  );

  constructor() {
    this.root = el('div', 'mp-screen mp-loading', { hidden: '', 'aria-busy': 'true' }, [
      this.bg,
      el('div', 'mp-loading-inner', {}, [this.name, this.bar, this.label]),
    ]);
  }

  show(sceneName: string, still?: string): void {
    clear(this.bg);
    this.bg.style.background = placeholderGradient(sceneName);
    if (still) {
      const img = el('img', '', { src: still, alt: '' });
      img.addEventListener('error', () => img.remove());
      this.bg.append(img);
    }
    this.name.textContent = sceneName;
    this.setProgress(0, 'Preparing…');
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  setProgress(progress: number, label: string): void {
    const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
    this.fill.style.transform = `scaleX(${p})`;
    this.bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    this.label.textContent = label;
  }
}
