// Pure camera/lens maths for photo mode (unit-tested).
import type { FilmLook, PhotoParams } from '../types';

const SENSOR_H_MM = 24; // full-frame 36x24

/** Vertical FOV (degrees) for a full-frame-equivalent focal length. */
export function focalToVFov(mm: number): number {
  return (2 * Math.atan(SENSOR_H_MM / (2 * mm)) * 180) / Math.PI;
}

export function vFovToFocal(deg: number): number {
  return SENSOR_H_MM / (2 * Math.tan((deg * Math.PI) / 360));
}

/**
 * Approximate depth of field (thin lens, circle of confusion 0.03 mm) → pmndrs focusRange (m)
 * and a bokeh scale that grows with focal length and aperture size. Not physically exact: the post
 * effect is a stylised approximation, these keep the controls behaving like a real camera.
 */
export function dofFromLens(
  focalMm: number,
  fStop: number,
  focusM: number,
): { focusRange: number; bokehScale: number } {
  const f = focalMm / 1000;
  const c = 0.00003;
  const d = Math.max(0.3, focusM);
  const range = (2 * fStop * c * d * d) / (f * f);
  const bokeh = Math.min(8, Math.max(0.6, (focalMm / 50) * (2.8 / fStop) * 2.2));
  return { focusRange: Math.min(200, Math.max(0.15, range)), bokehScale: bokeh };
}

export function defaultPhotoParams(): PhotoParams {
  return {
    focalLength: 35,
    aperture: 5.6,
    focusDistance: 10,
    dof: false,
    exposure: 0,
    temperature: 0,
    tint: 0,
    contrast: 0,
    saturation: 0,
    vignette: 0.35,
    grain: 0.15,
    bloom: 1,
    chromaticAberration: 0,
    lensFlare: false,
    look: 'neutral' as FilmLook,
    grid: false,
    horizon: false,
    metadataOverlay: false,
    pauseMotion: false,
    roll: 0,
  };
}

/** Largest capture multiplier whose final image stays under a pixel budget. */
export function maxCaptureScale(bufferW: number, bufferH: number, pixelBudget: number): 1 | 2 | 4 {
  for (const s of [4, 2] as const) if (bufferW * bufferH * s * s <= pixelBudget) return s;
  return 1;
}

/** Tile layout for tiled capture with an overlap margin (to hide post-effect seams). */
export function tileLayout(
  fullW: number,
  fullH: number,
  tileW: number,
  tileH: number,
  margin: number,
) {
  const stepX = tileW - 2 * margin;
  const stepY = tileH - 2 * margin;
  const tiles: { x: number; y: number; w: number; h: number }[] = [];
  for (let y = 0; y < fullH; y += stepY) {
    for (let x = 0; x < fullW; x += stepX) {
      tiles.push({ x, y, w: Math.min(stepX, fullW - x), h: Math.min(stepY, fullH - y) });
    }
  }
  return { tiles, stepX, stepY };
}
