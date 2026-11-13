// Shape of public/lab/manifest.json (written by scripts/fetch-assets.ts --lab).
export interface LabMaterial {
  source: string;
  id: string;
  name: string;
  authors: string[];
  url: string;
  why?: string;
  maps: { color: string; normal: string; arm?: string; height?: string };
  previewBytes: number;
}
export interface LabHdri {
  id: string;
  name: string;
  url: string;
  preview: string;
}
export interface LabMaterialGroup {
  label: string;
  use?: string;
  candidates: LabMaterial[];
}
export interface LabHdriGroup {
  label: string;
  candidates: LabHdri[];
}
export interface LabScene {
  materials: Record<string, LabMaterialGroup>;
  hdris: Record<string, LabHdriGroup>;
}
export interface LabManifest {
  generatedAt: string;
  scenes: Record<string, LabScene>;
}

export const FETCH_COMMAND = 'npm run assets:fetch -- --lab';

export class ManifestMissing extends Error {}

export async function loadManifest(url = '/lab/manifest.json'): Promise<LabManifest> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch {
    throw new ManifestMissing('Could not reach the dev server.');
  }
  const type = res.headers.get('content-type') ?? '';
  // Vite's SPA fallback answers missing files with index.html (200), so check the type too.
  if (!res.ok || type.includes('text/html')) {
    throw new ManifestMissing(`No manifest at ${url} (HTTP ${res.status}).`);
  }
  return (await res.json()) as LabManifest;
}
