// Fixed-step simulation clock. The sim always advances in TICK_DT steps (20 Hz); rendering
// interpolates between ticks. `timeScale` lets the headless balance runner run faster than real
// time, and lets menus slow the sim down. Pure TS.

export const TICK_HZ = 20;
export const TICK_DT = 1 / TICK_HZ;
/** Never simulate more than this many ticks per frame (avoids the spiral of death after a stall). */
export const MAX_TICKS_PER_FRAME = 8;

export class SimClock {
  tick = 0;
  timeScale = 1;
  paused = false;
  private acc = 0;

  /** Simulated seconds since start. */
  get time(): number {
    return this.tick * TICK_DT;
  }

  /** Interpolation factor in [0,1) between the last and the next tick, for rendering. */
  get alpha(): number {
    return this.acc / TICK_DT;
  }

  /** Feed real elapsed seconds; returns how many ticks to run now. */
  advance(realDt: number): number {
    if (this.paused) return 0;
    this.acc += Math.max(0, Math.min(realDt, 0.25)) * this.timeScale;
    // Tiny epsilon: 120 × (1/120) must give exactly 20 ticks despite float rounding.
    let n = Math.floor(this.acc / TICK_DT + 1e-9);
    if (n > MAX_TICKS_PER_FRAME) {
      n = MAX_TICKS_PER_FRAME;
      this.acc = 0;
    } else {
      this.acc = Math.max(0, this.acc - n * TICK_DT);
    }
    this.tick += n;
    return n;
  }
}
