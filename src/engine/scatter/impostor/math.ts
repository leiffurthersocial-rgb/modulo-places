// Pure maths for the yaw-ring impostor: view selection, blend weights, atlas layout, view frames.
// The GLSL in Impostor.ts mirrors these formulas exactly (keep them in sync).

export const TAU = Math.PI * 2;

export interface AtlasGrid {
  cols: number;
  rows: number;
}

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface ViewBlend {
  i0: number;
  i1: number;
  /** Weight of view i1 (view i0 gets 1 - w). */
  w: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Grid with the fewest cells for `views`, ties broken towards the squarest atlas. */
export function atlasGrid(views: number, aspect = 1): AtlasGrid {
  const n = Math.max(1, Math.floor(views));
  let best: AtlasGrid = { cols: n, rows: 1 };
  let bestCells = Infinity;
  let bestSkew = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    if (cols < rows) continue; // atlases are wider than tall
    const cells = cols * rows;
    const skew = Math.abs(Math.log((cols * 1) / (rows * aspect)));
    if (cells < bestCells || (cells === bestCells && skew < bestSkew)) {
      best = { cols, rows };
      bestCells = cells;
      bestSkew = skew;
    }
  }
  return best;
}

/** UV rect of a view cell. Row 0 is the bottom row (GL origin); insets are in cell-UV fractions. */
export function atlasRect(index: number, grid: AtlasGrid, insetU = 0, insetV = 0): UvRect {
  const col = index % grid.cols;
  const row = Math.floor(index / grid.cols);
  const cw = 1 / grid.cols;
  const ch = 1 / grid.rows;
  return {
    u0: (col + insetU) * cw,
    v0: (row + insetV) * ch,
    u1: (col + 1 - insetU) * cw,
    v1: (row + 1 - insetV) * ch,
  };
}

/** Azimuth (radians) of baked view `index`: camera direction in object space is (sin a, ., cos a). */
export function viewAzimuth(index: number, views: number): number {
  return (index / views) * TAU;
}

/** Camera azimuth in the object's local frame, given the camera offset from the instance and its yaw. */
export function localAzimuth(dx: number, dz: number, yaw: number): number {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const lx = c * dx - s * dz;
  const lz = s * dx + c * dz;
  return Math.atan2(lx, lz);
}

/** Two nearest views around the ring and the blend weight of the second. */
export function selectViews(azimuth: number, views: number): ViewBlend {
  let f = (azimuth / TAU) * views;
  f -= views * Math.floor(f / views);
  let i0 = Math.floor(f);
  if (i0 >= views) i0 = views - 1;
  const w = f - i0;
  return { i0, i1: (i0 + 1) % views, w };
}

export interface ViewFrame {
  right: Vec3Like;
  up: Vec3Like;
  /** Direction from the object towards the camera. */
  back: Vec3Like;
}

/** Orthonormal camera frame of a bake view (azimuth a, elevation e above the horizon). */
export function viewFrame(azimuth: number, elevation: number): ViewFrame {
  const sa = Math.sin(azimuth);
  const ca = Math.cos(azimuth);
  const se = Math.sin(elevation);
  const ce = Math.cos(elevation);
  return {
    right: { x: ca, y: 0, z: -sa },
    up: { x: -se * sa, y: ce, z: -se * ca },
    back: { x: sa * ce, y: se, z: ca * ce },
  };
}

/** Billboard-plane vertical coordinate extents of an object of radius r and height h seen at elevation e. */
export function projectedExtent(
  radius: number,
  height: number,
  elevation: number,
): { vMin: number; vMax: number } {
  const se = Math.sin(elevation);
  const ce = Math.cos(elevation);
  return { vMin: -radius * se, vMax: height * ce + radius * se };
}
