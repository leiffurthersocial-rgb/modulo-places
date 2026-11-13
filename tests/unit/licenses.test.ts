// Every shipped asset (public/pack/manifest.json), every lab candidate (public/lab/manifest.json)
// and every credited asset must have a license entry with an allowed license.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = <T>(p: string): T | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null);
const ALLOWED = new Set(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0', 'OFL-1.1', 'Pixabay Content License']);
const licenses = read<Record<string, { license: string; name: string; url: string }>>('assets/LICENSES.json') ?? {};

interface Src { source: string; id: string }

describe('asset licenses', () => {
  it('all license entries use an allowed license and have a source URL', () => {
    for (const [k, e] of Object.entries(licenses)) {
      expect(ALLOWED.has(e.license), `${k}: ${e.license}`).toBe(true);
      expect(e.url, k).toMatch(/^https:\/\//);
    }
  });

  it('every shipped asset has a license entry', () => {
    const pack = read<{ materials: Record<string, Src>; models: Record<string, Src>; hdris: Record<string, Src> }>(
      'public/pack/manifest.json',
    );
    if (!pack) return;
    for (const group of [pack.materials, pack.models, pack.hdris]) {
      for (const [key, a] of Object.entries(group)) {
        expect(licenses[`${a.source}:${a.id}`], `pack ${key} → ${a.source}:${a.id}`).toBeDefined();
      }
    }
  });

  it('every lab candidate has a license entry', () => {
    const lab = read<{ scenes: Record<string, { materials: Record<string, { candidates: Src[] }> }> }>(
      'public/lab/manifest.json',
    );
    if (!lab) return;
    for (const scene of Object.values(lab.scenes)) {
      for (const m of Object.values(scene.materials)) {
        for (const c of m.candidates) expect(licenses[`${c.source}:${c.id}`], `${c.source}:${c.id}`).toBeDefined();
      }
    }
  });
});
