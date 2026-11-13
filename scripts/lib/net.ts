// Polite HTTP for asset fetching: per-host rate limit, retries with backoff, generic User-Agent,
// on-disk cache in .asset-cache/ (gitignored), optional MD5 verification.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CACHE = join(process.cwd(), '.asset-cache');
const UA = 'asset-fetcher/0.1 (three.js hobby project; polite, cached)';
const MIN_GAP_MS = 750;
const lastHit = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(url: string): Promise<void> {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
}

export async function fetchRetry(
  url: string,
  init: RequestInit = {},
  tries = 4,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    await throttle(url);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, ...(init.headers ?? {}) },
      });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} ${url}`);
        await sleep(1500 * 2 ** i);
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      lastErr = e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function getJson<T>(url: string, cacheKey?: string, maxAgeH = 24 * 7): Promise<T> {
  if (cacheKey) {
    const p = join(CACHE, 'json', cacheKey + '.json');
    if (existsSync(p)) {
      const { at, data } = JSON.parse(readFileSync(p, 'utf8')) as { at: number; data: T };
      if (Date.now() - at < maxAgeH * 3600_000) return data;
    }
    const data = (await (await fetchRetry(url)).json()) as T;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ at: Date.now(), data }));
    return data;
  }
  return (await (await fetchRetry(url)).json()) as T;
}

/** Download to a cache path (skips if present and md5 matches). Returns the local path. */
export async function download(url: string, relPath: string, md5?: string): Promise<string> {
  const p = join(CACHE, relPath);
  if (existsSync(p)) {
    if (!md5 || createHash('md5').update(readFileSync(p)).digest('hex') === md5) return p;
  }
  const buf = Buffer.from(await (await fetchRetry(url)).arrayBuffer());
  if (md5) {
    const got = createHash('md5').update(buf).digest('hex');
    if (got !== md5) throw new Error(`MD5 mismatch for ${url}: ${got} != ${md5}`);
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  return p;
}
