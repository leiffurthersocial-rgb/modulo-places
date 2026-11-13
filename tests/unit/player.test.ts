import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { generateHeightfield, sampleHeight } from '../../src/engine/terrain/heightfield';
import { rapierHeightfieldDesc } from '../../src/engine/terrain/collision';
import { PlayerController } from '../../src/engine/player/PlayerController';
import {
  approach,
  bobAmplitude,
  clampToBoundary,
  headBobOffset,
  shapeBoundaryVelocity,
} from '../../src/engine/player/movement';
import type { SettingsStore } from '../../src/engine/core/settings';
import type { InputFrame, UserSettings } from '../../src/engine/types';

describe('movement math', () => {
  it('approach converges and is frame-rate independent', () => {
    expect(approach(0, 10, 8, 0)).toBe(0);
    const a = approach(approach(0, 1, 8, 0.05), 1, 8, 0.05);
    expect(a).toBeCloseTo(approach(0, 1, 8, 0.1), 10);
    expect(approach(0, 1, 8, 5)).toBeGreaterThan(0.999);
  });

  it('boundary shaping leaves inner motion alone', () => {
    expect(shapeBoundaryVelocity(10, 0, 3, 1, 50)).toEqual([3, 1]);
  });

  it('boundary shaping fades outward velocity to zero at walkRadius', () => {
    const mid = shapeBoundaryVelocity(47, 0, 2, 0, 50)[0];
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(2);
    expect(shapeBoundaryVelocity(50, 0, 2, 0, 50)[0]).toBeCloseTo(0, 10);
    // tangential motion is preserved
    expect(shapeBoundaryVelocity(50, 0, 0, 2, 50)[1]).toBeCloseTo(2, 10);
    // inward motion is not reduced
    expect(shapeBoundaryVelocity(48, 0, -1, 0, 50)[0]).toBeCloseTo(-1, 10);
  });

  it('pushes inward beyond walkRadius and clamps at +3', () => {
    expect(shapeBoundaryVelocity(52, 0, 0, 0, 50)[0]).toBeLessThan(0);
    const [x, z] = clampToBoundary(100, 0, 50);
    expect(Math.hypot(x, z)).toBeCloseTo(53, 10);
    expect(clampToBoundary(10, 5, 50)).toEqual([10, 5]);
  });

  it('head bob scales with speed and fades out when stopped', () => {
    expect(bobAmplitude(0)).toBe(0);
    expect(bobAmplitude(1.7)).toBeCloseTo(0.035, 6);
    expect(bobAmplitude(3.8)).toBeCloseTo(0.05, 6);
    const o = headBobOffset(Math.PI / 4, 3.8);
    expect(Math.abs(o.y)).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(headBobOffset(1, 0)).toEqual({ y: 0, x: 0 });
  });
});

function makeSettings(): SettingsStore {
  const s = { headBob: true, reduceMotion: false } as unknown as UserSettings;
  return { get: () => s } as unknown as SettingsStore;
}

function input(over: Partial<InputFrame> = {}): InputFrame {
  return {
    move: { x: 0, y: 0 },
    lift: 0,
    look: { x: 0, y: 0 },
    sprint: false,
    slow: false,
    crouch: false,
    pressed: new Set(),
    ...over,
  };
}

describe('PlayerController (rapier)', () => {
  const WALK_RADIUS = 30;
  let world: RAPIER.World;
  let hf: ReturnType<typeof generateHeightfield>;

  beforeAll(async () => {
    await RAPIER.init();
  });

  function setup(spawnX: number, spawnZ: number): PlayerController {
    hf = generateHeightfield(
      {
        size: 100,
        resolution: 65,
        source: { type: 'procedural' },
        height: 0.5,
        baseFrequency: 0.02,
        octaves: 2,
        warp: 2,
        layers: [],
      },
      3,
    );
    world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(rapierHeightfieldDesc(RAPIER, hf));
    world.step();
    const gh = (x: number, z: number) => sampleHeight(hf, x, z);
    return new PlayerController(RAPIER, world, {
      spawn: [spawnX, gh(spawnX, spawnZ) + 1, spawnZ],
      yaw: 0,
      walkRadius: WALK_RADIUS,
      settings: makeSettings(),
      groundHeight: gh,
    });
  }

  it('walks forward on the ground at roughly walk speed', () => {
    const p = setup(0, 0);
    const cam = new THREE.PerspectiveCamera();
    const dt = 1 / 60;
    for (let i = 0; i < 30; i++) {
      p.update(dt, input(), cam);
      world.step();
    }
    const startZ = p.feet.z;
    for (let i = 0; i < 180; i++) {
      p.update(dt, input({ move: { x: 0, y: 1 } }), cam);
      world.step();
      expect(Math.abs(p.feet.y - sampleHeight(hf, p.feet.x, p.feet.z))).toBeLessThan(0.15);
    }
    const travelled = startZ - p.feet.z; // yaw 0 faces -Z
    expect(travelled).toBeGreaterThan(1.7 * 3 * 0.7);
    expect(travelled).toBeLessThan(1.7 * 3 * 1.05);
    expect(p.speed).toBeGreaterThan(1.4);
    p.dispose();
  });

  it('stays within walkRadius + 3 when pushing outward for 30 s', () => {
    const p = setup(0, 0);
    const cam = new THREE.PerspectiveCamera();
    const dt = 1 / 60;
    let maxD = 0;
    for (let i = 0; i < 1800; i++) {
      p.update(dt, input({ move: { x: 0, y: 1 }, sprint: true }), cam);
      world.step();
      maxD = Math.max(maxD, Math.hypot(p.feet.x, p.feet.z));
    }
    expect(maxD).toBeLessThanOrEqual(WALK_RADIUS + 3 + 1e-6);
    p.dispose();
  });

  it('crouches and stands again when there is headroom', () => {
    const p = setup(0, 0);
    const cam = new THREE.PerspectiveCamera();
    for (let i = 0; i < 60; i++) {
      p.update(1 / 60, input({ crouch: true }), cam);
      world.step();
    }
    expect(p.crouching).toBe(true);
    expect(cam.position.y - p.feet.y).toBeLessThan(1.2);
    for (let i = 0; i < 60; i++) {
      p.update(1 / 60, input(), cam);
      world.step();
    }
    expect(p.crouching).toBe(false);
    expect(cam.position.y - p.feet.y).toBeGreaterThan(1.55);
    p.dispose();
  });
});
