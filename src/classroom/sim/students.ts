// Classmates: needs (Sims-style motives) → bucketed utility action choice, routines, break-time
// clusters, reactions to the player (seeing your screen, warning you, snitching). Pure TS.
import { TICK_DT } from './clock';
import type { StudentDef } from './data';
import { dist2, turnToward, type V2, wrapAngle, yawTo } from './geom';
import { facingDir } from './layout';
import { lineOfSight, personBox, samplePoint, EYE_HEIGHT } from './perception';
import { deviceOpen } from './player';
import { sendNote, updateReplies } from './social';
import type { Agent, Evidence } from './types';
import type { World } from './world';

export type StudentAction =
  | 'listen'
  | 'notes'
  | 'doodle'
  | 'yawn'
  | 'glance'
  | 'stretch'
  | 'whisper'
  | 'phone'
  | 'sneeze'
  | 'cough'
  | 'pickup'
  | 'sharpen'
  | 'raise-hand'
  | 'pass-note'
  | 'break'
  | 'return';

export interface StudentState {
  agent: Agent;
  def: StudentDef;
  needs: { bored: number; sleepy: number; social: number; anxious: number };
  action: StudentAction;
  actionT: number;
  actionDur: number;
  target: string | null;
  goal: V2 | null;
  cooldowns: Record<string, number>;
  knowledge: number;
  testProgress: number;
  warnedT: number;
  lookAt: V2 | null;
  lookT: number;
}

const BREAK_SPOTS: V2[] = [
  { x: 8.3, z: 1.2 },
  { x: 4.5, z: 3.2 },
  { x: 3.0, z: 4.6 },
  { x: 6.2, z: 4.4 },
];

export function studentEvidence(w: World, s: StudentState): Evidence[] {
  const r = w.rules();
  const out: Evidence[] = [];
  if (s.action === 'phone') out.push({ kind: 'device', weight: 0.9, point: 'device' });
  if (s.action === 'whisper' && !r.talkOk)
    out.push({ kind: 'talking', weight: 0.35, point: 'head' });
  if (w.notes.some((n) => n.state === 'moving' && n.carrier === s.agent.id))
    out.push({ kind: 'note', weight: 0.55, point: 'handR' });
  return out;
}

function cd(s: StudentState, key: string, w: World, secs: number): boolean {
  if ((s.cooldowns[key] ?? -99) > w.t) return false;
  s.cooldowns[key] = w.t + secs;
  return true;
}

function look(s: StudentState, at: V2, secs: number): void {
  s.lookAt = { ...at };
  s.lookT = secs;
}

function followPath(w: World, a: Agent, goal: V2): boolean {
  if (dist2(a.pos, goal) < 0.12) {
    a.moving = false;
    a.path = null;
    return true;
  }
  if (!a.path || a.pathVersion !== w.nav.version) {
    a.path = w.nav.findPath(a.pos, goal) ?? [goal];
    a.pathVersion = w.nav.version;
  }
  const next = a.path[0];
  if (!next) return true;
  const d = dist2(a.pos, next);
  const step = a.speed * TICK_DT;
  if (d <= step) {
    a.pos = { ...next };
    a.path.shift();
  } else {
    a.pos = {
      x: a.pos.x + ((next.x - a.pos.x) / d) * step,
      z: a.pos.z + ((next.z - a.pos.z) / d) * step,
    };
  }
  a.yaw = turnToward(a.yaw, yawTo(a.pos, next), 6 * TICK_DT);
  a.moving = true;
  return false;
}

function standFromSeat(w: World, s: StudentState): void {
  const a = s.agent;
  if (!a.sittingIn) return;
  const seat = w.seat(a.sittingIn)!;
  const f = facingDir(seat.facing);
  a.pos = { x: seat.pos[0] - f[0] * 0.25, z: seat.pos[1] - f[1] * 0.25 };
  a.sittingIn = null;
  a.stance = 'stand';
  w.noise(a.pos, 1.4, 'chair', a.id);
}

function sitInSeat(w: World, s: StudentState): void {
  const a = s.agent;
  const seat = w.seat(a.seat)!;
  if (w.player.sittingIn === seat.id) {
    // Someone (you) is in my seat! Stand next to it, annoyed.
    if (cd(s, 'seat-taken', w, 20)) {
      w.emit({ type: 'bark', who: a.id, text: 'Um. That’s my seat.', kind: 'seat' });
      w.relations.change(a.id, -2, 'found you in their seat', w);
    }
    return;
  }
  a.pos = { x: seat.pos[0], z: seat.pos[1] };
  a.sittingIn = seat.id;
  a.stance = 'sit';
  a.yaw = (seat.facing * Math.PI) / 180;
  a.moving = false;
  w.noise(a.pos, 1.4, 'chair', a.id);
  if (w.objects.wobblySeat === seat.id) {
    w.noise(a.pos, 3.5, 'wobble', a.id);
    w.emit({ type: 'wobble', who: a.id });
    for (const o of w.students)
      if (o !== s && cd(o, 'laugh', w, 8) && w.rngStudents.chance(0.6))
        w.say(o.agent.id, 'student', 'laugh');
    w.brain.tasks.push({
      kind: 'wobbly',
      dur: 8,
      pos: {
        x: seat.pos[0] + facingDir(seat.facing)[0] * 1.0,
        z: seat.pos[1] + facingDir(seat.facing)[1] * 1.0,
      },
      bark: 'wobbly',
      prank: 'swap-chair',
    });
  }
}

function chooseAction(w: World, s: StudentState): void {
  const r = w.rules();
  const T = w.teacher;
  const t = s.def.traits;
  const n = s.needs;
  const tDist = T.present ? dist2(T.pos, s.agent.pos) : 99;
  const pressure = tDist < 2.8 || w.t - s.warnedT < 40 || w.brain.target === s.agent.id;
  const scores: [StudentAction, number][] = [];
  const add = (a: StudentAction, v: number) => v > 0 && scores.push([a, v]);
  if (r.test) {
    add('notes', 3 + t.goody);
    add('glance', 0.2 + t.nosy * 0.2);
    add('yawn', n.sleepy * 0.5);
    add('stretch', 0.15);
  } else {
    // Lesson-compliant bucket
    add('listen', 1.0 + t.goody * 0.6 + (pressure ? 1.5 : 0));
    add('notes', 0.6 + t.goody * 1.0 + t.anxious * 0.4 + (r.group ? 0.5 : 0));
    // Idle bucket
    add('doodle', n.bored * 1.4);
    add('yawn', n.sleepy * 1.5);
    add('glance', 0.2 + t.nosy * 0.6 + n.bored * 0.4);
    add('stretch', n.bored * 0.4);
    add('cough', 0.04);
    add('sneeze', 0.025);
    if (!pressure) {
      // Social/disruptive buckets only when the teacher isn't breathing down their neck.
      add('whisper', n.social * (r.talkOk ? 2.2 : 0.4 + t.rebellious * 0.8));
      add('phone', n.bored * t.rebellious * 1.2 * (r.dim ? 1.6 : 1));
      add('pass-note', n.social * t.rebellious * 0.25);
      add('sharpen', 0.03 + n.bored * 0.06);
      add('raise-hand', (t.goody * 0.12 + t.anxious * 0.05) * (r.talkOk ? 0.3 : 1));
    }
  }
  scores.sort((a, b) => b[1] - a[1]);
  const top = scores.slice(0, 3);
  const sum = top.reduce((a, x) => a + x[1], 0);
  let roll = w.rngStudents.next() * sum;
  let pick: StudentAction = 'listen';
  for (const [a, v] of top) {
    roll -= v;
    if (roll <= 0) {
      pick = a;
      break;
    }
  }
  s.action = pick;
  s.actionT = 0;
  s.target = null;
  const dur: Partial<Record<StudentAction, [number, number]>> = {
    listen: [4, 10],
    notes: [5, 12],
    doodle: [5, 12],
    yawn: [2, 2.5],
    glance: [1.5, 3],
    stretch: [2, 3],
    whisper: [3, 6],
    phone: [6, 18],
    cough: [1, 1.2],
    sneeze: [1, 1.2],
    sharpen: [30, 30],
    'raise-hand': [6, 6],
    'pass-note': [1, 1],
  };
  const [lo, hi] = dur[pick] ?? [3, 6];
  s.actionDur = lo + (hi - lo) * w.rngStudents.next();
  // Entry effects
  const a = s.agent;
  switch (pick) {
    case 'yawn':
      if (cd(s, 'yawn', w, 75) && w.rngStudents.chance(0.3)) w.say(a.id, 'student', 'yawn');
      n.sleepy = Math.max(0, n.sleepy - 0.3);
      break;
    case 'cough':
      w.say(a.id, 'student', 'cough');
      w.noise(a.pos, 2.5, 'cough', a.id);
      break;
    case 'sneeze':
      w.say(a.id, 'student', 'sneeze');
      w.noise(a.pos, 4, 'sneeze', a.id);
      break;
    case 'glance': {
      const others = w.allAgents().filter((o) => o.id !== a.id && o.present);
      if (others.length) look(s, w.rngStudents.pick(others).pos, s.actionDur);
      break;
    }
    case 'whisper': {
      const nb = neighbourStudents(w, s);
      if (!nb.length) {
        s.action = 'listen';
        break;
      }
      const o = w.rngStudents.pick(nb);
      s.target = o.agent.id;
      look(s, o.agent.pos, s.actionDur);
      w.relations.changeBetween(a.id, o.agent.id, 1);
      n.social = Math.max(0, n.social - 0.4);
      break;
    }
    case 'phone':
      n.bored = Math.max(0, n.bored - 0.5);
      break;
    case 'pass-note': {
      const friends = w.students.filter(
        (o) => o !== s && o.agent.sittingIn && w.relations.between(a.id, o.agent.id) > 15,
      );
      if (friends.length)
        sendNote(
          w,
          a.id,
          w.rngStudents.pick(friends).agent.id,
          w.rngStudents.pick(['joke', 'bored', 'lunch']),
        );
      n.social = Math.max(0, n.social - 0.5);
      break;
    }
    case 'sharpen':
      standFromSeat(w, s);
      s.goal = sharpenerSpot(w);
      break;
    case 'raise-hand':
      if (T.present && !w.brain.requests.some((q) => q.target === a.id))
        w.brain.requests.push({ kind: 'question', target: a.id, pop: false });
      break;
  }
}

function sharpenerSpot(w: World): V2 {
  const f = w.layout.fixtures.find((x) => x.id === 'sharpener');
  return { x: 0.35, z: f ? f.center[0] : 1.2 };
}

function neighbourStudents(w: World, s: StudentState): StudentState[] {
  return w.students.filter(
    (o) => o !== s && o.agent.sittingIn && dist2(o.agent.pos, s.agent.pos) < 1.7,
  );
}

export function updateStudents(w: World): void {
  const r = w.rules();
  const dt = TICK_DT;
  updateReplies(w);
  for (const s of w.students) {
    const a = s.agent;
    if (!a.present) continue;
    const n = s.needs;
    const dull = r.break ? 0 : r.dim ? 1.4 : r.talkOk ? 0.5 : 1;
    n.bored = Math.min(1, n.bored + 0.006 * dull * dt);
    n.sleepy = Math.min(1, n.sleepy + 0.003 * (r.dim ? 3 : 1) * dt);
    n.social = Math.min(1, n.social + 0.004 * (0.5 + s.def.traits.rebellious) * dt);
    n.anxious += (s.def.traits.anxious * 0.3 - n.anxious) * 0.02 * dt;
    if (r.test) s.testProgress = Math.min(1, s.testProgress + dt / 260);

    // Break time: cluster at "smart zone" spots, chat, come back when it ends.
    if (r.break && s.action !== 'break') {
      if (a.sittingIn) standFromSeat(w, s);
      s.action = 'break';
      const base = BREAK_SPOTS[(hashIdx(a.id) + w.lesson.phaseIdx) % BREAK_SPOTS.length]!;
      s.goal = {
        x: base.x + (w.rngStudents.next() - 0.5) * 0.9,
        z: base.z + (w.rngStudents.next() - 0.5) * 0.9,
      };
      s.goal = w.nav.nearestWalkable(s.goal) ?? s.goal;
    } else if (!r.break && s.action === 'break') {
      s.action = 'return';
      s.goal = null;
    }

    if (s.action === 'break') {
      if (s.goal && followPath(w, a, s.goal)) {
        s.goal = null;
      }
      if (!a.moving && w.rngStudents.next() < 0.004) w.say(a.id, 'student', 'chat');
    } else if (
      s.action === 'return' ||
      s.action === 'sharpen' ||
      (!a.sittingIn && s.action !== 'pickup')
    ) {
      const seat = w.seat(a.seat)!;
      if (s.action === 'sharpen' && s.goal) {
        if (followPath(w, a, s.goal)) {
          s.goal = null;
          w.noise(a.pos, 2.2, 'sharpen', null);
        }
      } else {
        const behind = {
          x: seat.pos[0] - facingDir(seat.facing)[0] * 0.25,
          z: seat.pos[1] - facingDir(seat.facing)[1] * 0.25,
        };
        if (followPath(w, a, w.nav.nearestWalkable(behind) ?? behind)) {
          sitInSeat(w, s);
          if (a.sittingIn) {
            s.action = 'listen';
            s.actionT = 0;
            s.actionDur = 3;
          }
        }
      }
    } else {
      s.actionT += dt;
      if (s.action === 'whisper' && s.actionT % 2 < dt) w.noise(a.pos, 1.3, 'whisper', a.id);
      if (s.action === 'pickup' && s.actionT >= s.actionDur) s.action = 'listen';
      if (s.actionT >= s.actionDur) chooseAction(w, s);
    }

    reactToPlayer(w, s);
    // Head: glance targets, otherwise face the board/the table with a little idle drift.
    s.lookT -= dt;
    const seat = w.seat(a.sittingIn);
    let desired = a.yaw;
    if (s.lookT > 0 && s.lookAt) desired = yawTo(a.pos, s.lookAt);
    else if (seat) {
      const toBoard = yawTo(a.pos, { x: 4.5, z: 0.3 });
      const base =
        s.action === 'notes' || s.action === 'doodle' || s.action === 'phone' ? a.yaw : toBoard;
      desired = clampYaw(base, a.yaw, 1.4) + Math.sin(w.t * 0.3 + hashIdx(a.id)) * 0.15;
    }
    a.headYaw = turnToward(a.headYaw, desired, 3 * dt);
  }
}

function clampYaw(target: number, around: number, max: number): number {
  const d = wrapAngle(target - around);
  return around + Math.max(-max, Math.min(max, d));
}

function hashIdx(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 97;
}

/** Classmates react to what the player does near them. */
function reactToPlayer(w: World, s: StudentState): void {
  const a = s.agent;
  const p = w.player;
  const d = dist2(a.pos, p.pos);
  const r = w.rules();
  // React to loud noises nearby.
  for (const nz of w.noises) {
    if (nz.radius >= 3.5 && dist2(nz.pos, a.pos) < nz.radius && nz.source !== a.id)
      look(s, nz.pos, 1.5);
  }
  if (r.break) return;
  const aff = w.relations.toPlayer(a.id);
  const dev = w.ps.device;
  const showing = deviceOpen(w) && (dev.mode === 'game' || dev.mode === 'video');
  // Neighbour sees your screen.
  if (showing && d < 1.9 && a.sittingIn) {
    const pt = samplePoint(p, 'device', dev.kind === 'laptop' ? { laptopAt: w.laptopSpot(p) } : {});
    const facing = Math.abs(wrapAngle(yawTo(a.pos, { x: pt.x, z: pt.z }) - a.headYaw)) < 1.4;
    const eye = { x: a.pos.x, y: EYE_HEIGHT[a.stance], z: a.pos.z };
    const occ = [...w.geo.occluders.filter((b) => b.kind !== 'table'), personBox(w.teacher)];
    if (
      (facing || w.rngStudents.next() < s.def.traits.nosy * 0.02) &&
      lineOfSight(eye, pt, occ, [a.id, 'player'], true) &&
      cd(s, 'saw-screen', w, 45)
    ) {
      look(s, p.pos, 2.5);
      w.emit({ type: 'saw-screen', who: a.id });
      if (aff < -15 && s.def.traits.snitch > 0.4 && w.teacher.present) {
        w.say(a.id, 'student', 'snitch', {
          teacher: w.profile.name,
          target: w.profile.knowsNames ? p.name : 'the one in the back',
        });
        const st = w.susp('player');
        st.s = Math.min(1.6, st.s + 0.45);
        st.lastEvidence = {
          kind: 'reported',
          point: 'head',
          zone: 'report',
          dist: dist2(w.teacher.pos, p.pos),
        };
        st.lastEvidenceT = w.t;
        w.relations.change(a.id, -3, 'told on you', w);
      } else if (aff >= 25) {
        w.say(a.id, 'student', 'laugh');
        w.noise(a.pos, 0.9, 'laugh', a.id);
        w.relations.change(a.id, 0.5, 'enjoyed your screen', w);
      }
    }
  }
  // Friends warn you when the teacher closes in while you're on your device.
  const T = w.teacher;
  if (showing && aff >= 40 && d < 3 && T.present) {
    const td = dist2(T.pos, p.pos);
    const approaching =
      (w.brain.target === 'player' &&
        (w.brain.state === 'watch' || w.brain.state === 'confront')) ||
      (td < 3.2 && T.moving);
    if (approaching && cd(s, 'warn', w, 25)) {
      w.say(a.id, 'student', 'warnPlayer');
      w.noise(a.pos, 0.8, 'cough', a.id);
      w.emit({ type: 'warned-by-friend', who: a.id });
    }
  }
}
