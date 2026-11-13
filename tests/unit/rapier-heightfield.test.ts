// Locks down the heightfield data layout we hand to Rapier: a ray cast down at (x, z) must hit at
// sampleHeight(x, z). If Rapier changes its row/column convention, this fails loudly.
import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { generateHeightfield, sampleHeight } from '../../src/engine/terrain/heightfield';
import { rapierHeightfieldDesc } from '../../src/engine/terrain/collision';

describe('rapier heightfield', () => {
  it('matches sampleHeight at arbitrary points', async () => {
    await RAPIER.init();
    const hf = generateHeightfield(
      {
        size: 100,
        resolution: 33,
        source: { type: 'procedural' },
        height: 10,
        baseFrequency: 0.02,
        octaves: 4,
        warp: 8,
        layers: [],
      },
      5,
    );
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(rapierHeightfieldDesc(RAPIER, hf));
    world.step();
    const pts: [number, number][] = [
      [0, 0],
      [12.3, -7.7],
      [-30.1, 22.4],
      [41, 41],
      [-45, -12],
    ];
    for (const [x, z] of pts) {
      const ray = new RAPIER.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 500, true);
      expect(hit).not.toBeNull();
      const y = 200 - hit!.timeOfImpact;
      // Rapier triangulates each cell; bilinear vs triangle can differ slightly on curved cells.
      expect(Math.abs(y - sampleHeight(hf, x, z))).toBeLessThan(0.15);
    }
  });
});
