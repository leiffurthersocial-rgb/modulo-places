import { button, el } from './dom';
import { placeholderGradient } from './format';
import type { UIHost } from './types';

export class MainMenu {
  readonly root: HTMLElement;

  constructor(
    private host: UIHost,
    private cb: { openSettings(): void; openCredits(): void },
  ) {
    const grid = el('div', 'mp-cards');
    for (const scene of host.scenes) grid.append(this.card(scene));
    const header = el('header', 'mp-main-head', {}, [
      el('h1', 'mp-title', {}, ['Modulo: Places']),
      el('p', 'mp-tagline', {}, ['Walk. Look. Wait for the light. Take the photograph.']),
    ]);
    const footer = el('footer', 'mp-main-foot', {}, [
      button('Settings', '', () => cb.openSettings()),
      button('Credits', '', () => cb.openCredits()),
    ]);
    this.root = el('main', 'mp-screen mp-main', { hidden: '', 'aria-label': 'Main menu' }, [
      el('div', 'mp-main-inner', {}, [header, grid, footer]),
    ]);
  }

  show(): void {
    this.root.hidden = false;
    this.root.scrollTop = 0;
    const first = this.root.querySelector<HTMLElement>('.mp-card:not(.is-unavailable) .mp-btn-primary');
    first?.focus({ preventScroll: true });
  }

  hide(): void {
    this.root.hidden = true;
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  private card(scene: UIHost['scenes'][number]): HTMLElement {
    const preview = el('div', 'mp-card-preview');
    if (scene.preview) {
      const img = el('img', '', { src: scene.preview, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => {
        img.remove();
        preview.style.background = placeholderGradient(scene.id);
      });
      preview.append(img);
    } else {
      preview.style.background = placeholderGradient(scene.id);
    }
    if (!scene.available) preview.append(el('span', 'mp-badge', {}, ['Coming soon']));

    let selected = scene.moods[0]?.id;
    const moodRow = el('div', 'mp-chips', { role: 'radiogroup', 'aria-label': `Lighting mood for ${scene.name}` });
    const chipButtons: { id: string; b: HTMLButtonElement }[] = [];
    const paint = (): void => {
      for (const c of chipButtons) {
        c.b.setAttribute('aria-checked', String(c.id === selected));
        c.b.tabIndex = c.id === selected ? 0 : -1;
      }
    };
    for (const m of scene.moods) {
      const b = el('button', 'mp-chip', { type: 'button', role: 'radio', 'aria-checked': 'false' }, [m.name]);
      b.disabled = !scene.available;
      b.addEventListener('click', () => {
        selected = m.id;
        paint();
      });
      chipButtons.push({ id: m.id, b });
      moodRow.append(b);
    }
    paint();

    const enter = button(scene.available ? 'Enter' : 'Coming soon', 'mp-btn-primary', () => {
      if (scene.available) host_enter(this.host, scene.id, selected);
    });
    enter.disabled = !scene.available;

    return el('article', `mp-card${scene.available ? '' : ' is-unavailable'}`, {}, [
      preview,
      el('div', 'mp-card-body', {}, [
        el('h2', 'mp-card-title', {}, [scene.name]),
        el('p', 'mp-card-desc', {}, [scene.description]),
        scene.moods.length ? moodRow : null,
        enter,
      ]),
    ]);
  }
}

function host_enter(host: UIHost, id: string, mood: string | undefined): void {
  if (mood) host.actions.enterScene(id, mood);
  else host.actions.enterScene(id);
}
