import { describe, expect, it } from 'vitest';
import type { Box, V2 } from '../../src/classroom/sim/geom';
import { World } from '../../src/classroom/sim/world';

const w = new World({ seed: 1, lessonType: 'lecture', teacher: 'strict' });
const nav = w.nav;
const spots = Object.entries(w.layout.spots ?? {}).map(
  ([k, v]) => [k, { x: v[0], z: v[1] }] as [string, V2],
);

function polylineWalkable(a: V2, path: V2[]): boolean {
  let prev = a;
  for (const p of path) {
    const n = Math.ceil(Math.hypot(p.x - prev.x, p.z - prev.z) / 0.05);
    for (let i = 0; i <= n; i++) {
      const t = n ? i / n : 1;
      if (!nav.walkable({ x: prev.x + (p.x - prev.x) * t, z: prev.z + (p.z - prev.z) * t }))
        return false;
    }
    prev = p;
  }
  return true;
}

describe('NavGrid on the real classroom', () => {
  it('has spots to test', () => {
    expect(spots.length).toBeGreaterThan(5);
  });
  it('finds paths between all layout spots and seat positions that never cross blocked cells', () => {
    const points: [string, V2][] = [
      ...spots,
      ...w.layout.seats.map((s) => [s.id, { x: s.pos[0], z: s.pos[1] }] as [string, V2]),
    ];
    for (const [na, a] of points) {
      for (const [nb, b] of points) {
        if (na === nb) continue;
        const path = nav.findPath(a, b);
        expect(path, `${na} -> ${nb}`).not.toBeNull();
        const start = nav.nearestWalkable(a)!;
        expect(polylineWalkable(start, path!), `${na} -> ${nb} crosses a blocked cell`).toBe(true);
      }
    }
  });
  it('tables are blocked, open floor is walkable', () => {
    expect(nav.walkable({ x: 4.55, z: 5.65 })).toBe(false);
    expect(nav.walkable({ x: 4.5, z: 3.6 })).toBe(true);
    expect(nav.walkable({ x: -1, z: 3 })).toBe(false);
  });
});

describe('NavGrid dynamic obstacles', () => {
  it('setDynamic blocks cells and bumps version; removing restores', () => {
    const g = new World({ seed: 2, lessonType: 'lecture', teacher: 'strict' }).nav;
    const probe = { x: 4.5, z: 3.6 };
    expect(g.walkable(probe)).toBe(true);
    const v0 = g.version;
    const box: Box = {
      id: 'dyn',
      kind: 'prop',
      cx: 4.5,
      cz: 3.6,
      hx: 0.5,
      hz: 0.5,
      yaw: 0,
      y0: 0,
      y1: 1,
    };
    g.setDynamic('dyn', box);
    expect(g.version).toBe(v0 + 1);
    expect(g.walkable(probe)).toBe(false);
    g.setDynamic('dyn', null);
    expect(g.version).toBe(v0 + 2);
    expect(g.walkable(probe)).toBe(true);
  });
  it('a full-width wall across the middle aisle forces a longer or no path; removal restores the direct one', () => {
    const g = new World({ seed: 3, lessonType: 'lecture', teacher: 'strict' }).nav;
    const a = { x: 4.5, z: 2.6 };
    const b = { x: 4.5, z: 4.4 };
    const len = (p: V2[] | null) => {
      if (!p) return Infinity;
      let s = 0;
      let prev = a;
      for (const q of p) {
        s += Math.hypot(q.x - prev.x, q.z - prev.z);
        prev = q;
      }
      return s;
    };
    const base = len(g.findPath(a, b));
    expect(base).toBeLessThan(2.5);
    g.setDynamic('block', {
      id: 'block',
      kind: 'prop',
      cx: 4.5,
      cz: 3.5,
      hx: 1.5,
      hz: 0.2,
      yaw: 0,
      y0: 0,
      y1: 1,
    });
    expect(len(g.findPath(a, b))).toBeGreaterThan(base + 0.5);
    g.setDynamic('block', null);
    expect(len(g.findPath(a, b))).toBeCloseTo(base, 3);
  });
});
