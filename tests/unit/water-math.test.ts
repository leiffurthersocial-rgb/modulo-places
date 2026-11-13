import { describe, expect, it } from 'vitest';
import {
  downstreamSlope,
  enforceNonIncreasing,
  minCrossSectionHeight,
  resampleUniform,
  ribbonIndices,
  smoothMonotonic,
  waterProfile,
} from '../../src/engine/water/math';

describe('water math', () => {
  it('resamples with near-uniform spacing and unit tangents', () => {
    const st = resampleUniform(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      0.6,
    );
    expect(st[0]!.s).toBe(0);
    expect(st[st.length - 1]!.s).toBeCloseTo(20);
    expect(st.length).toBeGreaterThan(30);
    for (const s of st) expect(Math.hypot(s.tx, s.tz)).toBeCloseTo(1);
    expect(st[1]!.tx).toBeCloseTo(1);
  });

  it('finds the minimum height across a section', () => {
    const h = (x: number, z: number) => Math.abs(z) * 0.5 + 1 + 0 * x;
    const m = minCrossSectionHeight({ x: 0, z: 0, tx: 1, tz: 0 }, 2, 8, h);
    expect(m).toBeCloseTo(1);
  });

  it('enforces non-increasing profiles', () => {
    expect(enforceNonIncreasing([5, 6, 4, 5, 3])).toEqual([5, 5, 4, 4, 3]);
  });

  it('smoothing never rises downstream', () => {
    const raw = Array.from({ length: 60 }, (_, i) => 10 - i * 0.05 + Math.sin(i) * 0.3);
    const p = waterProfile(raw, 0.18);
    for (let i = 1; i < p.length; i++) expect(p[i]!).toBeLessThanOrEqual(p[i - 1]! + 1e-12);
    const q = smoothMonotonic(raw, 2, 3);
    for (let i = 1; i < q.length; i++) expect(q[i]!).toBeLessThanOrEqual(q[i - 1]! + 1e-12);
  });

  it('computes slope >= 0', () => {
    const s = downstreamSlope([3, 2, 1, 1, 1], [0, 1, 2, 3, 4]);
    expect(s[1]).toBeCloseTo(2 / 3);
    expect(s[4]).toBe(0);
    expect(Math.min(...s)).toBeGreaterThanOrEqual(0);
  });

  it('builds ribbon indices', () => {
    const idx = ribbonIndices(3, 4);
    expect(idx.length).toBe(2 * 3 * 3 * 2);
    expect(Math.max(...idx)).toBe(11);
  });
});
