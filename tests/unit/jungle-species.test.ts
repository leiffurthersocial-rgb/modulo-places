import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { JUNGLE_SPECIES, TEMPLE } from '../../src/scenes/jungle/placeholders';

function tris(g: THREE.BufferGeometry): number {
  return (g.index ? g.index.count : g.attributes.position!.count) / 3;
}

describe('jungle greybox species', () => {
  for (const [id, build] of Object.entries(JUNGLE_SPECIES)) {
    it(`${id} builds finite geometry with colours`, () => {
      const sp = build();
      expect(sp.variants.length).toBeGreaterThan(0);
      let maxY = 0;
      for (const v of sp.variants) {
        expect(v.length).toBeGreaterThan(0);
        for (const lod of v) {
          expect(lod.length).toBeGreaterThan(0);
          for (const part of lod) {
            const g = part.geometry;
            const pos = g.attributes.position as THREE.BufferAttribute;
            expect(g.attributes.color).toBeDefined();
            expect(g.attributes.normal).toBeDefined();
            for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
            expect(tris(g)).toBeGreaterThan(0);
            g.computeBoundingBox();
            maxY = Math.max(maxY, g.boundingBox!.max.y);
          }
        }
      }
      expect(maxY).toBeGreaterThan(0);
      for (const o of sp.owned) o.dispose();
    });
  }

  it('scattered plants have decreasing triangle counts per LOD', () => {
    for (const id of ['jungle:giant-tree', 'jungle:monstera', 'jungle:palm', 'jungle:fern-big']) {
      const sp = JUNGLE_SPECIES[id]!();
      const counts = sp.variants[0]!.map((lod) => lod.reduce((a, p) => a + tris(p.geometry), 0));
      expect(counts.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThan(counts[i - 1]!);
    }
  });

  it('stair geometry constants match human scale', () => {
    expect(TEMPLE.riser).toBeCloseTo(0.3);
    expect(TEMPLE.riser * TEMPLE.steps).toBeCloseTo(TEMPLE.topY);
    expect(TEMPLE.doorH).toBeGreaterThanOrEqual(2.5);
    expect(TEMPLE.doorH).toBeLessThanOrEqual(3);
  });
});
