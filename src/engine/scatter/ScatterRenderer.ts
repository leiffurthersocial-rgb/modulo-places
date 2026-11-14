// Instanced scatter rendering with per-instance LOD and culling.
//
// For every rule × variant × LOD there is one set of InstancedMeshes (one per material part). When
// the camera moves or turns enough, each instance is distance-culled, tested against a widened
// view frustum and assigned an LOD; its precomputed matrix is copied into that LOD's buffer.
// Draw calls are therefore parts × LODs × variants per rule — independent of instance count and
// of how the instances are spread (DECISIONS D-028, replacing the cell buckets of D-018).
import * as THREE from 'three';
import type { QualitySettings, ScatterRuleDef } from '../types';
import { STRIDE, type ScatterResult } from './scatter';
import { disposeSpecies, placeholderSpecies, type Species, type SpeciesPart } from './species';

interface LodBatch {
  meshes: THREE.InstancedMesh[];
  matrices: THREE.InstancedBufferAttribute;
  colors: THREE.InstancedBufferAttribute;
  count: number;
}

interface Group {
  rule: ScatterRuleDef;
  species: Species;
  lodDistances: number[];
  n: number;
  pos: Float32Array; // bounding-sphere centre per instance
  radius: Float32Array; // bounding radius per instance (m)
  matrices: Float32Array; // 16 per instance
  colors: Float32Array; // 3 per instance
  variant: Uint8Array;
  /** batches[variant][lod] */
  batches: (LodBatch | undefined)[][];
}

export interface ScatterStats {
  instances: number;
  visibleInstances: number;
  meshes: number;
  visibleMeshes: number;
}

export type SpeciesResolver = (meshId: string) => Species | null;

const _frustum = new THREE.Frustum();
const _proj = new THREE.Matrix4();
const _wideCam = new THREE.PerspectiveCamera();
const _sphere = new THREE.Sphere();
const _dir = new THREE.Vector3();

export class ScatterRenderer {
  readonly root = new THREE.Group();
  private groups: Group[] = [];
  private speciesCache = new Map<string, Species>();
  private quality: QualitySettings;
  private lastPos = new THREE.Vector3(Infinity, 0, 0);
  private lastDir = new THREE.Vector3();
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
      const n = r.count;
      const g: Group = {
        rule: r.rule,
        species: sp,
        lodDistances: (r.rule.lods ?? [25, 60, 120, 400]).slice(0, Math.max(0, lodCount - 1)),
        n,
        pos: new Float32Array(n * 3),
        radius: new Float32Array(n),
        matrices: new Float32Array(n * 16),
        colors: new Float32Array(n * 3),
        variant: new Uint8Array(n),
        batches: sp.variants.map(() => []),
      };
      const base = new THREE.Color(r.rule.color ?? '#ffffff');
      const variation = r.rule.colorVariation ?? 0.1;
      const extent = Math.max(sp.height, sp.radius * 2);
      for (let i = 0; i < n; i++) {
        const d = r.data.subarray(i * STRIDE, i * STRIDE + STRIDE);
        p.set(d[0]!, d[1]!, d[2]!);
        e.set(d[5]!, d[3]!, d[6]!, 'YXZ');
        q.setFromEuler(e);
        s.setScalar(d[4]!);
        m.compose(p, q, s);
        m.toArray(g.matrices, i * 16);
        const v = (d[7]! * 7.31) % 1; // decorrelate tint from the variant choice
        color.copy(base).multiplyScalar(1 - variation + v * variation * 2);
        color.toArray(g.colors, i * 3);
        g.pos[i * 3] = d[0]!;
        g.pos[i * 3 + 1] = d[1]! + sp.height * d[4]! * 0.5;
        g.pos[i * 3 + 2] = d[2]!;
        g.radius[i] = extent * 0.6 * d[4]!;
        g.variant[i] = Math.min(nVar - 1, Math.floor(d[7]! * nVar));
      }
      this.groups.push(g);
    }
    this.lastPos.set(Infinity, 0, 0);
    this.stats.instances = this.groups.reduce((a, g) => a + g.n, 0);
  }

  private batch(g: Group, variant: number, lod: number): LodBatch {
    const existing = g.batches[variant]![lod];
    if (existing) return existing;
    let cap = 0;
    for (let i = 0; i < g.n; i++) if (g.variant[i] === variant) cap++;
    cap = Math.max(1, cap);
    const matrices = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    matrices.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    const geoLods = g.species.variants[variant]!;
    const isImpostor = lod >= geoLods.length;
    const parts: SpeciesPart[] = isImpostor
      ? (g.species.impostor ?? geoLods[geoLods.length - 1]!)
      : geoLods[lod]!;
    const meshes = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, cap);
      mesh.instanceMatrix = matrices;
      mesh.instanceColor = colors;
      mesh.frustumCulled = false; // culled per instance in update()
      mesh.castShadow = (g.rule.castShadow ?? false) && part.castShadow && !isImpostor;
      mesh.receiveShadow = true;
      mesh.name = `scatter:${g.rule.id}:v${variant}:lod${lod}`;
      mesh.count = 0;
      mesh.visible = false;
      this.root.add(mesh);
      return mesh;
    });
    const b: LodBatch = { meshes, matrices, colors, count: 0 };
    g.batches[variant]![lod] = b;
    return b;
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.lastPos.set(Infinity, 0, 0);
  }

  /** Re-batch when the camera moved > 0.75 m or turned > ~4°, or when forced. */
  update(camera: THREE.Camera, force = false): void {
    const cam = camera as THREE.PerspectiveCamera;
    cam.getWorldDirection(_dir);
    if (
      !force &&
      cam.position.distanceToSquared(this.lastPos) < 0.56 &&
      _dir.dot(this.lastDir) > 0.9975
    )
      return;
    this.lastPos.copy(cam.position);
    this.lastDir.copy(_dir);

    // Widened frustum: the margin absorbs small turns between updates and keeps nearby
    // off-screen shadow casters (their shadows can still fall into view).
    _wideCam.copy(cam);
    _wideCam.fov = Math.min(170, cam.fov * 1.35);
    _wideCam.aspect = cam.aspect * 1.15;
    _wideCam.clearViewOffset();
    _wideCam.updateProjectionMatrix();
    _wideCam.updateMatrixWorld();
    _proj.multiplyMatrices(_wideCam.projectionMatrix, _wideCam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_proj);

    const q = this.quality;
    const ddScale = q.drawDistance / 160;
    const cx = cam.position.x;
    const cy = cam.position.y;
    const cz = cam.position.z;
    const nearKeep2 = 12 * 12; // always keep very close instances (shadows behind the camera)
    let visInst = 0;
    let visMesh = 0;
    let meshes = 0;
    for (const g of this.groups) {
      const cull = Math.min(q.drawDistance, (g.rule.cullDistance ?? 1e9) * ddScale);
      const cull2 = cull * cull;
      const maxLod = g.species.variants[0]!.length - 1 + (g.species.impostor ? 1 : 0);
      const lodD2 = g.lodDistances.map((d) => (d * q.lodBias) ** 2);
      for (const vb of g.batches) for (const b of vb) if (b) b.count = 0;
      for (let i = 0; i < g.n; i++) {
        const x = g.pos[i * 3]!;
        const y = g.pos[i * 3 + 1]!;
        const z = g.pos[i * 3 + 2]!;
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > cull2) continue;
        if (d2 > nearKeep2) {
          _sphere.center.set(x, y, z);
          _sphere.radius = g.radius[i]!;
          if (!_frustum.intersectsSphere(_sphere)) continue;
        }
        let lod = 0;
        while (lod < lodD2.length && d2 > lodD2[lod]!) lod++;
        if (lod > maxLod) lod = maxLod;
        const b = this.batch(g, g.variant[i]!, lod);
        (b.matrices.array as Float32Array).set(
          g.matrices.subarray(i * 16, i * 16 + 16),
          b.count * 16,
        );
        (b.colors.array as Float32Array).set(g.colors.subarray(i * 3, i * 3 + 3), b.count * 3);
        b.count++;
        visInst++;
      }
      for (const vb of g.batches) {
        for (const b of vb) {
          if (!b) continue;
          meshes += b.meshes.length;
          const on = b.count > 0;
          for (const mesh of b.meshes) {
            mesh.count = b.count;
            mesh.visible = on;
          }
          if (on) {
            visMesh += b.meshes.length;
            b.matrices.clearUpdateRanges();
            b.matrices.addUpdateRange(0, b.count * 16);
            b.matrices.needsUpdate = true;
            b.colors.clearUpdateRanges();
            b.colors.addUpdateRange(0, b.count * 3);
            b.colors.needsUpdate = true;
          }
        }
      }
    }
    this.stats.visibleInstances = visInst;
    this.stats.visibleMeshes = visMesh;
    this.stats.meshes = meshes;
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
      for (const vb of g.batches) {
        for (const b of vb) {
          if (!b) continue;
          for (const mesh of b.meshes) this.root.remove(mesh);
          b.meshes[0]?.dispose(); // releases the shared instance buffers' GL objects
        }
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
