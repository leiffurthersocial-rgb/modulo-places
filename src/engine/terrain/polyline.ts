// Polyline helpers for paths and creeks (pure; tested).
import type { Vec2 } from '../types';

/** Distance from (x, z) to a polyline, plus the parameter t (0..1 along total length). */
export function distToPolyline(pts: Vec2[], x: number, z: number): { d: number; t: number } {
  let best = Infinity;
  let bestT = 0;
  let acc = 0;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++)
    total += Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
    const px = ax + dx * u;
    const pz = az + dz * u;
    const d = Math.hypot(x - px, z - pz);
    const segLen = Math.sqrt(len2);
    if (d < best) {
      best = d;
      bestT = total > 0 ? (acc + u * segLen) / total : 0;
    }
    acc += segLen;
  }
  return { d: best, t: bestT };
}

/** Catmull-Rom resample so hand-placed control points become smooth curves. */
export function smoothPolyline(pts: Vec2[], segmentsPerSpan = 8): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    for (let s = 0; s < segmentsPerSpan; s++) {
      const t = s / segmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}
