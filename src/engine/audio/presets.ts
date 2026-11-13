import type { AmbienceMix } from './math';

export const AMBIENCE_PRESETS: Record<string, AmbienceMix> = {
  'forest-dawn': {
    wind: 0.2,
    windGust: 0.2,
    birds: 0.6,
    birdsDawnChorus: 0.95,
    insects: 0.03,
    creek: 0.6,
    rain: 0,
    night: 0.08,
  },
  'forest-midday': {
    wind: 0.45,
    windGust: 0.5,
    birds: 0.5,
    birdsDawnChorus: 0.1,
    insects: 0.5,
    creek: 0.5,
    rain: 0,
    night: 0,
  },
  'forest-dusk': {
    wind: 0.2,
    windGust: 0.25,
    birds: 0.18,
    birdsDawnChorus: 0,
    insects: 0.15,
    creek: 0.5,
    rain: 0,
    night: 0.4,
  },
};
