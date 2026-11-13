// Pure maths for the creek ribbon: resampling, cross-sections, monotonic water profile, indices.

export type P2 = [number, number];

export interface Station {
  x: number;
  z: number;
  /** Unit tangent (downstream) in XZ. */
  tx: number;
  tz: number;
  /** Distance along the stream (m). */
  s: number;
}

/** Resample a polyline at roughly uniform spacing (always keeps both end points). */
export function resampleUniform(pts: readonly P2[], spacing: number): Station[] {
  const out: Station[] = [];
  if (pts.length < 2) return out;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    cum.push(cum[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[cum.length - 1]!;
  if (total <= 1e-9) return out;
  const n = Math.max(1, Math.round(total / spacing));
  let seg = 0;
  const pos: P2[] = [];
  const ss: number[] = [];
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * total;
    while (seg < pts.length - 2 && cum[seg + 1]! < s) seg++;
    const a = pts[seg]!;
    const b = pts[seg + 1]!;
    const len = cum[seg + 1]! - cum[seg]! || 1e-9;
    const u = Math.min(1, Math.max(0, (s - cum[seg]!) / len));
    pos.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    ss.push(s);
  }
  for (let k = 0; k <= n; k++) {
    const p0 = pos[Math.max(0, k - 1)]!;
    const p1 = pos[Math.min(n, k + 1)]!;
    let tx = p1[0] - p0[0];
    let tz = p1[1] - p0[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    out.push({ x: pos[k]![0], z: pos[k]![1], tx, tz, s: ss[k]! });
  }
  return out;
}

/** Lowest terrain height across a cross-section centred on the station. */
export function minCrossSectionHeight(
  st: Pick<Station, 'x' | 'z' | 'tx' | 'tz'>,
  halfWidth: number,
  samples: number,
  height: (x: number, z: number) => number,
): number {
  const nx = -st.tz;
  const nz = st.tx;
  let m = Infinity;
  const n = Math.max(1, samples);
  for (let i = 0; i <= n; i++) {
    const o = (i / n - 0.5) * 2 * halfWidth;
    m = Math.min(m, height(st.x + nx * o, st.z + nz * o));
  }
  return m;
}

/** Running minimum: result[i] <= result[i-1]. */
export function enforceNonIncreasing(h: readonly number[]): number[] {
  const out: number[] = [];
  let m = Infinity;
  for (const v of h) {
    m = Math.min(m, v);
    out.push(m);
  }
  return out;
}

/** Box-smooth `passes` times, re-enforcing monotonic descent so smoothing never creates uphill flow. */
export function smoothMonotonic(h: readonly number[], radius: number, passes: number): number[] {
  let cur = enforceNonIncreasing(h);
  for (let p = 0; p < passes; p++) {
    const next: number[] = [];
    for (let i = 0; i < cur.length; i++) {
      let sum = 0;
      let c = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(cur.length - 1, i + radius); j++) {
        sum += cur[j]!;
        c++;
      }
      next.push(sum / c);
    }
    cur = enforceNonIncreasing(next);
  }
  return cur;
}

/** Water surface profile: min terrain per section + depth, smoothed, never rising downstream. */
export function waterProfile(
  minTerrain: readonly number[],
  depth: number,
  radius = 3,
  passes = 2,
): number[] {
  return smoothMonotonic(
    minTerrain.map((v) => v + depth),
    radius,
    passes,
  );
}

/** Downstream gradient (positive = steeper drop), per station, clamped to [0, 1.5]. */
export function downstreamSlope(h: readonly number[], s: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < h.length; i++) {
    const a = Math.max(0, i - 2);
    const b = Math.min(h.length - 1, i + 2);
    const ds = (s[b] ?? 0) - (s[a] ?? 0) || 1;
    const g = ((h[a] ?? 0) - (h[b] ?? 0)) / ds;
    out.push(Math.min(1.5, Math.max(0, g)));
  }
  return out;
}

/** Triangle indices for a ribbon of `rows` cross-sections with `cols` vertices each. Faces point up (+Y) for a ribbon whose across axis is tangent rotated +90deg about Y. */
export function ribbonIndices(rows: number, cols: number): number[] {
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
  }
  return idx;
}
