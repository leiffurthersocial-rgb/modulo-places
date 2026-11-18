// Phase-3 benchmark route (?bench=SECONDS): scripted camera path, per-frame timing, results panel.
import * as THREE from 'three';

export interface BenchOptions {
  seconds: number;
  preset: string | null;
  lesson: string;
  teacher: string;
  seed: number;
}

export interface BenchResult {
  preset: string;
  seconds: number;
  frames: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  avgFps: number;
  drawCalls: number;
  triangles: number;
  textures: number;
  geometries: number;
  estGpuMB: number;
  simTickMsAvg: number;
  userAgent: string;
}

/** Fractions of the room (x, z) plus absolute height in metres: a loop of 6 waypoints. */
const WAYPOINTS: [number, number, number][] = [
  [0.12, 0.2, 1.6],
  [0.85, 0.15, 2.2],
  [0.9, 0.6, 1.3],
  [0.7, 0.9, 2.3],
  [0.25, 0.85, 1.2],
  [0.1, 0.5, 1.8],
];
export const BENCH_LOOP_SECONDS = 20;

export class BenchCameraPath {
  private curve: THREE.CatmullRomCurve3;
  private centre: THREE.Vector3;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(
    [W, , D]: [number, number, number],
    private teacher: () => { x: number; z: number },
  ) {
    this.curve = new THREE.CatmullRomCurve3(
      WAYPOINTS.map(([fx, fz, y]) => new THREE.Vector3(fx * W, y, fz * D)),
      true,
      'centripetal',
    );
    this.centre = new THREE.Vector3(W / 2, 1.1, D / 2);
  }

  /** Place the camera for elapsed seconds; deterministic in t. */
  place(camera: THREE.Camera, t: number): void {
    this.curve.getPointAt((t / BENCH_LOOP_SECONDS) % 1, this.pos);
    const T = this.teacher();
    // Look between the room centre and the teacher.
    this.look.set((this.centre.x + T.x) / 2, 1.1, (this.centre.z + T.z) / 2);
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
  }
}

export function summarizeFrames(times: number[]) {
  const n = times.length;
  if (!n) return { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, avgFps: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(n - 1, Math.floor(n * p))]!;
  const avg = times.reduce((a, b) => a + b, 0) / n;
  return {
    avgMs: avg,
    p50Ms: pct(0.5),
    p95Ms: pct(0.95),
    p99Ms: pct(0.99),
    maxMs: sorted[n - 1]!,
    avgFps: avg > 0 ? 1000 / avg : 0,
  };
}

export function showBenchPanel(r: BenchResult): void {
  const el = document.createElement('div');
  el.id = 'bench-panel';
  el.style.cssText =
    'position:fixed;left:12px;top:12px;z-index:50;background:rgba(0,0,0,.82);color:#dfe;font:12px/1.4 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:8px;max-width:360px';
  const f = (n: number) => n.toFixed(1);
  const rows: [string, string][] = [
    ['preset', r.preset],
    ['frames', `${r.frames} in ${r.seconds}s`],
    ['avg fps', f(r.avgFps)],
    ['frame ms avg/p50', `${f(r.avgMs)} / ${f(r.p50Ms)}`],
    ['p95 / p99 / max', `${f(r.p95Ms)} / ${f(r.p99Ms)} / ${f(r.maxMs)}`],
    ['draw calls / tris', `${r.drawCalls} / ${r.triangles}`],
    ['tex / geo', `${r.textures} / ${r.geometries}`],
    ['est. GPU MB', f(r.estGpuMB)],
    ['sim tick ms', r.simTickMsAvg.toFixed(3)],
  ];
  const table = document.createElement('div');
  table.style.cssText = 'display:grid;grid-template-columns:auto auto;gap:2px 14px';
  for (const [k, v] of rows) {
    const a = document.createElement('span');
    a.textContent = k;
    const b = document.createElement('b');
    b.textContent = v;
    table.append(a, b);
  }
  const btn = document.createElement('button');
  btn.textContent = 'Copy JSON';
  btn.style.cssText = 'margin-top:8px;padding:6px 12px;font:inherit;cursor:pointer';
  btn.addEventListener('click', () => {
    const text = JSON.stringify(r, null, 2);
    const done = () => (btn.textContent = 'Copied');
    if (navigator.clipboard?.writeText)
      navigator.clipboard.writeText(text).then(done, () => undefined);
    else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    }
  });
  el.append(table, btn);
  document.body.appendChild(el);
}
