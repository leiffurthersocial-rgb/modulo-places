// Turns ScatterResults into InstancedMeshes grouped by spatial cell. Each cell × rule is one
// InstancedMesh whose geometry is swapped between LOD levels as the camera moves (instance data is
// shared across LODs). Three's per-object frustum culling then works per cell (DECISIONS D-007).
import * as THREE from 'three';
import { patchMaterial } from '../render/materials';
import type { QualitySettings } from '../types';
import { buildPlaceholderSpecies, type Species } from './placeholders';
import { STRIDE, type ScatterResult } from './scatter';

const CELL = 32;

interface Cell {
  mesh: THREE.InstancedMesh;
  center: THREE.Vector3;
  radius: number;
  lod: number;
}

interface Group {
  ruleId: string;
  species: Species;
  lodDistances: number[];
  cullDistance: number | undefined;
  cells: Cell[];
  count: number;
}

export interface ScatterStats {
  instances: number;
  visibleInstances: number;
  meshes: number;
  visibleMeshes: number;
}

export class ScatterRenderer {
  readonly root = new THREE.Group();
  private groups: Group[] = [];
  private speciesCache = new Map<string, Species>();
  private quality: QualitySettings;
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  readonly stats: ScatterStats = { instances: 0, visibleInstances: 0, meshes: 0, visibleMeshes: 0 };

  constructor(quality: QualitySettings) {
    this.root.name = 'scatter';
    this.quality = quality;
  }

  private species(id: string): Species {
    let s = this.speciesCache.get(id);
    if (!s) {
      s = buildPlaceholderSpecies(id);
      patchMaterial(s.material, { wind: s.wind, windHeight: s.windHeight, flutter: s.flutter });
      this.speciesCache.set(id, s);
    }
    return s;
  }

  /** Replace all instances (call again after re-scattering, e.g. density change). */
  build(results: ScatterResult[]): void {
    this.clearInstances();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const color = new THREE.Color();
    for (const r of results) {
      if (r.count === 0) continue;
      const sp = this.species(r.rule.mesh);
      const buckets = new Map<string, number[]>();
      for (let i = 0; i < r.count; i++) {
        const x = r.data[i * STRIDE]!;
        const z = r.data[i * STRIDE + 2]!;
        const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = []));
        b.push(i);
      }
      const group: Group = {
        ruleId: r.rule.id,
        species: sp,
        lodDistances: r.rule.lods ?? [25, 60, 120].slice(0, Math.max(0, sp.lods.length - 1)),
        cullDistance: r.rule.cullDistance,
        cells: [],
        count: r.count,
      };
      const base = new THREE.Color(r.rule.color ?? '#ffffff');
      const variation = r.rule.colorVariation ?? 0.15;
      for (const idx of buckets.values()) {
        const mesh = new THREE.InstancedMesh(sp.lods[0]!, sp.material, idx.length);
        mesh.name = `scatter:${r.rule.id}`;
        mesh.castShadow = r.rule.castShadow ?? false;
        mesh.receiveShadow = true;
        idx.forEach((src, j) => {
          const d = r.data.subarray(src * STRIDE, src * STRIDE + STRIDE);
          p.set(d[0]!, d[1]!, d[2]!);
          e.set(d[5]!, d[3]!, d[6]!, 'YXZ');
          q.setFromEuler(e);
          s.setScalar(d[4]!);
          m.compose(p, q, s);
          mesh.setMatrixAt(j, m);
          const v = d[7]!;
          color.copy(base).multiplyScalar(1 - variation + v * variation * 2);
          mesh.setColorAt(j, color);
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        const bs = mesh.boundingSphere!;
        this.root.add(mesh);
        group.cells.push({ mesh, center: bs.center.clone(), radius: bs.radius, lod: 0 });
      }
      this.groups.push(group);
    }
    this.lastCam.set(Infinity, 0, 0);
    this.stats.instances = this.groups.reduce((a, g) => a + g.count, 0);
    this.stats.meshes = this.groups.reduce((a, g) => a + g.cells.length, 0);
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.lastCam.set(Infinity, 0, 0);
  }

  /** LOD + distance culling per cell; cheap enough every frame but skipped if the camera barely moved. */
  update(camera: THREE.Camera, force = false): void {
    const cam = camera.position;
    if (!force && cam.distanceToSquared(this.lastCam) < 0.25) return;
    this.lastCam.copy(cam);
    const q = this.quality;
    const ddScale = q.drawDistance / 160;
    let visInst = 0;
    let visMesh = 0;
    for (const g of this.groups) {
      const cull = Math.min(q.drawDistance, (g.cullDistance ?? 1e9) * ddScale);
      for (const c of g.cells) {
        const d = Math.max(0, cam.distanceTo(c.center) - c.radius);
        const visible = d < cull;
        c.mesh.visible = visible;
        if (!visible) continue;
        visMesh++;
        visInst += c.mesh.count;
        const ld = d / q.lodBias;
        let lod = 0;
        while (lod < g.lodDistances.length && ld > g.lodDistances[lod]!) lod++;
        lod = Math.min(lod, g.species.lods.length - 1);
        if (lod !== c.lod) {
          c.lod = lod;
          c.mesh.geometry = g.species.lods[lod]!;
        }
      }
    }
    this.stats.visibleInstances = visInst;
    this.stats.visibleMeshes = visMesh;
  }

  /** Instances of a rule, for collision proxies. */
  forEachInstance(
    ruleId: string,
    results: ScatterResult[],
    fn: (x: number, y: number, z: number, scale: number) => void,
  ): void {
    const r = results.find((x) => x.rule.id === ruleId);
    if (!r) return;
    for (let i = 0; i < r.count; i++)
      fn(
        r.data[i * STRIDE]!,
        r.data[i * STRIDE + 1]!,
        r.data[i * STRIDE + 2]!,
        r.data[i * STRIDE + 4]!,
      );
  }

  speciesInfo(meshId: string): Species {
    return this.species(meshId);
  }

  private clearInstances(): void {
    for (const g of this.groups) {
      for (const c of g.cells) {
        this.root.remove(c.mesh);
        c.mesh.dispose(); // frees instance buffers; shared geometry/material disposed in dispose()
      }
    }
    this.groups = [];
  }

  dispose(): void {
    this.clearInstances();
    for (const s of this.speciesCache.values()) {
      for (const g of s.lods) g.dispose();
      s.material.dispose();
    }
    this.speciesCache.clear();
  }
}
