import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Heightfield } from './heightfield';

type Rapier = typeof RAPIER_NS;

/**
 * Rapier heightfields take an (nrows+1) x (ncols+1) matrix in column-major order, centred on the
 * collider origin, with rows along Z and columns along X. Our heightfield is row-major
 * (index = iz * res + ix). Verified by tests/unit/rapier-heightfield.test.ts.
 */
export function rapierHeightfieldDesc(R: Rapier, hf: Heightfield): RAPIER_NS.ColliderDesc {
  const n = hf.res - 1;
  const data = new Float32Array(hf.res * hf.res);
  // Column-major: element (row=iz, col=ix) at ix * (nrows+1) + iz.
  for (let iz = 0; iz < hf.res; iz++) {
    for (let ix = 0; ix < hf.res; ix++) {
      data[ix * hf.res + iz] = hf.heights[iz * hf.res + ix]!;
    }
  }
  return R.ColliderDesc.heightfield(n, n, data, { x: hf.size, y: 1, z: hf.size }).setFriction(0.8);
}
