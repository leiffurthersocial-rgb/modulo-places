// Photo mode: free-fly camera clamped to a bounding volume, lens/grade parameters, focus picking
// and capture. Capture at 1x renders one frame; 2x/4x use tiled rendering via setViewOffset with an
// overlap margin so bloom/AO/DOF/SMAA don't seam, then lens effects (vignette, grain) are applied
// once over the whole image so they are not repeated per tile.
import * as THREE from 'three';
import type { InputFrame, PhotoParams } from '../types';
import { defaultPhotoParams, focalToVFov, tileLayout } from './lens';

export interface PhotoBounds {
  halfExtent: number;
  maxHeight: number;
  groundHeight: (x: number, z: number) => number;
}

export class PhotoMode {
  active = false;
  params: PhotoParams = defaultPhotoParams();
  readonly position = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  private vel = new THREE.Vector3();
  private savedFov = 65;

  enter(camera: THREE.PerspectiveCamera, yaw: number, pitch: number): void {
    this.active = true;
    this.position.copy(camera.position);
    this.yaw = yaw;
    this.pitch = pitch;
    this.vel.set(0, 0, 0);
    this.savedFov = camera.fov;
  }

  exit(camera: THREE.PerspectiveCamera): void {
    this.active = false;
    camera.fov = this.savedFov;
    camera.updateProjectionMatrix();
  }

  update(
    dt: number,
    input: InputFrame,
    camera: THREE.PerspectiveCamera,
    bounds: PhotoBounds,
  ): void {
    // Slower look at long focal lengths so framing stays controllable.
    const lookScale = Math.min(1, 35 / this.params.focalLength) ** 0.7;
    this.yaw -= input.look.x * lookScale;
    this.pitch = THREE.MathUtils.clamp(this.pitch + input.look.y * lookScale, -1.55, 1.55);

    const speed = input.sprint ? 12 : input.slow ? 0.8 : 3.5;
    const fwd = new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const target = new THREE.Vector3()
      .addScaledVector(fwd, input.move.y * speed)
      .addScaledVector(right, input.move.x * speed)
      .addScaledVector(THREE.Object3D.DEFAULT_UP, input.lift * speed);
    this.vel.lerp(target, 1 - Math.exp(-dt * 6));
    this.position.addScaledVector(this.vel, dt);

    const b = bounds.halfExtent;
    this.position.x = THREE.MathUtils.clamp(this.position.x, -b, b);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -b, b);
    const ground = bounds.groundHeight(this.position.x, this.position.z) + 0.15;
    this.position.y = THREE.MathUtils.clamp(this.position.y, ground, bounds.maxHeight);

    camera.position.copy(this.position);
    camera.rotation.set(this.pitch, this.yaw, THREE.MathUtils.degToRad(this.params.roll), 'YXZ');
    const fov = focalToVFov(this.params.focalLength);
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  reset(): void {
    this.params = defaultPhotoParams();
  }
}

export interface CaptureContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  /** Render one full post-processed frame into the canvas. */
  renderFrame: (lensFx: boolean) => void;
  vignette: number;
  grain: number;
}

/** Capture the current view at `scale`× the drawing-buffer size. Returns a PNG blob. */
export async function capture(
  ctx: CaptureContext,
  scale: 1 | 2 | 4,
): Promise<{ blob: Blob; width: number; height: number }> {
  const src = ctx.renderer.domElement;
  const W = src.width;
  const H = src.height;
  const out = document.createElement('canvas');
  out.width = W * scale;
  out.height = H * scale;
  const g = out.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');

  if (scale === 1) {
    ctx.renderFrame(true);
    g.drawImage(src, 0, 0); // same task as render: drawing buffer is still valid
  } else {
    const margin = Math.round(Math.min(W, H) * 0.08);
    const { tiles } = tileLayout(W * scale, H * scale, W, H, margin);
    const cam = ctx.camera;
    for (const t of tiles) {
      // Tile region in full-image space, expanded by the margin; the viewport is the full canvas.
      cam.setViewOffset(W * scale, H * scale, t.x - margin, t.y - margin, W, H);
      ctx.renderFrame(false);
      g.drawImage(src, margin, margin, t.w, t.h, t.x, t.y, t.w, t.h);
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
    }
    cam.clearViewOffset();
    applyLensFx(g, out.width, out.height, ctx.vignette, ctx.grain);
    ctx.renderFrame(true); // restore the live frame
  }
  const blob = await new Promise<Blob>((res, rej) =>
    out.toBlob((b) => (b ? res(b) : rej(new Error('PNG encode failed'))), 'image/png'),
  );
  out.width = out.height = 0; // release memory early (iPad)
  return { blob, width: W * scale, height: H * scale };
}

/** Whole-image vignette + grain for tiled captures (matches the live effects closely enough). */
function applyLensFx(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  vignette: number,
  grain: number,
): void {
  if (vignette > 0.001) {
    const r = Math.hypot(w, h) / 2;
    const grad = g.createRadialGradient(w / 2, h / 2, r * 0.35, w / 2, h / 2, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, vignette * 0.9)})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }
  if (grain > 0.001) {
    const N = 256;
    const tile = document.createElement('canvas');
    tile.width = tile.height = N;
    const tg = tile.getContext('2d')!;
    const img = tg.createImageData(N, N);
    for (let i = 0; i < N * N; i++) {
      const v = 128 + (Math.random() - 0.5) * 255;
      img.data.set([v, v, v, 255], i * 4);
    }
    tg.putImageData(img, 0, 0);
    g.globalCompositeOperation = 'overlay';
    g.globalAlpha = grain * 0.25;
    g.fillStyle = g.createPattern(tile, 'repeat')!;
    g.fillRect(0, 0, w, h);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }
}
