// Fetch third-party assets (polite, cached in .asset-cache/, licenses recorded in assets/LICENSES.json).
//
//   npx tsx scripts/fetch-assets.ts --lab [--scene forest]   lab candidates → public/lab/
//   npx tsx scripts/fetch-assets.ts --picks                  picked assets (src/config/picks.json) → cache
//   npx tsx scripts/fetch-assets.ts --manual                 print manual-download instructions
//
// Poly Haven lab candidates are loaded live from their CDN (CORS *, credited). ambientCG only ships
// zips, so their lab candidates are converted to small WebP previews committed under public/lab/acg/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadLicenses, saveLicenses, upsertLicense } from './lib/licenses';
import {
  ambientcgInfo,
  ambientcgTexture,
  MANUAL_SOURCES,
  polyhavenHdri,
  polyhavenInfo,
  polyhavenModel,
  polyhavenTexture,
  polyhavenTextureUrls,
  type MaterialFiles,
  type Res,
} from './lib/sources';

interface Candidate { source: 'polyhaven' | 'ambientcg'; id: string; why?: string }
interface Group { label: string; use?: string; candidates: Candidate[] }
interface Candidates { scenes: Record<string, { materials: Record<string, Group>; models?: Record<string, Group>; hdris?: Record<string, Group> }> }

export interface LabMaterial {
  source: string;
  id: string;
  name: string;
  authors: string[];
  url: string;
  why?: string;
  maps: { color: string; normal: string; arm?: string; height?: string };
  /** Bytes of the preview maps (download cost in the lab, not shipping cost). */
  previewBytes: number;
}
export interface LabManifest {
  generatedAt: string;
  scenes: Record<string, { materials: Record<string, { label: string; use?: string; candidates: LabMaterial[] }>; hdris: Record<string, { label: string; candidates: { id: string; name: string; url: string; preview: string }[] }> }>;
}

const args = new Set(process.argv.slice(2));
const argVal = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ROOT = process.cwd();
// Thumbnail URLs come from the Poly Haven catalogue metadata (thumbnail_url field).
const phCatalogue = (() => {
  const all: Record<string, { thumbnail_url?: string }> = {};
  for (const t of ['textures', 'models', 'hdris']) {
    const f = join(ROOT, '.asset-cache', 'meta', `ph-${t}.json`);
    if (existsSync(f)) Object.assign(all, JSON.parse(readFileSync(f, 'utf8')) as typeof all);
  }
  return all;
})();
const phThumb = (id: string) => phCatalogue[id]?.thumbnail_url ?? '';
const LAB_DIR = join(ROOT, 'public', 'lab');

/** Pack AO (R), roughness (G), metal=0 (B) into one image, like Poly Haven's "arm" map. */
async function packArm(files: MaterialFiles, size: number, out: string): Promise<void> {
  const grey = async (p: string | undefined, fallback: number) =>
    p
      ? await sharp(p).resize(size, size).greyscale().raw().toBuffer()
      : Buffer.alloc(size * size, fallback);
  const ao = await grey(files.ao, 255);
  const rough = await grey(files.rough, 200);
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = ao[i]!;
    rgb[i * 3 + 1] = rough[i]!;
    rgb[i * 3 + 2] = 0;
  }
  await sharp(rgb, { raw: { width: size, height: size, channels: 3 } }).webp({ quality: 82 }).toFile(out);
}

async function labAmbientcg(id: string, size: number): Promise<{ maps: LabMaterial['maps']; bytes: number }> {
  const files = await ambientcgTexture(id, '1k');
  const dir = join(LAB_DIR, 'acg', id);
  mkdirSync(dir, { recursive: true });
  const color = join(dir, 'color.webp');
  const normal = join(dir, 'normal.webp');
  const arm = join(dir, 'arm.webp');
  const height = join(dir, 'height.webp');
  if (!existsSync(color)) await sharp(files.color).resize(size, size).webp({ quality: 80 }).toFile(color);
  if (!existsSync(normal)) await sharp(files.normal).resize(size, size).webp({ quality: 88 }).toFile(normal);
  if (!existsSync(arm)) await packArm(files, size, arm);
  if (files.height && !existsSync(height)) await sharp(files.height).resize(size / 2, size / 2).greyscale().webp({ quality: 80 }).toFile(height);
  const rel = (p: string) => '/' + p.slice(join(ROOT, 'public').length + 1).replaceAll('\\', '/');
  const maps: LabMaterial['maps'] = { color: rel(color), normal: rel(normal), arm: rel(arm) };
  if (files.height) maps.height = rel(height);
  const { statSync } = await import('node:fs');
  const bytes = [color, normal, arm, files.height ? height : null].filter(Boolean).reduce((s, p) => s + statSync(p!).size, 0);
  return { maps, bytes };
}

async function lab(): Promise<void> {
  const cand = JSON.parse(readFileSync(join(ROOT, 'src/config/lab-candidates.json'), 'utf8')) as Candidates;
  const only = argVal('--scene');
  const lic = loadLicenses();
  const manifestPath = join(LAB_DIR, 'manifest.json');
  const manifest: LabManifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as LabManifest)
    : { generatedAt: '', scenes: {} };
  for (const [sceneId, scene] of Object.entries(cand.scenes)) {
    if (only && only !== sceneId) continue;
    const out: LabManifest['scenes'][string] = { materials: {}, hdris: {} };
    for (const [key, group] of Object.entries(scene.materials)) {
      const list: LabMaterial[] = [];
      for (const c of group.candidates) {
        try {
          const info = c.source === 'polyhaven' ? await polyhavenInfo(c.id) : await ambientcgInfo(c.id);
          upsertLicense(lic, info);
          let maps: LabMaterial['maps'];
          let bytes = 0;
          if (c.source === 'polyhaven') {
            const urls = await polyhavenTextureUrls(c.id, '1k');
            if (!urls.color || !urls.normal) throw new Error('missing maps');
            maps = { color: urls.color, normal: urls.normal };
            if (urls.arm) maps.arm = urls.arm;
            if (urls.height) maps.height = urls.height;
          } else {
            ({ maps, bytes } = await labAmbientcg(c.id, 1024));
          }
          list.push({ source: c.source, id: c.id, name: info.name, authors: info.authors, url: info.url, why: c.why, maps, previewBytes: bytes });
          console.log(`  ✓ ${sceneId}/${key}: ${c.source}:${c.id}`);
        } catch (e) {
          console.warn(`  ✗ ${sceneId}/${key}: ${c.source}:${c.id} — ${(e as Error).message}`);
        }
      }
      out.materials[key] = { label: group.label, use: group.use, candidates: list };
    }
    for (const [mood, group] of Object.entries(scene.hdris ?? {})) {
      const list: LabManifest['scenes'][string]['hdris'][string]['candidates'] = [];
      for (const c of group.candidates) {
        try {
          const info = await polyhavenInfo(c.id);
          upsertLicense(lic, info);
          list.push({ id: c.id, name: info.name, url: info.url, preview: phThumb(c.id) });
        } catch (e) {
          console.warn(`  ✗ hdri ${c.id} — ${(e as Error).message}`);
        }
      }
      out.hdris[mood] = { label: group.label, candidates: list };
    }
    manifest.scenes[sceneId] = out;
    saveLicenses(lic); // persist progress per scene
  }
  manifest.generatedAt = new Date().toISOString();
  mkdirSync(LAB_DIR, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
  console.log(`wrote ${manifestPath}`);
}

interface Picks {
  materials: Record<string, { source: 'polyhaven' | 'ambientcg'; id: string; hero?: boolean }>;
  models?: Record<string, { source: 'polyhaven'; id: string }>;
  hdris?: Record<string, { source: 'polyhaven'; id: string }>;
}

async function picks(): Promise<void> {
  const p = JSON.parse(readFileSync((process.argv.includes('--picks-file') ? process.argv[process.argv.indexOf('--picks-file') + 1]! : join(ROOT, 'src/config/picks.json')), 'utf8')) as Picks;
  const lic = loadLicenses();
  for (const [key, m] of Object.entries(p.materials)) {
    const res: Res = m.hero ? '4k' : '2k';
    const info = m.source === 'polyhaven' ? await polyhavenInfo(m.id) : await ambientcgInfo(m.id);
    upsertLicense(lic, info);
    if (m.source === 'polyhaven') await polyhavenTexture(m.id, res);
    else await ambientcgTexture(m.id, res);
    console.log(`  ✓ material ${key} ← ${m.source}:${m.id} @${res}`);
  }
  for (const [key, m] of Object.entries(p.models ?? {})) {
    upsertLicense(lic, await polyhavenInfo(m.id));
    await polyhavenModel(m.id, '2k');
    console.log(`  ✓ model ${key} ← ${m.id}`);
  }
  for (const [key, h] of Object.entries(p.hdris ?? {})) {
    upsertLicense(lic, await polyhavenInfo(h.id));
    await polyhavenHdri(h.id, '2k');
    await polyhavenHdri(h.id, '1k');
    console.log(`  ✓ hdri ${key} ← ${h.id}`);
  }
  saveLicenses(lic);
}

if (args.has('--lab')) await lab();
else if (args.has('--picks')) await picks();
else console.log(MANUAL_SOURCES);
