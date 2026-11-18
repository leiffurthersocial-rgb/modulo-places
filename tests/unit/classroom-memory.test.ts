import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { estimateGpuMemory } from '../../src/classroom/render/memory';

describe('estimateGpuMemory', () => {
  it('counts geometry attributes and index, deduping shared geometry', () => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(30), 3)); // 120 B
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(12), 1)); // 24 B
    const mat = new THREE.MeshBasicMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geo, mat), new THREE.Mesh(geo, mat));
    const e = estimateGpuMemory(scene);
    expect(e.geometryBytes).toBe(144);
    expect(e.textureBytes).toBe(0);
    expect(e.totalBytes).toBe(144);
  });

  it('counts textures once, with mip overhead only when mipmapped', () => {
    const flat = new THREE.DataTexture(new Uint8Array(16 * 16 * 4), 16, 16);
    const mip = new THREE.DataTexture(new Uint8Array(16 * 16 * 4), 16, 16);
    mip.generateMipmaps = true;
    const scene = new THREE.Scene();
    const a = new THREE.MeshBasicMaterial({ map: flat });
    const b = new THREE.MeshBasicMaterial({ map: flat, alphaMap: mip });
    const g = new THREE.BufferGeometry();
    scene.add(new THREE.Mesh(g, a), new THREE.Mesh(g, b));
    const e = estimateGpuMemory(scene);
    expect(e.textureBytes).toBeCloseTo(16 * 16 * 4 + 16 * 16 * 4 * 1.33, 5);
  });

  it('adds drawing buffer and directional shadow map', () => {
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    sun.shadow.mapSize.set(512, 512);
    scene.add(sun);
    const stub = { getDrawingBufferSize: (v: THREE.Vector2) => v.set(100, 50) };
    const e = estimateGpuMemory(scene, stub);
    expect(e.shadowBytes).toBe(512 * 512 * 4);
    expect(e.targetBytes).toBe(100 * 50 * 8);
    expect(e.totalMB).toBeCloseTo((512 * 512 * 4 + 100 * 50 * 8) / (1024 * 1024), 6);
    sun.castShadow = false;
    expect(estimateGpuMemory(scene).shadowBytes).toBe(0);
  });
});
