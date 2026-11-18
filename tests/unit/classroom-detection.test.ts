import { describe, expect, it } from 'vitest';
import { teacherProfile } from '../../src/classroom/sim/data';
import { type Box, type V2, yawDir } from '../../src/classroom/sim/geom';
import {
  heardLoudness,
  inHorizontalView,
  lineOfSight,
  visionZone,
} from '../../src/classroom/sim/perception';
import { samplePoint } from '../../src/classroom/sim/perception';
import { World } from '../../src/classroom/sim/world';
import { segmentHitsBox } from '../../src/classroom/sim/geom';

const V = teacherProfile('strict').vision; // inner 60/7.5, mid 110/9, periph 170/3.5
const eye: V2 = { x: 0, z: 0 };
/** Point `dist` away at `deg` degrees off the gaze axis (headYaw 0 = toward -z). */
const at = (deg: number, dist: number): V2 => {
  const d = yawDir((deg * Math.PI) / 180);
  return { x: d.x * dist, z: d.z * dist };
};

describe('visionZone', () => {
  it('inner cone', () => {
    expect(visionZone(V, eye, 0, at(0, 5))?.zone).toBe('inner');
    expect(visionZone(V, eye, 0, at(25, 5))?.zone).toBe('inner');
    expect(visionZone(V, eye, 0, at(-25, 5))?.zone).toBe('inner');
  });
  it('mid zone beyond the inner range and angle', () => {
    expect(visionZone(V, eye, 0, at(0, 8.5))?.zone).toBe('mid');
    expect(visionZone(V, eye, 0, at(40, 3))?.zone).toBe('mid');
  });
  it('peripheral at wide angles up close', () => {
    expect(visionZone(V, eye, 0, at(70, 3))?.zone).toBe('peripheral');
    expect(visionZone(V, eye, 0, at(-70, 3))?.zone).toBe('peripheral');
  });
  it('near field catches things right behind', () => {
    expect(visionZone(V, eye, 0, at(150, 0.8))?.zone).toBe('near');
    expect(visionZone(V, eye, 0, at(150, 2))).toBeNull();
  });
  it('null when too far or behind', () => {
    expect(visionZone(V, eye, 0, at(0, 12))).toBeNull();
    expect(visionZone(V, eye, 0, at(180, 4))).toBeNull();
  });
  it('coffin lateral cap excludes far off-axis points a plain cone would see', () => {
    // 40 degrees is inside the 55 degree mid half-angle and 5 m is inside 9 m, but lateral = 3.2 m > 2.4 m.
    expect(visionZone(V, eye, 0, at(40, 5))).toBeNull();
    expect(visionZone(V, eye, 0, at(40, 3))?.zone).toBe('mid');
  });
  it('respects head yaw and has bounded, decreasing factor', () => {
    const yaw = Math.PI / 2;
    const d = yawDir(yaw);
    const near = visionZone(V, eye, yaw, { x: d.x * 2, z: d.z * 2 })!;
    const far = visionZone(V, eye, yaw, { x: d.x * 6, z: d.z * 6 })!;
    expect(near.zone).toBe('inner');
    expect(near.factor).toBeGreaterThan(far.factor);
    expect(far.factor).toBeGreaterThan(0);
    expect(near.factor).toBeLessThanOrEqual(1);
  });
  it('scale widens ranges', () => {
    expect(visionZone(V, eye, 0, at(0, 12))).toBeNull();
    expect(visionZone(V, eye, 0, at(0, 12), 1.6)).not.toBeNull();
  });
});

describe('segmentHitsBox', () => {
  const box = (yaw: number): Box => ({
    id: 'b',
    kind: 'prop',
    cx: 0,
    cz: 0,
    hx: 1,
    hz: 0.2,
    yaw,
    y0: 0,
    y1: 1,
  });
  it('hits and misses an axis-aligned box', () => {
    expect(
      segmentHitsBox({ x: 0, y: 0.5, z: -2 }, { x: 0, y: 0.5, z: 2 }, box(0)),
    ).toBeGreaterThanOrEqual(0);
    expect(segmentHitsBox({ x: 0, y: 0.5, z: -2 }, { x: 0, y: 0.5, z: 2 }, box(0))).toBeCloseTo(
      0.45,
      1,
    );
    expect(segmentHitsBox({ x: 3, y: 0.5, z: -2 }, { x: 3, y: 0.5, z: 2 }, box(0))).toBe(-1);
  });
  it('misses over the top and when the segment ends short', () => {
    expect(segmentHitsBox({ x: 0, y: 2, z: -2 }, { x: 0, y: 2, z: 2 }, box(0))).toBe(-1);
    expect(segmentHitsBox({ x: 0, y: 0.5, z: -2 }, { x: 0, y: 0.5, z: -1 }, box(0))).toBe(-1);
  });
  it('honours box rotation', () => {
    // A horizontal segment at z = 0.8 misses the unrotated box but crosses the box turned 90 degrees.
    const a = { x: -2, y: 0.5, z: 0.8 };
    const b = { x: 2, y: 0.5, z: 0.8 };
    expect(segmentHitsBox(a, b, box(0))).toBe(-1);
    expect(segmentHitsBox(a, b, box(Math.PI / 2))).toBeGreaterThanOrEqual(0);
  });
});

describe('lineOfSight with real table slabs', () => {
  const w = new World({ seed: 1, lessonType: 'lecture', teacher: 'strict' });
  const p = w.player; // seated at s-b3 behind table t-b3
  const phone = samplePoint(p, 'device');
  const far = { x: p.pos.x, y: 1.62, z: 2.5 };
  const near = { x: p.pos.x, y: 1.62, z: p.pos.z - 1.2 };

  it('a phone low in a seated lap is hidden from a far viewer by the tabletop', () => {
    expect(phone.y).toBeLessThan(0.7);
    expect(lineOfSight(far, phone, w.geo.occluders, ['teacher', 'player'], false)).toBe(false);
  });
  it('is visible when the viewer is close enough to look over the tables', () => {
    expect(lineOfSight(near, phone, w.geo.occluders, ['teacher', 'player'], true)).toBe(true);
    expect(lineOfSight(far, phone, w.geo.occluders, ['teacher', 'player'], true)).toBe(true);
  });
  it('a raised phone above the tabletop is visible from far away', () => {
    const raised = { ...phone, y: 1.0 };
    expect(lineOfSight(far, raised, w.geo.occluders, ['teacher', 'player'], false)).toBe(true);
  });
  it('walls block sight', () => {
    expect(
      lineOfSight({ x: 4, y: 1.5, z: 3 }, { x: 4, y: 1.5, z: 20 }, w.geo.occluders, [], true),
    ).toBe(false);
  });
});

describe('hearing and view helpers', () => {
  it('heardLoudness falls off linearly to zero at the radius', () => {
    const s = { x: 0, z: 0 };
    expect(heardLoudness(s, s, 4)).toBe(1);
    expect(heardLoudness(s, { x: 2, z: 0 }, 4)).toBeCloseTo(0.5);
    expect(heardLoudness(s, { x: 3, z: 0 }, 4)).toBeCloseTo(0.25);
    expect(heardLoudness(s, { x: 4, z: 0 }, 4)).toBe(0);
    expect(heardLoudness(s, { x: 10, z: 0 }, 4)).toBe(0);
  });
  it('inHorizontalView', () => {
    expect(inHorizontalView(eye, 0, at(0, 5))).toBe(true);
    expect(inHorizontalView(eye, 0, at(50, 5))).toBe(true);
    expect(inHorizontalView(eye, 0, at(60, 5))).toBe(false);
    expect(inHorizontalView(eye, 0, at(180, 5))).toBe(false);
    expect(inHorizontalView(eye, 0, at(80, 5), 90)).toBe(true);
  });
});
