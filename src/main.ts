// Entry point. URL parameters (for QA and automation):
//   ?shot=N&scene=greybox&mood=dusk&cam=ridge&preset=medium[&dof=1&focus=8&focal=85]
//       → render N fixed frames from a review camera, then window.__shotReady = true
//   ?bench=20&scene=greybox&preset=medium → scripted camera path for 20 s, result in window.__bench
import { App, type AppOptions } from './engine/core/App';
import type { PresetId } from './engine/types';

declare global {
  interface Window {
    __shotReady?: boolean;
    __info?: Record<string, unknown>;
    __bench?: Record<string, unknown>;
    __app?: App;
  }
}

const q = new URLSearchParams(location.search);
const opts: AppOptions = {};
if (q.has('preset')) opts.preset = q.get('preset') as PresetId;
if (q.has('shot')) {
  const photo =
    q.has('focal') || q.has('dof')
      ? {
          focalLength: Number(q.get('focal') ?? 35),
          dof: q.get('dof') === '1',
          focusDistance: Number(q.get('focus') ?? 10),
          aperture: Number(q.get('f') ?? 2.8),
        }
      : undefined;
  opts.shot = {
    scene: q.get('scene') ?? 'greybox',
    mood: q.get('mood') ?? undefined,
    camera: q.get('cam') ?? 'spawn',
    frames: Number(q.get('shot')) || 4,
    preset: opts.preset,
    photo,
  };
} else if (q.has('bench')) {
  opts.bench = {
    scene: q.get('scene') ?? 'greybox',
    mood: q.get('mood') ?? undefined,
    preset: opts.preset,
    seconds: Number(q.get('bench')) || 20,
  };
}

const app = new App(document.getElementById('app')!, opts);
if (import.meta.env.DEV || q.has('test')) window.__app = app;
void app.boot();
