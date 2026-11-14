import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildBroadleaf, type BroadleafKind } from '../../src/engine/scatter/broadleaf';

// Regression (see conifer-normals): zero-length / NaN normals black out the frame through bloom.
describe('broadleaf geometry normals', () => {
  const m = {
    bark: new THREE.MeshStandardMaterial(),
    foliage: new THREE.MeshStandardMaterial(),
    rects: [[0, 0, 1, 1]] as [number, number, number, number][],
    aspect: [1],
  };
  it('unit normals everywhere, all kinds and LODs', () => {
    for (const kind of ['maple', 'deciduous', 'jungle-giant', 'jungle-canopy'] as BroadleafKind[])
      for (const lod of [0, 1, 2] as const)
        for (const p of buildBroadleaf({ kind, height: 20, seed: 5, lod }, m).parts) {
          const n = p.geometry.getAttribute('normal');
          for (let i = 0; i < n.count; i++)
            expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 2);
        }
  });
});
