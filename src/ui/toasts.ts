import { el } from './dom';

export class Toasts {
  readonly root: HTMLElement;
  private hint = el('div', 'mp-hint', { hidden: '', role: 'status' });
  private hintTimer = 0;
  private timers = new Set<number>();

  constructor() {
    this.root = el('div', 'mp-toasts', { 'aria-live': 'polite' });
  }

  get hintElement(): HTMLElement {
    return this.hint;
  }

  toast(text: string, ms = 4000): void {
    const t = el('div', 'mp-toast', {}, [text]);
    this.root.append(t);
    while (this.root.children.length > 4) this.root.firstElementChild?.remove();
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      t.remove();
    }, ms);
    this.timers.add(id);
  }

  showHint(text: string, ms = 6000): void {
    window.clearTimeout(this.hintTimer);
    this.hint.textContent = text;
    this.hint.hidden = false;
    this.hintTimer = window.setTimeout(() => (this.hint.hidden = true), ms);
  }

  dispose(): void {
    window.clearTimeout(this.hintTimer);
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
  }
}
