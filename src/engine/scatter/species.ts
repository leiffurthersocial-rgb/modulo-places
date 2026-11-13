// Scatter species: what gets instanced. A species has variants (e.g. the rocks of a rock set), each
// with an LOD chain, each LOD made of parts (one per material: bark, needles, …). Built either
// from a processed GLB (LOD0..LODn nodes, see scripts/process-assets.ts) or from the greybox
// placeholders.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchMaterial } from '../render/materials';
import { buildPlaceholderSpecies } from './placeholders';

export interface SpeciesPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow: boolean;
}

export interface Species {
  /** variants[v][lod] = parts */
  variants: SpeciesPart[][][];
  /** Max variant height / footprint radius at scale 1 (m). */
  height: number;
  radius: number;
  /** Optional far LOD shown beyond the last geometry LOD (one part, no shadows). */
  impostor?: SpeciesPart[] | null;
  /** Everything this species owns (disposed with it). */
  owned: (THREE.BufferGeometry | THREE.Material)[];
}

export function placeholderSpecies(id: string): Species {
  const p = buildPlaceholderSpecies(id);
  patchMaterial(p.material, { wind: p.wind, windHeight: p.windHeight, flutter: p.flutter });
  return {
    variants: [p.lods.map((g) => [{ geometry: g, material: p.material, castShadow: true }])],
    height: p.height,
    radius: p.radius,
    owned: [...p.lods, p.material],
  };
}

const FOLIAGE = /leaf|leaves|needle|foliage|branch|twig|grass|fern|nettle|weed|moss|shrub|frond/i;

export function isFoliage(m: THREE.Material): boolean {
  const s = m as THREE.MeshStandardMaterial;
  return s.alphaTest > 0 || s.transparent || !!s.alphaMap || FOLIAGE.test(m.name);
}

export interface ModelSpeciesOptions {
  /** Main-bend sway amplitude (m at the top) — applied to every part so foliage stays attached. */
  wind: number;
  /** Extra leaf flutter on foliage parts (m). */
  flutter: number;
  alphaToCoverage: boolean;
  /** Treat the whole model as one variant even if LOD groups have several children. */
  single?: boolean;
}

/** Build a species from a processed GLB scene (children "LOD0", "LOD1", …). */
export function speciesFromGltf(root: THREE.Object3D, o: ModelSpeciesOptions): Species {
  root.updateMatrixWorld(true);
  const lodGroups = root.children
    .filter((c) => /^LOD\d+$/.test(c.name))
    .sort((a, b) => Number(a.name.slice(3)) - Number(b.name.slice(3)));
  const groups = lodGroups.length > 0 ? lodGroups : [root];
  const nVariants = o.single ? 1 : Math.max(1, Math.min(...groups.map((g) => g.children.length)));
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];
  const materials = new Map<THREE.Material, THREE.Material>();
  let height = 0;
  let radius = 0;

  // First pass: per-variant reference frames from LOD0 (so every LOD shares the same pivot).
  const frames: THREE.Matrix4[] = [];
  for (let v = 0; v < nVariants; v++) {
    const node = o.single ? groups[0]! : groups[0]!.children[v]!;
    const box = new THREE.Box3().setFromObject(node);
    const c = box.getCenter(new THREE.Vector3());
    frames.push(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
    const size = box.getSize(new THREE.Vector3());
    height = Math.max(height, size.y);
    radius = Math.max(radius, Math.max(size.x, size.z) / 2);
  }

  const patchedFor = (m: THREE.Material): THREE.Material => {
    let out = materials.get(m);
    if (out) return out;
    out = m.clone();
    const foliage = isFoliage(out);
    const s = out as THREE.MeshStandardMaterial;
    if (foliage) {
      s.side = THREE.DoubleSide;
      s.transparent = false;
      s.alphaTest = Math.max(s.alphaTest, 0.45);
      s.alphaToCoverage = o.alphaToCoverage;
      s.forceSinglePass = true;
    }
    patchMaterial(out, {
      wind: o.wind,
      windHeight: Math.max(0.5, height),
      flutter: foliage ? o.flutter : 0,
    });
    materials.set(m, out);
    owned.push(out);
    return out;
  };

  const variants: SpeciesPart[][][] = [];
  for (let v = 0; v < nVariants; v++) {
    const lods: SpeciesPart[][] = [];
    for (const g of groups) {
      const node = o.single ? g : g.children[v];
      if (!node) continue;
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      node.traverse((x) => {
        const mesh = x as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const geo = mesh.geometry.clone();
        geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(frames[v]!, mesh.matrixWorld));
        if (mats.length > 1 && geo.groups.length > 1) {
          // Split multi-material meshes by group.
          for (const grp of geo.groups) {
            const sub = geo.clone();
            sub.clearGroups();
            sub.setDrawRange(grp.start, grp.count);
            const m = mats[grp.materialIndex ?? 0]!;
            const list = byMat.get(m) ?? [];
            list.push(sub);
            byMat.set(m, list);
          }
          return;
        }
        const list = byMat.get(mats[0]!) ?? [];
        list.push(geo);
        byMat.set(mats[0]!, list);
      });
      const parts: SpeciesPart[] = [];
      for (const [m, geos] of byMat) {
        const merged = geos.length === 1 ? geos[0]! : (mergeGeometries(geos, false) ?? geos[0]!);
        merged.computeBoundingSphere();
        owned.push(merged);
        const pm = patchedFor(m);
        parts.push({ geometry: merged, material: pm, castShadow: true });
      }
      lods.push(parts);
    }
    variants.push(lods);
  }
  return { variants, height, radius, owned };
}

export function disposeSpecies(s: Species): void {
  for (const x of s.owned) x.dispose();
}
