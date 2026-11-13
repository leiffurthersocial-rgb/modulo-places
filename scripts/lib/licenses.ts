// assets/LICENSES.json: one entry per third-party asset we ship or show (lab included).
// Tests fail if a shipped asset has no entry (tests/unit/licenses.test.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LicenseEntry {
  /** "<source>:<id>" */
  key: string;
  source:
    | 'polyhaven'
    | 'ambientcg'
    | 'quaternius'
    | 'kenney'
    | 'sketchfab'
    | 'freesound'
    | 'pixabay'
    | 'google-fonts';
  id: string;
  name: string;
  authors: string[];
  license: 'CC0-1.0' | 'CC-BY-4.0' | 'CC-BY-3.0' | 'OFL-1.1' | 'Pixabay Content License';
  url: string;
  /** Required attribution text when the license needs it. */
  attribution?: string;
  fetchedAt: string;
}

export const ALLOWED_LICENSES = new Set([
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'OFL-1.1',
  'Pixabay Content License',
]);

const FILE = join(process.cwd(), 'assets', 'LICENSES.json');

export function loadLicenses(): Record<string, LicenseEntry> {
  if (!existsSync(FILE)) return {};
  return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, LicenseEntry>;
}

export function saveLicenses(all: Record<string, LicenseEntry>): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(FILE, JSON.stringify(sorted, null, 2) + '\n');
}

export function upsertLicense(
  all: Record<string, LicenseEntry>,
  e: Omit<LicenseEntry, 'key' | 'fetchedAt'>,
): void {
  if (!ALLOWED_LICENSES.has(e.license))
    throw new Error(`Refusing ${e.source}:${e.id}: license ${e.license} not allowed`);
  const key = `${e.source}:${e.id}`;
  all[key] = { ...e, key, fetchedAt: all[key]?.fetchedAt ?? new Date().toISOString().slice(0, 10) };
}
