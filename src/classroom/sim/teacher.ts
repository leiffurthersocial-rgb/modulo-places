// Teacher brain: hierarchical state machine (alarm states always win) + bucketed utility for the
// routine activity, with inertia. Telegraphs every escalation (head turn, speech trailing off) and
// writes a "how you got caught" card for every penalty. Pure TS.
import { TICK_DT } from './clock';
import { type RoutineKey } from './data';
import { dist2, turnToward, type V2, wrapAngle, yawTo } from './geom';
import { facingDir } from './layout';
import type { PenaltyKind } from './record';
import { interceptNote } from './social';
import type { CaughtCard, World } from './world';
import type { EvidenceKind } from './types';

export type TeacherState =
  | 'board'
  | 'facing'
  | 'patrol'
  | 'behind'
  | 'check'
  | 'handout'
  | 'answer'
  | 'laptop'
  | 'leave'
  | 'away'
  | 'return'
  | 'investigate'
  | 'watch'
  | 'confront'
  | 'penalty'
  | 'task';

export const ALARM_STATES: TeacherState[] = ['watch', 'confront', 'penalty'];

export interface TeacherRequest {
  kind: 'question' | 'handout' | 'leave';
  target?: string;
  pop?: boolean;
}

export interface TeacherTask {
  kind: string;
  dur: number;
  pos: V2;
  bark: string;
  prank?: string;
}

export interface TeacherBrain {
  state: TeacherState;
  stateT: number;
  dur: number;
  target: string | null;
  goal: V2 | null;
  faceYaw: number | null;
  lookAt: V2 | null;
  stops: { pos: V2; look: V2 | null; faceYaw: number | null; pause: number }[];
  stopT: number;
  distracted: boolean;
  glancing: number;
  nextGlance: number;
  warnedGlance: boolean;
  writeT: number;
  requests: TeacherRequest[];
  tasks: TeacherTask[];
  task: TeacherTask | null;
  taskDone: string[];
  heard: { pos: V2; loud: number; kind: string }[];
  pendingPunish: { target: string; kind: string; severity: number; summary: string }[];
  seen: string[];
  watchLowT: number;
  watchStartT: number;
  confrontBarked: boolean;
  lastRoutine: RoutineKey | null;
  speaking: boolean;
  investigateCd: number;
  arrived: boolean;
  stuckT: number;
  question: TeacherRequest | null;
}

export function newTeacherBrain(): TeacherBrain {
  return {
    state: 'facing',
    stateT: 0,
    dur: 6,
    target: null,
    goal: null,
    faceYaw: Math.PI,
    lookAt: null,
    stops: [],
    stopT: 0,
    distracted: false,
    glancing: 0,
    nextGlance: 8,
    warnedGlance: false,
    writeT: 0,
    requests: [],
    tasks: [],
    task: null,
    taskDone: [],
    heard: [],
    pendingPunish: [],
    seen: [],
    watchLowT: 0,
    watchStartT: 0,
    confrontBarked: false,
    lastRoutine: null,
    speaking: true,
    investigateCd: 0,
    arrived: false,
    stuckT: 0,
    question: null,
  };
}

const SEVERITY: Partial<Record<EvidenceKind, number>> = {
  device: 0.6,
  'device-glow': 0.5,
  fumble: 0.65,
  twitchy: 0.4,
  'out-of-seat': 0.45,
  sprinting: 0.5,
  'wrong-seat': 0.3,
  note: 0.5,
  peek: 0.88,
  cheatsheet: 0.92,
  prank: 0.6,
  throw: 0.55,
  talking: 0.35,
  reported: 0.55,
  absorbed: 0.3,
};

export const EVIDENCE_TEXT: Record<EvidenceKind, string> = {
  device: 'Using a device in class',
  'device-glow': 'A glowing screen in the dark',
  fumble: 'Fumbling to hide a screen',
  twitchy: 'Suspicious screen switching',
  'out-of-seat': 'Wandering around during the lesson',
  sprinting: 'Running in the classroom',
  'wrong-seat': 'Sitting in someone else’s seat',
  note: 'Passing notes',
  peek: 'Copying from a classmate',
  cheatsheet: 'Using a cheat sheet',
  prank: 'Pranking',
  throw: 'Throwing things',
  talking: 'Talking during the lesson',
  reported: 'Reported by a classmate',
  absorbed: 'Not paying attention',
};

const POINT_TEXT: Record<string, string> = {
  head: 'your face',
  torso: 'you',
  handL: 'your hand',
  handR: 'your hand',
  device: 'your screen',
  lap: 'your lap',
};

const ZONE_TEXT: Record<string, string> = {
  inner: 'straight in front of them',
  mid: 'in their field of view',
  peripheral: 'out of the corner of their eye',
  near: 'right next to them',
  heard: 'they heard it',
  report: 'a classmate told them',
};

const PENALTY_TEXT: Record<PenaltyKind, string> = {
  letoff: 'Let off with a long look (no strike).',
  warning: 'Verbal warning: the teacher watches you more closely for the rest of the lesson.',
  written: 'Written warning: you’re moved to the front seat.',
  detention: 'Detention: your next lesson is detention.',
  callhome: 'Call home + grade drop.',
};

// -------------------------------------------------------------------------------------------------

function setState(w: World, s: TeacherState, dur = 999): void {
  const b = w.brain;
  b.state = s;
  b.stateT = 0;
  b.dur = dur;
  b.goal = null;
  b.faceYaw = null;
  b.lookAt = null;
  b.stops = [];
  b.stopT = 0;
  b.distracted = false;
  b.glancing = 0;
  b.arrived = false;
  b.stuckT = 0;
  b.speaking = s === 'board' || s === 'facing' || s === 'answer';
  w.emit({ type: 'teacher-state', kind: s, target: b.target ?? undefined });
}

function spot(w: World, k: string, fb: [number, number]): V2 {
  const s = w.layout.spots?.[k] ?? fb;
  return { x: s[0], z: s[1] };
}

function seatFront(w: World, seatId: string): { pos: V2; look: V2 } | null {
  const seat = w.seat(seatId);
  if (!seat) return null;
  const f = facingDir(seat.facing);
  const pos = { x: seat.pos[0] + f[0] * 1.08, z: seat.pos[1] + f[1] * 1.08 };
  return {
    pos: w.nav.nearestWalkable(pos) ?? pos,
    look: { x: seat.pos[0] + f[0] * 0.2, z: seat.pos[1] + f[1] * 0.2 },
  };
}

function seatBehind(w: World, seatId: string): { pos: V2; look: V2 } | null {
  const seat = w.seat(seatId);
  if (!seat) return null;
  const f = facingDir(seat.facing);
  const pos = { x: seat.pos[0] - f[0] * 0.5, z: seat.pos[1] - f[1] * 0.5 };
  return {
    pos: w.nav.nearestWalkable(pos) ?? pos,
    look: { x: seat.pos[0] + f[0] * 0.25, z: seat.pos[1] + f[1] * 0.25 },
  };
}

function occupiedSeats(w: World): string[] {
  return w
    .allAgents()
    .filter((a) => a.kind !== 'teacher' && a.present && a.sittingIn)
    .map((a) => a.sittingIn!);
}

function range(w: World, r: [number, number]): number {
  return r[0] + (r[1] - r[0]) * w.rngTeacher.next();
}

// -------------------------------------------------------------------------------------------------
// Routine choice (utility with buckets: requests/tasks > routine)

function pickRoutine(w: World): void {
  const b = w.brain;
  const r = w.rules();
  b.target = null;
  if (b.tasks.length) return startTask(w, b.tasks.shift()!);
  const req = b.requests.shift();
  if (req) return startRequest(w, req);
  if (r.break) {
    if (w.rngTeacher.chance(0.25)) return startRequest(w, { kind: 'leave' });
    setState(w, 'laptop', range(w, [15, 30]));
    b.goal = spot(w, 'desk', [1.2, 0.35]);
    b.faceYaw = Math.PI;
    return;
  }
  const P = w.profile;
  const bias = w.phase().bias ?? {};
  const keys: RoutineKey[] = ['board', 'facing', 'patrol', 'behind', 'check', 'laptop', 'leave'];
  const scores = keys.map((k) => {
    let v = P.weights[k] * (bias[k] ?? 1);
    if (k === b.lastRoutine) v *= 0.45; // inertia against repeating (and against ping-pong)
    if (k === 'leave' && (r.test || r.detention || w.t < 30)) v = 0;
    if (k === 'board' && r.test) v *= 0.2;
    v *= 1 + P.variance * (w.rngTeacher.next() - 0.5) * 2;
    return [k, Math.max(0, v)] as const;
  });
  const top = [...scores].sort((a, b2) => b2[1] - a[1]).slice(0, 3);
  const sum = top.reduce((a, x) => a + x[1], 0);
  let roll = w.rngTeacher.next() * sum;
  let pick: RoutineKey = 'facing';
  for (const [k, v] of top) {
    roll -= v;
    if (roll <= 0) {
      pick = k;
      break;
    }
  }
  b.lastRoutine = pick;
  startRoutine(w, pick);
}

function startRoutine(w: World, k: RoutineKey): void {
  const b = w.brain;
  const P = w.profile;
  switch (k) {
    case 'board':
      setState(w, 'board', range(w, P.durations.board));
      b.goal = spot(w, 'board', [4.5, 0.75]);
      b.faceYaw = 0;
      b.nextGlance = w.t + glanceInterval(w);
      if (w.objects.markerHidden || w.objects.sticker) b.dur = 2; // effects trigger via pranks
      return;
    case 'facing':
      setState(w, 'facing', range(w, P.durations.facing));
      b.goal = spot(w, 'front', [4.5, 1.1]);
      b.faceYaw = Math.PI;
      return;
    case 'laptop':
      setState(w, 'laptop', range(w, P.durations.laptop));
      b.goal = spot(w, 'desk', [1.2, 0.35]);
      b.faceYaw = Math.PI;
      b.nextGlance = w.t + glanceInterval(w) * 1.3;
      return;
    case 'patrol': {
      setState(w, 'patrol');
      const pool = ['center', 'laneLeft', 'laneRight', 'laneBack', 'window', 'front'].map((x) =>
        spot(w, x, [4.5, 3.5]),
      );
      pool.push({ x: 3.0, z: 4.6 }, { x: 6.0, z: 4.6 }, { x: 3.0, z: 2.4 }, { x: 6.0, z: 2.4 });
      const n = 3 + w.rngTeacher.int(0, 1);
      for (let i = 0; i < n; i++)
        b.stops.push({
          pos: w.rngTeacher.pick(pool),
          look: null,
          faceYaw: null,
          pause: 1.2 + w.rngTeacher.next() * 1.5,
        });
      return;
    }
    case 'behind': {
      const seats = occupiedSeats(w);
      if (!seats.length) return startRoutine(w, 'facing');
      // Students the teacher has a feeling about get visited more often.
      const weights = seats.map((sid) => {
        const occ = w.occupantOf(sid);
        const st = occ ? w.susp(occ.id) : null;
        return 1 + (st ? st.heat * 6 + st.s * 3 : 0) + (occ?.id === 'player' ? 0.6 : 0);
      });
      let roll = w.rngTeacher.next() * weights.reduce((a, x) => a + x, 0);
      let sid = seats[0]!;
      for (let i = 0; i < seats.length; i++) {
        roll -= weights[i]!;
        if (roll <= 0) {
          sid = seats[i]!;
          break;
        }
      }
      const s = seatBehind(w, sid);
      if (!s) return startRoutine(w, 'facing');
      setState(w, 'behind');
      b.stops.push({ pos: s.pos, look: s.look, faceYaw: null, pause: 5 + w.rngTeacher.next() * 5 });
      return;
    }
    case 'check': {
      const seats = occupiedSeats(w);
      setState(w, 'check');
      const n = Math.min(3, seats.length);
      const chosen = new Set<string>();
      while (chosen.size < n) chosen.add(w.rngTeacher.pick(seats));
      for (const sid of chosen) {
        const f = seatFront(w, sid);
        if (f)
          b.stops.push({
            pos: f.pos,
            look: f.look,
            faceYaw: null,
            pause: 2.2 + w.rngTeacher.next(),
          });
      }
      return;
    }
    case 'leave':
      return startRequest(w, { kind: 'leave' });
  }
}

function glanceInterval(w: World): number {
  const slow =
    w.profile.id === 'distracted'
      ? 2
      : w.profile.id === 'lazy'
        ? 1.4
        : w.profile.id === 'hawk'
          ? 0.6
          : 1;
  return (6 + w.rngTeacher.next() * 9) * slow;
}

function startRequest(w: World, q: TeacherRequest): void {
  const b = w.brain;
  switch (q.kind) {
    case 'question': {
      const a = q.target ? w.agent(q.target) : undefined;
      if (!a || !a.present) return pickRoutine(w);
      setState(w, 'answer', 6);
      b.confrontBarked = false;
      b.target = a.id;
      b.question = q;
      if (q.pop) {
        b.goal = spot(w, 'front', [4.5, 1.1]);
        b.lookAt = a.pos;
        w.say('teacher', 'teacher', 'popQuestion', { name: a.name });
        w.emit({ type: 'pop-question', target: a.id });
      } else {
        const toward = {
          x: a.pos.x + (w.teacher.pos.x - a.pos.x) * 0.2,
          z: a.pos.z + (w.teacher.pos.z - a.pos.z) * 0.2,
        };
        const f = a.sittingIn ? seatFront(w, a.sittingIn) : null;
        b.goal = f?.pos ?? w.nav.nearestWalkable(toward) ?? toward;
        b.lookAt = a.pos;
      }
      return;
    }
    case 'handout': {
      setState(w, 'handout');
      w.say('teacher', 'teacher', 'handout');
      const seats = occupiedSeats(w).sort();
      for (const sid of seats) {
        const f = seatFront(w, sid);
        if (f) b.stops.push({ pos: f.pos, look: f.look, faceYaw: null, pause: 0.9 });
      }
      return;
    }
    case 'leave':
      setState(w, 'leave');
      b.goal = spot(w, 'door', [0.85, 6.75]);
      w.say('teacher', 'teacher', 'leave');
      return;
  }
}

function startTask(w: World, t: TeacherTask): void {
  const b = w.brain;
  setState(w, 'task', t.dur);
  b.task = t;
  b.goal = w.nav.nearestWalkable(t.pos) ?? t.pos;
  b.lookAt = t.pos;
  w.say('teacher', 'teacher', t.bark);
  w.emit({ type: 'teacher-task', kind: t.kind });
}

// -------------------------------------------------------------------------------------------------
// Movement and head

function moveToward(w: World, goal: V2, speedMul = 1): boolean {
  const T = w.teacher;
  if (dist2(T.pos, goal) < 0.15) {
    T.moving = false;
    T.path = null;
    return true;
  }
  if (
    !T.path ||
    T.pathVersion !== w.nav.version ||
    (T.path.length && dist2(T.path[T.path.length - 1]!, goal) > 0.2)
  ) {
    T.path = w.nav.findPath(T.pos, goal) ?? [goal];
    T.pathVersion = w.nav.version;
  }
  const next = T.path[0];
  if (!next) {
    T.moving = false;
    return true;
  }
  const d = dist2(T.pos, next);
  const step = w.profile.walkSpeed * speedMul * TICK_DT;
  const prev = { ...T.pos };
  if (d <= step) {
    T.pos = { ...next };
    T.path.shift();
  } else
    T.pos = {
      x: T.pos.x + ((next.x - T.pos.x) / d) * step,
      z: T.pos.z + ((next.z - T.pos.z) / d) * step,
    };
  // Don't walk through the (standing) player or classmates: slide around them.
  for (const a of w.allAgents()) {
    if (a.id === 'teacher' || !a.present || a.sittingIn) continue;
    const dx = T.pos.x - a.pos.x;
    const dz = T.pos.z - a.pos.z;
    const dd = Math.hypot(dx, dz);
    if (dd < 0.45 && dd > 1e-6)
      T.pos = { x: a.pos.x + (dx / dd) * 0.45, z: a.pos.z + (dz / dd) * 0.45 };
  }
  const moved = dist2(prev, T.pos);
  w.brain.stuckT = moved < step * 0.3 ? w.brain.stuckT + TICK_DT : 0;
  if (w.brain.stuckT > 2.5) {
    // Give up on this goal rather than grinding against someone.
    w.brain.stuckT = 0;
    T.path = null;
    return true;
  }
  T.yaw = turnToward(T.yaw, yawTo(prev, T.pos), 8 * TICK_DT);
  T.moving = true;
  T.stepAcc = (T.stepAcc ?? 0) + moved;
  if (T.stepAcc > 0.7) {
    T.stepAcc = 0;
    w.emit({ type: 'step', who: 'teacher', kind: 'carpet', value: 1 });
  }
  return false;
}

function updateHead(w: World): void {
  const T = w.teacher;
  const b = w.brain;
  let desired = T.headYaw;
  let rate = (w.profile.turnSpeed * Math.PI) / 180;
  if (b.state === 'watch' || b.state === 'confront') {
    const a = b.target ? w.agent(b.target) : undefined;
    if (a) desired = yawTo(T.pos, a.pos);
    rate *= b.state === 'watch' ? 0.6 : 1; // slow, readable head turn = the telegraph
  } else if (b.glancing > 0) {
    desired = b.state === 'board' ? Math.PI : Math.PI + Math.sin(w.t * 0.9) * 0.6;
  } else if (b.lookAt && (!T.moving || dist2(T.pos, b.lookAt) < 3)) {
    desired = yawTo(T.pos, b.lookAt);
  } else if (T.moving) {
    desired = T.yaw + Math.sin(w.t * 0.8) * (b.state === 'patrol' ? 0.55 : 0.25);
  } else if (b.faceYaw !== null) {
    const sweep =
      b.state === 'facing'
        ? Math.sin(w.t * 0.35) * 0.75
        : b.state === 'laptop' && !b.distracted
          ? Math.sin(w.t * 0.6) * 0.5
          : 0;
    desired = b.faceYaw + sweep;
  }
  T.headYaw = turnToward(T.headYaw, desired, rate * TICK_DT);
  // Body follows the head when standing still.
  if (!T.moving && Math.abs(wrapAngle(T.headYaw - T.yaw)) > 0.9)
    T.yaw = turnToward(T.yaw, T.headYaw, rate * 0.5 * TICK_DT);
}

// -------------------------------------------------------------------------------------------------
// Penalties

function punish(w: World, targetId: string): void {
  const st = w.susp(targetId);
  const a = w.agent(targetId);
  if (!a) return;
  const b = w.brain;
  if (targetId !== 'player') {
    const s = w.student(targetId);
    w.say('teacher', 'teacher', 'confront', { name: a.name });
    if (s) {
      s.warnedT = w.t;
      s.action = 'listen';
      s.actionT = 0;
      s.needs.anxious = Math.min(1, s.needs.anxious + 0.4);
    }
    const n = w.notes.find((x) => x.state === 'moving' && x.carrier === targetId);
    if (n) interceptNote(w, n, `taken from ${a.name}`);
    st.heat = Math.min(0.3, st.heat + 0.1);
    st.s = st.heat;
    st.graceUntil = w.t + 20;
    w.emit({ type: 'npc-warned', target: targetId });
    return;
  }
  const ps = w.ps;
  const ev = st.lastEvidence;
  const pending = b.pendingPunish.find((x) => x.target === 'player');
  b.pendingPunish = b.pendingPunish.filter((x) => x.target !== 'player');
  const kind: string = pending?.kind ?? ev?.kind ?? 'device';
  const severity = pending?.severity ?? SEVERITY[(ev?.kind ?? 'device') as EvidenceKind] ?? 0.5;
  let summary =
    pending?.summary ?? EVIDENCE_TEXT[(ev?.kind ?? 'device') as EvidenceKind] ?? 'Misbehaving';
  if (kind === 'device' && ps.device.kind === 'laptop') summary = 'Gaming/watching on the laptop';
  if (kind === 'device' && ps.device.kind === 'phone') summary = 'Using the phone in class';
  const telegraphLead = Math.max(0, w.t - b.watchStartT);
  const lines: string[] = [];
  if (ev) {
    lines.push(
      ev.zone === 'report' || ev.zone === 'heard'
        ? `How: ${ZONE_TEXT[ev.zone]} (${ev.dist.toFixed(1)} m away).`
        : `Seen: ${POINT_TEXT[ev.point] ?? 'you'}, ${ZONE_TEXT[ev.zone]}, ${ev.dist.toFixed(1)} m away.`,
    );
  }
  lines.push(`Exposure: ${st.exposure.toFixed(1)} s in view.`);
  lines.push(`Warning signs: they started watching you ${telegraphLead.toFixed(1)} s before.`);

  // The substitute doesn't know faces and goes by the seating chart.
  const seatOwner = w.students.find((s) => s.def.seat === w.player.sittingIn);
  if (
    !w.profile.knowsNames &&
    w.player.sittingIn &&
    w.player.sittingIn !== w.player.seat &&
    seatOwner
  ) {
    w.say('teacher', 'teacher', 'substituteWho', { name: seatOwner.def.name });
    w.relations.change(
      seatOwner.def.id,
      -20,
      'got blamed by the substitute for your misbehaviour',
      w,
    );
    const card: CaughtCard = {
      t: w.t,
      penalty: 'letoff',
      title: `The substitute wrote down “${seatOwner.def.name}”`,
      lines: [...lines, `${seatOwner.def.name} gets the blame. They will remember.`],
    };
    w.stats.caughtCards.push(card);
    w.emit({ type: 'caught', who: 'player', kind, text: card.title });
    st.s = st.heat;
    st.graceUntil = w.t + 15;
    return;
  }

  const p = w.punishPlayer(kind, severity, summary);
  const barkKey: Record<PenaltyKind, string> = {
    letoff: 'clear',
    warning: 'warning',
    written: 'written',
    detention: 'detention',
    callhome: 'callhome',
  };
  w.say('teacher', 'teacher', barkKey[p], { name: w.player.name });
  if (
    (kind === 'device' || kind === 'fumble' || kind === 'twitchy') &&
    ps.device.kind === 'phone'
  ) {
    ps.phoneConfiscated = true;
    ps.device.kind = null;
    ps.device.mode = 'off';
    lines.push('Phone confiscated until the end of the lesson.');
    w.emit({ type: 'device', kind: 'confiscated' });
  } else if (kind === 'device' && ps.device.kind === 'laptop') {
    ps.device.mode = 'decoy';
    lines.push('Laptop back on your notes, please.');
  }
  if (kind === 'cheatsheet') {
    ps.hasCheatSheet = false;
    lines.push('Cheat sheet confiscated. The test grade will reflect it.');
    ps.test.quality *= 0.5;
  }
  if (kind === 'peek') ps.test.quality *= 0.6;
  const n = w.notes.find((x) => x.state === 'moving' && x.carrier === 'player');
  if (n) interceptNote(w, n, 'taken from you');
  lines.push(PENALTY_TEXT[p]);
  const card: CaughtCard = { t: w.t, penalty: p, title: `Caught: ${summary}`, lines };
  w.stats.caughtCards.push(card);
  w.detectionLog.push({
    t: w.t,
    target: 'player',
    evidence: (ev?.kind ?? 'device') as EvidenceKind,
    point: ev?.point ?? 'head',
    distance: ev?.dist ?? 0,
    zone: ev?.zone ?? 'inner',
    exposure: st.exposure,
    teacherState: b.state,
  });
  w.emit({ type: 'caught', who: 'player', kind, text: card.title, value: telegraphLead });
  w.emit({ type: 'penalty', kind: p });
  st.s = st.heat;
  st.exposure = 0;
  st.graceUntil = w.t + 25;
  if (!w.player.sittingIn)
    w.emit({ type: 'bark', who: 'teacher', text: 'Back to your seat. Now.', kind: 'seat' });
  if (p === 'written' && w.player.sittingIn && w.player.sittingIn !== w.player.seat) {
    w.emit({ type: 'hint', text: 'Move to the front seat (next to the board).' });
  }
}

// -------------------------------------------------------------------------------------------------

const GLANCE_KINDS = new Set([
  'door',
  'cough',
  'sneeze',
  'chair',
  'sharpen',
  'paper',
  'plane',
  'wobble',
  'drop',
  'buzz',
  'laugh',
]);
const INVESTIGATE_KINDS = new Set([
  'thud',
  'knock',
  'gust',
  'step-run',
  'whisper',
  'device-audio',
  'game-beep',
  'step',
]);

export function updateTeacher(w: World): void {
  const T = w.teacher;
  const b = w.brain;
  const dt = TICK_DT;
  b.stateT += dt;
  b.investigateCd = Math.max(0, b.investigateCd - dt);

  // --- Alarm bucket: suspicion ------------------------------------------------------------------
  if (T.present && b.state !== 'away' && b.state !== 'leave') {
    let best: string | null = null;
    let bestS = 0;
    for (const [id, st] of w.suspicion) {
      if (id === 'teacher') continue;
      if (st.s > bestS) {
        best = id;
        bestS = st.s;
      }
    }
    const inAlarm = ALARM_STATES.includes(b.state);
    if (!inAlarm && best && bestS >= 0.35) {
      setState(w, 'watch');
      b.target = best;
      b.watchStartT = w.t;
      b.watchLowT = 0;
      b.speaking = false; // speech trails off
      w.say('teacher', 'teacher', 'telegraph');
      w.emit({ type: 'telegraph', target: best, value: bestS });
    } else if (
      b.state === 'watch' &&
      best &&
      best !== b.target &&
      bestS > w.susp(b.target ?? '').s + 0.3
    ) {
      b.target = best;
      b.watchStartT = w.t;
      w.emit({ type: 'telegraph', target: best, value: bestS });
    }
  }

  // --- Hearing → investigate / glance ---------------------------------------------------------
  if (b.heard.length) {
    const h = b.heard.reduce((a, x) => (x.loud > a.loud ? x : a));
    b.heard = [];
    const routine =
      !ALARM_STATES.includes(b.state) &&
      b.state !== 'task' &&
      b.state !== 'away' &&
      b.state !== 'leave' &&
      b.state !== 'investigate';
    if (routine && T.present) {
      if (INVESTIGATE_KINDS.has(h.kind) && h.loud > 0.12 && b.investigateCd <= 0) {
        setState(w, 'investigate', 3.5);
        b.goal = w.nav.nearestWalkable(h.pos) ?? h.pos;
        b.lookAt = h.pos;
        b.investigateCd = 6;
        w.say('teacher', 'teacher', 'investigate');
        w.emit({ type: 'investigate', pos: h.pos, kind: h.kind });
      } else if (GLANCE_KINDS.has(h.kind) || h.loud > 0.3) {
        b.lookAt = h.pos;
        b.glancing = 0;
      }
    }
  }

  // --- State behaviour ------------------------------------------------------------------------
  switch (b.state) {
    case 'watch': {
      const a = b.target ? w.agent(b.target) : undefined;
      const st = w.susp(b.target ?? '');
      if (!a || !a.present) {
        pickRoutine(w);
        break;
      }
      if (b.stateT > 1.0 && b.stateT - dt <= 1.0) {
        if (b.target === 'player' || w.profile.knowsNames)
          w.say('teacher', 'teacher', 'watch', { name: a.name });
        else w.say('teacher', 'teacher', 'watchAnon');
      }
      if (st.s >= 0.7) {
        const goal = approachSpot(w, a.pos);
        moveToward(w, goal, 0.9);
      } else T.moving = false;
      const evidenceFresh =
        w.t - st.lastEvidenceT < 0.6 || b.pendingPunish.some((x) => x.target === b.target);
      if (st.s >= 1.0 && b.stateT >= 1.2 && evidenceFresh) {
        setState(w, 'confront', 6);
        b.target = a.id;
        b.confrontBarked = false;
        break;
      }
      if (st.s < 0.22) {
        b.watchLowT += dt;
        if (b.watchLowT > 1.5) {
          if (w.rngTeacher.chance(0.4)) w.say('teacher', 'teacher', 'clear');
          w.emit({ type: 'relax', target: b.target ?? undefined });
          pickRoutine(w);
        }
      } else b.watchLowT = 0;
      break;
    }
    case 'confront': {
      const a = b.target ? w.agent(b.target) : undefined;
      if (!a) {
        pickRoutine(w);
        break;
      }
      const there =
        dist2(T.pos, a.pos) < 1.35 || moveToward(w, approachSpot(w, a.pos), 1.1) || b.stateT > 4;
      if (there && !b.confrontBarked) {
        b.confrontBarked = true;
        T.moving = false;
        b.stateT = 0;
        const named = a.id !== 'player' || w.profile.knowsNames;
        w.say('teacher', 'teacher', named ? 'confront' : 'confrontAnon', { name: a.name });
        w.emit({ type: 'confront', target: a.id });
      } else if (b.confrontBarked && b.stateT > 1.4) {
        punish(w, a.id);
        setState(w, 'penalty', 2.5);
        b.target = a.id;
        b.lookAt = a.pos;
      }
      break;
    }
    case 'penalty':
      if (b.stateT >= b.dur) pickRoutine(w);
      break;
    case 'investigate':
      if (!b.arrived && b.goal) b.arrived = moveToward(w, b.goal, 1.15);
      if (b.arrived) {
        b.lookAt = null;
        b.faceYaw = T.headYaw + Math.sin(b.stateT * 2) * 1.2;
        b.dur -= dt;
        if (b.dur <= 0) {
          if (w.rngTeacher.chance(0.5)) w.say('teacher', 'teacher', 'clear');
          pickRoutine(w);
        }
      }
      break;
    case 'task': {
      const t = b.task;
      if (!t) {
        pickRoutine(w);
        break;
      }
      if (!b.arrived && b.goal) b.arrived = moveToward(w, b.goal);
      if (b.arrived) {
        b.distracted = true;
        T.stance = t.kind === 'gust' ? 'crouch' : 'stand';
        b.dur -= dt;
        if (b.dur <= 0) {
          T.stance = 'stand';
          if (t.prank && !b.taskDone.includes(t.prank)) b.taskDone.push(t.prank);
          b.task = null;
          pickRoutine(w);
        }
      }
      break;
    }
    case 'board':
    case 'facing':
    case 'laptop': {
      if (!b.arrived && b.goal) b.arrived = moveToward(w, b.goal);
      if (b.arrived) {
        if (b.state === 'laptop') b.distracted = b.glancing <= 0;
        if (b.state === 'board' || b.state === 'laptop') {
          // Glances at the class, telegraphed: writing stops ~0.6 s before the head turns.
          if (!b.warnedGlance && w.t >= b.nextGlance - 0.6 && b.glancing <= 0) {
            b.warnedGlance = true;
            w.emit({ type: 'glance-soon', kind: b.state });
          }
          if (w.t >= b.nextGlance && b.glancing <= 0) {
            b.glancing = 1.4 + w.rngTeacher.next() * 1.2;
            b.nextGlance = w.t + b.glancing + glanceInterval(w);
            b.warnedGlance = false;
          }
          if (b.glancing > 0) b.glancing -= dt;
          if (b.state === 'board' && b.glancing <= 0 && !b.warnedGlance) {
            b.writeT += dt;
            if (b.writeT > 0.8) {
              b.writeT = 0;
              w.emit({ type: 'writing' });
            }
          }
        }
        if (b.stateT >= b.dur) pickRoutine(w);
      } else if (b.stateT > 20) pickRoutine(w);
      break;
    }
    case 'patrol':
    case 'behind':
    case 'check':
    case 'handout': {
      const stop = b.stops[0];
      if (!stop) {
        pickRoutine(w);
        break;
      }
      if (!b.arrived) {
        b.arrived = moveToward(w, stop.pos);
        b.lookAt = b.arrived
          ? stop.look
          : stop.look && dist2(T.pos, stop.pos) < 2
            ? stop.look
            : null;
        b.stopT = 0;
      } else {
        b.lookAt = stop.look;
        b.faceYaw = stop.faceYaw ?? T.headYaw;
        b.stopT += dt;
        if (b.stopT >= stop.pause) {
          b.stops.shift();
          b.arrived = false;
        }
      }
      if (b.stateT > 60) pickRoutine(w);
      break;
    }
    case 'answer': {
      const a = b.target ? w.agent(b.target) : undefined;
      if (!a) {
        pickRoutine(w);
        break;
      }
      b.lookAt = a.pos;
      if (!b.arrived && b.goal) b.arrived = moveToward(w, b.goal);
      if (b.arrived && !b.confrontBarked) {
        // confrontBarked doubles as "the question has started" flag in this state.
        b.confrontBarked = true;
        b.speaking = true;
        b.dur = b.stateT + 5;
        if (!b.question?.pop) w.say('teacher', 'teacher', 'question', { name: a.name });
      }
      if (b.confrontBarked && b.stateT >= b.dur) {
        if (a.id === 'player') {
          w.ps.handRaised = false;
          const goodAnswer = w.ps.working || w.stats.workSeconds > 20;
          w.record.trust[w.profile.id] =
            (w.record.trust[w.profile.id] ?? 0) + (goodAnswer ? 2 : -2);
          w.emit({
            type: 'bark',
            who: 'teacher',
            text: goodAnswer ? 'Good. Exactly.' : 'Were you even listening?',
            kind: 'answer',
          });
        }
        b.question = null;
        pickRoutine(w);
      }
      break;
    }
    case 'leave':
      if (moveToward(w, b.goal ?? spot(w, 'door', [0.85, 6.75]))) {
        T.present = false;
        T.pos = spot(w, 'doorOutside', [0.85, 7.6]);
        w.objects.doorOpen = 2;
        w.noise(spot(w, 'door', [0.85, 6.75]), 4, 'door', 'teacher');
        setState(w, 'away', 22 + w.rngTeacher.next() * 28);
        w.emit({ type: 'teacher-left' });
      }
      break;
    case 'away':
      T.moving = false;
      if (b.stateT >= b.dur) {
        T.present = true;
        T.pos = spot(w, 'door', [0.85, 6.75]);
        w.objects.doorOpen = 2;
        w.noise(T.pos, 4, 'door', 'teacher');
        setState(w, 'return');
        b.goal = spot(w, 'front', [4.5, 1.1]);
        w.say('teacher', 'teacher', 'back');
        w.emit({ type: 'teacher-back' });
      }
      break;
    case 'return':
      if (moveToward(w, b.goal ?? spot(w, 'front', [4.5, 1.1]))) pickRoutine(w);
      break;
  }

  // Prank tasks interrupt routine activities (not alarms).
  if (
    b.tasks.length &&
    !ALARM_STATES.includes(b.state) &&
    b.state !== 'task' &&
    b.state !== 'away' &&
    b.state !== 'leave'
  ) {
    startTask(w, b.tasks.shift()!);
  }
  // Pending punishments (a classmate told, a note was handed over) lead to a confrontation.
  if (
    b.pendingPunish.length &&
    !ALARM_STATES.includes(b.state) &&
    T.present &&
    b.state !== 'away'
  ) {
    const p = b.pendingPunish[0]!;
    setState(w, 'watch');
    b.target = p.target;
    b.watchStartT = w.t;
    w.emit({ type: 'telegraph', target: p.target, value: 1 });
  }
  if (!b.goal && b.state !== 'watch') T.moving = false;
  updateHead(w);
}

function approachSpot(w: World, target: V2): V2 {
  const T = w.teacher;
  const d = dist2(T.pos, target) || 1;
  const p = {
    x: target.x + ((T.pos.x - target.x) / d) * 1.0,
    z: target.z + ((T.pos.z - target.z) / d) * 1.0,
  };
  return w.nav.nearestWalkable(p) ?? p;
}
