// Favourites: one material candidate per "<scene>/<key>", one HDRI per "<scene>/<mood>".
export interface Picks {
  materials: Record<string, { source: string; id: string }>;
  hdris: Record<string, { source: 'polyhaven'; id: string }>;
}

const KEY = 'modulo-lab-picks-v1';

export function loadPicks(): Picks {
  const empty: Picks = { materials: {}, hdris: {} };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Picks>;
    return { materials: p.materials ?? {}, hdris: p.hdris ?? {} };
  } catch {
    return empty;
  }
}

export function savePicks(p: Picks): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: picks live for this session only */
  }
}

export function exportPicks(p: Picks): string {
  return JSON.stringify({ materials: p.materials, hdris: p.hdris }, null, 2);
}
