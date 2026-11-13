// Estimated GPU memory for the shipped KTX2 tiers. ASTC 4x4 (and ETC2/UASTC-transcoded) store
// 8 bits per texel = 1 byte per texel; a full mip chain adds ~1/3 (1 + 1/4 + 1/16 ... = 4/3).
export const MIP_FACTOR = 4 / 3;
export const BYTES_PER_TEXEL = 1;
/** colour, normal, arm */
export const MAPS_PER_MATERIAL = 3;
export const VRAM_TIERS = [512, 1024, 2048, 4096] as const;

/** Bytes for one square compressed map of `size` px per side, including mips. */
export function mapBytes(size: number): number {
  return size * size * BYTES_PER_TEXEL * MIP_FACTOR;
}

/** Bytes for a whole material (default 3 maps) at one tier. */
export function materialBytes(size: number, maps: number = MAPS_PER_MATERIAL): number {
  return mapBytes(size) * maps;
}

export interface VramRow {
  size: number;
  perMap: number;
  total: number;
}

export function vramTable(include4k = false, maps: number = MAPS_PER_MATERIAL): VramRow[] {
  return VRAM_TIERS.filter((s) => include4k || s <= 2048).map((size) => ({
    size,
    perMap: mapBytes(size),
    total: materialBytes(size, maps),
  }));
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${Math.round(n)} B`;
}
