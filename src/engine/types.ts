// Shared contracts between engine modules, UI and scene data. Keep this file dependency-free
// (no three.js imports) so it can be used by scripts, tests and UI alike.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Linear-ish sRGB hex string, e.g. "#a8b4c0". */
export type ColorHex = string;

// ---------------------------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------------------------

export type PresetId = 'ultra' | 'high' | 'medium' | 'low' | 'saver' | 'custom';

export interface QualitySettings {
  /** Multiplier on min(devicePixelRatio, maxDpr). */
  renderScale: number;
  maxDpr: number;
  fpsCap: 30 | 60;
  shadows: { enabled: boolean; mapSize: 512 | 1024 | 2048 | 4096; distance: number };
  ao: 'off' | 'performance' | 'medium' | 'high';
  aoHalfRes: boolean;
  /** 'msaa' = multisampled scene target (enables alpha-to-coverage on foliage). */
  aa: 'none' | 'fxaa' | 'smaa' | 'msaa' | 'msaa+smaa';
  bloom: boolean;
  grade: boolean;
  lensFx: boolean; // vignette, grain, chromatic aberration
  lightShafts: 'off' | 'cards' | 'radial';
  textureTier: 512 | 1024 | 2048 | 4096;
  vegetationDensity: number; // 0..1
  drawDistance: number; // metres
  lodBias: number; // >1 keeps detail further
  water: 'simple' | 'reflect' | 'refract';
  particles: number; // 0..1
  liveDof: boolean;
  anisotropy: number;
}

// ---------------------------------------------------------------------------------------------
// User settings (persisted)
// ---------------------------------------------------------------------------------------------

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'slow'
  | 'crouch'
  | 'up'
  | 'down'
  | 'photoMode'
  | 'capture'
  | 'cycleMood'
  | 'debug'
  | 'hideUI'
  | 'menu';

export type KeyBindings = Record<Action, string[]>; // KeyboardEvent.code values

export interface UserSettings {
  version: 1;
  preset: PresetId;
  /** Only used when preset === 'custom'. */
  custom: QualitySettings;
  fov: number; // vertical degrees, 50..90
  lookSensitivity: number; // 0.2..3
  invertY: boolean;
  headBob: boolean;
  reduceMotion: boolean;
  uiScale: number; // 0.8..1.5
  touchControls: 'auto' | 'on' | 'off';
  watchdog: boolean;
  bindings: KeyBindings;
  masterVolume: number; // 0..1
  seenTutorial: boolean;
}

// ---------------------------------------------------------------------------------------------
// Input frame (produced by engine/input, consumed by player and photo camera)
// ---------------------------------------------------------------------------------------------

export interface InputFrame {
  /** x = strafe right, y = forward; each -1..1 (analog for touch). */
  move: { x: number; y: number };
  /** Vertical movement for photo free-fly: -1..1. */
  lift: number;
  /** Look delta in radians this frame (already sensitivity-scaled; +x = turn right, +y = look up). */
  look: { x: number; y: number };
  sprint: boolean;
  slow: boolean;
  crouch: boolean;
  /** Actions that went down this frame (edge-triggered). */
  pressed: ReadonlySet<Action>;
}

// ---------------------------------------------------------------------------------------------
// Lighting moods
// ---------------------------------------------------------------------------------------------

export interface MoodDef {
  id: string;
  name: string;
  sky: {
    /** Analytic gradient sky (greybox) or an HDRI id resolved by the asset system. */
    zenith: ColorHex;
    horizon: ColorHex;
    ground: ColorHex;
    hdri?: string;
    hdriIntensity?: number;
  };
  sun: {
    /** Degrees; azimuth 0 = +Z (south-ish), 90 = +X. */
    azimuth: number;
    elevation: number;
    color: ColorHex;
    intensity: number;
    /** Angular disc size in degrees (visual only). */
    discSize?: number;
  };
  ambient: { sky: ColorHex; ground: ColorHex; intensity: number };
  fog: {
    color: ColorHex;
    /** Exponential density at height 0. */
    density: number;
    /** Height falloff (1/m); 0 = uniform fog. */
    heightFalloff: number;
    /** World Y where height fog is densest. */
    baseHeight: number;
    /** How strongly the sun tints fog when looking toward it (0..1). */
    sunScatter: number;
  };
  post: {
    exposure: number; // EV offset
    contrast: number; // -1..1
    saturation: number; // -1..1
    temperature: number; // -1 (cool) .. 1 (warm)
    tint: number; // -1 (green) .. 1 (magenta)
    bloom: number; // intensity
    vignette: number; // 0..1
  };
  /** Optional per-mood particle preset id ('mist', 'rain', 'snow', 'pollen', ...). */
  particles?: string[];
  ambience?: string[];
}

// ---------------------------------------------------------------------------------------------
// Scene definition (scene.json)
// ---------------------------------------------------------------------------------------------

export interface TerrainDef {
  /** Side length in metres (square, centred on origin). */
  size: number;
  /** Heightfield resolution (vertices per side). */
  resolution: number;
  source: { type: 'procedural'; seedOffset?: number } | { type: 'image'; url: string };
  /** Procedural parameters. */
  height: number;
  baseFrequency: number;
  octaves: number;
  warp: number;
  /** Optional flat areas or paths: [x, z, radius, targetHeight|null]. */
  flatten?: { x: number; z: number; radius: number; height?: number }[];
  layers: TerrainLayerDef[];
}

export interface TerrainLayerDef {
  id: string;
  /** Material id resolved by the material registry (greybox: procedural). */
  material: string;
  color: ColorHex;
  roughness: number;
  /** Splat rule: weights from slope (degrees) and height (m) ranges, plus noise. */
  slope?: Vec2;
  height?: Vec2;
  noise?: number;
}

export type MaskDef =
  | { type: 'slope'; min?: number; max?: number; soft?: number }
  | { type: 'height'; min?: number; max?: number; soft?: number }
  | { type: 'noise'; frequency: number; threshold: number; soft?: number; seedOffset?: number }
  | { type: 'exclude'; x: number; z: number; radius: number; soft?: number }
  | { type: 'layer'; layer: string; min: number };

export interface ScatterRuleDef {
  id: string;
  /** Mesh id: greybox primitives ('tree', 'bush', 'rock', 'grass', 'fern', 'log', 'pebble') or an asset id. */
  mesh: string;
  /** Instances per 100 m² before masks, at vegetationDensity = 1. */
  density: number;
  /** Minimum distance between instances of this rule (m). */
  minDistance: number;
  scale: Vec2;
  /** Random yaw always; tilt in degrees and fraction aligned to terrain normal. */
  tilt?: number;
  alignToNormal?: number;
  sink?: number;
  masks?: MaskDef[];
  /** Clustering: probability multiplied by noise at this frequency. */
  cluster?: { frequency: number; strength: number };
  /** LOD switch distances (m) at lodBias 1; length defines number of LODs. */
  lods?: number[];
  /** Hard cull distance (m) at drawDistance scale 1. */
  cullDistance?: number;
  castShadow?: boolean;
  collision?: 'none' | 'cylinder' | 'sphere';
  /** Colour variation for greybox. */
  color?: ColorHex;
  colorVariation?: number;
  /** Is this rule "detail" that scales with vegetationDensity (true) or structural (false)? */
  detail?: boolean;
}

export interface PropDef {
  id: string;
  mesh: string;
  position: Vec3;
  rotation?: Vec3; // degrees
  scale?: number | Vec3;
  collision?: 'none' | 'box' | 'cylinder' | 'mesh';
  color?: ColorHex;
}

export interface SceneDef {
  id: string;
  name: string;
  description: string;
  seed: number;
  preview?: string;
  terrain: TerrainDef;
  scatter: ScatterRuleDef[];
  props: PropDef[];
  spawn: { position: Vec3; yaw: number };
  /** Walkable soft boundary radius (m) and photo-mode bounding box half-extent. */
  bounds: { walkRadius: number; photoHalfExtent: number; photoMaxHeight: number };
  moods: MoodDef[];
  defaultMood: string;
  /** Fixed review cameras for screenshot QA. */
  cameras: { id: string; position: Vec3; target: Vec3; fov?: number }[];
}

// ---------------------------------------------------------------------------------------------
// Photo mode
// ---------------------------------------------------------------------------------------------

export type FilmLook = 'neutral' | 'filmic' | 'moody' | 'vintage' | 'bw' | 'pastel';

export interface PhotoParams {
  focalLength: number; // mm, full-frame equivalent, 14..200
  aperture: number; // f-stop, 1.4..22
  focusDistance: number; // m
  dof: boolean;
  exposure: number; // EV offset, -3..3
  temperature: number; // -1..1
  tint: number; // -1..1
  contrast: number; // -1..1
  saturation: number; // -1..1
  vignette: number; // 0..1
  grain: number; // 0..1
  bloom: number; // 0..3
  chromaticAberration: number; // 0..1
  lensFlare: boolean;
  look: FilmLook;
  grid: boolean;
  horizon: boolean;
  metadataOverlay: boolean;
  pauseMotion: boolean;
  roll: number; // degrees
}
