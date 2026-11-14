import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildBamboo,
  buildBigLeafPlant,
  buildPalm,
  buildTreeFern,
  createTropicalMaterials,
  type TropicalLod,
} from '../../src/engine/scatter/tropical';
import type { BuiltModel } from '../../src/engine/scatter/conifer';

const rects = (n: number) => Array.from({ length: n }, (_, i) => [0.1 * i, 0, 0.1 * i + 0.1, 1] as [number, number, number, number]);
const atlas = (n: number) => ({
  albedo: new THREE.Texture(),
  normal: new THREE.Texture(),
  rects: rects(n),
  aspect: Array.from({ length: n }, () => 0.6),
});
const mats = createTropicalMaterials({ bark: null, tropical: atlas(6), bambooLeaf: atlas(4) }, false);

const tris = (m: BuiltModel): number =>
  m.parts.reduce((a, p) => a + (p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position!.count) / 3, 0);
const LODS: TropicalLod[] = [0, 1, 2];

type Build = (lod: TropicalLod, seed?: number) => BuiltModel;
const cases: Record<string, { build: Build; budget: number }> = {
  monstera: { build: (lod, seed = 5) => buildBigLeafPlant({ kind: 'monstera', height: 1.7, seed, lod }, mats), budget: 1500 },
  'elephant-ear': { build: (lod, seed = 5) => buildBigLeafPlant({ kind: 'elephant-ear', height: 2, seed, lod }, mats), budget: 1500 },
  banana: { build: (lod, seed = 5) => buildBigLeafPlant({ kind: 'banana', height: 4.4, seed, lod }, mats), budget: 1500 },
  palm: { build: (lod, seed = 5) => buildPalm({ height: 11, seed, lod }, mats), budget: 4000 },
  'tree-fern': { build: (lod, seed = 5) => buildTreeFern({ height: 3.6, seed, lod }, mats), budget: 2500 },
  bamboo: { build: (lod, seed = 5) => buildBamboo({ height: 9, seed, lod, culms: 12 }, mats), budget: 6000 },
  'bamboo-big': { build: (lod, seed = 5) => buildBamboo({ height: 12, seed, lod, culms: 20 }, mats), budget: 6000 },
};

describe('tropical builders', () => {
  for (const [id, { build, budget }] of Object.entries(cases)) {
    it(`${id}: LOD budgets, monotonic, sensible size`, () => {
      const t = LODS.map((l) => tris(build(l)));
      expect(t[0]).toBeLessThanOrEqual(budget);
      expect(t[1]).toBeLessThanOrEqual(budget * 0.4 + 1);
      expect(t[2]).toBeLessThanOrEqual(budget * 0.15 + 1);
      expect(t[0]).toBeGreaterThan(t[1]!);
      expect(t[1]).toBeGreaterThan(t[2]!);
      expect(t[2]).toBeGreaterThan(30);
      const m = build(0);
      expect(m.height).toBeGreaterThan(0.5);
      expect(m.radius).toBeGreaterThan(0.2);
    });

    it(`${id}: deterministic per seed, varies across seeds`, () => {
      const a = build(0, 7).parts[0]!.geometry.getAttribute('position');
      const b = build(0, 7).parts[0]!.geometry.getAttribute('position');
      const c = build(0, 8).parts[0]!.geometry.getAttribute('position');
      expect(Array.from(a.array)).toEqual(Array.from(b.array));
      expect(Array.from(a.array)).not.toEqual(Array.from(c.array));
    });

    it(`${id}: finite attributes and unit normals`, () => {
      for (const lod of LODS)
        for (const p of build(lod).parts) {
          const g = p.geometry;
          const pos = g.getAttribute('position');
          const n = g.getAttribute('normal');
          const uv = g.getAttribute('uv');
          const col = g.getAttribute('color');
          for (const v of [...pos.array, ...uv.array, ...col.array]) expect(Number.isFinite(v)).toBe(true);
          for (let i = 0; i < n.count; i++) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 2);
          expect(pos.count).toBe(n.count);
        }
    });
  }

  it('bamboo grows taller with height and keeps culms in a clump', () => {
    const small = buildBamboo({ height: 5, seed: 1, lod: 0, culms: 8 }, mats);
    const big = buildBamboo({ height: 12, seed: 1, lod: 0, culms: 16 }, mats);
    expect(big.height).toBeGreaterThan(small.height);
    expect(big.height).toBeLessThan(14);
  });
});
