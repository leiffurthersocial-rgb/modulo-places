import { describe, expect, it } from 'vitest';
import { validateContent } from '../../src/classroom/sim/data';
import {
  applyOffense,
  endLesson,
  migrateRecord,
  newRecord,
  RECORD_VERSION,
} from '../../src/classroom/sim/record';

const off = (
  r: ReturnType<typeof newRecord>,
  o: { severity?: number; strictness?: number; roll?: number } = {},
) =>
  applyOffense(r, {
    kind: 'device',
    severity: o.severity ?? 0.5,
    strictness: o.strictness ?? 1,
    teacher: 'strict',
    roll: o.roll ?? 0.5,
    summary: 'Phone',
  });

describe('penalty ladder', () => {
  it('escalates warning -> written -> detention -> callhome', () => {
    const r = newRecord();
    expect([off(r), off(r), off(r), off(r)]).toEqual([
      'warning',
      'written',
      'detention',
      'callhome',
    ]);
    expect(r.warnings).toBe(1);
    expect(r.writtenWarnings).toBe(1);
    expect(r.detentions).toBe(1);
    expect(r.callsHome).toBe(1);
    expect(r.detentionPending).toBe(true);
    expect(r.grades.some((g) => g.label.includes('call home'))).toBe(true);
    expect(r.strikes).toBe(2); // not stuck at call home
    expect(r.offenses).toHaveLength(4);
    expect(r.trust.strict).toBeLessThan(0);
  });
  it('written warning moves the seat', () => {
    const r = newRecord();
    off(r);
    off(r);
    expect(r.seatOverride).toBe('s-front');
  });
  it('letoff only at zero strikes with roll > strictness', () => {
    const r = newRecord();
    expect(off(r, { strictness: 0.5, roll: 0.4 })).toBe('warning');
    const r2 = newRecord();
    expect(off(r2, { strictness: 0.5, roll: 0.9 })).toBe('letoff');
    expect(r2.strikes).toBe(0);
    const r3 = newRecord();
    r3.strikes = 1;
    expect(off(r3, { strictness: 0.5, roll: 0.99 })).toBe('written');
    // strictness 1.0 can never let off (roll < 1)
    const r4 = newRecord();
    expect(off(r4, { strictness: 1, roll: 0.999 })).toBe('warning');
  });
  it('severe offenses (>= 0.85) add two strikes and are never let off', () => {
    const r = newRecord();
    expect(off(r, { severity: 0.9, strictness: 0.1, roll: 0.99 })).toBe('written');
    expect(r.strikes).toBe(2);
    const r2 = newRecord();
    r2.strikes = 2;
    expect(off(r2, { severity: 0.85 })).toBe('callhome');
  });
  it('a clean lesson removes one strike and advances the lesson counter; a dirty one does not', () => {
    const r = newRecord();
    r.strikes = 2;
    r.seatOverride = 's-front';
    endLesson(r, true, 'strict');
    expect(r.strikes).toBe(1);
    expect(r.lessonInDay).toBe(1);
    expect(r.seatOverride).toBe('s-front');
    endLesson(r, true, 'strict');
    expect(r.strikes).toBe(0);
    expect(r.seatOverride).toBeNull();
    endLesson(r, true, 'strict');
    expect(r.strikes).toBe(0);
    r.strikes = 2;
    endLesson(r, false, 'strict');
    expect(r.strikes).toBe(2);
  });
});

describe('migrateRecord', () => {
  it('upgrades a v1-like save and keeps strikes', () => {
    const m = migrateRecord({ version: 1, grades: [70, 80], strikes: 1 });
    expect(m.version).toBe(RECORD_VERSION);
    expect(m.strikes).toBe(1);
    expect(m.grades).toHaveLength(2);
    expect(m.grades[0]).toMatchObject({ value: 70 });
    expect(typeof m.grades[0]!.label).toBe('string');
    expect(m.grades[1]!.value).toBe(80);
    expect(m.npcAffinity).toEqual({});
    expect(m.wishlist.done).toEqual([]);
    expect(Object.keys(m.affinity).length).toBeGreaterThan(0);
  });
  it('handles garbage and keeps current saves', () => {
    expect(migrateRecord(null).version).toBe(RECORD_VERSION);
    expect(migrateRecord('x').strikes).toBe(0);
    const r = newRecord();
    r.strikes = 3;
    expect(migrateRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });
});

describe('content', () => {
  it('validateContent() is clean', () => {
    expect(validateContent()).toEqual([]);
  });
});
