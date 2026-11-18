// Scripted bot players for the headless balance runner and tests. Bots only use cues a human
// could perceive: where the teacher is and looks, what they're doing, barks/telegraph events.
import { dist2, type V2, wrapAngle, yawDir, yawTo } from './geom';
import { NOTES } from './data';
import { interactables } from './player';
import type { Rng } from './rng';
import { idleCommand, type PlayerCommand, type SimEvent } from './types';
import type { World } from './world';

export type BotStyle = 'angel' | 'gamer' | 'sneaky' | 'prankster' | 'postman' | 'chaos';
export const BOT_STYLES: BotStyle[] = ['angel', 'gamer', 'sneaky', 'prankster', 'postman', 'chaos'];

export class Bot {
  readonly style: BotStyle;
  private rng: Rng;
  private yaw = 0;
  private alarmT = -99;
  private safeSince = 0;
  private trip: {
    target: string;
    verb: string;
    pos: V2;
    phase: 'go' | 'act' | 'back';
    t: number;
  } | null = null;
  private path: V2[] | null = null;
  private nextNote = 30;
  private nextChaos = 0;
  private holdThrow = 0;
  private lastPos: V2 = { x: 0, z: 0 };
  private stuck = 0;

  constructor(style: BotStyle, rng: Rng) {
    this.style = style;
    this.rng = rng;
  }

  observe(events: SimEvent[]): void {
    for (const e of events) {
      if (
        (e.type === 'telegraph' && e.target === 'player') ||
        e.type === 'warned-by-friend' ||
        e.type === 'glance-soon'
      )
        this.alarmT = e.t;
    }
  }

  /** Would a careful human feel watched right now? */
  private danger(w: World): boolean {
    const T = w.teacher;
    if (!T.present) return false;
    const p = w.player.pos;
    const d = dist2(T.pos, p);
    const looking = Math.abs(wrapAngle(yawTo(T.pos, p) - T.headYaw)) < 1.2;
    return w.t - this.alarmT < 3 || d < 3.2 || (looking && d < 7.5) || (T.moving && d < 4.5);
  }

  command(w: World): PlayerCommand {
    const p = w.player;
    const cmd = idleCommand(this.yaw, -0.2);
    const seat = w.seat(p.sittingIn ?? p.seat);
    if (seat && p.sittingIn) this.yaw = (seat.facing * Math.PI) / 180;
    cmd.yaw = this.yaw;
    const r = w.rules();
    const dev = w.ps.device;
    const danger = this.danger(w);
    if (!danger) this.safeSince += 0.05;
    else this.safeSince = 0;

    // Get back to your (possibly reassigned) seat first.
    if (!this.trip && !r.break && (!p.sittingIn || p.sittingIn !== p.seat)) {
      if (p.sittingIn && p.sittingIn !== p.seat)
        cmd.interact = { target: p.sittingIn, verb: 'stand' };
      else this.walkTo(w, cmd, w.seat(p.seat)!.pos, p.seat!, 'sit');
      return cmd;
    }
    switch (this.style) {
      case 'angel':
        cmd.work = true;
        if (this.rng.chance(0.0006)) cmd.raiseHand = true;
        break;
      case 'gamer':
        if (dev.kind !== 'phone' && !w.ps.phoneConfiscated) cmd.device = 'phone';
        else if (dev.mode === 'decoy') cmd.device = 'switch';
        break;
      case 'sneaky':
      case 'postman': {
        const wantsDevice = this.style === 'sneaky';
        if (wantsDevice && !w.ps.phoneConfiscated) {
          if (!dev.kind && this.safeSince > 2.5) cmd.device = 'phone';
          else if (dev.kind && dev.mode !== 'decoy' && danger) cmd.device = 'switch';
          else if (dev.kind && dev.mode === 'decoy' && this.safeSince > 4) cmd.device = 'switch';
          if (dev.mode === 'decoy' || !dev.kind) cmd.work = true;
        } else cmd.work = true;
        if (this.style === 'postman' && w.t > this.nextNote && !danger && p.sittingIn) {
          const seated = w.students.filter((s) => s.agent.sittingIn);
          if (seated.length) {
            const to = this.rng.pick(seated).agent.id;
            cmd.note = { template: this.rng.pick(NOTES.filter((n) => !n.answers)).id, to };
          }
          this.nextNote = w.t + 35 + this.rng.next() * 30;
        }
        if (r.test && this.style === 'sneaky' && !danger) cmd.peek = true;
        break;
      }
      case 'prankster':
        cmd.work = true;
        if (
          !this.trip &&
          !danger &&
          this.safeSince > 3 &&
          (w.brain.state === 'board' ||
            w.brain.state === 'laptop' ||
            w.brain.state === 'away' ||
            r.break)
        ) {
          const opts = interactables(w).flatMap((i) =>
            i.verbs.filter((v) => v.verb.startsWith('prank:')).map((v) => ({ i, v })),
          );
          if (opts.length && this.rng.chance(0.02)) {
            const o = this.rng.pick(opts);
            this.trip = { target: o.i.id, verb: o.v.verb, pos: o.i.pos, phase: 'go', t: 0 };
          }
        }
        break;
      case 'chaos':
        if (w.t > this.nextChaos) {
          this.nextChaos = w.t + 5 + this.rng.next() * 15;
          const roll = this.rng.next();
          if (roll < 0.3) cmd.device = 'phone';
          else if (roll < 0.5) cmd.make = 'paper-ball';
          else if (roll < 0.7 && p.holding) this.holdThrow = 1;
          else if (roll < 0.85) {
            const any = interactables(w).filter((i) => i.kind !== 'seat');
            if (any.length) {
              const o = this.rng.pick(any);
              this.trip = { target: o.id, verb: o.verbs[0]!.verb, pos: o.pos, phase: 'go', t: 0 };
            }
          } else cmd.device = 'switch';
        }
        if (this.holdThrow > 0) {
          this.holdThrow = 0;
          cmd.yaw = this.rng.next() * Math.PI * 2;
          cmd.throwPower = this.rng.next();
        }
        break;
    }
    if (this.trip) this.runTrip(w, cmd);
    return cmd;
  }

  private runTrip(w: World, cmd: PlayerCommand): void {
    const t = this.trip!;
    const p = w.player;
    t.t += 0.05;
    if (t.t > 40) {
      this.trip = null;
      return;
    }
    if (t.phase === 'go') {
      if (p.sittingIn) {
        cmd.interact = { target: p.sittingIn, verb: 'stand' };
        return;
      }
      if (this.moveTo(w, cmd, t.pos, 1.0)) {
        cmd.interact = { target: t.target, verb: t.verb };
        t.phase = 'act';
        t.t = 0;
      }
    } else if (t.phase === 'act') {
      cmd.move = { x: 0, z: 0 };
      if (!w.ps.action && t.t > 0.2) {
        t.phase = 'back';
        this.path = null;
      }
    } else {
      const seat = w.seat(p.seat)!;
      if (this.walkTo(w, cmd, seat.pos, seat.id, 'sit') || p.sittingIn) this.trip = null;
    }
  }

  private walkTo(
    w: World,
    cmd: PlayerCommand,
    pos: [number, number],
    seatId: string,
    verb: string,
  ): boolean {
    const goal = { x: pos[0], z: pos[1] };
    if (this.moveTo(w, cmd, goal, 0.9)) {
      cmd.interact = { target: seatId, verb };
      this.path = null;
      return true;
    }
    return false;
  }

  private moveTo(w: World, cmd: PlayerCommand, goal: V2, within: number): boolean {
    const p = w.player;
    if (dist2(p.pos, goal) <= within) return true;
    this.stuck = dist2(p.pos, this.lastPos) < 0.01 ? this.stuck + 0.05 : 0;
    this.lastPos = { ...p.pos };
    if (this.stuck > 1.5) {
      this.stuck = 0;
      this.path = null;
    }
    if (!this.path || this.path.length === 0) this.path = w.nav.findPath(p.pos, goal) ?? [goal];
    let next = this.path[0]!;
    if (dist2(p.pos, next) < 0.2 && this.path.length > 1) {
      this.path.shift();
      next = this.path[0]!;
    }
    const y = yawTo(p.pos, next);
    const d = yawDir(y);
    cmd.move = { x: d.x, z: d.z };
    cmd.yaw = y;
    this.yaw = y;
    cmd.crouch = this.style === 'prankster';
    return false;
  }
}

export interface RunResult {
  style: BotStyle;
  seed: number;
  lessonType: string;
  teacher: string;
  offenses: number;
  penalties: string[];
  telegraphLeads: number[];
  deviceSeconds: number;
  pranks: number;
  pranksClean: number;
  notesDelivered: number;
  testScore: number | null;
  ticks: number;
  hash: number;
}

/** Runs one lesson headless with a bot. */
export function runLesson(world: World, bot: Bot, maxTicks = 20000): RunResult {
  const leads: number[] = [];
  let ticks = 0;
  while (!world.over && ticks < maxTicks) {
    world.step(bot.command(world));
    const ev = world.drainEvents();
    for (const e of ev)
      if (e.type === 'caught' && e.who === 'player' && e.value !== undefined) leads.push(e.value);
    bot.observe(ev);
    ticks++;
  }
  return {
    style: bot.style,
    seed: world.seed,
    lessonType: world.lessonType,
    teacher: world.profile.id,
    offenses: world.stats.offenses.length,
    penalties: world.stats.offenses.map((o) => o.penalty),
    telegraphLeads: leads,
    deviceSeconds: world.stats.gameSeconds + world.stats.videoSeconds,
    pranks: world.stats.pranks.length,
    pranksClean: world.stats.pranks.filter((p) => p.clean).length,
    notesDelivered: world.stats.notesDelivered.length,
    testScore: world.stats.testScore,
    ticks,
    hash: world.eventHash,
  };
}
