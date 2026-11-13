import { button, clear, el } from './dom';
import type { UIHost } from './types';

export class PauseMenu {
  readonly root: HTMLElement;
  private moodList = el('div', 'mp-list', { role: 'group', 'aria-label': 'Lighting mood' });
  private moods: { id: string; name: string }[] = [];
  private current = '';
  private resumeBtn: HTMLButtonElement;

  constructor(
    private host: UIHost,
    private cb: { openSettings(): void; hide(): void },
  ) {
    this.resumeBtn = button('Resume', 'mp-btn-primary', () => host.actions.resume());
    const dialog = el(
      'div',
      'mp-dialog mp-pause-dialog',
      { role: 'dialog', 'aria-label': 'Paused' },
      [
        el('h2', 'mp-h2', {}, ['Paused']),
        this.resumeBtn,
        el('h3', 'mp-h3', {}, ['Lighting']),
        this.moodList,
        el('div', 'mp-stack', {}, [
          button('Photo mode', '', () => {
            cb.hide();
            host.actions.togglePhoto(true);
          }),
          button('Settings', '', () => cb.openSettings()),
          button('Exit to menu', '', () => host.actions.exitToMenu()),
        ]),
      ],
    );
    this.root = el('div', 'mp-screen mp-modal', { hidden: '' }, [dialog]);
  }

  show(moods: { id: string; name: string }[], current: string): void {
    this.moods = moods;
    this.current = current;
    this.renderMoods();
    this.root.hidden = false;
    this.resumeBtn.focus();
  }

  hide(): void {
    this.root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  setMood(id: string): void {
    this.current = id;
    this.renderMoods();
  }

  private renderMoods(): void {
    clear(this.moodList);
    this.moodList.hidden = this.moods.length === 0;
    for (const m of this.moods) {
      const b = el(
        'button',
        'mp-btn mp-mood',
        { type: 'button', 'aria-pressed': String(m.id === this.current) },
        [m.name],
      );
      b.addEventListener('click', () => {
        this.current = m.id;
        this.host.actions.setMood(m.id);
        this.renderMoods();
      });
      this.moodList.append(b);
    }
  }
}
