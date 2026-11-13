// Turns ScatterResults into InstancedMeshes grouped by spatial cell (and species variant). Each
// bucket owns one instance-matrix/colour buffer shared by all of its LOD meshes, so switching LOD
// only toggles which (lazily created) meshes are visible — no buffer re-upload. Three's per-object
// frustum culling then works per cell (DECISIONS D-007 / D-018).
import * as THREE from 'three';
import type { QualitySettings, ScatterRuleDef } from '../types';
import { STRIDE, type ScatterResult } from './scatter';
import { disposeSpecies, placeholderSpecies, type Species, type SpeciesPart } from './species';

const CELL = 32;

interface Bucket {
  count: number;
  matrices: THREE.InstancedBufferAttribute;
  colors: THREE.InstancedBufferAttribute;
  sphere: THREE.Sphere;
  /** lodMeshes[lod] = meshes for that LOD's parts (created on first use). */
  lodMeshes: (THREE.InstancedMesh[] | undefined)[];
  lod: number;
  variant: number;
}

interface Group {
  rule: ScatterRuleDef;
  species: Species;
  lodDistances: number[];
  buckets: Bucket[];
  count: number;
}

export interface ScatterStats {
  instances: number;
  visibleInstances: number;
  meshes: number;
  visibleMeshes: number;
}

export type SpeciesResolver = (meshId: string) => Species | null;

export class ScatterRenderer {
  readonly root = new THREE.Group();
  private groups: Group[] = [];
  private speciesCache = new Map<string, Species>();
  private quality: QualitySettings;
  private lastCam = new THREE.Vector3(Infinity, 0, 0);
  readonly stats: ScatterStats = { instances: 0, visibleInstances: 0, meshes: 0, visibleMeshes: 0 };

  constructor(
    quality: QualitySettings,
    private resolve: SpeciesResolver = () => null,
  ) {
    this.root.name = 'scatter';
    this.quality = quality;
  }

  species(id: string): Species {
    let s = this.speciesCache.get(id);
    if (!s) {
      s = this.resolve(id) ?? placeholderSpecies(id);
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
      const nVar = sp.variants.length;
      const lodCount = sp.variants[0]!.length + (sp.impostor ? 1 : 0);
      const buckets = new Map<string, number[]>();
      for (let i = 0; i < r.count; i++) {
        const x = r.data[i * STRIDE]!;
        const z = r.data[i * STRIDE + 2]!;
        const v = Math.min(nVar - 1, Math.floor(r.data[i * STRIDE + 7]! * nVar));
        const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)},${v}`;
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = []));
        b.push(i);
      }
      const defaults = [25, 60, 120, 400];
      const group: Group = {
        rule: r.rule,
        species: sp,
        lodDistances: (r.rule.lods ?? defaults).slice(0, Math.max(0, lodCount - 1)),
        buckets: [],
        count: r.count,
      };
      const base = new THREE.Color(r.rule.color ?? '#ffffff');
      const variation = r.rule.colorVariation ?? 0.1;
      for (const [key, idx] of buckets) {
        const variant = Number(key.split(',')[2]);
        const matrices = new THREE.InstancedBufferAttribute(new Float32Array(idx.length * 16), 16);
        const colors = new THREE.InstancedBufferAttribute(new Float32Array(idx.length * 3), 3);
        const box = new THREE.Box3();
        idx.forEach((src, j) => {
          const d = r.data.subarray(src * STRIDE, src * STRIDE + STRIDE);
          p.set(d[0]!, d[1]!, d[2]!);
          e.set(d[5]!, d[3]!, d[6]!, 'YXZ');
          q.setFromEuler(e);
          s.setScalar(d[4]!);
          m.compose(p, q, s);
          m.toArray(matrices.array, j * 16);
          const v = (d[7]! * 7.31) % 1; // decorrelate from the variant choice
          color.copy(base).multiplyScalar(1 - variation + v * variation * 2);
          color.toArray(colors.array, j * 3);
          box.expandByPoint(p);
          box.expandByPoint(p.clone().setY(p.y + sp.height * d[4]!));
        });
        box.expandByScalar(sp.radius * (r.rule.scale[1] ?? 1));
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        group.buckets.push({
          count: idx.length,
          matrices,
          colors,
          sphere,
          lodMeshes: [],
          lod: -1,
          variant,
        });
      }
      this.groups.push(group);
    }
    this.lastCam.set(Infinity, 0, 0);
    this.stats.instances = this.groups.reduce((a, g) => a + g.count, 0);
    this.stats.meshes = this.groups.reduce((a, g) => a + g.buckets.length, 0);
  }

  private meshesFor(g: Group, b: Bucket, lod: number): THREE.InstancedMesh[] {
    let list = b.lodMeshes[lod];
    if (list) return list;
    const geoLods = g.species.variants[b.variant]!;
    const parts: SpeciesPart[] =
      lod < geoLods.length ? geoLods[lod]! : (g.species.impostor ?? geoLods[geoLods.length - 1]!);
    list = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, b.count);
      mesh.instanceMatrix = b.matrices;
      mesh.instanceColor = b.colors;
      mesh.boundingSphere = b.sphere;
      mesh.castShadow = (g.rule.castShadow ?? false) && part.castShadow && lod < geoLods.length;
      mesh.receiveShadow = true;
      mesh.name = `scatter:${g.rule.id}:v${b.variant}:lod${lod}`;
      mesh.visible = false;
      this.root.add(mesh);
      return mesh;
    });
    b.lodMeshes[lod] = list;
    return list;
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.lastCam.set(Infinity, 0, 0);
  }

  /** LOD + distance culling per bucket; skipped if the camera barely moved. */
  update(camera: THREE.Camera, force = false): void {
    const cam = camera.position;
    if (!force && cam.distanceToSquared(this.lastCam) < 0.25) return;
    this.lastCam.copy(cam);
    const q = this.quality;
    const ddScale = q.drawDistance / 160;
    let visInst = 0;
    let visMesh = 0;
    for (const g of this.groups) {
      const cull = Math.min(q.drawDistance, (g.rule.cullDistance ?? 1e9) * ddScale);
      const maxLod = g.species.variants[0]!.length - 1 + (g.species.impostor ? 1 : 0);
      for (const b of g.buckets) {
        const d = Math.max(0, cam.distanceTo(b.sphere.center) - b.sphere.radius);
        const visible = d < cull;
        let lod = -1;
        if (visible) {
          const ld = d / q.lodBias;
          lod = 0;
          while (lod < g.lodDistances.length && ld > g.lodDistances[lod]!) lod++;
          lod = Math.min(lod, maxLod);
        }
        if (lod !== b.lod) {
          if (b.lod >= 0) for (const mesh of b.lodMeshes[b.lod] ?? []) mesh.visible = false;
          if (lod >= 0) for (const mesh of this.meshesFor(g, b, lod)) mesh.visible = true;
          b.lod = lod;
        }
        if (visible) {
          visMesh += b.lodMeshes[lod]?.length ?? 0;
          visInst += b.count;
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
      for (const b of g.buckets) {
        for (const list of b.lodMeshes) for (const mesh of list ?? []) this.root.remove(mesh);
        // Shared geometry/material belong to the species; instance buffers are freed with the
        // meshes' WebGL attributes when the attribute objects are garbage collected — dispose
        // explicitly via a throwaway mesh so WebGL buffers are released now.
        const anyMesh = b.lodMeshes.find((l) => l && l.length > 0)?.[0];
        anyMesh?.dispose();
      }
    }
    this.groups = [];
  }

  dispose(): void {
    this.clearInstances();
    for (const s of this.speciesCache.values()) disposeSpecies(s);
    this.speciesCache.clear();
  }
}
