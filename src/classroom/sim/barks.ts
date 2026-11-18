// Tiered barks (Splinter Cell Blacklist): specific lines first, then generic, then minimal, so
// memorable lines are not repeated. Pure TS.
import type { BarkTiers } from './data';
import type { Rng } from './rng';

export class BarkPicker {
  private used = new Map<string, number>();

  pick(
    key: string,
    tiers: BarkTiers | undefined,
    rng: Rng,
    vars: Record<string, string> = {},
  ): string {
    if (!tiers || tiers.length === 0) return '';
    const n = this.used.get(key) ?? 0;
    this.used.set(key, n + 1);
    // Tier 1 lines are used once each, then tier 2 lines once each, then tier 3 forever.
    let idx = n;
    let tier = 0;
    while (tier < tiers.length - 1 && idx >= tiers[tier]!.length) {
      idx -= tiers[tier]!.length;
      tier++;
    }
    const lines = tiers[tier]!;
    const line = tier === tiers.length - 1 ? rng.pick(lines) : lines[idx % lines.length]!;
    return line.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? k);
  }

  reset(): void {
    this.used.clear();
  }
}
