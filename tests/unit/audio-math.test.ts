import { describe, expect, it } from 'vitest';
import {
  clamp,
  densityToMeanInterval,
  inverseDistanceGain,
  lerpMix,
  mergeMix,
  mulberry32,
  nearestPointOnPolyline,
  poissonInterval,
  randomWalk,
  relativePan,
  SILENT_MIX,
} from '../../src/engine/audio/math';
import { AMBIENCE_PRESETS } from '../../src/engine/audio/presets';

describe('nearestPointOnPolyline', () => {
  const line: [number, number, number][] = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 0, 10],
  ];
  it('projects onto interior of a segment', () => {
    const r = nearestPointOnPolyline(line, { x: 4, y: 3, z: 2 });
    expect(r?.point).toEqual([4, 0, 0]);
    expect(r?.distance).toBeCloseTo(Math.hypot(3, 2));
    expect(r?.segment).toBe(0);
  });
  it('clamps to endpoints and picks the closest segment', () => {
    const r = nearestPointOnPolyline(line, { x: 12, y: 0, z: 14 });
    expect(r?.point).toEqual([10, 0, 10]);
    expect(r?.segment).toBe(1);
  });
  it('handles empty, single point and degenerate segments', () => {
    expect(nearestPointOnPolyline([], { x: 0, y: 0, z: 0 })).toBeNull();
    expect(nearestPointOnPolyline([[1, 0, 0]], { x: 4, y: 0, z: 0 })?.distance).toBe(3);
    expect(
      nearestPointOnPolyline(
        [
          [1, 1, 1],
          [1, 1, 1],
        ],
        { x: 1, y: 1, z: 2 },
      )?.distance,
    ).toBe(1);
  });
});

describe('scheduling math', () => {
  it('prng is deterministic and in [0,1)', () => {
    const a = mulberry32(5),
      b = mulberry32(5);
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('poissonInterval respects clamps and mean', () => {
    const r = mulberry32(1);
    let sum = 0;
    for (let i = 0; i < 4000; i++) {
      const v = poissonInterval(r, 2, 0.1, 20);
      expect(v).toBeGreaterThanOrEqual(0.1);
      sum += v;
    }
    expect(sum / 4000).toBeGreaterThan(1.7);
    expect(sum / 4000).toBeLessThan(2.3);
  });
  it('densityToMeanInterval is monotone and infinite at zero', () => {
    expect(densityToMeanInterval(0, 20, 1)).toBe(Infinity);
    expect(densityToMeanInterval(1, 20, 1)).toBeCloseTo(1);
    expect(densityToMeanInterval(0.3, 20, 1)).toBeGreaterThan(densityToMeanInterval(0.6, 20, 1));
  });
  it('randomWalk stays in bounds', () => {
    const r = mulberry32(9);
    let v = 0.5;
    for (let i = 0; i < 500; i++) {
      v = randomWalk(v, r, 0.8, 0, 1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
  it('inverseDistanceGain', () => {
    expect(inverseDistanceGain(1)).toBe(1);
    expect(inverseDistanceGain(30)).toBeLessThan(inverseDistanceGain(10));
    expect(inverseDistanceGain(500)).toBe(inverseDistanceGain(80));
  });
});

describe('mix helpers', () => {
  it('lerpMix interpolates and clamps t', () => {
    const b = { ...SILENT_MIX, wind: 1, birds: 0.5 };
    expect(lerpMix(SILENT_MIX, b, 0.5).wind).toBeCloseTo(0.5);
    expect(lerpMix(SILENT_MIX, b, 5).birds).toBeCloseTo(0.5);
  });
  it('mergeMix clamps and ignores NaN', () => {
    const m = mergeMix(SILENT_MIX, { wind: 3, birds: Number.NaN, rain: -1 });
    expect(m.wind).toBe(1);
    expect(m.birds).toBe(0);
    expect(m.rain).toBe(0);
  });
  it('presets are valid 0..1 mixes', () => {
    for (const k of ['forest-dawn', 'forest-midday', 'forest-dusk']) {
      const p = AMBIENCE_PRESETS[k];
      expect(p).toBeDefined();
      for (const v of Object.values(p ?? {})) expect(v).toBe(clamp(v, 0, 1));
    }
    expect(AMBIENCE_PRESETS['forest-dawn']?.birdsDawnChorus).toBeGreaterThan(
      AMBIENCE_PRESETS['forest-midday']?.birdsDawnChorus ?? 1,
    );
  });
  it('relativePan: right is positive when facing -z', () => {
    const l = { x: 0, y: 0, z: 0 },
      f = { x: 0, y: 0, z: -1 };
    expect(relativePan(l, f, { x: 5, y: 0, z: 0 })).toBeCloseTo(1);
    expect(relativePan(l, f, { x: -5, y: 0, z: 0 })).toBeCloseTo(-1);
    expect(relativePan(l, f, { x: 0, y: 0, z: -5 })).toBeCloseTo(0);
  });
});
