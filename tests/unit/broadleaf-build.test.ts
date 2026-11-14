import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildBroadleaf,
  type BroadleafKind,
  type BroadleafMaterials,
} from '../../src/engine/scatter/broadleaf';

const KINDS: BroadleafKind[] = ['maple', 'deciduous', 'jungle-giant', 'jungle-canopy'];
const HEIGHT: Record<BroadleafKind, number> = {
  maple: 6,
  deciduous: 11,
  'jungle-giant': 30,
  'jungle-canopy': 18,
};

const mats = (): BroadleafMaterials => ({
  bark: new THREE.MeshStandardMaterial(),
  foliage: new THREE.MeshStandardMaterial({ vertexColors: true }),
  rects: [
    [0.02, 0.01, 0.47, 0.49],
    [0.55, 0.01, 0.95, 0.49],
    [0.05, 0.51, 0.45, 0.99],
    [0.57, 0.51, 0.93, 0.99],
  ],
  aspect: [0.94, 0.85, 0.82, 0.75],
});

const tris = (r: ReturnType<typeof buildBroadleaf>): number =>
  r.parts.reduce((n, p) => n + (p.geometry.index?.count ?? 0) / 3, 0);

describe('broadleaf triangle budgets', () => {
  const budgets: Record<BroadleafKind, number[]> = {
    maple: [9000, 3500, 1200],
    deciduous: [9000, 3500, 1200],
    'jungle-giant': [12000, 3500, 1200],
    'jungle-canopy': [9000, 3500, 1200],
  };
  for (const kind of KINDS)
    for (const lod of [0, 1, 2] as const)
      it(`${kind} LOD${lod} within budget`, () => {
        for (const seed of [1, 7, 211]) {
          const r = buildBroadleaf({ kind, height: HEIGHT[kind], seed, lod }, mats());
          expect(tris(r)).toBeLessThanOrEqual(budgets[kind][lod]!);
          expect(tris(r)).toBeGreaterThan(budgets[kind][lod]! * 0.2);
        }
      });
  it('LOD1/2 shrink', () => {
    for (const kind of KINDS) {
      const t = ([0, 1, 2] as const).map((lod) =>
        tris(buildBroadleaf({ kind, height: HEIGHT[kind], seed: 5, lod }, mats())),
      );
      expect(t[1]!).toBeLessThan(t[0]!);
      expect(t[2]!).toBeLessThan(t[1]!);
    }
  });
});

describe('broadleaf determinism and bounds', () => {
  it('same seed -> identical geometry; different seed -> different', () => {
    for (const kind of KINDS) {
      const p = { kind, height: HEIGHT[kind], seed: 42, lod: 0 as const };
      const pos = (s: number) =>
        Array.from(
          buildBroadleaf({ ...p, seed: s }, mats()).parts[1]!.geometry.getAttribute('position')
            .array,
        );
      expect(pos(42)).toEqual(pos(42));
      expect(pos(43)).not.toEqual(pos(42));
    }
  });
  it('height matches request, pivot at base, attributes present, footprint sane', () => {
    for (const kind of KINDS)
      for (const lod of [0, 1, 2] as const) {
        const H = HEIGHT[kind];
        const r = buildBroadleaf({ kind, height: H, seed: 7, lod }, mats());
        const b = new THREE.Box3();
        for (const part of r.parts) {
          part.geometry.computeBoundingBox();
          b.union(part.geometry.boundingBox!);
          for (const a of ['uv', 'normal', 'color'])
            expect(part.geometry.getAttribute(a)).toBeTruthy();
        }
        expect(b.max.y).toBeGreaterThan(H * 0.97);
        expect(b.max.y).toBeLessThanOrEqual(H * 1.001);
        expect(b.min.y).toBeGreaterThanOrEqual(-0.01);
        expect(r.height).toBe(H);
        expect(r.radius).toBeGreaterThan(H * 0.15);
        expect(r.radius).toBeLessThan(H * 1.2);
      }
  });
  it('foliage vertex colour in AO range, no NaN positions', () => {
    for (const kind of KINDS) {
      const r = buildBroadleaf({ kind, height: HEIGHT[kind], seed: 3, lod: 0 }, mats());
      const col = r.parts[1]!.geometry.getAttribute('color');
      let lo = 1;
      let hi = 0;
      for (let i = 0; i < col.count; i++) {
        lo = Math.min(lo, col.getX(i));
        hi = Math.max(hi, col.getX(i));
      }
      expect(lo).toBeGreaterThanOrEqual(0.3);
      expect(hi).toBeLessThanOrEqual(1);
      for (const part of r.parts)
        for (const v of part.geometry.getAttribute('position').array as Float32Array)
          expect(Number.isFinite(v)).toBe(true);
    }
  });
});
