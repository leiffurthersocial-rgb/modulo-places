// Process fetched assets into shippable, content-hashed files under public/pack/.
//
//   npx tsx scripts/process-assets.ts [--only materials|models|hdris|audio]
//
// Materials: KTX2 tiers 512/1024/2048 (+4096 for hero picks). color = ETC1S (sRGB),
//            arm (AO/rough/metal) = ETC1S (linear), normal = UASTC + zstd (ETC1S ruins normals).
// Models:    glTF → dedup/weld/prune → LOD chain via meshoptimizer simplify (LOD0/1/2 meshes in one
//            GLB sharing textures) → textures resized + KTX2 → meshopt compression.
// HDRIs:     1k/2k .hdr copied (content-hashed).
// Audio:     ffmpeg → Opus .ogg + AAC .m4a (Safari < 18.4 has no Ogg; DECISIONS D-014).
// Writes public/pack/manifest.json and reports/asset-sizes.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { cloneDocument, dedup, meshopt, mergeDocuments, prune, resample, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { encodeToKTX2 } from 'ktx2-encoder';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { ambientcgTexture, type MaterialFiles, polyhavenHdri, polyhavenModel, polyhavenTexture } from './lib/sources';

const ROOT = process.cwd();
const PACK = join(ROOT, 'public', 'pack');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? process.argv[i + 1] : undefined;
})();

type Tier = 512 | 1024 | 2048 | 4096;
interface Manifest {
  materials: Record<string, { source: string; id: string; tiers: Partial<Record<Tier, { color: string; normal: string; arm: string; bytes: number }>> }>;
  models: Record<string, { source: string; id: string; file: string; bytes: number; lods: number; triangles: number[] }>;
  hdris: Record<string, { source: string; id: string; '1k': string; '2k': string; bytes: number }>;
  audio: Record<string, { ogg: string; m4a: string; bytes: number }>;
}

interface Picks {
  materials: Record<string, { source: 'polyhaven' | 'ambientcg'; id: string; hero?: boolean }>;
  models?: Record<string, { source: 'polyhaven'; id: string; lodRatios?: number[] }>;
  hdris?: Record<string, { source: 'polyhaven'; id: string }>;
  audio?: Record<string, { file: string }>;
}

const manifestPath = join(PACK, 'manifest.json');
const manifest: Manifest = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest)
  : { materials: {}, models: {}, hdris: {}, audio: {} };

/** Write bytes as <dir>/<name>.<hash8><ext>; returns the site-relative URL. */
function writeHashed(dir: string, name: string, ext: string, data: Uint8Array): string {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
  const abs = join(PACK, dir);
  mkdirSync(abs, { recursive: true });
  const file = `${name}.${hash}${ext}`;
  const p = join(abs, file);
  if (!existsSync(p)) writeFileSync(p, data);
  return `/pack/${dir}/${file}`;
}

const imageDecoder = async (buffer: Uint8Array) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

async function armImage(files: MaterialFiles, size: number): Promise<Buffer> {
  if (files.arm) return sharp(files.arm).resize(size, size).png().toBuffer();
  const grey = async (p: string | undefined, v: number) =>
    p ? await sharp(p).resize(size, size).greyscale().raw().toBuffer() : Buffer.alloc(size * size, v);
  const ao = await grey(files.ao, 255);
  const rough = await grey(files.rough, 200);
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = ao[i]!;
    rgb[i * 3 + 1] = rough[i]!;
  }
  return sharp(rgb, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

async function processMaterials(p: Picks): Promise<void> {
  for (const [key, m] of Object.entries(p.materials)) {
    const res = m.hero ? '4k' : '2k';
    const files = m.source === 'polyhaven' ? await polyhavenTexture(m.id, res) : await ambientcgTexture(m.id, res);
    const tiers: Tier[] = m.hero ? [512, 1024, 2048, 4096] : [512, 1024, 2048];
    const entry: Manifest['materials'][string] = { source: m.source, id: m.id, tiers: {} };
    for (const t of tiers) {
      const dir = `materials/${key}/${t}`;
      const color = await sharp(files.color).resize(t, t).png().toBuffer();
      const normal = await sharp(files.normal).resize(t, t).png().toBuffer();
      const arm = await armImage(files, t);
      const kColor = await encodeToKTX2(new Uint8Array(color), { isUASTC: false, qualityLevel: 230, compressionLevel: 2, generateMipmap: true, isPerceptual: true, imageDecoder });
      const kArm = await encodeToKTX2(new Uint8Array(arm), { isUASTC: false, qualityLevel: 200, compressionLevel: 2, generateMipmap: true, isPerceptual: false, imageDecoder });
      const kNormal = await encodeToKTX2(new Uint8Array(normal), { isUASTC: true, isNormalMap: true, needSupercompression: true, generateMipmap: true, isPerceptual: false, imageDecoder });
      entry.tiers[t] = {
        color: writeHashed(dir, 'color', '.ktx2', kColor),
        normal: writeHashed(dir, 'normal', '.ktx2', kNormal),
        arm: writeHashed(dir, 'arm', '.ktx2', kArm),
        bytes: kColor.byteLength + kNormal.byteLength + kArm.byteLength,
      };
      console.log(`  ✓ ${key} @${t}: ${(entry.tiers[t]!.bytes / 1024).toFixed(0)} KB`);
    }
    manifest.materials[key] = entry;
  }
}

async function processModels(p: Picks): Promise<void> {
  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  for (const [key, m] of Object.entries(p.models ?? {})) {
    const src = await polyhavenModel(m.id, '2k');
    const doc: Document = await io.read(src);
    await doc.transform(dedup(), prune(), weld(), resample());
    // LOD chain: duplicate each mesh's primitives and simplify the copies.
    const ratios = m.lodRatios ?? [1, 0.35, 0.12];
    const triangles: number[] = [];
    const root = doc.getRoot();
    const baseScene = root.listScenes()[0]!;
    const baseNodes = baseScene.listChildren();
    for (let li = 1; li < ratios.length; li++) {
      const lodDoc = cloneDocument(doc);
      await lodDoc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: ratios[li]!, error: 0.002 * li, lockBorder: false }));
      // Merge the simplified meshes back as "LOD<li>" nodes.
      const lodScene = lodDoc.getRoot().listScenes()[0]!;
      const map = mergeDocuments(doc, lodDoc);
      const merged = map.get(lodScene) as typeof baseScene;
      const group = doc.createNode(`LOD${li}`);
      for (const n of merged.listChildren()) group.addChild(n);
      baseScene.addChild(group);
      merged.dispose();
    }
    const lod0 = doc.createNode('LOD0');
    for (const n of baseNodes) lod0.addChild(n);
    baseScene.addChild(lod0);
    await doc.transform(dedup(), prune());
    for (const node of baseScene.listChildren()) {
      let tris = 0;
      node.traverse((n) => {
        for (const prim of n.getMesh()?.listPrimitives() ?? []) tris += (prim.getIndices()?.getCount() ?? 0) / 3;
      });
      triangles.push(tris);
    }
    await doc.transform(textureCompress({ encoder: sharp, resize: [1024, 1024], targetFormat: 'png' }));
    const { ktx2 } = await import('ktx2-encoder/gltf-transform');
    await doc.transform(ktx2({ isUASTC: false, qualityLevel: 220, generateMipmap: true, imageDecoder }) as never);
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const glb = await io.writeBinary(doc);
    manifest.models[key] = { source: m.source, id: m.id, file: writeHashed('models', key.replaceAll('/', '-'), '.glb', glb), bytes: glb.byteLength, lods: ratios.length, triangles };
    console.log(`  ✓ model ${key}: ${(glb.byteLength / 1024).toFixed(0)} KB, tris ${triangles.join('/')}`);
  }
}

async function processHdris(p: Picks): Promise<void> {
  for (const [key, h] of Object.entries(p.hdris ?? {})) {
    const k1 = readFileSync(await polyhavenHdri(h.id, '1k'));
    const k2 = readFileSync(await polyhavenHdri(h.id, '2k'));
    const name = key.replaceAll('/', '-');
    manifest.hdris[key] = { source: h.source, id: h.id, '1k': writeHashed('hdris', `${name}-1k`, '.hdr', k1), '2k': writeHashed('hdris', `${name}-2k`, '.hdr', k2), bytes: k1.byteLength + k2.byteLength };
    console.log(`  ✓ hdri ${key}`);
  }
}

function processAudio(p: Picks): void {
  for (const [key, a] of Object.entries(p.audio ?? {})) {
    const src = join(ROOT, '.asset-cache', a.file);
    const tmp = join(ROOT, '.asset-cache', 'tmp');
    mkdirSync(tmp, { recursive: true });
    const ogg = join(tmp, `${basename(src, extname(src))}.ogg`);
    const m4a = join(tmp, `${basename(src, extname(src))}.m4a`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '2', '-c:a', 'libopus', '-b:a', '96k', ogg]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ac', '2', '-c:a', 'aac', '-b:a', '112k', m4a]);
    const o = readFileSync(ogg);
    const m = readFileSync(m4a);
    const name = key.replaceAll('/', '-');
    manifest.audio[key] = { ogg: writeHashed('audio', name, '.ogg', o), m4a: writeHashed('audio', name, '.m4a', m), bytes: o.byteLength + m.byteLength };
  }
}

function sizeReport(): void {
  const lines = ['# Asset size report', '', `Generated ${new Date().toISOString()}`, '', '## Materials (download per material, all three maps)', '', '| Material | 512 | 1k | 2k | 4k |', '|---|---|---|---|---|'];
  const kb = (n?: number) => (n ? `${(n / 1024).toFixed(0)} KB` : '—');
  const totals: Record<number, number> = { 512: 0, 1024: 0, 2048: 0, 4096: 0 };
  for (const [k, m] of Object.entries(manifest.materials)) {
    lines.push(`| ${k} | ${kb(m.tiers[512]?.bytes)} | ${kb(m.tiers[1024]?.bytes)} | ${kb(m.tiers[2048]?.bytes)} | ${kb(m.tiers[4096]?.bytes)} |`);
    for (const t of [512, 1024, 2048, 4096] as const) totals[t]! += m.tiers[t]?.bytes ?? m.tiers[2048]?.bytes ?? 0;
  }
  lines.push(`| **total** | ${kb(totals[512])} | ${kb(totals[1024])} | ${kb(totals[2048])} | ${kb(totals[4096])} |`, '', '## Models', '', '| Model | GLB | Triangles per LOD |', '|---|---|---|');
  for (const [k, m] of Object.entries(manifest.models)) lines.push(`| ${k} | ${kb(m.bytes)} | ${m.triangles.join(' / ')} |`);
  lines.push('', '## HDRIs', '', '| Key | 1k+2k |', '|---|---|');
  for (const [k, h] of Object.entries(manifest.hdris)) lines.push(`| ${k} | ${kb(h.bytes)} |`);
  lines.push('', '## Audio', '', '| Key | ogg+m4a |', '|---|---|');
  for (const [k, a] of Object.entries(manifest.audio)) lines.push(`| ${k} | ${kb(a.bytes)} |`);
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(join(ROOT, 'reports', 'asset-sizes.md'), lines.join('\n') + '\n');
}

/** Credits for shipped assets only (lab candidates are credited on the lab page). */
function writeCredits(): void {
  const lic = JSON.parse(readFileSync(join(ROOT, 'assets', 'LICENSES.json'), 'utf8')) as Record<string, { name: string; authors: string[]; license: string; url: string; source: string }>;
  const keys = new Set<string>();
  for (const m of Object.values(manifest.materials)) keys.add(`${m.source}:${m.id}`);
  for (const m of Object.values(manifest.models)) keys.add(`${m.source}:${m.id}`);
  for (const h of Object.values(manifest.hdris)) keys.add(`${h.source}:${h.id}`);
  const out = [...keys].sort().map((k) => {
    const e = lic[k];
    if (!e) throw new Error(`No license entry for shipped asset ${k}`);
    return { name: e.name, role: `${e.source} · ${e.authors.join(', ')}`, license: e.license, url: e.url };
  });
  writeFileSync(join(ROOT, 'src', 'data', 'asset-credits.json'), JSON.stringify(out, null, 2) + '\n');
}

function packBytes(): number {
  if (!existsSync(PACK)) return 0;
  let n = 0;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else n += statSync(p).size;
    }
  };
  walk(PACK);
  return n;
}

const picksPath = (process.argv.includes('--picks-file') ? process.argv[process.argv.indexOf('--picks-file') + 1]! : join(ROOT, 'src/config/picks.json'));
if (!existsSync(picksPath)) {
  console.log('No src/config/picks.json yet — pick favourites in /lab.html and export them first.');
  process.exit(0);
}
const picks = JSON.parse(readFileSync(picksPath, 'utf8')) as Picks;
if (!only || only === 'materials') await processMaterials(picks);
if (!only || only === 'models') await processModels(picks);
if (!only || only === 'hdris') await processHdris(picks);
if (!only || only === 'audio') processAudio(picks);
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
writeCredits();
sizeReport();
console.log(`pack total: ${(packBytes() / 1048576).toFixed(1)} MB`);
