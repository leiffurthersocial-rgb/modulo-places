import { describe, expect, it } from 'vitest';
import { validateSceneDef } from '../../src/data/schema';
import type {
  MaskDef,
  MoodDef,
  ScatterRuleDef,
  SceneDef,
  TerrainDef,
  TerrainLayerDef,
} from '../../src/engine/types';

const sceneFiles = import.meta.glob('../../src/scenes/*/scene.json', {
  eager: true,
  import: 'default',
});

function rule(id: string, over: Partial<ScatterRuleDef> = {}): ScatterRuleDef {
  return { id, mesh: 'tree', density: 1, minDistance: 4, scale: [0.8, 1.2], ...over };
}

function layer(id: string, over: Partial<TerrainLayerDef> = {}): TerrainLayerDef {
  return { id, material: 'grass', color: '#4a7a3a', roughness: 0.9, ...over };
}

function mood(id: string): MoodDef {
  return {
    id,
    name: id,
    sky: { zenith: '#3a6ea5', horizon: '#cfe3f0', ground: '#6b5b4e' },
    sun: { azimuth: 180, elevation: 45, color: '#fff4e0', intensity: 3 },
    ambient: { sky: '#8fa9c4', ground: '#4a4038', intensity: 0.6 },
    fog: { color: '#c8d6e0', density: 0.002, heightFalloff: 0.05, baseHeight: 0, sunScatter: 0.3 },
    post: {
      exposure: 0,
      contrast: 0.1,
      saturation: 0,
      temperature: 0,
      tint: 0,
      bloom: 0.2,
      vignette: 0.2,
    },
  };
}

/** A valid scene; each call returns a fresh object so tests can mutate it. */
function base(): SceneDef {
  return {
    id: 'test-scene',
    name: 'Test Scene',
    description: 'Fixture',
    seed: 42,
    terrain: {
      size: 1000,
      resolution: 129,
      source: { type: 'procedural' },
      height: 40,
      baseFrequency: 0.004,
      octaves: 5,
      warp: 0.2,
      layers: [layer('grass')],
    },
    scatter: [rule('grass')],
    props: [{ id: 'rock-1', mesh: 'rock', position: [1, 0, 2] }],
    spawn: { position: [0, 0, 0], yaw: 0 },
    bounds: { walkRadius: 400, photoHalfExtent: 300, photoMaxHeight: 60 },
    moods: [mood('day')],
    defaultMood: 'day',
    cameras: [{ id: 'cam-1', position: [0, 5, -10], target: [0, 0, 0] }],
  };
}

function expectPathError(input: unknown, path: string): void {
  const r = validateSceneDef(input);
  // Failure output shows every message, so a wrong path is easy to diagnose.
  expect(r.ok ? 'valid' : r.errors.join(' | ')).toContain(`${path}: `);
}

describe('validateSceneDef', () => {
  it('accepts a minimal valid scene', () => {
    const scene = base();
    const r = validateSceneDef(scene);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scene).toBe(scene);
  });

  it('ignores unknown extra keys', () => {
    expect(validateSceneDef({ ...base(), editorNote: 'anything' }).ok).toBe(true);
  });

  it('rejects non-object input with a root error', () => {
    expectPathError(null, '<root>');
  });

  const invalid: [string, (s: SceneDef) => void, string][] = [
    [
      'duplicate scatter id',
      (s) => {
        s.scatter = [rule('a'), rule('b'), rule('a')];
      },
      'scatter[2].id',
    ],
    [
      'bad hex color',
      (s) => {
        s.terrain.layers = [layer('rock', { color: 'red' })];
      },
      'terrain.layers[0].color',
    ],
    [
      'defaultMood not in moods',
      (s) => {
        s.defaultMood = 'night';
      },
      'defaultMood',
    ],
    [
      'scale min > max',
      (s) => {
        s.scatter = [rule('a', { scale: [2, 1] })];
      },
      'scatter[0].scale',
    ],
    [
      'walkRadius too big',
      (s) => {
        s.bounds.walkRadius = 600;
      },
      'bounds.walkRadius',
    ],
    [
      'bad mask type',
      (s) => {
        s.scatter = [rule('a', { masks: [{ type: 'wibble' } as unknown as MaskDef] })];
      },
      'scatter[0].masks[0].type',
    ],
    [
      'lods not increasing',
      (s) => {
        s.scatter = [rule('a', { lods: [10, 50, 40] })];
      },
      'scatter[0].lods[2]',
    ],
    [
      'resolution out of range',
      (s) => {
        s.terrain.resolution = 16;
      },
      'terrain.resolution',
    ],
    [
      'missing name',
      (s) => {
        (s as Partial<SceneDef>).name = undefined;
      },
      'name',
    ],
    [
      'image source without url',
      (s) => {
        s.terrain.source = { type: 'image' } as unknown as TerrainDef['source'];
      },
      'terrain.source.url',
    ],
    [
      'negative seed',
      (s) => {
        s.seed = -1;
      },
      'seed',
    ],
    [
      'terrain.size out of range',
      (s) => {
        s.terrain.size = 5000;
      },
      'terrain.size',
    ],
    [
      'mood fog density negative',
      (s) => {
        s.moods = [{ ...mood('day'), fog: { ...mood('day').fog, density: -1 } }];
      },
      'moods[0].fog.density',
    ],
    [
      'mood sun elevation out of range',
      (s) => {
        s.moods = [{ ...mood('day'), sun: { ...mood('day').sun, elevation: 120 } }];
      },
      'moods[0].sun.elevation',
    ],
    [
      'prop position not finite',
      (s) => {
        s.props = [{ id: 'p', mesh: 'rock', position: [1, 2, Number.NaN] }];
      },
      'props[0].position',
    ],
    [
      'duplicate camera id',
      (s) => {
        s.cameras = [
          { id: 'c', position: [0, 0, 0], target: [0, 0, 0] },
          { id: 'c', position: [1, 0, 0], target: [0, 0, 0] },
        ];
      },
      'cameras[1].id',
    ],
    [
      'empty layers',
      (s) => {
        s.terrain.layers = [];
      },
      'terrain.layers',
    ],
  ];

  it.each(invalid)('rejects %s with a path-qualified error', (_label, mutate, path) => {
    const s = base();
    mutate(s);
    expectPathError(s, path);
    expect(validateSceneDef(s).ok).toBe(false);
  });

  it('validates every bundled src/scenes/*/scene.json (zero files is fine)', () => {
    for (const [file, data] of Object.entries(sceneFiles)) {
      const r = validateSceneDef(data);
      expect(r.ok ? 'valid' : r.errors.join(' | '), file).toBe('valid');
    }
  });
});
