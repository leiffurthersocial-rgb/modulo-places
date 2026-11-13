// Minimal typings for n8ao 1.10 (the package ships none). Only what the engine uses.
declare module 'n8ao' {
  import type { Camera, Scene, Color } from 'three';
  import type { Pass } from 'postprocessing';
  export interface N8AOConfiguration {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    color: Color;
    gammaCorrection: boolean;
    screenSpaceRadius: boolean;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
  }
  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
  }
}
