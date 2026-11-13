import { describe, expect, it } from 'vitest';
import {
  TAU,
  atlasGrid,
  atlasRect,
  localAzimuth,
  projectedExtent,
  selectViews,
  viewAzimuth,
  viewFrame,
} from '../../src/engine/scatter/impostor/math';

describe('impostor view selection', () => {
  it('picks the exact view with zero blend', () => {
    for (let i = 0; i < 8; i++) {
      const b = selectViews(viewAzimuth(i, 8), 8);
      expect(b.i0).toBe(i);
      expect(b.i1).toBe((i + 1) % 8);
      expect(b.w).toBeCloseTo(0, 6);
    }
  });
  it('blends half way between two views', () => {
    const b = selectViews((0.5 / 12) * TAU, 12);
    expect(b.i0).toBe(0);
    expect(b.i1).toBe(1);
    expect(b.w).toBeCloseTo(0.5, 6);
  });
  it('wraps negative and >2pi azimuths', () => {
    const a = selectViews(-0.25 * (TAU / 8), 8);
    expect(a.i0).toBe(7);
    expect(a.i1).toBe(0);
    expect(a.w).toBeCloseTo(0.75, 6);
    const b = selectViews(TAU + 1.5 * (TAU / 8), 8);
    expect(b.i0).toBe(1);
    expect(b.w).toBeCloseTo(0.5, 6);
  });
  it('weights stay in [0,1] and indices in range', () => {
    for (let k = -50; k < 50; k++) {
      const b = selectViews(k * 0.37, 10);
      expect(b.w).toBeGreaterThanOrEqual(0);
      expect(b.w).toBeLessThan(1 + 1e-9);
      expect(b.i0).toBeGreaterThanOrEqual(0);
      expect(b.i0).toBeLessThan(10);
    }
  });
});

describe('local azimuth', () => {
  it('is camera azimuth for zero yaw', () => {
    expect(localAzimuth(0, 5, 0)).toBeCloseTo(0, 6);
    expect(localAzimuth(5, 0, 0)).toBeCloseTo(Math.PI / 2, 6);
  });
  it('compensates instance yaw (rotated tree seen from same place shows another side)', () => {
    // Rotate the object by +yaw about Y: local azimuth of a fixed camera decreases by yaw.
    const yaw = 0.7;
    expect(localAzimuth(0, 5, yaw)).toBeCloseTo(-yaw, 6);
    expect(localAzimuth(Math.sin(yaw) * 3, Math.cos(yaw) * 3, yaw)).toBeCloseTo(0, 6);
  });
});

describe('atlas layout', () => {
  it('chooses compact grids', () => {
    expect(atlasGrid(8)).toEqual({ cols: 4, rows: 2 });
    expect(atlasGrid(12)).toEqual({ cols: 4, rows: 3 });
    expect(atlasGrid(1)).toEqual({ cols: 1, rows: 1 });
  });
  it('rects tile the unit square without overlap', () => {
    const g = atlasGrid(12);
    let area = 0;
    for (let i = 0; i < 12; i++) {
      const r = atlasRect(i, g);
      area += (r.u1 - r.u0) * (r.v1 - r.v0);
      expect(r.u0).toBeGreaterThanOrEqual(0);
      expect(r.u1).toBeLessThanOrEqual(1 + 1e-9);
      expect(r.v1).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(area).toBeCloseTo(12 / (g.cols * g.rows), 9);
    const r5 = atlasRect(5, g);
    expect(r5.u0).toBeCloseTo(1 / 4, 9);
    expect(r5.v0).toBeCloseTo(1 / 3, 9);
  });
  it('applies insets', () => {
    const r = atlasRect(0, { cols: 2, rows: 2 }, 0.1, 0.2);
    expect(r.u0).toBeCloseTo(0.05, 9);
    expect(r.v0).toBeCloseTo(0.1, 9);
    expect(r.u1).toBeCloseTo(0.5 - 0.05, 9);
  });
});

describe('view frame', () => {
  it('is orthonormal and faces the camera direction', () => {
    const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
      a.x * b.x + a.y * b.y + a.z * b.z;
    for (const az of [0, 1, 2.5, 4]) {
      const f = viewFrame(az, (8 * Math.PI) / 180);
      expect(dot(f.right, f.right)).toBeCloseTo(1, 9);
      expect(dot(f.up, f.up)).toBeCloseTo(1, 9);
      expect(dot(f.back, f.back)).toBeCloseTo(1, 9);
      expect(dot(f.right, f.up)).toBeCloseTo(0, 9);
      expect(dot(f.right, f.back)).toBeCloseTo(0, 9);
      expect(dot(f.up, f.back)).toBeCloseTo(0, 9);
      expect(f.back.y).toBeGreaterThan(0);
    }
    expect(viewFrame(0, 0).back).toEqual({ x: 0, y: 0, z: 1 });
  });
  it('projected extent grows with elevation', () => {
    const a = projectedExtent(3, 10, 0);
    expect(a.vMin).toBeCloseTo(0, 9);
    expect(a.vMax).toBeCloseTo(10, 9);
    const b = projectedExtent(3, 10, 0.2);
    expect(b.vMin).toBeLessThan(0);
  });
});
