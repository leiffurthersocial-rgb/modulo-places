// Lighting moods: hand-tuned data (MoodDef) blended over time. Everything visible that depends on
// the mood (sky, sun, ambient, fog, IBL, post grade) is derived from one interpolated MoodState.
import * as THREE from 'three';
import type { MoodDef } from '../types';

export interface MoodState {
  zenith: THREE.Color;
  horizon: THREE.Color;
  ground: THREE.Color;
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  sunDisc: number;
  ambSky: THREE.Color;
  ambGround: THREE.Color;
  ambIntensity: number;
  ibl: number;
  fogColor: THREE.Color;
  fogDensity: number;
  fogFalloff: number;
  fogBase: number;
  fogSunScatter: number;
  exposure: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  bloom: number;
  vignette: number;
  shafts: number;
  nightLights: number;
  aurora: number;
  stars: number;
}

const c = (hex: string) => new THREE.Color(hex);

export function sunDirection(
  azimuthDeg: number,
  elevationDeg: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  return out
    .set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
    .normalize();
}

export function moodToState(m: MoodDef): MoodState {
  return {
    zenith: c(m.sky.zenith),
    horizon: c(m.sky.horizon),
    ground: c(m.sky.ground),
    sunDir: sunDirection(m.sun.azimuth, m.sun.elevation),
    sunColor: c(m.sun.color),
    sunIntensity: m.sun.intensity,
    sunDisc: Math.cos(THREE.MathUtils.degToRad(m.sun.discSize ?? 0.55)),
    ambSky: c(m.ambient.sky),
    ambGround: c(m.ambient.ground),
    ambIntensity: m.ambient.intensity,
    ibl: m.ambient.ibl ?? 0.5,
    fogColor: c(m.fog.color),
    fogDensity: m.fog.density,
    fogFalloff: m.fog.heightFalloff,
    fogBase: m.fog.baseHeight,
    fogSunScatter: m.fog.sunScatter,
    exposure: m.post.exposure,
    contrast: m.post.contrast,
    saturation: m.post.saturation,
    temperature: m.post.temperature,
    tint: m.post.tint,
    bloom: m.post.bloom,
    vignette: m.post.vignette,
    shafts: m.post.shafts ?? 1,
    nightLights: m.post.nightLights ?? 0,
    aurora: m.sky.aurora ?? 0,
    stars: m.sky.stars ?? 0,
  };
}

/** Blend a→b into out. Colours lerp in linear space; sun direction slerps; fog density lerps in log space. */
export function lerpMood(a: MoodState, b: MoodState, t: number, out: MoodState): MoodState {
  const l = (x: number, y: number) => x + (y - x) * t;
  out.zenith.copy(a.zenith).lerp(b.zenith, t);
  out.horizon.copy(a.horizon).lerp(b.horizon, t);
  out.ground.copy(a.ground).lerp(b.ground, t);
  out.sunDir.copy(a.sunDir).lerp(b.sunDir, t).normalize();
  out.sunColor.copy(a.sunColor).lerp(b.sunColor, t);
  out.sunIntensity = l(a.sunIntensity, b.sunIntensity);
  out.sunDisc = l(a.sunDisc, b.sunDisc);
  out.ambSky.copy(a.ambSky).lerp(b.ambSky, t);
  out.ambGround.copy(a.ambGround).lerp(b.ambGround, t);
  out.ambIntensity = l(a.ambIntensity, b.ambIntensity);
  out.ibl = l(a.ibl, b.ibl);
  out.fogColor.copy(a.fogColor).lerp(b.fogColor, t);
  out.fogDensity = Math.exp(
    l(Math.log(Math.max(a.fogDensity, 1e-6)), Math.log(Math.max(b.fogDensity, 1e-6))),
  );
  out.fogFalloff = l(a.fogFalloff, b.fogFalloff);
  out.fogBase = l(a.fogBase, b.fogBase);
  out.fogSunScatter = l(a.fogSunScatter, b.fogSunScatter);
  out.exposure = l(a.exposure, b.exposure);
  out.contrast = l(a.contrast, b.contrast);
  out.saturation = l(a.saturation, b.saturation);
  out.temperature = l(a.temperature, b.temperature);
  out.tint = l(a.tint, b.tint);
  out.bloom = l(a.bloom, b.bloom);
  out.vignette = l(a.vignette, b.vignette);
  out.shafts = l(a.shafts, b.shafts);
  out.nightLights = l(a.nightLights, b.nightLights);
  out.aurora = l(a.aurora, b.aurora);
  out.stars = l(a.stars, b.stars);
  return out;
}

export function cloneState(s: MoodState): MoodState {
  return lerpMood(s, s, 0, {
    ...s,
    zenith: s.zenith.clone(),
    horizon: s.horizon.clone(),
    ground: s.ground.clone(),
    sunDir: s.sunDir.clone(),
    sunColor: s.sunColor.clone(),
    ambSky: s.ambSky.clone(),
    ambGround: s.ambGround.clone(),
    fogColor: s.fogColor.clone(),
  });
}

/** Drives a cross-fade between moods. Call update(dt); read `.state`. */
export class MoodBlender {
  private from: MoodState;
  private to: MoodState;
  private t = 1;
  private duration = 3;
  readonly state: MoodState;
  current: MoodDef;

  constructor(initial: MoodDef) {
    this.current = initial;
    this.from = moodToState(initial);
    this.to = moodToState(initial);
    this.state = cloneState(this.from);
  }

  /** Start a cross-fade from whatever is on screen now. */
  go(mood: MoodDef, seconds = 3): void {
    this.from = cloneState(this.state);
    this.to = moodToState(mood);
    this.current = mood;
    this.duration = Math.max(0.0001, seconds);
    this.t = seconds <= 0 ? 1 : 0;
    if (seconds <= 0) lerpMood(this.from, this.to, 1, this.state);
  }

  get blending(): boolean {
    return this.t < 1;
  }

  /** Returns true while the state changed this frame. */
  update(dt: number): boolean {
    if (this.t >= 1) return false;
    this.t = Math.min(1, this.t + dt / this.duration);
    const e = this.t * this.t * (3 - 2 * this.t);
    lerpMood(this.from, this.to, e, this.state);
    return true;
  }
}
