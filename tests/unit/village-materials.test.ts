import { describe, expect, it } from 'vitest';
import { registerVillagePlaceholders } from '../../src/scenes/village/placeholders';
import { placeholderSpecies } from '../../src/engine/scatter/species';
import scene from '../../src/scenes/village/scene.json';

registerVillagePlaceholders();

describe('village material split', () => {
  it('scene.json declares the library materials with positive scales', () => {
    const m = (scene as { materials?: Record<string, { scale: number }> }).materials ?? {};
    for (const k of ['village/wood-planks', 'village/roof-tiles', 'village/plaster', 'village/stone-paving', 'forest/rock'])
      expect(m[k]?.scale).toBeGreaterThan(0);
  });

  it('houses split into several per-material parts on every LOD', () => {
    for (const id of ['village:house-a', 'village:house-b', 'village:storehouse', 'village:shrine']) {
      const sp = placeholderSpecies(id);
      const lods = sp.variants[0]!;
      expect(lods[0]!.length).toBeGreaterThanOrEqual(4);
      expect(lods[2]!.length).toBeGreaterThanOrEqual(3);
      for (const o of sp.owned) o.dispose();
    }
  });
});
