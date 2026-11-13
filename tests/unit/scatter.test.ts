import { describe, expect, it } from 'vitest';
import { generateHeightfield, sampleHeight } from '../../src/engine/terrain/heightfield';
import { scatterAll, scatterRule, STRIDE } from '../../src/engine/scatter/scatter';
import { Rng, hashSeed } from '../../src/engine/core/random';
import type { ScatterRuleDef, TerrainDef } from '../../src/engine/types';

const terrain: TerrainDef = {
  size: 120,
  resolution: 65,
  source: { type: 'procedural' },
  height: 8,
  baseFrequency: 0.012,
  octaves: 5,
  warp: 12,
  layers: [],
};

const rules: ScatterRuleDef[] = [
  { id: 'tree', mesh: 'tree', density: 2, minDistance: 3, scale: [0.8, 1.3], detail: false },
  {
    id: 'grass',
    mesh: 'grass',
    density: 200,
    minDistance: 0,
    scale: [0.6, 1.2],
    masks: [{ type: 'slope', max: 30, soft: 5 }],
    cluster: { frequency: 0.05, strength: 0.6 },
  },
];

describe('random', () => {
  it('Rng is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
    expect(new Rng(43).next()).not.toBe(new Rng(42).next());
  });
  it('hashSeed separates parts', () => {
    expect(hashSeed('ab', 'c')).not.toBe(hashSeed('a', 'bc'));
  });
});

describe('heightfield', () => {
  it('is deterministic and samples the grid exactly at vertices', () => {
    const a = generateHeightfield(terrain, 7);
    const b = generateHeightfield(terrain, 7);
    expect(a.heights).toEqual(b.heights);
    const ix = 10;
    const iz = 20;
    const x = -terrain.size / 2 + ix * a.step;
    const z = -terrain.size / 2 + iz * a.step;
    expect(sampleHeight(a, x, z)).toBeCloseTo(a.heights[iz * a.res + ix]!, 4);
  });
  it('changes with the seed', () => {
    const a = generateHeightfield(terrain, 7);
    const b = generateHeightfield(terrain, 8);
    expect(a.heights).not.toEqual(b.heights);
  });
});

describe('scatter', () => {
  const hf = generateHeightfield(terrain, 7);

  it('is deterministic for a fixed seed', () => {
    const a = scatterAll(rules, hf, { seed: 1234, vegetationDensity: 1 });
    const b = scatterAll(rules, hf, { seed: 1234, vegetationDensity: 1 });
    for (let i = 0; i < a.length; i++) expect(a[i]!.data).toEqual(b[i]!.data);
  });

  it('a rule does not depend on other rules (stable when rules are added)', () => {
    const solo = scatterRule(rules[1]!, hf, { seed: 1234, vegetationDensity: 1 });
    const all = scatterAll(rules, hf, { seed: 1234, vegetationDensity: 1 });
    expect(solo.data).toEqual(all[1]!.data);
  });

  it('different seeds give different layouts', () => {
    const a = scatterRule(rules[0]!, hf, { seed: 1, vegetationDensity: 1 });
    const b = scatterRule(rules[0]!, hf, { seed: 2, vegetationDensity: 1 });
    expect(a.data).not.toEqual(b.data);
  });

  it('respects min distance', () => {
    const r = scatterRule(rules[0]!, hf, { seed: 9, vegetationDensity: 1 });
    expect(r.count).toBeGreaterThan(10);
    for (let i = 0; i < r.count; i++) {
      for (let j = i + 1; j < r.count; j++) {
        const dx = r.data[i * STRIDE]! - r.data[j * STRIDE]!;
        const dz = r.data[i * STRIDE + 2]! - r.data[j * STRIDE + 2]!;
        expect(dx * dx + dz * dz).toBeGreaterThanOrEqual(9 - 1e-6);
      }
    }
  });

  it('places instances on the terrain surface', () => {
    const r = scatterRule(rules[0]!, hf, { seed: 9, vegetationDensity: 1 });
    for (let i = 0; i < r.count; i += 7) {
      const d = r.data.subarray(i * STRIDE, i * STRIDE + 3);
      expect(d[1]).toBeCloseTo(sampleHeight(hf, d[0]!, d[2]!), 4);
    }
  });

  it('vegetationDensity scales detail rules but not structural ones', () => {
    const full = scatterAll(rules, hf, { seed: 3, vegetationDensity: 1 });
    const low = scatterAll(rules, hf, { seed: 3, vegetationDensity: 0.3 });
    expect(low[0]!.count).toBe(full[0]!.count);
    expect(low[1]!.count).toBeLessThan(full[1]!.count * 0.5);
  });
});
