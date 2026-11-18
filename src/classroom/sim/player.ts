// The player inside the sim: movement + collision, sitting, devices and quick-switch, work/peek/
// cheat, throwing, cover actions, prank setup, notes. Bots drive exactly the same code. Pure TS.
import { TICK_DT } from './clock';
import { NOTES, PRANKS } from './data';
import {
  clamp,
  dist2,
  resolveCircleBox,
  surfaceAt,
  type V2,
  wrapAngle,
  yawDir,
  yawTo,
} from './geom';
import { facingDir } from './layout';
import { canStartPrank, completePrank } from './pranks';
import { sendNote } from './social';
import type { DeviceState, Evidence, PlayerCommand } from './types';
import type { Interactable, World } from './world';

export const PLAYER_RADIUS = 0.22;
const SPEED = { stand: 1.35, crouch: 0.65, sprint: 2.8 };
const REACH = 1.5;

export interface PlayerAction {
  kind: 'sharpen' | 'prank' | 'handin' | 'bin' | 'chat';
  t: number;
  dur: number;
  target: string;
  prankId?: string;
}

export interface PlayerState {
  device: DeviceState;
  phoneConfiscated: boolean;
  cover: { reason: string; until: number; target: V2; from: V2 } | null;
  action: PlayerAction | null;
  working: boolean;
  peeking: string | null;
  cheating: boolean;
  hasCheatSheet: boolean;
  test: { progress: number; quality: number };
  stepAcc: number;
  standMoveT: number;
  handRaised: boolean;
  chatted: string[];
  makeCount: number;
  throwFlash: number;
  passingNote: boolean;
  lastNoteT: number;
  peekBark: Record<string, boolean>;
  bleedT: number;
  /** Latest human-readable hint for the HUD ("Can't do that during a lesson", …). */
  hint: string;
  hintT: number;
}

export function newPlayerState(): PlayerState {
  return {
    device: {
      kind: null,
      mode: 'off',
      content: 'game',
      brightness: 0.7,
      earbud: false,
      fumble: 0,
      switches: [],
    },
    phoneConfiscated: false,
    cover: null,
    action: null,
    working: false,
    peeking: null,
    cheating: false,
    hasCheatSheet: false,
    test: { progress: 0, quality: 0 },
    stepAcc: 0,
    standMoveT: 0,
    handRaised: false,
    chatted: [],
    makeCount: 0,
    throwFlash: 0,
    passingNote: false,
    lastNoteT: -99,
    peekBark: {},
    bleedT: 0,
    hint: '',
    hintT: -99,
  };
}

function hint(w: World, text: string): void {
  w.ps.hint = text;
  w.ps.hintT = w.t;
  w.emit({ type: 'hint', text });
}

export function deviceOpen(w: World): boolean {
  const d = w.ps.device;
  return d.kind !== null && d.mode !== 'off';
}

/** True when the player is somewhere they shouldn't be right now and has no cover. */
export function outOfSeatIllegal(w: World): boolean {
  const p = w.player;
  if (p.sittingIn) return false;
  const r = w.rules();
  if (r.break || r.seatFree) return false;
  if (r.group) {
    const seat = w.seat(p.seat);
    if (seat && Math.hypot(seat.pos[0] - p.pos.x, seat.pos[1] - p.pos.z) < 1.6) return false;
  }
  return !coverValid(w);
}

function coverValid(w: World): boolean {
  const c = w.ps.cover;
  if (!c || w.t > c.until) return false;
  // Staying near the straight route between seat and cover target keeps the cover believable.
  const p = w.player.pos;
  const ax = c.from.x;
  const az = c.from.z;
  const bx = c.target.x;
  const bz = c.target.z;
  const vx = bx - ax;
  const vz = bz - az;
  const L = vx * vx + vz * vz || 1;
  const t = clamp(((p.x - ax) * vx + (p.z - az) * vz) / L, 0, 1);
  return Math.hypot(p.x - (ax + vx * t), p.z - (az + vz * t)) < 1.5;
}

export function playerEvidence(w: World): Evidence[] {
  const ps = w.ps;
  const p = w.player;
  const out: Evidence[] = [];
  const d = ps.device;
  const r = w.rules();
  if (d.kind && d.mode !== 'off') {
    if (d.mode === 'game' || d.mode === 'video') {
      if (d.kind === 'laptop')
        out.push({
          kind: 'device',
          weight: r.detention ? 1.2 : 1.0,
          point: 'device',
          screenYaw: p.yaw,
        });
      else out.push({ kind: 'device', weight: r.detention ? 1.2 : 0.95, point: 'device' });
    }
    if (w.objects.lightsDim)
      out.push({
        kind: 'device-glow',
        weight: (d.mode === 'decoy' ? 0.12 : 0.3) * d.brightness,
        point: 'head',
      });
  }
  if (d.fumble > 0) out.push({ kind: 'fumble', weight: 1.2, point: 'device' });
  if (d.switches.filter((t) => w.t - t < 15).length >= 4)
    out.push({ kind: 'twitchy', weight: 0.35, point: 'head' });
  if (outOfSeatIllegal(w)) {
    const sprint = p.speed > 2;
    out.push({
      kind: sprint ? 'sprinting' : 'out-of-seat',
      weight: r.detention ? 1.2 : sprint ? 0.65 : p.stance === 'crouch' ? 0.55 : 0.42,
      point: 'torso',
    });
  }
  if (p.sittingIn && p.sittingIn !== p.seat && w.profile.knowsNames && !r.break && !r.seatFree)
    out.push({ kind: 'wrong-seat', weight: 0.3, point: 'head' });
  if (ps.peeking) out.push({ kind: 'peek', weight: 0.7, point: 'head' });
  if (ps.cheating) out.push({ kind: 'cheatsheet', weight: 0.8, point: 'lap' });
  if (ps.passingNote) out.push({ kind: 'note', weight: 0.55, point: 'handR' });
  if (ps.action?.kind === 'prank') out.push({ kind: 'prank', weight: 0.85, point: 'handR' });
  if (ps.action?.kind === 'chat' && !r.talkOk)
    out.push({ kind: 'talking', weight: 0.4, point: 'head' });
  if (ps.throwFlash > 0) out.push({ kind: 'throw', weight: 1.0, point: 'handR' });
  if (p.holding && !r.break && !r.seatFree) {
    const it = w.items.find((i) => i.id === p.holding);
    if (it && (it.kind === 'paper-ball' || it.kind === 'paper-plane'))
      out.push({ kind: 'note', weight: 0.25, point: 'handR' });
  }
  return out;
}

/** Player's own subject knowledge for tests (studying earlier in the lesson/day helps). */
export function playerKnowledge(w: World): number {
  const study = (w.record.counters.study ?? 0) + w.stats.workSeconds;
  return clamp(0.48 + 0.3 * Math.min(1, study / 300), 0, 0.85);
}

export function sitDown(w: World, seatId: string): boolean {
  const p = w.player;
  const seat = w.seat(seatId);
  if (!seat) return false;
  const occ = w.allAgents().find((a) => a.id !== 'player' && a.sittingIn === seatId);
  if (occ) {
    hint(w, `${occ.name} is sitting there.`);
    return false;
  }
  p.pos = { x: seat.pos[0], z: seat.pos[1] };
  p.sittingIn = seatId;
  p.stance = 'sit';
  p.yaw = (seat.facing * Math.PI) / 180;
  p.moving = false;
  w.ps.cover = null;
  w.noise(p.pos, 1.6, 'chair', 'player');
  w.emit({ type: 'sit', who: 'player', target: seatId });
  if (w.objects.wobblySeat === seatId) {
    w.noise(p.pos, 3.5, 'wobble', 'player');
    w.emit({ type: 'wobble', who: 'player' });
  }
  return true;
}

export function standUp(w: World): void {
  const p = w.player;
  if (!p.sittingIn) return;
  const seat = w.seat(p.sittingIn)!;
  const f = facingDir(seat.facing);
  p.pos = { x: seat.pos[0] - f[0] * 0.15, z: seat.pos[1] - f[1] * 0.15 };
  p.sittingIn = null;
  p.stance = 'stand';
  if (w.ps.device.kind === 'laptop') closeDevice(w);
  w.noise(p.pos, 1.6, 'chair', 'player');
  w.emit({ type: 'stand', who: 'player' });
}

function closeDevice(w: World): void {
  const d = w.ps.device;
  if (!d.kind) return;
  d.kind = null;
  d.mode = 'off';
  d.fumble = 0;
  w.emit({ type: 'device', kind: 'close' });
}

function deviceCommand(w: World, c: NonNullable<PlayerCommand['device']>): void {
  const d = w.ps.device;
  const p = w.player;
  switch (c) {
    case 'phone':
      if (d.kind === 'phone') return closeDevice(w);
      if (w.ps.phoneConfiscated)
        return hint(w, 'Your phone is on the teacher’s desk until the end of the lesson.');
      d.kind = 'phone';
      d.mode = d.content;
      w.emit({ type: 'device', kind: 'phone' });
      return;
    case 'laptop':
      if (d.kind === 'laptop') return closeDevice(w);
      if (!p.sittingIn) return hint(w, 'Sit down to open your laptop.');
      d.kind = 'laptop';
      d.mode = 'decoy';
      w.noise(p.pos, 1.0, 'paper', 'player');
      w.emit({ type: 'device', kind: 'laptop' });
      return;
    case 'switch':
      if (!d.kind) return;
      d.mode = d.mode === 'decoy' ? d.content : 'decoy';
      // A fumbled switch under observation is worse than being seen on the content.
      d.fumble = 0.45;
      d.switches.push(w.t);
      if (d.switches.length > 8) d.switches.shift();
      w.emit({ type: 'device', kind: d.mode });
      return;
    case 'content':
      d.content = d.content === 'game' ? 'video' : 'game';
      if (d.kind && d.mode !== 'decoy') d.mode = d.content;
      w.emit({ type: 'device', kind: d.mode });
      return;
    case 'earbud':
      d.earbud = !d.earbud;
      w.emit({ type: 'earbud', value: d.earbud ? 1 : 0 });
      return;
    case 'bright-up':
      d.brightness = clamp(d.brightness + 0.2, 0.2, 1);
      return;
    case 'bright-down':
      d.brightness = clamp(d.brightness - 0.2, 0.2, 1);
      return;
    case 'close':
      return closeDevice(w);
  }
}

/** Starts a short legitimate action that gives "cover" for being out of the seat. */
function giveCover(w: World, reason: string, target: V2, seconds: number): void {
  const seat = w.seat(w.player.seat);
  const from = seat ? { x: seat.pos[0], z: seat.pos[1] } : { ...w.player.pos };
  w.ps.cover = { reason, until: w.t + seconds, target: { ...target }, from };
  w.emit({ type: 'cover', kind: reason, value: seconds });
}

function interact(w: World, target: string, verb: string): void {
  const p = w.player;
  const ps = w.ps;
  const it = interactablesById(w).get(target);
  if (!it) return;
  if (dist2(p.pos, it.pos) > it.reach + 0.2) return hint(w, 'Too far away.');
  if (verb === 'sit') {
    sitDown(w, target);
    return;
  }
  if (verb === 'stand') return standUp(w);
  if (p.sittingIn && verb !== 'chat' && verb !== 'whisper' && verb !== 'pickup')
    return hint(w, 'Stand up first.');
  if (verb.startsWith('prank:')) {
    const id = verb.slice(6);
    const err = canStartPrank(w, id, target);
    if (err) return hint(w, err);
    const def = PRANKS.find((x) => x.id === id)!;
    ps.action = { kind: 'prank', t: 0, dur: def.setup, target, prankId: id };
    w.emit({ type: 'action', kind: 'prank', target: id, value: def.setup });
    return;
  }
  switch (verb) {
    case 'sharpen':
      ps.action = { kind: 'sharpen', t: 0, dur: 3, target };
      giveCover(w, 'Sharpening a pencil', it.pos, 16);
      w.noise(it.pos, 2.2, 'sharpen', null);
      return;
    case 'bin': {
      ps.action = { kind: 'bin', t: 0, dur: 1, target };
      giveCover(w, 'Throwing something away', it.pos, 12);
      if (p.holding) {
        w.removeItem(p.holding);
        p.holding = null;
      }
      return;
    }
    case 'handin':
      ps.action = { kind: 'handin', t: 0, dur: 1.5, target };
      giveCover(w, 'Handing in papers', it.pos, 12);
      return;
    case 'pickup': {
      if (p.holding) return hint(w, 'Hands full.');
      const item = w.items.find((i) => i.id === target);
      if (!item || item.heldBy) return;
      item.heldBy = 'player';
      item.flight = undefined;
      p.holding = item.id;
      const seat = w.seat(p.seat);
      if (seat && Math.hypot(seat.pos[0] - item.pos.x, seat.pos[1] - item.pos.z) < 2.2)
        giveCover(w, 'Picking up something you dropped', item.pos, 8);
      w.emit({ type: 'pickup', who: 'player', target: item.id });
      return;
    }
    case 'chat':
    case 'whisper': {
      const s = w.student(target);
      if (!s) return;
      ps.action = { kind: 'chat', t: 0, dur: 2, target };
      const talkOk = !!w.rules().talkOk;
      if (!talkOk) w.noise(p.pos, 1.4, 'whisper', 'player');
      if (!ps.chatted.includes(target)) {
        ps.chatted.push(target);
        w.relations.change(target, talkOk ? 3 : 2, 'chatted with you', w);
      }
      w.say(target, 'student', 'chat');
      return;
    }
    case 'close-window':
      if (w.objects.windowOpen) {
        w.objects.windowOpen = false;
        w.emit({ type: 'object', kind: 'window-closed' });
      }
      return;
  }
}

/** Throw the held item along the look direction; lands where it hits something. */
function throwHeld(w: World, power: number, yaw: number): void {
  const p = w.player;
  const item = w.items.find((i) => i.id === p.holding);
  if (!item) return;
  const plane = item.kind === 'paper-plane';
  const maxD = (plane ? 1.5 + power * 5 : 1.5 + power * 6.5) * (p.sittingIn ? 0.8 : 1);
  const dir = yawDir(yaw);
  const from = { x: p.pos.x + dir.x * 0.3, z: p.pos.z + dir.z * 0.3 };
  let to = { ...from };
  let onTable = false;
  for (let d = 0.3; d <= maxD; d += 0.1) {
    const q = { x: p.pos.x + dir.x * d, z: p.pos.z + dir.z * d };
    const hitWall =
      q.x < 0.1 ||
      q.z < 0.1 ||
      q.x > w.layout.room.size[0] - 0.1 ||
      q.z > w.layout.room.size[2] - 0.1;
    const col = w.geo.colliders.find(
      (b) => (b.kind === 'column' || b.kind === 'wall') && resolveCircleBox(q, 0.05, b) !== q,
    );
    if (hitWall || col) break;
    to = q;
  }
  // Land on a table/desk if the end point is above one.
  for (const b of w.geo.colliders) {
    if ((b.kind === 'table' || b.kind === 'desk') && resolveCircleBox(to, 0.01, b) !== to) {
      onTable = true;
      break;
    }
  }
  const dur = Math.max(0.25, dist2(from, to) / (plane ? 3.2 : 7));
  item.heldBy = null;
  item.pos = to;
  item.y = onTable ? 0.76 : 0.03;
  item.onTable = onTable;
  item.flight = {
    from,
    to,
    y0: p.stance === 'sit' ? 0.9 : 1.3,
    y1: item.y,
    t0: w.t,
    t1: w.t + dur,
    arc: plane ? 0.35 : 0.8,
  };
  p.holding = null;
  w.ps.throwFlash = 0.35;
  w.emit({ type: 'throw', who: 'player', target: item.id, value: dur });
}

function updateFlights(w: World): void {
  for (const it of w.items) {
    const f = it.flight;
    if (!f || f.done || w.t < f.t1) continue;
    f.done = true;
    if (it.kind === 'paper-plane') {
      w.noise(it.pos, 1.8, 'plane', null);
      const desk = w.geo.colliders.find((b) => b.id === 'teacher-desk');
      if (desk && resolveCircleBox(it.pos, 0.01, desk) !== it.pos)
        completePrank(w, 'paper-plane', 'teacher-desk', it.id);
    } else {
      w.noise(it.pos, 5.5, 'thud', null);
    }
    w.emit({ type: 'land', target: it.id, pos: { ...it.pos } });
  }
}

export function updatePlayer(w: World, cmd: PlayerCommand): void {
  const p = w.player;
  const ps = w.ps;
  const dt = TICK_DT;
  const r = w.rules();
  p.yaw = cmd.yaw;
  p.headYaw = cmd.yaw;
  p.pitch = cmd.pitch;
  ps.throwFlash = Math.max(0, ps.throwFlash - dt);
  ps.device.fumble = Math.max(0, ps.device.fumble - dt);

  if (cmd.device) deviceCommand(w, cmd.device);
  if (cmd.raiseHand && !ps.handRaised && w.teacher.present) {
    ps.handRaised = true;
    w.brain.requests.push({ kind: 'question', target: 'player', pop: false });
    w.emit({ type: 'raise-hand', who: 'player' });
  }
  if (cmd.make && !p.holding) {
    if (ps.makeCount >= 8) hint(w, 'Out of spare paper.');
    else {
      ps.makeCount++;
      const it = w.addItem(cmd.make, p.pos, 1, 'player');
      p.holding = it.id;
      w.noise(p.pos, 1.2, 'paper', 'player');
      w.emit({ type: 'make', kind: cmd.make, target: it.id });
    }
  }
  if (cmd.throwPower !== undefined && p.holding) throwHeld(w, clamp(cmd.throwPower, 0, 1), cmd.yaw);
  if (cmd.note) {
    if (!p.sittingIn) hint(w, 'Sit down to pass a note.');
    else if (w.t - ps.lastNoteT < 4) hint(w, 'Give it a moment.');
    else {
      const tpl = NOTES.find((n) => n.id === cmd.note!.template);
      if (tpl && sendNote(w, 'player', cmd.note.to, tpl.id)) ps.lastNoteT = w.t;
    }
  }
  if (cmd.interact) interact(w, cmd.interact.target, cmd.interact.verb);

  // Movement ---------------------------------------------------------------------------------
  const mv = Math.hypot(cmd.move.x, cmd.move.z);
  if (p.sittingIn) {
    p.moving = false;
    p.speed = 0;
    ps.standMoveT = mv > 0.3 ? ps.standMoveT + dt : 0;
    if (ps.standMoveT > 0.25) {
      standUp(w);
      ps.standMoveT = 0;
    }
  } else {
    p.stance = cmd.crouch ? 'crouch' : 'stand';
    const sprint = cmd.sprint && !cmd.crouch && mv > 0.5;
    const speed = sprint ? SPEED.sprint : cmd.crouch ? SPEED.crouch : SPEED.stand;
    p.speed = mv > 0.05 ? speed * Math.min(1, mv) : 0;
    p.moving = mv > 0.05;
    if (p.moving) {
      const k = Math.min(1, mv);
      let np: V2 = {
        x: p.pos.x + (cmd.move.x / mv) * speed * k * dt,
        z: p.pos.z + (cmd.move.z / mv) * speed * k * dt,
      };
      for (let pass = 0; pass < 2; pass++) {
        for (const b of w.geo.colliders) np = resolveCircleBox(np, PLAYER_RADIUS, b);
        for (const a of w.allAgents()) {
          if (a.id === 'player' || !a.present) continue;
          const dx = np.x - a.pos.x;
          const dz = np.z - a.pos.z;
          const d = Math.hypot(dx, dz);
          const minD = PLAYER_RADIUS + 0.2;
          if (d < minD && d > 1e-6)
            np = { x: a.pos.x + (dx / d) * minD, z: a.pos.z + (dz / d) * minD };
        }
      }
      const moved = dist2(np, p.pos);
      p.pos = np;
      ps.stepAcc += moved;
      const stride = sprint ? 0.9 : cmd.crouch ? 0.5 : 0.7;
      if (ps.stepAcc >= stride) {
        ps.stepAcc = 0;
        const hard = surfaceAt(w.layout, p.pos) === 'hard';
        const radius = sprint ? (hard ? 10 : 6) : cmd.crouch ? (hard ? 1.5 : 0.6) : hard ? 5 : 2.2;
        w.noise(p.pos, radius, sprint ? 'step-run' : 'step', 'player');
        w.emit({
          type: 'step',
          who: 'player',
          kind: hard ? 'hard' : 'carpet',
          value: sprint ? 2 : cmd.crouch ? 0.4 : 1,
        });
      }
      if (ps.action && ps.action.kind !== 'chat') {
        w.emit({ type: 'action-cancel', kind: ps.action.kind });
        ps.action = null;
      }
    }
  }

  // Ongoing action ------------------------------------------------------------------------------
  if (ps.action) {
    const a = ps.action;
    a.t += dt;
    if (a.t >= a.dur) {
      if (a.kind === 'prank' && a.prankId) completePrank(w, a.prankId, a.target);
      if (a.kind === 'handin') w.stats.workSeconds += 5;
      w.emit({ type: 'action-done', kind: a.kind, target: a.target });
      ps.action = null;
    }
  }
  if (ps.cover && w.t > ps.cover.until) ps.cover = null;
  if (p.sittingIn && ps.cover) ps.cover = null;

  // Work / peek / cheat -------------------------------------------------------------------------
  const d = ps.device;
  const handsFree = !d.kind || d.mode === 'decoy';
  ps.working = cmd.work && !!p.sittingIn && handsFree && !cmd.peek && !cmd.cheat;
  ps.peeking = null;
  ps.cheating = false;
  if (ps.working) {
    w.stats.workSeconds += dt;
    if (r.test) {
      const before = ps.test.progress;
      ps.test.progress = Math.min(1, before + dt / 240);
      ps.test.quality += (ps.test.progress - before) * playerKnowledge(w);
    }
  }
  if (cmd.peek && p.sittingIn && r.test) {
    const n = peekTarget(w);
    if (n) {
      const s = w.student(n)!;
      ps.peeking = n;
      const allows =
        w.relations.toPlayer(n) >= 10 ||
        (s.def.traits.helpful > 0.6 && w.relations.toPlayer(n) >= 0);
      if (allows) {
        const before = ps.test.progress;
        ps.test.progress = Math.min(1, before + dt / 200);
        ps.test.quality += (ps.test.progress - before) * Math.max(playerKnowledge(w), s.knowledge);
        w.stats.cheated = true;
        if (!ps.peekBark[n]) w.say(n, 'student', 'allowCopy');
      } else if (!ps.peekBark[n]) {
        w.say(n, 'student', 'refuseCopy');
        w.relations.change(n, -2, 'caught you copying', w);
      }
      ps.peekBark[n] = true;
    }
  }
  if (cmd.cheat && p.sittingIn && r.test && ps.hasCheatSheet && handsFree) {
    ps.cheating = true;
    w.stats.cheated = true;
    const before = ps.test.progress;
    ps.test.progress = Math.min(1, before + dt / 180);
    ps.test.quality += (ps.test.progress - before) * 0.92;
  }

  // Device side effects ---------------------------------------------------------------------
  if (d.kind && (d.mode === 'video' || d.mode === 'game')) {
    if (d.mode === 'video') w.stats.videoSeconds += dt;
    else w.stats.gameSeconds += dt;
    ps.bleedT += dt;
    const period = d.mode === 'video' ? 1.5 : 2.5;
    if (ps.bleedT >= period) {
      ps.bleedT = 0;
      const radius = d.earbud ? 0.5 : d.mode === 'video' ? 2.6 : 1.3;
      w.noise(p.pos, radius, d.mode === 'video' ? 'device-audio' : 'game-beep', 'player');
    }
  }
  if (cmd.gameScore !== undefined) w.stats.bestScore = Math.max(w.stats.bestScore, cmd.gameScore);

  // Sneaking stats --------------------------------------------------------------------------
  if (outOfSeatIllegal(w) && w.teacher.present && w.susp('player').s < 0.3)
    w.stats.sneakSeconds += dt;
  updateFlights(w);
}

/** Classmate whose paper the player is looking at (test copying). */
export function peekTarget(w: World): string | null {
  const p = w.player;
  let best: string | null = null;
  let bestA = 0.6;
  for (const s of w.students) {
    if (!s.agent.sittingIn) continue;
    const spot = w.laptopSpot(s.agent) ?? s.agent.pos;
    if (dist2(p.pos, s.agent.pos) > 1.6) continue;
    const a = Math.abs(wrapAngle(yawTo(p.pos, spot) - p.yaw));
    if (a < bestA) {
      bestA = a;
      best = s.agent.id;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Interactables (shared by client prompts, bots and the sim's own range checks)

export function interactables(w: World): Interactable[] {
  const L = w.layout;
  const out: Interactable[] = [];
  const spot = (k: string, fb: [number, number]) => {
    const s = L.spots?.[k] ?? fb;
    return { x: s[0], z: s[1] };
  };
  const p = w.player;
  const r = w.rules();
  for (const s of L.seats) {
    const verbs: Interactable['verbs'] = [];
    if (p.sittingIn === s.id) verbs.push({ verb: 'stand', label: 'Stand up' });
    else if (!p.sittingIn) {
      const occ = w.allAgents().find((a) => a.id !== 'player' && a.sittingIn === s.id);
      if (!occ) verbs.push({ verb: 'sit', label: s.id === p.seat ? 'Sit (your seat)' : 'Sit' });
      if (
        !occ &&
        r.break &&
        s.id !== p.seat &&
        w.objects.wobblySeat !== s.id &&
        w.occupantOf(s.id)?.kind === 'student'
      )
        verbs.push({ verb: 'prank:swap-chair', label: 'Swap in the wobbly chair', risk: 'risky' });
    }
    if (verbs.length)
      out.push({
        id: s.id,
        kind: 'seat',
        label: 'Chair',
        pos: { x: s.pos[0], z: s.pos[1] },
        y: 0.5,
        verbs,
        reach: 1.1,
      });
  }
  const fx = (id: string) => L.fixtures.find((f) => f.id === id);
  const wallPoint = (id: string, inset = 0.35) => {
    const f = fx(id);
    if (!f) return { x: 0, z: 0, y: 1 };
    const W = L.room.size[0];
    const D = L.room.size[2];
    const along = f.center[0];
    switch (f.wall) {
      case 'front':
        return { x: along, z: inset, y: f.center[1] };
      case 'back':
        return { x: along, z: D - inset, y: f.center[1] };
      case 'left':
        return { x: inset, z: along, y: f.center[1] };
      case 'right':
        return { x: W - inset, z: along, y: f.center[1] };
    }
  };
  const add = (
    id: string,
    kind: string,
    label: string,
    pos: { x: number; z: number; y: number },
    verbs: Interactable['verbs'],
    reach = REACH,
  ) => out.push({ id, kind, label, pos: { x: pos.x, z: pos.z }, y: pos.y, verbs, reach });
  add('sharpener', 'sharpener', 'Pencil sharpener', wallPoint('sharpener', 0.3), [
    { verb: 'sharpen', label: 'Sharpen pencil (cover)' },
  ]);
  const bin = L.props.find((x) => x.id === 'bin')!;
  add('bin', 'bin', 'Bin', { x: bin.pos[0], z: bin.pos[1], y: 0.4 }, [
    { verb: 'bin', label: p.holding ? 'Throw away' : 'Use bin (cover)' },
  ]);
  const deskVerbs: Interactable['verbs'] = [{ verb: 'handin', label: 'Hand in papers (cover)' }];
  const held = w.items.find((i) => i.id === p.holding);
  if (held?.kind === 'paper-plane' && !w.objects.planeOnDesk)
    deskVerbs.push({ verb: 'prank:paper-plane', label: 'Leave the paper plane', risk: 'risky' });
  add('teacher-desk', 'desk', 'Teacher’s desk', { x: 1.2, z: 1.55, y: 1.05 }, deskVerbs, 1.3);
  if (!w.objects.markerHidden)
    add(
      'marker',
      'marker',
      'Board marker',
      { x: 4.5, z: 0.35, y: 0.85 },
      [{ verb: 'prank:hide-marker', label: 'Hide the marker', risk: 'risky' }],
      1.3,
    );
  if (!w.objects.sticker)
    add(
      'board',
      'board',
      'Whiteboard',
      { x: 5.6, z: 0.35, y: 1.4 },
      [{ verb: 'prank:board-sticker', label: 'Stick a smiley on it', risk: 'risky' }],
      1.3,
    );
  if (w.objects.projectorInput === 1)
    add(
      'projector-remote',
      'remote',
      'Projector remote',
      { x: 1.6, z: 1.55, y: 1.06 },
      [{ verb: 'prank:projector-input', label: 'Switch the input', risk: 'risky' }],
      1.2,
    );
  if (!w.objects.docCamFlipped)
    add(
      'doc-camera',
      'doccam',
      'Document camera',
      { x: 0.85, z: 1.55, y: 1.3 },
      [{ verb: 'prank:doc-cam-flip', label: 'Flip the camera', risk: 'risky' }],
      1.2,
    );
  const win = spot('window', [8.55, 1.4]);
  add(
    'window-a',
    'window',
    'Window',
    { x: win.x, z: win.z, y: 1.5 },
    w.objects.windowOpen
      ? [{ verb: 'close-window', label: 'Close the window' }]
      : [{ verb: 'prank:open-window', label: 'Open it a crack', risk: 'risky' }],
  );
  const rad = spot('radiator', [8.55, 2.6]);
  add('radiator', 'radiator', 'Radiator', { x: rad.x, z: rad.z, y: 0.4 }, [
    { verb: 'prank:radiator-knock', label: 'Make it knock', risk: 'loud' },
  ]);
  if (w.objects.clockOffsetMin === 0)
    add(
      'clock',
      'clock',
      'Wall clock',
      { x: 0.85, z: 6.65, y: 2.4 },
      [{ verb: 'prank:clock-offset', label: 'Set it 5 min fast', risk: 'risky' }],
      1.0,
    );
  if (w.objects.posterOrder[0] === 0)
    add(
      'poster-1',
      'poster',
      'Posters',
      { x: 5.1, z: 6.7, y: 1.65 },
      [{ verb: 'prank:reorder-posters', label: 'Reorder the posters', risk: 'risky' }],
      1.0,
    );
  for (const s of w.students) {
    if (!s.agent.present) continue;
    const verbs: Interactable['verbs'] =
      r.talkOk || r.break
        ? [{ verb: 'chat', label: `Chat with ${s.def.name}` }]
        : [{ verb: 'whisper', label: `Whisper to ${s.def.name}`, risk: 'risky' }];
    out.push({
      id: s.agent.id,
      kind: 'student',
      label: s.def.name,
      pos: { ...s.agent.pos },
      y: s.agent.stance === 'sit' ? 1.0 : 1.4,
      verbs,
      reach: 1.7,
    });
  }
  for (const it of w.items) {
    if (it.heldBy || it.kind === 'note' || (it.flight && !it.flight.done)) continue;
    if (it.kind !== 'paper-ball' && it.kind !== 'paper-plane') continue;
    out.push({
      id: it.id,
      kind: 'item',
      label: it.kind === 'paper-ball' ? 'Paper ball' : 'Paper plane',
      pos: { ...it.pos },
      y: it.y,
      verbs: [{ verb: 'pickup', label: 'Pick up' }],
      reach: 1.3,
    });
  }
  return out;
}

export function interactablesById(w: World): Map<string, Interactable> {
  return new Map(interactables(w).map((i) => [i.id, i]));
}
