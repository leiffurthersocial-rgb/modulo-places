import { CREDITS, CREDITS_NOTE } from './credits';
import { button, el } from './dom';

export class CreditsScreen {
  readonly root: HTMLElement;
  private opener: Element | null = null;
  private onClose: () => void;

  constructor(onClose: () => void) {
    this.onClose = onClose;
    const list = el('ul', 'mp-credits');
    for (const c of CREDITS) {
      const name = c.url ? el('a', 'mp-link', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, [c.name]) : el('span', '', {}, [c.name]);
      list.append(el('li', 'mp-credit', {}, [name, el('span', 'mp-dim', {}, [` — ${c.role}`]), el('span', 'mp-license', {}, [c.license])]));
    }
    const dialog = el('div', 'mp-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Credits', tabindex: '-1' }, [
      el('header', 'mp-dialog-head', {}, [el('h2', 'mp-h2', {}, ['Credits']), button('Close', 'mp-btn-primary', () => this.close())]),
      list,
      el('p', 'mp-note', {}, [CREDITS_NOTE]),
    ]);
    this.root = el('div', 'mp-screen mp-modal', { hidden: '' }, [dialog]);
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.opener = document.activeElement;
    this.root.hidden = false;
    this.root.querySelector<HTMLElement>('.mp-dialog')?.focus();
  }

  close(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    if (this.opener instanceof HTMLElement) this.opener.focus();
    this.opener = null;
    this.onClose();
  }
}
