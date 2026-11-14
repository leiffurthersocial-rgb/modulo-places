import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { registerVillagePlaceholders } from '../../src/scenes/village/placeholders';
import { placeholderSpecies } from '../../src/engine/scatter/species';
import scene from '../../src/scenes/village/scene.json';

registerVillagePlaceholders();

const tris = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.attributes.position!.count) / 3;
const total = (parts: { geometry: THREE.BufferGeometry }[]): number => parts.reduce((a, p) => a + tris(p.geometry), 0);

const meshIds = new Set<string>([
  ...scene.props.map((p) => p.mesh),
  ...scene.scatter.map((s) => s.mesh),
]);
const villageIds = [...meshIds].filter((m) => m.startsWith('village:'));

describe('village greybox species', () => {
  it('scene uses village species', () => {
    expect(villageIds.length).toBeGreaterThan(10);
  });

  for (const id of villageIds) {
    it(`${id} builds finite geometry with vertex colours`, () => {
      const sp = placeholderSpecies(id);
      expect(sp.variants.length).toBeGreaterThan(0);
      for (const v of sp.variants) {
        expect(v.length).toBeGreaterThan(0);
        for (const lod of v) {
          expect(lod.length).toBeGreaterThan(0);
          for (const part of lod) {
            const g = part.geometry;
            expect(g.attributes.color).toBeDefined();
            expect(g.attributes.normal).toBeDefined();
            const pos = g.attributes.position as THREE.BufferAttribute;
            for (let i = 0; i < pos.array.length; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
            expect(tris(g)).toBeGreaterThan(0);
          }
        }
      }
      for (const o of sp.owned) o.dispose();
    });
  }

  it('houses stay within the triangle budget and LODs decrease', () => {
    for (const id of ['village:house-a', 'village:house-b', 'village:house-c', 'village:shrine']) {
      const sp = placeholderSpecies(id);
      const counts = sp.variants[0]!.map(total);
      expect(counts[0]!).toBeLessThanOrEqual(6000);
      for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeLessThan(counts[i - 1]!);
    }
  });

  it('scattered species have 3 decreasing LODs', () => {
    for (const id of ['village:bamboo', 'village:maple']) {
      const sp = placeholderSpecies(id);
      expect(sp.variants.length).toBeGreaterThanOrEqual(2);
      for (const v of sp.variants) {
        const counts = v.map(total);
        expect(counts.length).toBe(3);
        expect(counts[1]!).toBeLessThan(counts[0]!);
        expect(counts[2]!).toBeLessThan(counts[1]!);
      }
    }
  });

  it('lantern species carry a night-light glow part', () => {
    for (const id of ['village:stone-lantern', 'village:lantern-post', 'village:house-a']) {
      const sp = placeholderSpecies(id);
      const parts = sp.variants[0]![0]!;
      const glow = parts.find((p) => (p.material as THREE.MeshStandardMaterial).emissiveIntensity > 1);
      expect(glow).toBeDefined();
    }
  });
});
