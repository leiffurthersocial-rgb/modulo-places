// Lighting moods for the lab. Forest uses the real moods from the greybox scene. Village, jungle and
// cabin moods below are hand-written PLACEHOLDERS until those scenes exist; replace them with the
// scene.json moods when the scenes land (the lab only needs the MoodDef shape).
import type { MoodDef } from '../engine/types';
import greybox from '../scenes/greybox/scene.json';

const forest = (greybox as unknown as { moods: MoodDef[] }).moods.slice(0, 3);

const village: MoodDef[] = [
  {
    id: 'lantern-dusk',
    name: 'Lantern dusk',
    sky: { zenith: '#28345a', horizon: '#d98a62', ground: '#2e2824' },
    sun: { azimuth: 260, elevation: 3, color: '#ff8a4c', intensity: 1.6, discSize: 0.7 },
    ambient: { sky: '#6b749c', ground: '#43362b', intensity: 0.7 },
    fog: { color: '#8f7a78', density: 0.014, heightFalloff: 0.09, baseHeight: 0, sunScatter: 0.8 },
    post: {
      exposure: 0.55,
      contrast: 0.08,
      saturation: 0.08,
      temperature: 0.3,
      tint: 0.05,
      bloom: 1.1,
      vignette: 0.38,
    },
  },
  {
    id: 'rainy-morning',
    name: 'Rainy morning',
    sky: { zenith: '#6a7684', horizon: '#aab3ba', ground: '#4b4f50' },
    sun: { azimuth: 120, elevation: 22, color: '#d4dde6', intensity: 0.9, discSize: 1.4 },
    ambient: { sky: '#aab6c2', ground: '#4a4d4b', intensity: 1.0 },
    fog: { color: '#a3adb5', density: 0.03, heightFalloff: 0.06, baseHeight: 0, sunScatter: 0.1 },
    post: {
      exposure: 0.2,
      contrast: -0.02,
      saturation: -0.2,
      temperature: -0.08,
      tint: 0,
      bloom: 0.4,
      vignette: 0.3,
    },
  },
  {
    id: 'midday',
    name: 'Midday',
    sky: { zenith: '#4a7fba', horizon: '#c3d4e0', ground: '#5d5a50' },
    sun: { azimuth: 190, elevation: 60, color: '#fff2de', intensity: 4.4, discSize: 0.55 },
    ambient: { sky: '#aac4e2', ground: '#51493b', intensity: 0.9 },
    fog: { color: '#b8c7d4', density: 0.006, heightFalloff: 0.05, baseHeight: 0, sunScatter: 0.2 },
    post: {
      exposure: -0.1,
      contrast: 0.05,
      saturation: 0,
      temperature: 0,
      tint: 0,
      bloom: 0.35,
      vignette: 0.22,
    },
  },
];

const jungle: MoodDef[] = [
  {
    id: 'midday',
    name: 'Midday canopy',
    sky: { zenith: '#4f86b0', horizon: '#bfd8cf', ground: '#3f4a38' },
    sun: { azimuth: 170, elevation: 70, color: '#fff6e0', intensity: 4.6, discSize: 0.55 },
    ambient: { sky: '#9fc7b5', ground: '#3a4a2c', intensity: 1.0 },
    fog: { color: '#a9c2b4', density: 0.02, heightFalloff: 0.07, baseHeight: 0, sunScatter: 0.3 },
    post: {
      exposure: -0.15,
      contrast: 0.06,
      saturation: 0.12,
      temperature: 0.03,
      tint: -0.05,
      bloom: 0.5,
      vignette: 0.28,
    },
  },
  {
    id: 'storm',
    name: 'Storm',
    sky: { zenith: '#3b4650', horizon: '#7a8a88', ground: '#2f3a33' },
    sun: { azimuth: 150, elevation: 30, color: '#b9c9cc', intensity: 0.7, discSize: 2 },
    ambient: { sky: '#7f9490', ground: '#2f3a2c', intensity: 0.85 },
    fog: { color: '#6f807c', density: 0.04, heightFalloff: 0.05, baseHeight: 0, sunScatter: 0.05 },
    post: {
      exposure: 0.4,
      contrast: 0.1,
      saturation: -0.1,
      temperature: -0.1,
      tint: -0.08,
      bloom: 0.3,
      vignette: 0.42,
    },
  },
  {
    id: 'golden-hour',
    name: 'Golden hour',
    sky: { zenith: '#4a6a8f', horizon: '#f2b878', ground: '#3d3a2a' },
    sun: { azimuth: 250, elevation: 9, color: '#ffbb70', intensity: 3.0, discSize: 0.7 },
    ambient: { sky: '#a5b4b0', ground: '#4b4125', intensity: 0.8 },
    fog: { color: '#cfae86', density: 0.022, heightFalloff: 0.08, baseHeight: 0, sunScatter: 0.8 },
    post: {
      exposure: 0.2,
      contrast: 0.08,
      saturation: 0.1,
      temperature: 0.22,
      tint: 0.02,
      bloom: 0.9,
      vignette: 0.32,
    },
  },
];

const cabin: MoodDef[] = [
  {
    id: 'blue-hour',
    name: 'Blue hour',
    sky: { zenith: '#1e2d52', horizon: '#6f86b0', ground: '#222a36' },
    sun: { azimuth: 280, elevation: 1, color: '#7d94c8', intensity: 0.9, discSize: 0.8 },
    ambient: { sky: '#5c72a6', ground: '#2c3240', intensity: 0.8 },
    fog: { color: '#6a7a9c', density: 0.016, heightFalloff: 0.08, baseHeight: 0, sunScatter: 0.4 },
    post: {
      exposure: 0.75,
      contrast: 0.06,
      saturation: -0.05,
      temperature: -0.28,
      tint: 0.04,
      bloom: 0.8,
      vignette: 0.4,
    },
  },
  {
    id: 'midday',
    name: 'Midday',
    sky: { zenith: '#5388c4', horizon: '#c9dcea', ground: '#6b6e70' },
    sun: { azimuth: 195, elevation: 48, color: '#fff4e6', intensity: 4.0, discSize: 0.55 },
    ambient: { sky: '#b3cbe6', ground: '#5a5a58', intensity: 0.95 },
    fog: { color: '#c3d1de', density: 0.005, heightFalloff: 0.05, baseHeight: 0, sunScatter: 0.2 },
    post: {
      exposure: -0.1,
      contrast: 0.04,
      saturation: -0.02,
      temperature: -0.02,
      tint: 0,
      bloom: 0.35,
      vignette: 0.22,
    },
  },
  {
    id: 'aurora-night',
    name: 'Aurora night',
    sky: { zenith: '#0f2a2e', horizon: '#2c5a58', ground: '#10161c' },
    sun: { azimuth: 30, elevation: 14, color: '#a9c8ff', intensity: 0.35, discSize: 1.0 },
    ambient: { sky: '#3a7a74', ground: '#161e26', intensity: 0.65 },
    fog: { color: '#274a50', density: 0.012, heightFalloff: 0.07, baseHeight: 0, sunScatter: 0.3 },
    post: {
      exposure: 1.2,
      contrast: 0.1,
      saturation: 0.1,
      temperature: -0.2,
      tint: -0.12,
      bloom: 1.2,
      vignette: 0.45,
    },
  },
];

export const LAB_MOODS: Record<string, MoodDef[]> = { forest, village, jungle, cabin };
