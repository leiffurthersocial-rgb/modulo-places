import type { PresetId, QualitySettings } from '../engine/types';

export const PRESET_ORDER: Exclude<PresetId, 'custom'>[] = ['ultra', 'high', 'medium', 'low', 'saver'];

export const PRESET_LABELS: Record<PresetId, string> = {
  ultra: 'Ultra',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  saver: 'Battery Saver',
  custom: 'Custom',
};

export const QUALITY_PRESETS: Record<Exclude<PresetId, 'custom'>, QualitySettings> = {
  ultra: {
    renderScale: 1,
    maxDpr: 2,
    fpsCap: 60,
    shadows: { enabled: true, mapSize: 4096, distance: 80 },
    ao: 'high',
    aoHalfRes: false,
    aa: 'msaa+smaa',
    bloom: true,
    grade: true,
    lensFx: true,
    lightShafts: 'radial',
    textureTier: 4096,
    vegetationDensity: 1,
    drawDistance: 200,
    lodBias: 1.25,
    water: 'refract',
    particles: 1,
    liveDof: true,
    anisotropy: 8,
  },
  high: {
    renderScale: 1,
    maxDpr: 1.5,
    fpsCap: 60,
    shadows: { enabled: true, mapSize: 2048, distance: 60 },
    ao: 'medium',
    aoHalfRes: false,
    aa: 'msaa',
    bloom: true,
    grade: true,
    lensFx: true,
    lightShafts: 'radial',
    textureTier: 2048,
    vegetationDensity: 0.85,
    drawDistance: 160,
    lodBias: 1,
    water: 'refract',
    particles: 1,
    liveDof: true,
    anisotropy: 4,
  },
  medium: {
    renderScale: 0.85,
    maxDpr: 2,
    fpsCap: 60,
    shadows: { enabled: true, mapSize: 2048, distance: 40 },
    ao: 'performance',
    aoHalfRes: true,
    aa: 'smaa',
    bloom: true,
    grade: true,
    lensFx: false,
    lightShafts: 'cards',
    textureTier: 1024,
    vegetationDensity: 0.6,
    drawDistance: 120,
    lodBias: 0.8,
    water: 'reflect',
    particles: 0.5,
    liveDof: false,
    anisotropy: 4,
  },
  low: {
    renderScale: 0.75,
    maxDpr: 2,
    fpsCap: 30,
    shadows: { enabled: true, mapSize: 1024, distance: 25 },
    ao: 'off',
    aoHalfRes: true,
    aa: 'fxaa',
    bloom: false,
    grade: true,
    lensFx: false,
    lightShafts: 'cards',
    textureTier: 1024,
    vegetationDensity: 0.4,
    drawDistance: 90,
    lodBias: 0.6,
    water: 'simple',
    particles: 0.25,
    liveDof: false,
    anisotropy: 2,
  },
  saver: {
    renderScale: 0.7,
    maxDpr: 1,
    fpsCap: 30,
    shadows: { enabled: false, mapSize: 512, distance: 0 },
    ao: 'off',
    aoHalfRes: true,
    aa: 'none',
    bloom: false,
    grade: false,
    lensFx: false,
    lightShafts: 'off',
    textureTier: 512,
    vegetationDensity: 0.3,
    drawDistance: 70,
    lodBias: 0.5,
    water: 'simple',
    particles: 0.1,
    liveDof: false,
    anisotropy: 1,
  },
};

/** Validate a quality settings object; returns a list of problems (empty = valid). */
export function validateQuality(q: QualitySettings): string[] {
  const errs: string[] = [];
  const range = (name: string, v: number, lo: number, hi: number) => {
    if (!Number.isFinite(v) || v < lo || v > hi) errs.push(`${name}=${v} outside [${lo}, ${hi}]`);
  };
  range('renderScale', q.renderScale, 0.4, 2);
  range('maxDpr', q.maxDpr, 0.5, 3);
  range('vegetationDensity', q.vegetationDensity, 0, 1);
  range('drawDistance', q.drawDistance, 20, 1000);
  range('lodBias', q.lodBias, 0.25, 4);
  range('particles', q.particles, 0, 1);
  range('anisotropy', q.anisotropy, 1, 16);
  range('shadows.distance', q.shadows.distance, 0, 500);
  if (q.fpsCap !== 30 && q.fpsCap !== 60) errs.push(`fpsCap=${q.fpsCap}`);
  if (![512, 1024, 2048, 4096].includes(q.textureTier)) errs.push(`textureTier=${q.textureTier}`);
  if (q.shadows.enabled && q.shadows.distance <= 0) errs.push('shadows enabled with distance 0');
  return errs;
}
