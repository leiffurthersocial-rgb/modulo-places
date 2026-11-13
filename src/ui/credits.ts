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
  { name: 'Rapier', role: 'Physics and collision', license: 'Apache-2.0', url: 'https://rapier.rs' },
];

export const CREDITS_NOTE = 'Assets: procedural placeholders (Phase 1). Asset credits will appear here.';
