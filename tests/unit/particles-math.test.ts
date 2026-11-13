import { describe, expect, it } from 'vitest';
import {
  makeSeeds,
  mulberry32,
  pointSizePx,
  stepIntensity,
  visibleCount,
  wrapCentered,
  wrapPositive,
} from '../../src/engine/atmosphere/particles/math';

describe('particle math', () => {
  it('wrapCentered stays in [-size/2, size/2)', () => {
    for (const v of [-123.4, -10, -5, 0, 4.99, 5, 17.3, 1e4]) {
      const w = wrapCentered(v, 10);
      expect(w).toBeGreaterThanOrEqual(-5);
      expect(w).toBeLessThan(5);
      expect((v - w) / 10).toBeCloseTo(Math.round((v - w) / 10), 6);
    }
    expect(wrapCentered(5, 10)).toBe(-5);
    expect(wrapCentered(3, 0)).toBe(0);
  });

  it('wrapPositive is non-negative', () => {
    expect(wrapPositive(-1, 4)).toBe(3);
    expect(wrapPositive(9, 4)).toBe(1);
  });

  it('visibleCount scales and clamps', () => {
    expect(visibleCount(1000, 0.5)).toBe(500);
    expect(visibleCount(1000, 2)).toBe(1000);
    expect(visibleCount(1000, -1)).toBe(0);
    expect(visibleCount(1000, Number.NaN)).toBe(1000);
    expect(visibleCount(0, 1)).toBe(0);
  });

  it('stepIntensity fades and snaps', () => {
    expect(stepIntensity(0, 1, 0.5, 2)).toBeCloseTo(0.25);
    expect(stepIntensity(0.9, 1, 1, 2)).toBe(1);
    expect(stepIntensity(1, 0, 0.5, 2)).toBeCloseTo(0.75);
    expect(stepIntensity(0.3, 1, 0.016, 0)).toBe(1);
  });

  it('pointSizePx clamps', () => {
    expect(pointSizePx(0.01, 1.7, 1000, 1000, 1, 6)).toBe(1);
    expect(pointSizePx(0.5, 1.7, 1000, 0.1, 1, 6)).toBe(6);
    expect(pointSizePx(0.02, 1.7, 1000, 5, 1, 6)).toBeCloseTo(3.4);
  });

  it('seeds are deterministic and in range', () => {
    const a = makeSeeds(50, 7);
    const b = makeSeeds(50, 7);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a.length).toBe(200);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...a)).toBeLessThan(1);
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});
