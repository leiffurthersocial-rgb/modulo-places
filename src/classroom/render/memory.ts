// Rough GPU memory estimate for a three.js scene (no WebGL needed). Shared geometries, attributes
// and textures are counted once. Numbers are approximations: good for comparing presets/builds.
import * as THREE from 'three';

const MIP_FACTOR = 1.33;
const MB = 1024 * 1024;

export interface GpuMemoryEstimate {
  geometryBytes: number;
  textureBytes: number;
  targetBytes: number;
  shadowBytes: number;
  totalBytes: number;
  totalMB: number;
}

/** Minimal slice of WebGLRenderer used here, so tests can pass a stub. */
export interface DrawingBufferSource {
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
}

function textureBytes(t: THREE.Texture): number {
  const img = t.image as { width?: number; height?: number } | null;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!w || !h) return 0;
  return w * h * 4 * (t.generateMipmaps ? MIP_FACTOR : 1);
}

function collectTextures(mat: THREE.Material, into: Set<THREE.Texture>): void {
  for (const v of Object.values(mat)) {
    if (v instanceof THREE.Texture) into.add(v);
  }
  const uniforms = (mat as THREE.ShaderMaterial).uniforms;
  if (uniforms)
    for (const u of Object.values(uniforms))
      if ((u as { value?: unknown }).value instanceof THREE.Texture)
        into.add((u as { value: THREE.Texture }).value);
}

export function estimateGpuMemory(
  scene: THREE.Scene,
  renderer?: DrawingBufferSource | null,
): GpuMemoryEstimate {
  const buffers = new Set<object>(); // dedupes attributes / interleaved buffers / indices
  const geometries = new Set<THREE.BufferGeometry>();
  const textures = new Set<THREE.Texture>();
  let shadowBytes = 0;

  if (scene.background instanceof THREE.Texture) textures.add(scene.background);
  if (scene.environment) textures.add(scene.environment);

  scene.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g?.isBufferGeometry) geometries.add(g);
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (m) for (const mm of Array.isArray(m) ? m : [m]) collectTextures(mm, textures);
    const light = o as THREE.DirectionalLight;
    if (light.isLight && light.castShadow && light.shadow) {
      const s = light.shadow.mapSize;
      const faces = (o as THREE.PointLight).isPointLight ? 6 : 1;
      shadowBytes += s.x * s.y * 4 * faces;
    }
  });

  let geometryBytes = 0;
  const addBuffer = (key: object, bytes: number) => {
    if (buffers.has(key)) return;
    buffers.add(key);
    geometryBytes += bytes;
  };
  for (const g of geometries) {
    for (const a of Object.values(g.attributes)) {
      const ib = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute
        ? (a as THREE.InterleavedBufferAttribute).data
        : null;
      if (ib) addBuffer(ib, ib.array.byteLength);
      else addBuffer(a, (a as THREE.BufferAttribute).array.byteLength);
    }
    if (g.index) addBuffer(g.index, g.index.array.byteLength);
  }

  let texBytes = 0;
  for (const t of textures) texBytes += textureBytes(t);

  let targetBytes = 0;
  if (renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // colour + depth/stencil, 4 bytes each
    targetBytes = size.x * size.y * 4 * 2;
  }

  const totalBytes = geometryBytes + texBytes + targetBytes + shadowBytes;
  return {
    geometryBytes,
    textureBytes: texBytes,
    targetBytes,
    shadowBytes,
    totalBytes,
    totalMB: totalBytes / MB,
  };
}
