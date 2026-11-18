// Modulo: Classroom entry.
// URL parameters:
//   ?seed=&lesson=&teacher=   shared lesson link (pre-fills the title screen)
//   ?shot=N[&t=SECONDS&bot=STYLE&cam=seat|overview|front|teacher|top&debug=1&hud=1&device=phone|laptop&preset=]
//       screenshot mode: deterministic, pre-simulates t seconds (optionally with a bot), renders
//       N fixed-step frames, then sets window.__shotReady = true.
//   ?bench=SECONDS[&preset=&lesson=&teacher=&seed=]
//       benchmark: real-time lesson with a sneaky bot, scripted camera path, then window.__bench.
import { ClassroomApp, type ShotOptions } from './app';
import type { BenchOptions } from './bench';
import type { BotStyle } from './sim/bots';
import { parseSeed } from './sim/rng';

const q = new URLSearchParams(location.search);
let shot: ShotOptions | null = null;
if (q.has('shot')) {
  shot = {
    frames: Math.max(1, Number(q.get('shot')) || 2),
    lesson: q.get('lesson') ?? 'lecture',
    teacher: q.get('teacher') ?? 'strict',
    seed: parseSeed(q.get('seed'), 1),
    preSeconds: Number(q.get('t') ?? 0),
    bot: (q.get('bot') as BotStyle | null) ?? null,
    cam: q.get('cam') ?? 'seat',
    debug: q.get('debug') === '1',
    hud: q.get('hud') === '1',
    device: (q.get('device') as 'phone' | 'laptop' | null) ?? null,
    preset: q.get('preset'),
  };
}
let bench: BenchOptions | null = null;
if (!shot && q.has('bench')) {
  bench = {
    seconds: Math.max(1, Number(q.get('bench')) || 20),
    preset: q.get('preset'),
    lesson: q.get('lesson') ?? 'lecture',
    teacher: q.get('teacher') ?? 'strict',
    seed: parseSeed(q.get('seed'), 1),
  };
}
const app = new ClassroomApp(document.getElementById('app')!, shot, bench);
app.boot();
