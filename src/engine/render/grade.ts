// Custom grading effects for pmndrs/postprocessing.
// LinearGradeEffect runs before tone mapping (scene-referred): exposure + white balance.
// DisplayGradeEffect runs after tone mapping (display-referred): contrast, saturation, split tone,
// fade and B&W — the "film look" controls.
import { BlendFunction, Effect } from 'postprocessing';
import * as THREE from 'three';
import type { FilmLook } from '../types';

export class LinearGradeEffect extends Effect {
  constructor() {
    super(
      'LinearGradeEffect',
      /* glsl */ `
      uniform float exposure;
      uniform vec3 wbScale;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        outputColor = vec4(inputColor.rgb * wbScale * exposure, inputColor.a);
      }`,
      {
        blendFunction: BlendFunction.SRC,
        uniforms: new Map<string, THREE.Uniform>([
          ['exposure', new THREE.Uniform(1)],
          ['wbScale', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ]),
      },
    );
  }

  /** ev: stops; temperature/tint in -1..1 (approximate, LMS-free channel gains). */
  set(ev: number, temperature: number, tint: number): void {
    this.uniforms.get('exposure')!.value = Math.pow(2, ev);
    const t = THREE.MathUtils.clamp(temperature, -1, 1) * 0.22;
    const g = THREE.MathUtils.clamp(tint, -1, 1) * 0.12;
    const v = this.uniforms.get('wbScale')!.value as THREE.Vector3;
    v.set(1 + t, 1 - g, 1 - t);
    // Keep luminance roughly constant.
    const lum = v.x * 0.2126 + v.y * 0.7152 + v.z * 0.0722;
    v.multiplyScalar(1 / lum);
  }
}

export interface LookParams {
  contrast: number;
  saturation: number;
  fade: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  bw: number;
  exposure: number;
  toneMapping: 'agx' | 'aces' | 'neutral';
}

export const FILM_LOOKS: Record<FilmLook, LookParams> = {
  neutral: { contrast: 0, saturation: 0, fade: 0, shadowTint: [0, 0, 0], highlightTint: [0, 0, 0], bw: 0, exposure: 0, toneMapping: 'agx' },
  filmic: { contrast: 0.08, saturation: -0.04, fade: 0.015, shadowTint: [-0.01, 0.0, 0.015], highlightTint: [0.02, 0.008, -0.015], bw: 0, exposure: 0, toneMapping: 'aces' },
  moody: { contrast: 0.16, saturation: -0.28, fade: 0.0, shadowTint: [-0.02, 0.01, 0.03], highlightTint: [0.01, 0.0, -0.01], bw: 0, exposure: -0.35, toneMapping: 'agx' },
  vintage: { contrast: -0.06, saturation: -0.22, fade: 0.07, shadowTint: [0.0, 0.02, 0.0], highlightTint: [0.04, 0.02, -0.03], bw: 0, exposure: 0.05, toneMapping: 'agx' },
  bw: { contrast: 0.32, saturation: -1, fade: 0.0, shadowTint: [0, 0, 0], highlightTint: [0, 0, 0], bw: 1, exposure: 0, toneMapping: 'aces' },
  pastel: { contrast: -0.18, saturation: -0.12, fade: 0.1, shadowTint: [0.01, 0.0, 0.02], highlightTint: [0.02, 0.01, 0.0], bw: 0, exposure: 0.2, toneMapping: 'neutral' },
};

export class DisplayGradeEffect extends Effect {
  constructor() {
    super(
      'DisplayGradeEffect',
      /* glsl */ `
      uniform float contrast;
      uniform float saturation;
      uniform float fade;
      uniform vec3 shadowTint;
      uniform vec3 highlightTint;
      uniform float bw;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        vec3 c = clamp(inputColor.rgb, 0.0, 1.0);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        // Split toning by luminance.
        c += shadowTint * (1.0 - smoothstep(0.0, 0.5, l)) + highlightTint * smoothstep(0.5, 1.0, l);
        // S-curve contrast around mid grey (display space).
        c = clamp(c, 0.0, 1.0);
        vec3 s = c * c * (3.0 - 2.0 * c);
        c = contrast >= 0.0 ? mix(c, s, contrast * 2.0) : mix(c, vec3(0.5), -contrast * 0.6);
        l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, 1.0 + saturation);
        c = mix(c, vec3(l), bw);
        // Fade: lifted blacks, softened whites.
        c = c * (1.0 - fade * 1.4) + fade;
        outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
      }`,
      {
        blendFunction: BlendFunction.SRC,
        uniforms: new Map<string, THREE.Uniform>([
          ['contrast', new THREE.Uniform(0)],
          ['saturation', new THREE.Uniform(0)],
          ['fade', new THREE.Uniform(0)],
          ['shadowTint', new THREE.Uniform(new THREE.Vector3())],
          ['highlightTint', new THREE.Uniform(new THREE.Vector3())],
          ['bw', new THREE.Uniform(0)],
        ]),
      },
    );
  }

  set(contrast: number, saturation: number, look: LookParams): void {
    const u = this.uniforms;
    u.get('contrast')!.value = THREE.MathUtils.clamp(contrast + look.contrast, -1, 1);
    u.get('saturation')!.value = THREE.MathUtils.clamp(saturation + look.saturation, -1, 1);
    u.get('fade')!.value = look.fade;
    (u.get('shadowTint')!.value as THREE.Vector3).fromArray(look.shadowTint);
    (u.get('highlightTint')!.value as THREE.Vector3).fromArray(look.highlightTint);
    u.get('bw')!.value = look.bw;
  }
}
