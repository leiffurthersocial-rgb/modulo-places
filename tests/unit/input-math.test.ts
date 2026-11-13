import { describe, expect, it } from 'vitest';
import {
  clampSpike,
  clampToRadius,
  isTap,
  joystickVector,
  keyboardMove,
  pixelsToLook,
  toNdc,
} from '../../src/engine/input/math';

describe('clampSpike', () => {
  it('passes normal values and drops spikes / NaN', () => {
    expect(clampSpike(12)).toBe(12);
    expect(clampSpike(-300)).toBe(-300);
    expect(clampSpike(301)).toBe(0);
    expect(clampSpike(-5000)).toBe(0);
    expect(clampSpike(NaN)).toBe(0);
  });
});

describe('keyboardMove', () => {
  it('normalises diagonals', () => {
    const m = keyboardMove(false, true, false, true);
    expect(Math.hypot(m.x, m.y)).toBeCloseTo(1, 6);
  });
  it('cancels opposing keys', () => {
    expect(keyboardMove(true, true, false, false)).toEqual({ x: 0, y: 0 });
    expect(keyboardMove(false, false, false, true)).toEqual({ x: 0, y: 1 });
  });
});

describe('joystickVector', () => {
  it('has a deadzone', () => {
    expect(joystickVector(3, 3, 60).magnitude).toBe(0);
  });
  it('maps up on screen to forward', () => {
    const j = joystickVector(0, -60, 60);
    expect(j.y).toBeCloseTo(1, 6);
    expect(j.x).toBeCloseTo(0, 6);
    expect(j.sprint).toBe(true);
  });
  it('is analog and does not sprint at half radius', () => {
    const j = joystickVector(30, 0, 60);
    expect(j.x).toBeGreaterThan(0.3);
    expect(j.x).toBeLessThan(0.6);
    expect(j.sprint).toBe(false);
  });
  it('never exceeds unit magnitude', () => {
    const j = joystickVector(500, 500, 60);
    expect(Math.hypot(j.x, j.y)).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('handles zero radius', () => {
    expect(joystickVector(10, 10, 0).magnitude).toBe(0);
  });
});

describe('clampToRadius', () => {
  it('limits length', () => {
    const c = clampToRadius(120, 0, 60);
    expect(c.x).toBeCloseTo(60, 6);
    expect(clampToRadius(10, 10, 60)).toEqual({ x: 10, y: 10 });
  });
});

describe('pixelsToLook', () => {
  it('moving mouse right turns right, moving down looks down', () => {
    const l = pixelsToLook(100, 100, 0.0022, 1, false);
    expect(l.x).toBeCloseTo(0.22, 6);
    expect(l.y).toBeCloseTo(-0.22, 6);
  });
  it('invertY flips y and sensitivity scales', () => {
    const l = pixelsToLook(0, 100, 0.0022, 2, true);
    expect(l.y).toBeCloseTo(0.44, 6);
  });
});

describe('isTap / toNdc', () => {
  it('detects taps', () => {
    expect(isTap(2, 100)).toBe(true);
    expect(isTap(9, 100)).toBe(false);
    expect(isTap(2, 400)).toBe(false);
  });
  it('converts to NDC with y up', () => {
    const rect = { left: 0, top: 0, width: 200, height: 100 };
    const c = toNdc(100, 50, rect);
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(0, 9);
    const tl = toNdc(0, 0, rect);
    expect(tl.x).toBe(-1);
    expect(tl.y).toBe(1);
  });
});
