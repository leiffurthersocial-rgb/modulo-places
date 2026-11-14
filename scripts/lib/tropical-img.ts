// Image helpers for scripts/bake-tropical.ts (RGBA8 buffers, colour dilation, KTX2 encode glue).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

export interface Img {
  w: number;
  h: number;
  d: Uint8Array;
}

export const newImg = (w: number, h: number): Img => ({ w, h, d: new Uint8Array(w * h * 4) });

export async function decodeDataUrl(dataUrl: string): Promise<Img> {
  return decodeBuffer(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

export async function decodeBuffer(b: Buffer | Uint8Array): Promise<Img> {
  const { data, info } = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { w: info.width, h: info.height, d: new Uint8Array(data) };
}

export const imageDecoder = async (buffer: Uint8Array) => {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

export function toPng(a: Img): Promise<Buffer> {
  return sharp(Buffer.from(a.d), { raw: { width: a.w, height: a.h, channels: 4 } })
    .png()
    .toBuffer();
}

/** Box-downsample by f; colour weighted by alpha when alphaWeighted. */
export function downsample(img: Img, f: number, alphaWeighted: boolean): Img {
  const w = img.w / f;
  const h = img.h / f;
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let j = 0; j < f; j++)
        for (let i = 0; i < f; i++) {
          const p = ((y * f + j) * img.w + x * f + i) * 4;
          const al = img.d[p + 3]! / 255;
          const wt = alphaWeighted ? al : 1;
          r += img.d[p]! * wt;
          g += img.d[p + 1]! * wt;
          b += img.d[p + 2]! * wt;
          a += al;
          wsum += wt;
        }
      const o = (y * w + x) * 4;
      const k = wsum > 0 ? 1 / wsum : 0;
      d[o] = r * k;
      d[o + 1] = g * k;
      d[o + 2] = b * k;
      d[o + 3] = (a / (f * f)) * 255;
    }
  return { w, h, d };
}

/** Fill texels where mask is false with the mean of the nearest filled neighbours (iterative). */
export function dilate(img: Img, mask: Uint8Array, iterations: number): void {
  const filled = Uint8Array.from(mask);
  for (let it = 0; it < iterations; it++) {
    const add: number[] = [];
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x < img.w; x++) {
        const i = y * img.w + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let c = 0;
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++) {
            const xx = x + k;
            const yy = y + j;
            if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue;
            const q = yy * img.w + xx;
            if (!filled[q]) continue;
            r += img.d[q * 4]!;
            g += img.d[q * 4 + 1]!;
            b += img.d[q * 4 + 2]!;
            c++;
          }
        if (c > 0) add.push(i, r / c, g / c, b / c);
      }
    if (add.length === 0) break;
    for (let k = 0; k < add.length; k += 4) {
      const i = add[k]!;
      img.d[i * 4] = add[k + 1]!;
      img.d[i * 4 + 1] = add[k + 2]!;
      img.d[i * 4 + 2] = add[k + 3]!;
      filled[i] = 1;
    }
  }
}

/** Blit src into dst at (ox, oy) (all four channels). */
export function blit(dst: Img, src: Img, ox: number, oy: number): void {
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const s = (y * src.w + x) * 4;
      const d = ((oy + y) * dst.w + ox + x) * 4;
      for (let c = 0; c < 4; c++) dst.d[d + c] = src.d[s + c]!;
    }
}

/** Separable box blur of the RGB channels only (radius r, clamped edges). */
export function boxBlurRgb(img: Img, r: number): Img {
  const out = newImg(img.w, img.h);
  const tmp = new Float32Array(img.w * img.h * 3);
  for (let y = 0; y < img.h; y++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += img.d[(y * img.w + Math.min(img.w - 1, Math.max(0, k))) * 4 + c]!;
      for (let x = 0; x < img.w; x++) {
        tmp[(y * img.w + x) * 3 + c] = acc / (2 * r + 1);
        const add = Math.min(img.w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        acc += img.d[(y * img.w + add) * 4 + c]! - img.d[(y * img.w + sub) * 4 + c]!;
      }
    }
  }
  for (let x = 0; x < img.w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(Math.min(img.h - 1, Math.max(0, k)) * img.w + x) * 3 + c]!;
      for (let y = 0; y < img.h; y++) {
        out.d[(y * img.w + x) * 4 + c] = acc / (2 * r + 1);
        const add = Math.min(img.h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        acc += tmp[(add * img.w + x) * 3 + c]! - tmp[(sub * img.w + x) * 3 + c]!;
      }
    }
  }
  for (let i = 0; i < img.w * img.h; i++) out.d[i * 4 + 3] = img.d[i * 4 + 3]!;
  return out;
}

export function writeHashed(pack: string, dir: string, name: string, data: Uint8Array): string {
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
  const abs = join(pack, dir);
  mkdirSync(abs, { recursive: true });
  const file = `${name}.${hash}.ktx2`;
  if (!existsSync(join(abs, file))) writeFileSync(join(abs, file), data);
  return `/pack/${dir}/${file}`;
}
