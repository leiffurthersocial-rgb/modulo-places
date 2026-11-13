// Scene registry. Scene data is loaded lazily so the menu stays light.
import type { SceneDef } from '../engine/types';

export interface SceneEntry {
  id: string;
  name: string;
  description: string;
  available: boolean;
  /** Engine test scenes: loadable by URL (?scene=…), not listed in the menu. */
  hidden?: boolean;
  moods: { id: string; name: string }[];
  load?: () => Promise<SceneDef>;
}

export const SCENES: SceneEntry[] = [
  {
    id: 'forest',
    name: 'Misty Forest',
    description: 'A mossy conifer valley with a creek, ferns and fallen trunks.',
    available: true,
    moods: [
      { id: 'dawn', name: 'Dawn mist' },
      { id: 'midday', name: 'Midday' },
      { id: 'dusk', name: 'Dusk' },
    ],
    load: async () => (await import('./forest/scene.json')).default as unknown as SceneDef,
  },
  {
    id: 'greybox',
    hidden: true,
    name: 'Misty Forest (greybox)',
    description: 'Engine test bed — placeholder plants, procedural terrain, three moods.',
    available: true,
    moods: [
      { id: 'dawn', name: 'Dawn mist' },
      { id: 'midday', name: 'Midday' },
      { id: 'dusk', name: 'Dusk' },
    ],
    load: async () => (await import('./greybox/scene.json')).default as unknown as SceneDef,
  },
  {
    id: 'village',
    name: 'Japanese Village',
    description: 'Wooden houses, a shrine path and a bamboo grove.',
    available: false,
    moods: [],
  },
  {
    id: 'jungle',
    name: 'Jungle Ruin',
    description: 'Overgrown stone, vines and humid light shafts.',
    available: false,
    moods: [],
  },
  {
    id: 'cabin',
    name: 'Snowy Mountain Cabin',
    description: 'Deep snow, pines and a lit window at blue hour.',
    available: false,
    moods: [],
  },
];
