import { describe, expect, it } from 'vitest';
import layoutJson from '../../src/classroom/data/layouts/classroom-a.json';
import { SimClock, TICK_DT } from '../../src/classroom/sim/clock';
import { facingDir, type RoomLayout, validateLayout } from '../../src/classroom/sim/layout';
import { hashString, parseSeed, Rng } from '../../src/classroom/sim/rng';

describe('classroom Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const sa = Array.from({ length: 1000 }, () => a.nextU32());
    const sb = Array.from({ length: 1000 }, () => b.nextU32());
    expect(sa).toEqual(sb);
  });
  it('differs for neighbouring seeds', () => {
    expect(new Rng(1).nextU32()).not.toBe(new Rng(2).nextU32());
  });
  it('stays in range and is roughly uniform', () => {
    const r = new Rng(7);
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      buckets[Math.floor(x * 10)]!++;
    }
    for (const b of buckets) expect(Math.abs(b - 10_000)).toBeLessThan(500);
  });
  it('round-trips state (for save/load)', () => {
    const r = new Rng(9);
    r.next();
    const s = r.state();
    const x = [r.next(), r.next()];
    r.setState(s);
    expect([r.next(), r.next()]).toEqual(x);
  });
  it('parses numeric and word seeds', () => {
    expect(parseSeed('123')).toBe(123);
    expect(parseSeed('monday')).toBe(hashString('monday'));
    expect(parseSeed(null, 5)).toBe(5);
  });
});

describe('SimClock', () => {
  it('runs a fixed 20 Hz tick independent of frame rate', () => {
    const fast = new SimClock();
    const slow = new SimClock();
    for (let i = 0; i < 120; i++) fast.advance(1 / 120);
    for (let i = 0; i < 30; i++) slow.advance(1 / 30);
    expect(fast.tick).toBe(20);
    expect(slow.tick).toBe(20);
    expect(fast.time).toBeCloseTo(1, 5);
    expect(TICK_DT).toBe(0.05);
  });
  it('honours timeScale and pause', () => {
    const c = new SimClock();
    c.timeScale = 4;
    c.advance(0.25);
    expect(c.tick).toBe(8);
    c.paused = true;
    expect(c.advance(1)).toBe(0);
  });
});

describe('classroom layout', () => {
  const layout = layoutJson as unknown as RoomLayout;
  it('validates', () => {
    expect(validateLayout(layout)).toEqual([]);
  });
  it('catches broken references', () => {
    const bad = structuredClone(layout);
    bad.seats[0]!.table = 'nope';
    bad.playerSeat = 'missing';
    expect(validateLayout(bad).length).toBe(2);
  });
  it('has room for the cast (≥ 10 seats incl. player)', () => {
    expect(layout.seats.length).toBeGreaterThanOrEqual(10);
  });
  it('facing 0 looks at the board (−z)', () => {
    const [x, z] = facingDir(0);
    expect(x).toBeCloseTo(0);
    expect(z).toBeCloseTo(-1);
  });
});
