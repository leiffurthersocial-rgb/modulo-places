import type { EventBus } from '../engine/core/events';
import type { SettingsStore } from '../engine/core/settings';
import type { PhotoParams } from '../engine/types';

export interface SceneCard {
  id: string;
  name: string;
  description: string;
  preview?: string;
  moods: { id: string; name: string }[];
  available: boolean;
}

export interface UIActions {
  enterScene(id: string, moodId?: string): void;
  exitToMenu(): void;
  /** Close pause menu, back to walking. */
  resume(): void;
  setMood(id: string): void;
  togglePhoto(on?: boolean): void;
  setPhotoParams(p: Partial<PhotoParams>): void;
  getPhotoParams(): PhotoParams;
  resetPhotoParams(): void;
  /** Next canvas tap sets focus. */
  armFocusPick(): void;
  capture(scale: 1 | 2 | 4): void;
  /** Debug seed override; null = scene default. */
  setSeed(seed: number | null): void;
}

export interface UIHost {
  events: EventBus;
  settings: SettingsStore;
  scenes: SceneCard[];
  actions: UIActions;
  isTouch(): boolean;
  maxCaptureScale(): 1 | 2 | 4;
}
