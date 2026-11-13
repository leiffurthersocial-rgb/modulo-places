import { describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';

describe('toolchain', () => {
  it('loads Rapier WASM under Node', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    expect(world.gravity.y).toBeCloseTo(-9.81);
  });
});
