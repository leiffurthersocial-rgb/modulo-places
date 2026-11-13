// Tiny typed event bus shared by engine and UI.
import type { PhotoParams, PresetId, QualitySettings, UserSettings } from '../types';

export interface EngineEvents {
  'settings:changed': UserSettings;
  'quality:applied': { preset: PresetId; settings: QualitySettings };
  'scene:loading': { id: string; progress: number; label: string };
  'scene:ready': { id: string };
  'scene:exited': { id: string };
  'mood:changed': { id: string; name: string };
  'photo:toggled': { active: boolean };
  'photo:params': PhotoParams;
  'photo:captured': { blob: Blob; width: number; height: number; filename: string };
  'ui:hidden': { hidden: boolean };
  'ui:menu': { open: boolean };
  'debug:toggled': { visible: boolean };
  'watchdog:downgrade': { from: PresetId; to: PresetId };
  toast: { text: string };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof EngineEvents, Set<Handler<never>>>();

  on<K extends keyof EngineEvents>(type: K, fn: Handler<EngineEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set.delete(fn as Handler<never>);
  }

  emit<K extends keyof EngineEvents>(type: K, payload: EngineEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as Handler<EngineEvents[K]>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}
