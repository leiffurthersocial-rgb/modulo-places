import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildConifer,
  buildLog,
  type ConiferMaterials,
  type ConiferParams,
} from '../../src/engine/scatter/conifer';

const mats = (): ConiferMaterials => ({
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

const tris = (r: ReturnType<typeof buildConifer>): number =>
  r.parts.reduce((n, p) => n + (p.geometry.index?.count ?? 0) / 3, 0);

function bounds(r: ReturnType<typeof buildConifer>): THREE.Box3 {
  const b = new THREE.Box3();
  for (const p of r.parts) {
    p.geometry.computeBoundingBox();
    b.union(p.geometry.boundingBox!);
  }
  return b;
}

describe('conifer triangle budgets', () => {
  const budgets = {
    fir: [8000, 3000, 1000],
    pine: [6000, 3000, 1000],
  } as const;
  for (const kind of ['fir', 'pine'] as const)
    for (const lod of [0, 1, 2] as const)
      it(`${kind} LOD${lod} within budget`, () => {
        const r = buildConifer({ kind, height: 20, seed: 3, lod }, mats());
        expect(tris(r)).toBeLessThanOrEqual(budgets[kind][lod]);
        expect(tris(r)).toBeGreaterThan(budgets[kind][lod] * 0.1);
      });
  it('saplings fit 2.5k at LOD0', () => {
    for (const kind of ['fir', 'pine'] as const)
      for (const h of [1.2, 2.5, 4]) {
        const r = buildConifer({ kind, height: h, seed: 9, lod: 0 }, mats());
        expect(tris(r)).toBeLessThanOrEqual(2500);
      }
  });
  it('LOD1/2 shrink', () => {
    const t = [0, 1, 2].map((lod) =>
      tris(buildConifer({ kind: 'fir', height: 18, seed: 5, lod: lod as 0 | 1 | 2 }, mats())),
    );
    expect(t[1]!).toBeLessThan(t[0]!);
    expect(t[2]!).toBeLessThan(t[1]!);
  });
});

describe('conifer determinism and bounds', () => {
  const p: ConiferParams = { kind: 'fir', height: 17, seed: 42, lod: 0 };
  it('same seed -> identical geometry; different seed -> different', () => {
    const a = buildConifer(p, mats());
    const b = buildConifer(p, mats());
    const c = buildConifer({ ...p, seed: 43 }, mats());
    const pa = a.parts[1]!.geometry.getAttribute('position').array;
    expect(Array.from(b.parts[1]!.geometry.getAttribute('position').array)).toEqual(Array.from(pa));
    expect(Array.from(c.parts[1]!.geometry.getAttribute('position').array)).not.toEqual(
      Array.from(pa),
    );
  });
  it('height matches request, pivot at base, attributes present', () => {
    for (const kind of ['fir', 'pine'] as const)
      for (const height of [1.5, 3, 12, 22]) {
        const r = buildConifer({ kind, height, seed: 7, lod: 0 }, mats());
        const b = bounds(r);
        expect(b.max.y).toBeGreaterThan(height * 0.97);
        expect(b.max.y).toBeLessThanOrEqual(height * 1.001);
        expect(b.min.y).toBeGreaterThanOrEqual(-0.01);
        expect(r.height).toBe(height);
        expect(r.radius).toBeGreaterThan(height * 0.05);
        for (const part of r.parts) {
          expect(part.geometry.getAttribute('uv')).toBeTruthy();
          expect(part.geometry.getAttribute('normal')).toBeTruthy();
          expect(part.geometry.getAttribute('color')).toBeTruthy();
        }
      }
  });
  it('foliage vertex colour in AO range', () => {
    const col = buildConifer(p, mats()).parts[1]!.geometry.getAttribute('color');
    let lo = 1;
    let hi = 0;
    for (let i = 0; i < col.count; i++) {
      lo = Math.min(lo, col.getX(i));
      hi = Math.max(hi, col.getX(i));
    }
    expect(lo).toBeGreaterThanOrEqual(0.3);
    expect(hi).toBeLessThanOrEqual(1);
  });
});

describe('fallen log', () => {
  it('budget, determinism, extent', () => {
    const bark = new THREE.MeshStandardMaterial();
    const a = buildLog({ length: 6, radius: 0.35, seed: 2, lod: 0 }, bark);
    const b = buildLog({ length: 6, radius: 0.35, seed: 2, lod: 0 }, bark);
    expect(tris(a)).toBeLessThanOrEqual(1500);
    expect(Array.from(a.parts[0]!.geometry.getAttribute('position').array)).toEqual(
      Array.from(b.parts[0]!.geometry.getAttribute('position').array),
    );
    const bb = bounds(a);
    expect(bb.min.x).toBeCloseTo(-3, 0);
    expect(bb.max.x).toBeGreaterThan(2.9);
    expect(bb.min.y).toBeGreaterThanOrEqual(-0.06);
    expect(a.parts[0]!.geometry.getAttribute('aMoss')).toBeTruthy();
    expect(tris(buildLog({ length: 6, radius: 0.35, seed: 2, lod: 2 }, bark))).toBeLessThan(
      tris(a),
    );
  });
});
