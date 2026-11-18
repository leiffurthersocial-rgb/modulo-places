// Grid navigation for NPCs: 0.1 m occupancy grid rasterised from static colliders (inflated by the
// agent radius), A* with octile heuristic and no corner cutting, then line-of-sight string pulling.
// Dynamic obstacles (a moved chair, dropped papers) are an overlay that bumps `version`. Pure TS.
import { type Box, pointInBox, type V2 } from './geom';

export class NavGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly radius: number;
  private base: Uint8Array;
  private dyn: Uint16Array;
  private dynBoxes = new Map<string, Box>();
  /** Increments whenever blocking changes; cached paths compare against it. */
  version = 0;

  constructor(width: number, depth: number, colliders: Box[], radius = 0.25, cell = 0.1) {
    this.cell = cell;
    this.radius = radius;
    this.cols = Math.ceil(width / cell);
    this.rows = Math.ceil(depth / cell);
    this.base = new Uint8Array(this.cols * this.rows);
    this.dyn = new Uint16Array(this.cols * this.rows);
    for (const b of colliders) this.raster(b, (i) => (this.base[i] = 1));
  }

  private raster(b: Box, fn: (i: number) => void): void {
    const r = Math.hypot(b.hx, b.hz) + this.radius;
    const c0 = Math.max(0, Math.floor((b.cx - r) / this.cell));
    const c1 = Math.min(this.cols - 1, Math.ceil((b.cx + r) / this.cell));
    const r0 = Math.max(0, Math.floor((b.cz - r) / this.cell));
    const r1 = Math.min(this.rows - 1, Math.ceil((b.cz + r) / this.cell));
    for (let rz = r0; rz <= r1; rz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const x = (cx + 0.5) * this.cell;
        const z = (rz + 0.5) * this.cell;
        if (pointInBox(b, x, z, this.radius)) fn(rz * this.cols + cx);
      }
    }
  }

  setDynamic(id: string, box: Box | null): void {
    const old = this.dynBoxes.get(id);
    if (old) this.raster(old, (i) => (this.dyn[i] = Math.max(0, this.dyn[i]! - 1)));
    if (box) {
      this.dynBoxes.set(id, box);
      this.raster(box, (i) => (this.dyn[i] = this.dyn[i]! + 1));
    } else this.dynBoxes.delete(id);
    this.version++;
  }

  cellOf(p: V2): [number, number] {
    return [
      Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / this.cell))),
      Math.min(this.rows - 1, Math.max(0, Math.floor(p.z / this.cell))),
    ];
  }

  blocked(c: number, r: number): boolean {
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return true;
    const i = r * this.cols + c;
    return this.base[i]! > 0 || this.dyn[i]! > 0;
  }

  walkable(p: V2): boolean {
    const [c, r] = this.cellOf(p);
    return !this.blocked(c, r);
  }

  /** Nearest walkable cell centre (spiral search), or null. */
  nearestWalkable(p: V2, maxRing = 15): V2 | null {
    const [c, r] = this.cellOf(p);
    if (!this.blocked(c, r)) return p;
    for (let k = 1; k <= maxRing; k++) {
      let best: V2 | null = null;
      let bestD = Infinity;
      for (let dz = -k; dz <= k; dz++) {
        for (let dx = -k; dx <= k; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== k) continue;
          if (this.blocked(c + dx, r + dz)) continue;
          const q = { x: (c + dx + 0.5) * this.cell, z: (r + dz + 0.5) * this.cell };
          const d = Math.hypot(q.x - p.x, q.z - p.z);
          if (d < bestD) {
            bestD = d;
            best = q;
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** Straight walkable line between two points (sampled every half cell). */
  lineClear(a: V2, b: V2): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / (this.cell * 0.5)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [c, r] = this.cellOf({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      if (this.blocked(c, r)) return false;
    }
    return true;
  }

  /** A* from a to b. Returns smoothed waypoints (excluding a, including b) or null. */
  findPath(a: V2, b: V2): V2[] | null {
    const start = this.nearestWalkable(a);
    const goal = this.nearestWalkable(b);
    if (!start || !goal) return null;
    const [sc, sr] = this.cellOf(start);
    const [gc, gr] = this.cellOf(goal);
    const N = this.cols * this.rows;
    const g = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    const si = sr * this.cols + sc;
    const gi = gr * this.cols + gc;
    g[si] = 0;
    heap.push(si, this.h(sc, sr, gc, gr));
    const SQ2 = Math.SQRT2;
    let found = false;
    let iters = 0;
    while (heap.size > 0 && iters++ < 40000) {
      const cur = heap.pop();
      if (cur === gi) {
        found = true;
        break;
      }
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cc = cur % this.cols;
      const cr = (cur - cc) / this.cols;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nc = cc + dx;
          const nr = cr + dz;
          if (this.blocked(nc, nr)) continue;
          if (dx && dz && (this.blocked(cc + dx, cr) || this.blocked(cc, cr + dz))) continue;
          const ni = nr * this.cols + nc;
          if (closed[ni]) continue;
          const ng = g[cur]! + (dx && dz ? SQ2 : 1);
          if (ng < g[ni]!) {
            g[ni] = ng;
            came[ni] = cur;
            heap.push(ni, ng + this.h(nc, nr, gc, gr));
          }
        }
      }
    }
    if (!found) return null;
    const cells: V2[] = [];
    for (let i = gi; i !== -1 && i !== si; i = came[i]!) {
      const c = i % this.cols;
      const r = (i - c) / this.cols;
      cells.push({ x: (c + 0.5) * this.cell, z: (r + 0.5) * this.cell });
    }
    cells.reverse();
    if (cells.length) cells[cells.length - 1] = goal;
    else cells.push(goal);
    return this.smooth(start, cells);
  }

  private h(c: number, r: number, gc: number, gr: number): number {
    const dx = Math.abs(c - gc);
    const dz = Math.abs(r - gr);
    return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
  }

  private smooth(start: V2, pts: V2[]): V2[] {
    const out: V2[] = [];
    let anchor = start;
    let i = 0;
    while (i < pts.length) {
      let j = pts.length - 1;
      while (j > i && !this.lineClear(anchor, pts[j]!)) j--;
      out.push(pts[j]!);
      anchor = pts[j]!;
      i = j + 1;
    }
    return out;
  }
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      ids[i] = ids[p]!;
      keys[i] = keys[p]!;
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0]!;
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r]! < keys[l]! ? r : l;
        if (keys[c]! >= lastKey) break;
        ids[i] = ids[c]!;
        keys[i] = keys[c]!;
        i = c;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}
