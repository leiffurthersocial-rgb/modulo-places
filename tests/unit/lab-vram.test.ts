import { describe, expect, it } from 'vitest';
import { formatBytes, mapBytes, materialBytes, vramTable } from '../../src/lab/vram';

describe('lab vram estimates', () => {
  it('computes one 1k map with mips', () => {
    expect(mapBytes(1024)).toBeCloseTo(1024 * 1024 * (4 / 3), 3);
  });
  it('multiplies by three maps by default', () => {
    expect(materialBytes(2048)).toBeCloseTo(2048 * 2048 * 4, 0);
    expect(materialBytes(512, 2)).toBeCloseTo(512 * 512 * (8 / 3), 3);
  });
  it('lists tiers, 4k optional', () => {
    expect(vramTable().map((r) => r.size)).toEqual([512, 1024, 2048]);
    expect(vramTable(true).map((r) => r.size)).toEqual([512, 1024, 2048, 4096]);
    expect(vramTable(true)[3]?.total).toBeCloseTo(4096 * 4096 * 4, 0);
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });
});
