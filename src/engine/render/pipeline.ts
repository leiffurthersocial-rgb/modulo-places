// Renderer + post-processing chain. The chain's *structure* comes from QualitySettings (+ whether
// photo-mode DOF / lens effects are live); per-frame *values* come from the mood and photo params.
//
// Pass order (each pmndrs EffectPass may hold at most one convolution effect):
//   RenderPass → [N8AO] → [DOF] → [GodRays] → main(LinearGrade, Bloom, ToneMap, DisplayGrade,
//   Vignette, Grain) → [ChromaticAberration] → [SMAA | FXAA]
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  EffectComposer,
  EffectPass,
  FXAAEffect,
  GodRaysEffect,
  NoiseEffect,
  type Pass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import * as THREE from 'three';
import type { QualitySettings } from '../types';
import { DisplayGradeEffect, LinearGradeEffect, type LookParams } from './grade';

export interface GradeInputs {
  exposure: number;
  temperature: number;
  tint: number;
  contrast: number;
  saturation: number;
  bloom: number;
  vignette: number;
  grain: number;
  chromaticAberration: number;
  look: LookParams;
  dof: { enabled: boolean; focusDistance: number; focusRange: number; bokehScale: number };
  /** Lens effects (vignette, grain, CA) — false while rendering capture tiles. */
  lensFx: boolean;
}

interface Structure {
  ao: QualitySettings['ao'];
  aoHalfRes: boolean;
  aa: QualitySettings['aa'];
  bloom: boolean;
  dof: boolean;
  ca: boolean;
  grain: boolean;
  shafts: boolean;
}

export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private structureKey = '';
  private passes: Pass[] = [];
  private effects: {
    linear: LinearGradeEffect;
    display: DisplayGradeEffect;
    tone: ToneMappingEffect;
    vignette: VignetteEffect;
    bloom?: BloomEffect;
    noise?: NoiseEffect;
    ca?: ChromaticAberrationEffect;
    dof?: DepthOfFieldEffect;
    rays?: GodRaysEffect;
    ao?: N8AOPostPass;
  };
  /** Mesh used as the god-ray light source (placed along the sun direction by the app). */
  readonly sunSprite: THREE.Mesh;
  private quality: QualitySettings | null = null;
  private width = 1;
  private height = 1;
  private pixelRatio = 1;

  constructor(container: HTMLElement, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
    });
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType });
    this.effects = {
      linear: new LinearGradeEffect(),
      display: new DisplayGradeEffect(),
      tone: new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
      vignette: new VignetteEffect({ offset: 0.3, darkness: 0.4 }),
    };
    this.sunSprite = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xfff2d8, fog: false, transparent: true, depthWrite: false }),
    );
    this.sunSprite.name = 'godray-sun';
    this.sunSprite.frustumCulled = false;
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** Drawing-buffer size in device pixels. */
  get bufferSize(): { width: number; height: number } {
    return { width: Math.round(this.width * this.pixelRatio), height: Math.round(this.height * this.pixelRatio) };
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.applyPixelRatio();
    this.renderer.shadowMap.enabled = q.shadows.enabled;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.applyPixelRatio();
  }

  private applyPixelRatio(): void {
    const q = this.quality;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.pixelRatio = q ? Math.min(dpr, q.maxDpr) * q.renderScale : 1;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height, false);
  }

  /** Rebuild passes if the structure changed; always push uniform values. */
  configure(g: GradeInputs, liveDof: boolean): void {
    const q = this.quality;
    if (!q) return;
    const s: Structure = {
      ao: q.ao,
      aoHalfRes: q.aoHalfRes,
      aa: q.aa,
      bloom: q.bloom,
      dof: g.dof.enabled && liveDof,
      ca: g.lensFx && q.lensFx && g.chromaticAberration > 0.001,
      grain: g.lensFx && q.lensFx && g.grain > 0.001,
      shafts: q.lightShafts === 'radial',
    };
    const key = JSON.stringify(s);
    if (key !== this.structureKey) {
      this.structureKey = key;
      this.rebuild(s);
    }
    this.applyValues(g, q);
  }

  private rebuild(s: Structure): void {
    for (const p of this.passes) {
      this.composer.removePass(p);
      p.dispose();
    }
    this.passes = [];
    for (const k of ['bloom', 'noise', 'ca', 'dof', 'rays'] as const) {
      this.effects[k]?.dispose();
      delete this.effects[k];
    }
    delete this.effects.ao; // disposed with its pass

    this.composer.multisampling = s.aa === 'msaa' || s.aa === 'msaa+smaa' ? 4 : 0;
    const add = (p: Pass) => {
      this.passes.push(p);
      this.composer.addPass(p);
    };
    add(new RenderPass(this.scene, this.camera));

    if (s.ao !== 'off') {
      const ao = new N8AOPostPass(this.scene, this.camera, this.width, this.height);
      ao.setQualityMode(s.ao === 'performance' ? 'Performance' : s.ao === 'medium' ? 'Medium' : 'High');
      ao.configuration.aoRadius = 2.0;
      ao.configuration.distanceFalloff = 1.0;
      ao.configuration.intensity = 2.2;
      ao.configuration.halfRes = s.aoHalfRes;
      ao.configuration.depthAwareUpsampling = true;
      ao.configuration.gammaCorrection = false; // we tone map later in linear space
      this.effects.ao = ao;
      add(ao);
    }
    if (s.dof) {
      this.effects.dof = new DepthOfFieldEffect(this.camera, { focusDistance: 10, focusRange: 5, bokehScale: 2 });
      add(new EffectPass(this.camera, this.effects.dof));
    }
    if (s.shafts) {
      this.effects.rays = new GodRaysEffect(this.camera, this.sunSprite, {
        density: 0.92,
        decay: 0.93,
        weight: 0.35,
        exposure: 0.45,
        samples: 48,
        clampMax: 1,
        resolutionScale: 0.5,
        blur: true,
      });
      add(new EffectPass(this.camera, this.effects.rays));
    }
    const main: import('postprocessing').Effect[] = [this.effects.linear];
    if (s.bloom) {
      this.effects.bloom = new BloomEffect({ intensity: 0.6, luminanceThreshold: 1.1, luminanceSmoothing: 0.3, mipmapBlur: true, radius: 0.7 });
      main.push(this.effects.bloom);
    }
    main.push(this.effects.tone, this.effects.display, this.effects.vignette);
    if (s.grain) {
      this.effects.noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
      main.push(this.effects.noise);
    }
    add(new EffectPass(this.camera, ...main));
    if (s.ca) {
      this.effects.ca = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.001, 0.001), radialModulation: true, modulationOffset: 0.25 });
      add(new EffectPass(this.camera, this.effects.ca));
    }
    if (s.aa === 'smaa' || s.aa === 'msaa+smaa') add(new EffectPass(this.camera, new SMAAEffect({ preset: SMAAPreset.MEDIUM })));
    else if (s.aa === 'fxaa') add(new EffectPass(this.camera, new FXAAEffect()));
  }

  private applyValues(g: GradeInputs, q: QualitySettings): void {
    const e = this.effects;
    e.linear.set(g.exposure + g.look.exposure, g.temperature, g.tint);
    e.display.set(g.contrast, g.saturation, g.look);
    e.tone.mode =
      g.look.toneMapping === 'aces' ? ToneMappingMode.ACES_FILMIC : g.look.toneMapping === 'neutral' ? ToneMappingMode.NEUTRAL : ToneMappingMode.AGX;
    e.display.blendMode.opacity.value = q.grade ? 1 : 0;
    const vig = g.lensFx || q.lensFx ? g.vignette : 0;
    e.vignette.darkness = vig;
    e.vignette.blendMode.opacity.value = g.lensFx ? 1 : 0;
    if (e.bloom) e.bloom.intensity = g.bloom;
    if (e.noise) e.noise.blendMode.opacity.value = g.grain * 0.35;
    if (e.ca) e.ca.offset.set(g.chromaticAberration * 0.004, g.chromaticAberration * 0.004);
    if (e.dof) {
      e.dof.cocMaterial.focusDistance = g.dof.focusDistance;
      e.dof.cocMaterial.focusRange = g.dof.focusRange;
      e.dof.bokehScale = g.dof.bokehScale;
    }
  }

  render(dt: number): void {
    this.renderer.info.reset();
    this.composer.render(dt);
  }

  dispose(): void {
    for (const p of this.passes) p.dispose();
    this.composer.dispose();
    this.sunSprite.geometry.dispose();
    (this.sunSprite.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
