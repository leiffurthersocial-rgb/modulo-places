// F3 overlay: frame timing, renderer counters, memory estimate vs budget, instance counts.
import * as THREE from 'three';

export interface DebugStats {
  preset: string;
  mood: string;
  seed: number;
  instances: number;
  visibleInstances: number;
  scatterMeshes: number;
  position: THREE.Vector3;
  extra?: Record<string, string | number>;
}

export class FrameTimer {
  private samples: number[] = [];
  private last = 0;
  avg = 0;
  p95 = 0;
  fps = 0;

  tick(nowMs: number): void {
    if (this.last) this.samples.push(nowMs - this.last);
    this.last = nowMs;
    if (this.samples.length >= 60) {
      const s = [...this.samples].sort((a, b) => a - b);
      this.avg = s.reduce((a, b) => a + b, 0) / s.length;
      this.p95 = s[Math.floor(s.length * 0.95)]!;
      this.fps = 1000 / this.avg;
      this.samples.length = 0;
    }
  }
}

/** Rough GPU memory estimate by walking the scene (textures, geometry, instance buffers). */
export function estimateMemory(scene: THREE.Scene): { textures: number; geometry: number } {
  const tex = new Set<THREE.Texture>();
  const geo = new Set<THREE.BufferGeometry>();
  let instance = 0;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geo.add(m.geometry);
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      const im = o as THREE.InstancedMesh;
      instance += im.instanceMatrix.array.byteLength + (im.instanceColor?.array.byteLength ?? 0);
    }
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat))
        if (v && (v as THREE.Texture).isTexture) tex.add(v as THREE.Texture);
    }
  });
  let t = 0;
  for (const x of tex) {
    const img = x.image as { width?: number; height?: number } | undefined;
    const w = img?.width ?? 0;
    const h = img?.height ?? 0;
    const bpp = (x as THREE.CompressedTexture).isCompressedTexture ? 1 : 4;
    t += w * h * bpp * (x.generateMipmaps || x.mipmaps?.length ? 1.33 : 1);
  }
  let g = instance;
  for (const x of geo) {
    for (const a of Object.values(x.attributes)) g += (a as THREE.BufferAttribute).array.byteLength;
    if (x.index) g += x.index.array.byteLength;
  }
  return { textures: t, geometry: g };
}

const MB = 1024 * 1024;

export class DebugOverlay {
  readonly el: HTMLDivElement;
  visible = false;
  private memCache = { textures: 0, geometry: 0 };
  private memAt = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'debug-overlay';
    Object.assign(this.el.style, {
      position: 'fixed',
      top: 'max(8px, env(safe-area-inset-top))',
      left: 'max(8px, env(safe-area-inset-left))',
      font: '11px/1.35 ui-monospace, Menlo, Consolas, monospace',
      color: '#d8f0d0',
      background: 'rgba(0,0,0,0.55)',
      padding: '8px 10px',
      borderRadius: '6px',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      zIndex: '50',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    parent.appendChild(this.el);
  }

  toggle(v = !this.visible): void {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  update(
    timer: FrameTimer,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    s: DebugStats,
    nowMs: number,
  ): void {
    if (!this.visible) return;
    if (nowMs - this.memAt > 1000) {
      this.memAt = nowMs;
      this.memCache = estimateMemory(scene);
    }
    const info = renderer.info;
    const lines = [
      `FPS ${timer.fps.toFixed(0).padStart(3)}  avg ${timer.avg.toFixed(1)} ms  p95 ${timer.p95.toFixed(1)} ms`,
      `draws ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k  lines ${info.render.lines}`,
      `geoms ${info.memory.geometries}  textures ${info.memory.textures}  programs ${info.programs?.length ?? 0}`,
      `mem≈ tex ${(this.memCache.textures / MB).toFixed(1)} MB  geo ${(this.memCache.geometry / MB).toFixed(1)} MB`,
      `instances ${s.visibleInstances.toLocaleString()} / ${s.instances.toLocaleString()}  cells ${s.scatterMeshes}`,
      `preset ${s.preset}  mood ${s.mood}  seed ${s.seed}`,
      `pos ${s.position.x.toFixed(1)}, ${s.position.y.toFixed(1)}, ${s.position.z.toFixed(1)}`,
      ...Object.entries(s.extra ?? {}).map(([k, v]) => `${k} ${v}`),
    ];
    this.el.textContent = lines.join('\n');
  }

  dispose(): void {
    this.el.remove();
  }
}
