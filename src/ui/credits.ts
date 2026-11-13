import assetCredits from '../data/asset-credits.json';
export interface CreditEntry {
  name: string;
  /** Role or source of the credit. */
  role: string;
  license: string;
  url?: string;
}

export const CREDITS: CreditEntry[] = [
  { name: 'three.js', role: '3D rendering library', license: 'MIT', url: 'https://threejs.org' },
  {
    name: 'pmndrs/postprocessing',
    role: 'Post-processing effects',
    license: 'Zlib',
    url: 'https://github.com/pmndrs/postprocessing',
  },
  {
    name: 'Rapier',
    role: 'Physics and collision',
    license: 'Apache-2.0',
    url: 'https://rapier.rs',
  },
  { name: 'N8AO', role: 'Ambient occlusion', license: 'ISC', url: 'https://github.com/N8python/n8ao' },
  ...(assetCredits as CreditEntry[]),
];

export const CREDITS_NOTE =
  (assetCredits as CreditEntry[]).length > 0
    ? 'Textures, models and HDRIs from Poly Haven (polyhaven.com) and ambientCG (ambientcg.com), CC0.'
    : 'Assets: procedural placeholders. Asset credits appear here once real assets ship.';
