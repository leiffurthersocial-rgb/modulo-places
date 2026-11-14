import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildConifer, buildLog } from '../../src/engine/scatter/conifer';

// Regression: zero-length normals at trunk tips produced NaN pixels that blacked out the frame.
describe('procedural geometry normals', () => {
  const m = {
    bark: new THREE.MeshStandardMaterial(),
    foliage: new THREE.MeshStandardMaterial(),
    rects: [[0, 0, 1, 1]] as [number, number, number, number][],
    aspect: [1],
  };
  const unitNormals = (g: THREE.BufferGeometry) => {
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 2);
  };
  it('conifers and logs have unit normals everywhere', () => {
    for (const kind of ['fir', 'pine'] as const)
      for (const lod of [0, 1, 2] as const)
        for (const p of buildConifer({ kind, height: 20, seed: 5, lod }, m).parts) unitNormals(p.geometry);
    for (const p of buildLog({ length: 6, radius: 0.3, seed: 3, lod: 0 }, m.bark).parts) unitNormals(p.geometry);
  });
});
