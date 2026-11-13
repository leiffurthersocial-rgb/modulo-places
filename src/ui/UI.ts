import './styles.css';
import { PRESET_LABELS } from '../data/quality-presets';
import type { UserSettings } from '../engine/types';
import { CapturePreview } from './capture-preview';
import { CreditsScreen } from './credits-screen';
import { el } from './dom';
import { LoadingScreen } from './loading-screen';
import { MainMenu } from './main-menu';
import { PauseMenu } from './pause-menu';
import { PhotoOverlays } from './photo-overlays';
import { PhotoPanel } from './photo-panel';
import { SettingsPanel } from './settings-panel';
import { Toasts } from './toasts';
import type { SceneCard, UIActions, UIHost } from './types';

export type { SceneCard, UIActions, UIHost };

export class UI {
  private container: HTMLElement;
  private mainMenu: MainMenu;
  private pauseMenu: PauseMenu;
  private settings: SettingsPanel;
  private credits: CreditsScreen;
  private loading = new LoadingScreen();
  private photoPanel: PhotoPanel;
  private overlays = new PhotoOverlays();
  private capture = new CapturePreview();
  private toasts = new Toasts();
  private unsubs: (() => void)[] = [];
  private sceneName = '';

  constructor(
    private root: HTMLElement,
    private host: UIHost,
  ) {
    this.credits = new CreditsScreen(() => this.refocus());
    this.settings = new SettingsPanel(host, () => this.refocus());
    this.mainMenu = new MainMenu(host, { openSettings: () => this.settings.open(), openCredits: () => this.credits.open() });
    this.pauseMenu = new PauseMenu(host, { openSettings: () => this.settings.open(), hide: () => this.pauseMenu.hide() });
    this.photoPanel = new PhotoPanel(host);

    this.container = el('div', 'mp-ui', {}, [
      this.overlays.root,
      this.photoPanel.root,
      this.toasts.root,
      this.toasts.hintElement,
      this.capture.root,
      this.mainMenu.root,
      this.pauseMenu.root,
      this.loading.root,
      this.settings.root,
      this.credits.root,
    ]);
    if (host.isTouch()) this.container.classList.add('mp-touch');
    root.append(this.container);

    // Form fields must not leak keystrokes (WASD etc.) to the game. Escape still passes through.
    this.container.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key === 'Escape') return;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) e.stopPropagation();
    });

    this.applySettings(host.settings.get());
    const ev = host.events;
    this.unsubs.push(
      ev.on('settings:changed', (s) => {
        this.applySettings(s);
        this.settings.sync();
      }),
      ev.on('scene:loading', (p) => this.loading.setProgress(p.progress, p.label)),
      ev.on('mood:changed', (m) => {
        this.overlays.setContext(undefined, m.name);
        this.pauseMenu.setMood(m.id);
      }),
      ev.on('photo:params', (p) => {
        this.overlays.update(p);
        this.photoPanel.sync();
      }),
      ev.on('photo:captured', (c) => this.capture.show(c)),
      ev.on('ui:hidden', (h) => this.setHidden(h.hidden)),
      ev.on('toast', (t) => this.toasts.toast(t.text)),
      ev.on('watchdog:downgrade', (d) =>
        this.toasts.toast(`Graphics lowered to ${PRESET_LABELS[d.to]} to keep things smooth.`, 6000),
      ),
    );
  }

  get menuOpen(): boolean {
    return this.mainMenu.isOpen || this.pauseMenu.isOpen || this.settings.isOpen || this.credits.isOpen;
  }

  showMainMenu(): void {
    this.pauseMenu.hide();
    this.setPhotoMode(false);
    this.mainMenu.show();
  }

  showPauseMenu(sceneId: string, moods: { id: string; name: string }[], currentMood: string): void {
    const card = this.host.scenes.find((s) => s.id === sceneId);
    if (card) this.sceneName = card.name;
    const moodName = moods.find((m) => m.id === currentMood)?.name;
    this.overlays.setContext(this.sceneName, moodName);
    this.mainMenu.hide();
    this.pauseMenu.show(moods, currentMood);
  }

  hideMenus(): void {
    this.mainMenu.hide();
    this.pauseMenu.hide();
    this.settings.close();
    this.credits.close();
  }

  showLoading(sceneName: string, still?: string): void {
    this.sceneName = sceneName;
    this.overlays.setContext(sceneName);
    this.mainMenu.hide();
    this.pauseMenu.hide();
    this.loading.show(sceneName, still);
  }

  hideLoading(): void {
    this.loading.hide();
  }

  setPhotoMode(active: boolean): void {
    this.photoPanel.setActive(active);
    this.overlays.setActive(active);
    if (active) this.overlays.update(this.host.actions.getPhotoParams());
    document.body.classList.toggle('photo-mode', active);
  }

  setHidden(hidden: boolean): void {
    document.body.classList.toggle('ui-hidden', hidden);
  }

  showHint(text: string, ms?: number): void {
    this.toasts.showHint(text, ms);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.settings.dispose();
    this.capture.dismiss();
    this.toasts.dispose();
    this.container.remove();
    document.body.classList.remove('ui-hidden', 'photo-mode');
    this.root.style.removeProperty('--ui-scale');
  }

  private applySettings(s: Readonly<UserSettings>): void {
    this.root.style.setProperty('--ui-scale', String(s.uiScale));
    this.container.classList.toggle('mp-reduce', s.reduceMotion);
  }

  /** After a modal closes, put focus back on something sensible inside an open screen. */
  private refocus(): void {
    if (this.pauseMenu.isOpen) this.root.querySelector<HTMLElement>('.mp-pause-dialog .mp-btn-primary')?.focus();
  }
}
