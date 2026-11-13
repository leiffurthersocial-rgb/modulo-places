import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../src/engine/core/settings';
import {
  apertureFromIndex,
  apertureToIndex,
  conflictsForAction,
  findBindingConflicts,
  focalFromSlider,
  focalToSlider,
  focusFromSlider,
  focusToSlider,
  formatAperture,
  formatDistance,
  formatEv,
  formatSigned,
  keyLabel,
  logMap,
  logUnmap,
  placeholderGradient,
} from '../../src/ui/format';

describe('focal length mapping', () => {
  it('hits the endpoints', () => {
    expect(focalFromSlider(0)).toBe(14);
    expect(focalFromSlider(1)).toBe(200);
    expect(focalToSlider(14)).toBeCloseTo(0);
    expect(focalToSlider(200)).toBeCloseTo(1);
  });
  it('round-trips common lenses', () => {
    for (const mm of [14, 24, 35, 50, 85, 135, 200]) expect(focalFromSlider(focalToSlider(mm))).toBe(mm);
  });
  it('clamps out-of-range input', () => {
    expect(focalFromSlider(-1)).toBe(14);
    expect(focalFromSlider(2)).toBe(200);
    expect(focalToSlider(5)).toBe(0);
  });
});

describe('log mapping', () => {
  it('is the inverse of itself', () => {
    expect(logUnmap(logMap(0.37, 0.3, 100), 0.3, 100)).toBeCloseTo(0.37);
  });
  it('focus distance round-trips', () => {
    expect(focusFromSlider(0)).toBe(0.3);
    expect(focusFromSlider(1)).toBe(100);
    expect(focusFromSlider(focusToSlider(5))).toBeCloseTo(5, 1);
  });
});

describe('aperture', () => {
  it('spans f/1.4 to f/22 in 13 steps', () => {
    expect(apertureFromIndex(0)).toBe(1.4);
    expect(apertureFromIndex(12)).toBe(22);
    expect(apertureFromIndex(99)).toBe(22);
    expect(apertureFromIndex(-4)).toBe(1.4);
  });
  it('includes the full stops', () => {
    expect(apertureFromIndex(3)).toBe(2.8);
    expect(apertureFromIndex(6)).toBe(5.6);
  });
  it('index round-trips', () => {
    for (let i = 0; i <= 12; i++) expect(apertureToIndex(apertureFromIndex(i))).toBe(i);
  });
  it('formats', () => {
    expect(formatAperture(1.4)).toBe('f/1.4');
    expect(formatAperture(5.6)).toBe('f/5.6');
    expect(formatAperture(11.2)).toBe('f/11');
    expect(formatAperture(22)).toBe('f/22');
  });
});

describe('number formatting', () => {
  it('formats EV', () => {
    expect(formatEv(0)).toBe('0.0 EV');
    expect(formatEv(1.25)).toBe('+1.3 EV');
    expect(formatEv(-2)).toBe('-2.0 EV');
  });
  it('formats signed values without a sign at zero', () => {
    expect(formatSigned(0)).toBe('0.00');
    expect(formatSigned(0.004)).toBe('0.00');
    expect(formatSigned(0.5)).toBe('+0.50');
    expect(formatSigned(-0.5)).toBe('-0.50');
  });
  it('formats distance', () => {
    expect(formatDistance(2.345)).toBe('2.3 m');
    expect(formatDistance(42.4)).toBe('42 m');
  });
});

describe('key labels and conflicts', () => {
  it('labels codes', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('ShiftLeft')).toBe('Left Shift');
    expect(keyLabel('F3')).toBe('F3');
  });
  it('finds conflicts', () => {
    const b = structuredClone(DEFAULT_BINDINGS);
    expect(findBindingConflicts(b, 'forward', 'KeyW')).toEqual([]);
    expect(findBindingConflicts(b, 'forward', 'KeyS')).toEqual(['back']);
    b.down = ['KeyE'];
    expect(conflictsForAction(b, 'down')).toEqual(['up']);
    expect(conflictsForAction(b, 'up')).toEqual(['down']);
  });
});

describe('placeholderGradient', () => {
  it('is deterministic and varies by id', () => {
    expect(placeholderGradient('a')).toBe(placeholderGradient('a'));
    expect(placeholderGradient('a')).not.toBe(placeholderGradient('b'));
  });
});
