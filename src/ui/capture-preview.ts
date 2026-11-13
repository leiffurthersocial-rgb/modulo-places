import type { EngineEvents } from '../engine/core/events';
import { button, el } from './dom';

const DISMISS_MS = 8000;

export class CapturePreview {
  readonly root: HTMLElement;
  private url: string | null = null;
  private timer = 0;

  constructor() {
    this.root = el('div', 'mp-capture', { hidden: '', role: 'status' });
  }

  show(c: EngineEvents['photo:captured']): void {
    this.dismiss();
    const url = URL.createObjectURL(c.blob);
    this.url = url;

    const img = el('img', 'mp-capture-img', { src: url, alt: 'Captured photo preview' });
    const dl = el('a', 'mp-btn mp-btn-primary', { href: url, download: c.filename }, ['Download']);
    const actions = el('div', 'mp-capture-actions', {}, [dl]);

    const file = new File([c.blob], c.filename, { type: c.blob.type || 'image/png' });
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      actions.append(
        button('Share', '', () => {
          window.clearTimeout(this.timer);
          navigator.share({ files: [file], title: c.filename }).catch(() => undefined);
        }),
      );
    }
    const close = button('Close', 'mp-btn-small', () => this.dismiss());
    this.root.replaceChildren(
      img,
      el('div', 'mp-capture-meta', {}, [el('span', '', {}, [`${c.width} × ${c.height}`]), close]),
      actions,
    );
    this.root.hidden = false;
    this.timer = window.setTimeout(() => this.dismiss(), DISMISS_MS);
  }

  dismiss(): void {
    window.clearTimeout(this.timer);
    this.root.hidden = true;
    this.root.replaceChildren();
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }
}
