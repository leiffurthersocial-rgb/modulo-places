// Procedural species (DECISIONS D-031): conifers and saplings built from scanned bark + branch-card
// atlases baked from real twig scans, and fallen logs. Scatter rules reference them as
//   "conifer:fir" | "conifer:pine" | "conifer:fir-sapling" | "conifer:pine-sapling" | "log:<bark>"
import * as THREE from 'three';
import type { AssetLoader, Tier } from '../assets/AssetLoader';
import { patchMaterial } from '../render/materials';
import { buildConifer, buildLog, createConiferMaterials, type BuiltModel } from './conifer';
import type { Species } from './species';

export interface ProceduralOptions {
  tier: Tier;
  anisotropy: number;
  alphaToCoverage: boolean;
  wind: number;
  flutter: number;
  /** Bark material keys per kind (scene-specific variety). */
  barks: { fir: string; pine: string; log: string; moss: string };
}

/** Variant heights (m) at instance scale 1 — instance scale adds further variety. */
const HEIGHTS: Record<string, number[]> = {
  fir: [18, 21, 24],
  pine: [20, 23.5, 27],
  'fir-sapling': [1.6, 2.5, 3.6],
  'pine-sapling': [1.5, 2.4, 3.4],
};

function toSpecies(variants: BuiltModel[][], owned: (THREE.BufferGeometry | THREE.Material)[]): Species {
  let height = 0;
  let radius = 0;
  for (const lods of variants) {
    height = Math.max(height, lods[0]!.height);
    radius = Math.max(radius, lods[0]!.radius);
    for (const m of lods) for (const p of m.parts) owned.push(p.geometry);
  }
  return {
    variants: variants.map((lods) => lods.map((m) => m.parts.map((p) => ({ geometry: p.geometry, material: p.material, castShadow: true })))),
    height,
    radius,
    owned,
  };
}

export async function buildProceduralSpecies(meshId: string, assets: AssetLoader, o: ProceduralOptions): Promise<Species | null> {
  const [kind, name = ''] = meshId.split(':') as [string, string?];
  if (kind === 'conifer') {
    const base = name.startsWith('pine') ? 'pine' : 'fir';
    const sapling = name.endsWith('sapling');
    const [bark, foliage] = await Promise.all([assets.material(o.barks[base], o.tier, o.anisotropy), assets.foliage(base, o.anisotropy)]);
    if (!bark || !foliage) return null;
    const mats = createConiferMaterials({ bark, ...foliage }, o.alphaToCoverage);
    const heights = HEIGHTS[name] ?? HEIGHTS[base]!;
    const windHeight = Math.max(...heights);
    // Bark and needles share the main bend so the crown stays attached to the trunk.
    patchMaterial(mats.bark, { wind: o.wind, windHeight, key: `conifer-bark-${base}` });
    patchMaterial(mats.foliage, { wind: o.wind, windHeight, flutter: o.flutter, key: `conifer-foliage-${base}` });
    const variants = heights.map((h, v) =>
      ([0, 1, 2] as const).map((lod) => buildConifer({ kind: base, height: h, seed: 101 + v * 977, lod, sapling }, mats)),
    );
    return toSpecies(variants, [mats.bark, mats.foliage]);
  }
  if (kind === 'log') {
    const [bark, moss] = await Promise.all([assets.material(o.barks.log, o.tier, o.anisotropy), assets.material(o.barks.moss, o.tier, o.anisotropy)]);
    if (!bark) return null;
    const barkMat = new THREE.MeshStandardMaterial({ map: bark.map, normalMap: bark.normalMap, roughnessMap: bark.armMap, aoMap: bark.armMap, roughness: 1, metalness: 0, vertexColors: true });
    const mossMat = moss ? new THREE.MeshStandardMaterial({ map: moss.map, normalMap: moss.normalMap, roughness: 0.95, metalness: 0 }) : undefined;
    const sizes = [
      { length: 5, radius: 0.24 },
      { length: 7, radius: 0.32 },
      { length: 9, radius: 0.38 },
    ];
    const owned: (THREE.BufferGeometry | THREE.Material)[] = [barkMat];
    if (mossMat) owned.push(mossMat);
    const patched = new Set<THREE.Material>();
    const variants = sizes.map((s, v) =>
      ([0, 1, 2] as const).map((lod) => {
        const m = buildLog({ ...s, seed: 31 + v * 613, lod }, barkMat, mossMat);
        for (const p of m.parts) {
          if (!patched.has(p.material)) {
            patched.add(p.material);
            if (p.material !== barkMat && p.material !== mossMat) owned.push(p.material);
            patchMaterial(p.material, { key: 'log' });
          }
        }
        return m;
      }),
    );
    return toSpecies(variants, owned);
  }
  return null;
}
