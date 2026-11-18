import { describe, expect, it } from 'vitest';
import { Bot, BOT_STYLES, runLesson } from '../../src/classroom/sim/bots';
import { canStartPrank, completePrank } from '../../src/classroom/sim/pranks';
import { Rng } from '../../src/classroom/sim/rng';
import { sendNote } from '../../src/classroom/sim/social';
import { NOTES } from '../../src/classroom/sim/data';
import { idleCommand, type PlayerCommand, type SimEvent } from '../../src/classroom/sim/types';
import { World } from '../../src/classroom/sim/world';

/** Steps a world with a command factory until the lesson ends (or maxTicks); returns all events. */
function play(w: World, cmdAt: (tick: number) => PlayerCommand, maxTicks = 14000): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < maxTicks && !w.over; i++) {
    w.step(cmdAt(i));
    out.push(...w.drainEvents());
  }
  return out;
}

describe('determinism', () => {
  const run = (seed: number, style: (typeof BOT_STYLES)[number], botSeed = 5) => {
    const w = new World({ seed, lessonType: 'lecture', teacher: 'hawk' });
    const bot = new Bot(style, new Rng(botSeed));
    for (let i = 0; i < 3000; i++) {
      w.step(bot.command(w));
      bot.observe(w.drainEvents());
    }
    return w.eventHash;
  };
  it('same seed + same bot gives the same event hash', () => {
    for (const style of ['gamer', 'chaos', 'prankster'] as const)
      expect(run(11, style)).toBe(run(11, style));
  });
  it('different seeds differ', () => {
    expect(run(11, 'chaos')).not.toBe(run(12, 'chaos'));
    expect(run(21, 'gamer')).not.toBe(run(22, 'gamer'));
  });
  it('a full runLesson is reproducible', () => {
    const go = () =>
      runLesson(
        new World({ seed: 33, lessonType: 'worksheet', teacher: 'lazy' }),
        new Bot('sneaky', new Rng(1)),
      );
    expect(go()).toEqual(go());
  });
});

describe('gameplay invariants', () => {
  it('a seated angel who only works is never punished by a strict teacher', () => {
    for (const seed of [1, 2, 3]) {
      const w = new World({ seed, lessonType: 'lecture', teacher: 'strict' });
      const ev = play(w, () => ({ ...idleCommand(0, -0.2), work: true }));
      expect(w.over).toBe(true);
      expect(w.stats.offenses, `seed ${seed}`).toEqual([]);
      expect(ev.filter((e) => e.type === 'caught')).toEqual([]);
    }
  });

  it('phone-gaming gets caught by a hawk, always with >= 1.0 s telegraph', () => {
    // Seeds chosen from a sweep: the hawk catches ~85% of lecture-long phone sessions.
    for (const seed of [1, 4, 5, 6, 7]) {
      const w = new World({ seed, lessonType: 'lecture', teacher: 'hawk' });
      const ev = play(w, (i) => ({
        ...idleCommand(0, -0.2),
        device: i === 0 ? 'phone' : undefined,
      }));
      const caught = ev.filter((e) => e.type === 'caught' && e.who === 'player');
      expect(caught.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      for (const c of caught) {
        expect(c.value, 'telegraph lead must be reported').toBeDefined();
        expect(c.value!, `seed ${seed}`).toBeGreaterThanOrEqual(1.0);
      }
    }
  });

  it('after a penalty there is a grace period before the next catch (persistent laptop offender)', () => {
    for (const seed of [1, 5]) {
      const w = new World({ seed, lessonType: 'lecture', teacher: 'hawk' });
      const ev = play(w, () => {
        const d = w.ps.device;
        const c = idleCommand(0, -0.2);
        if (!d.kind) c.device = 'laptop';
        else if (d.mode === 'decoy') c.device = 'switch';
        return c;
      });
      const caught = ev.filter((e) => e.type === 'caught' && e.who === 'player');
      expect(caught.length, `seed ${seed}`).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < caught.length; i++)
        expect(caught[i]!.t - caught[i - 1]!.t, `seed ${seed}`).toBeGreaterThanOrEqual(10);
      for (const c of caught) expect(c.value!).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('bots keep the fairness contract across styles and teachers', () => {
    const teachers = ['strict', 'lazy', 'distracted', 'hawk', 'substitute'];
    BOT_STYLES.forEach((style, i) => {
      const r = runLesson(
        new World({ seed: 100 + i, lessonType: 'lecture', teacher: teachers[i % 5]! }),
        new Bot(style, new Rng(i)),
      );
      for (const lead of r.telegraphLeads) expect(lead, `${style}`).toBeGreaterThanOrEqual(1.0);
    });
  });
});

describe('notes', () => {
  it('player -> neighbour note resolves within 60 s', () => {
    const w = new World({ seed: 4, lessonType: 'study', teacher: 'lazy' });
    const tpl = NOTES.find((n) => !n.answers)!.id;
    expect(w.player.sittingIn).toBe('s-b3');
    expect(sendNote(w, 'player', 'mara', tpl)).toBe(true);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 1200; i++) {
      w.step(idleCommand());
      ev.push(...w.drainEvents());
    }
    expect(ev.some((e) => e.type === 'note-sent')).toBe(true);
    expect(
      ev.some((e) => ['note-delivered', 'note-lost', 'note-intercepted'].includes(e.type)),
    ).toBe(true);
  });
  it('refuses when the recipient is not seated / unknown', () => {
    const w = new World({ seed: 4, lessonType: 'study', teacher: 'lazy' });
    expect(sendNote(w, 'player', 'nobody', 'x')).toBe(false);
  });
});

describe('pranks', () => {
  const fresh = () => new World({ seed: 9, lessonType: 'lecture', teacher: 'lazy' });
  it('completePrank sets the room object', () => {
    const w = fresh();
    completePrank(w, 'board-sticker', 'board');
    expect(w.objects.sticker).toBe(true);
    completePrank(w, 'open-window', 'window-a');
    expect(w.objects.windowOpen).toBe(true);
    completePrank(w, 'hide-marker', 'marker');
    expect(w.objects.markerHidden).toBe(true);
    completePrank(w, 'projector-input', 'projector-remote');
    expect(w.objects.projectorInput).toBe(2);
    completePrank(w, 'reorder-posters', 'poster-1');
    expect(w.objects.posterOrder).not.toEqual([0, 1, 2, 3]);
    expect(w.pranks.map((p) => p.id)).toContain('board-sticker');
  });
  it('canStartPrank rejects swap-chair outside break and repeats', () => {
    const w = fresh();
    expect(canStartPrank(w, 'swap-chair', 's-b2')).not.toBeNull();
    expect(canStartPrank(w, 'board-sticker', 'board')).toBeNull();
    completePrank(w, 'board-sticker', 'board');
    expect(canStartPrank(w, 'board-sticker', 'board')).not.toBeNull();
    expect(canStartPrank(w, 'nope', 'x')).not.toBeNull();
  });
  it('swap-chair is allowed during the break', () => {
    const w = new World({ seed: 9, lessonType: 'lecture', teacher: 'lazy', startPhase: 4 });
    for (let i = 0; i < 5; i++) w.step(idleCommand());
    expect(w.rules().break).toBe(true);
    expect(canStartPrank(w, 'swap-chair', 's-b2')).toBeNull();
  });
});
