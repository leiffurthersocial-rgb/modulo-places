// Data-driven harmless pranks: setup (visible fiddling) → delayed effect → teacher distraction
// (cover for other mischief) → "Who did this?" where witnesses may tell. Pure TS.
// Hard rule: nothing targets a person's body, harms belongings or touches private information.
import { PRANKS, type PrankDef } from './data';
import { type V2 } from './geom';
import { EYE_HEIGHT, lineOfSight, personBox, samplePoint } from './perception';
import type { World } from './world';
import { yawTo, wrapAngle } from './geom';

export interface PrankRun {
  id: string;
  def: PrankDef;
  target: string;
  t0: number;
  effectAt: number;
  effectDone: boolean;
  resolved: boolean;
  witnesses: string[];
  /** Teacher confronted the player during setup. */
  seen: boolean;
  knockUntil?: number;
  nextKnock?: number;
}

export function canStartPrank(w: World, id: string, target: string): string | null {
  const def = PRANKS.find((p) => p.id === id);
  if (!def) return 'Unknown prank.';
  if (w.pranks.some((p) => p.id === id)) return 'Once per lesson is plenty.';
  if (def.requires === 'break' && !w.rules().break)
    return 'Only during the break, when the seats are empty.';
  if (def.requires === 'plane') {
    const held = w.items.find((i) => i.id === w.player.holding);
    if (held?.kind !== 'paper-plane') return 'Fold a paper plane first.';
  }
  if (def.requires === 'carry-free' && w.player.holding) return 'Hands full.';
  if (id === 'swap-chair' && !w.seat(target)) return 'Pick a classmate’s chair.';
  return null;
}

const TASK_POS: Record<string, V2> = {
  'marker-missing': { x: 1.2, z: 0.35 },
  'no-signal': { x: 1.2, z: 0.35 },
  gust: { x: 1.2, z: 0.35 },
  'posters-swapped': { x: 5.6, z: 6.75 },
  'plane-on-desk': { x: 1.2, z: 0.35 },
  sticker: { x: 5.6, z: 0.6 },
  'radiator-knock': { x: 8.5, z: 2.6 },
  'doccam-flipped': { x: 1.2, z: 0.35 },
};

const TASK_BARK: Record<string, string> = {
  'marker-missing': 'markerMissing',
  'no-signal': 'noSignal',
  gust: 'gust',
  'posters-swapped': 'posters',
  'plane-on-desk': 'plane',
  sticker: 'sticker',
  'radiator-knock': 'radiator',
  'doccam-flipped': 'doccam',
};

/** Who can see the player right now (classmates only). */
function witnesses(w: World): string[] {
  const p = w.player;
  const pt = samplePoint(p, 'torso');
  const out: string[] = [];
  for (const s of w.students) {
    const a = s.agent;
    if (!a.present) continue;
    const d = Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z);
    if (d > 7.5) continue;
    if (Math.abs(wrapAngle(yawTo(a.pos, p.pos) - a.headYaw)) > 1.9) continue;
    const eye = { x: a.pos.x, y: EYE_HEIGHT[a.stance], z: a.pos.z };
    const occ = [
      ...w.geo.occluders,
      ...w.students.filter((o) => o !== s).map((o) => personBox(o.agent)),
    ];
    if (lineOfSight(eye, pt, occ, [a.id, 'player'], false)) out.push(a.id);
  }
  return out;
}

export function completePrank(w: World, id: string, target: string, itemId?: string): void {
  const def = PRANKS.find((p) => p.id === id);
  if (!def || w.pranks.some((p) => p.id === id)) return;
  const o = w.objects;
  switch (def.effect.kind) {
    case 'marker-missing':
      o.markerHidden = true;
      break;
    case 'no-signal':
      o.projectorInput = 2;
      break;
    case 'gust':
      o.windowOpen = true;
      break;
    case 'wobbly-chair':
      o.wobblySeat = target;
      break;
    case 'clock-fast':
      o.clockOffsetMin = def.effect.minutes ?? 5;
      break;
    case 'posters-swapped':
      o.posterOrder = [1, 0, 3, 2];
      break;
    case 'plane-on-desk':
      o.planeOnDesk = true;
      if (itemId) w.removeItem(itemId);
      else if (w.player.holding) {
        w.removeItem(w.player.holding);
        w.player.holding = null;
      }
      break;
    case 'sticker':
      o.sticker = true;
      break;
    case 'doccam-flipped':
      o.docCamFlipped = true;
      break;
  }
  const wit = witnesses(w);
  const run: PrankRun = {
    id,
    def,
    target,
    t0: w.t,
    effectAt: w.t + def.delay,
    effectDone: false,
    resolved: false,
    witnesses: wit,
    seen:
      w.brain.target === 'player' && (w.brain.state === 'confront' || w.brain.state === 'penalty'),
  };
  w.pranks.push(run);
  w.emit({ type: 'prank', kind: id, text: def.name });
  // Classmates' opinions: rebels love it, goody-goodies don't.
  for (const sid of wit) {
    const t = w.student(sid)!.def.traits;
    if (t.rebellious > 0.5) {
      w.relations.change(sid, 3, `saw your prank (${def.name.toLowerCase()})`, w);
      if (w.rngSocial.chance(0.5)) w.say(sid, 'student', 'prankLove');
    } else if (t.goody > 0.6) {
      w.relations.change(sid, -3, `disapproved of your prank (${def.name.toLowerCase()})`, w);
      if (w.rngSocial.chance(0.4)) w.say(sid, 'student', 'prankHate');
    }
  }
}

/** Queue the teacher's reaction task for a prank (once). */
function trigger(w: World, run: PrankRun): void {
  if (run.effectDone) return;
  run.effectDone = true;
  const kind = run.def.effect.kind;
  if (kind === 'gust') {
    const win = w.layout.spots?.window ?? [8.55, 1.4];
    w.noise({ x: win[0], z: win[1] }, 5, 'gust', null);
    w.emit({ type: 'gust' });
  }
  if (kind === 'radiator-knock') {
    run.knockUntil = w.t + (run.def.effect.duration ?? 30);
    run.nextKnock = w.t;
    return;
  }
  if (kind === 'wobbly-chair' || kind === 'clock-fast') return; // handled elsewhere
  w.brain.tasks.push({
    kind,
    dur: run.def.distraction,
    pos: TASK_POS[kind] ?? { x: 1.2, z: 0.35 },
    bark: TASK_BARK[kind] ?? 'investigate',
    prank: run.id,
  });
}

export function updatePranks(w: World): void {
  const b = w.brain;
  for (const run of w.pranks) {
    if (run.resolved) continue;
    const k = run.def.effect.kind;
    if (!run.effectDone && w.t >= run.effectAt) {
      // Some effects only fire when the teacher needs the object.
      const needsUse =
        (k === 'marker-missing' && b.state === 'board') ||
        ((k === 'no-signal' || k === 'doccam-flipped') && b.state === 'laptop') ||
        (k === 'sticker' && b.state === 'board') ||
        (k === 'plane-on-desk' &&
          w.teacher.present &&
          Math.hypot(w.teacher.pos.x - 1.2, w.teacher.pos.z - 0.6) < 1.6) ||
        (k === 'posters-swapped' &&
          w.teacher.present &&
          w.teacher.pos.z > 3.2 &&
          w.rngSocial.chance(0.01)) ||
        k === 'gust' ||
        k === 'radiator-knock';
      if (needsUse) trigger(w, run);
    }
    if (run.knockUntil !== undefined) {
      if (w.t < run.knockUntil) {
        if (w.t >= (run.nextKnock ?? 0)) {
          const rad = w.layout.spots?.radiator ?? [8.55, 2.6];
          w.noise({ x: rad[0], z: rad[1] }, 6, 'knock', null);
          run.nextKnock = w.t + 3 + w.rngSocial.next() * 3;
          if (
            !b.tasks.some((t) => t.prank === run.id) &&
            !run.resolved &&
            w.t - run.effectAt > 6 &&
            !b.taskDone.includes(run.id)
          )
            b.tasks.push({
              kind: 'radiator-knock',
              dur: run.def.distraction,
              pos: TASK_POS['radiator-knock']!,
              bark: 'radiator',
              prank: run.id,
            });
        }
      } else if (b.taskDone.includes(run.id)) resolvePrank(w, run);
    }
    if (k === 'wobbly-chair' && run.effectDone === false && b.taskDone.includes(run.id)) {
      run.effectDone = true;
    }
    if (b.taskDone.includes(run.id) && run.knockUntil === undefined) resolvePrank(w, run);
    // Pranks that never get noticed still count as clean at lesson end (see summary).
  }
}

/** After the teacher dealt with a prank: "Who did this?" Witnesses may tell. */
export function resolvePrank(w: World, run: PrankRun): void {
  if (run.resolved) return;
  run.resolved = true;
  const o = w.objects;
  switch (run.def.effect.kind) {
    case 'marker-missing':
      o.markerHidden = false;
      break;
    case 'no-signal':
      o.projectorInput = 1;
      break;
    case 'gust':
      o.windowOpen = false;
      break;
    case 'wobbly-chair':
      o.wobblySeat = null;
      break;
    case 'posters-swapped':
      o.posterOrder = [0, 1, 2, 3];
      break;
    case 'plane-on-desk':
      o.planeOnDesk = false;
      break;
    case 'sticker':
      o.sticker = false;
      break;
    case 'doccam-flipped':
      o.docCamFlipped = false;
      break;
  }
  let told = false;
  for (const sid of run.witnesses) {
    const s = w.student(sid);
    if (!s?.agent.present) continue;
    const aff = w.relations.toPlayer(sid);
    const p = s.def.traits.snitch * (aff < -10 ? 1.1 : aff > 40 ? 0.03 : 0.2);
    if (w.rngSocial.next() < p) {
      told = true;
      w.say(sid, 'student', 'snitch', {
        teacher: w.profile.name,
        target: w.profile.knowsNames ? w.player.name : 'that one',
      });
      const st = w.susp('player');
      st.s = Math.max(st.s, 1.05);
      st.lastEvidence = { kind: 'reported', point: 'head', zone: 'report', dist: 0 };
      st.lastEvidenceT = w.t;
      w.brain.pendingPunish.push({
        target: 'player',
        kind: 'prank',
        severity: 0.6,
        summary: `Prank: ${run.def.name.toLowerCase()} (a classmate told)`,
      });
      w.relations.change(sid, -2, 'told on your prank', w);
      break;
    } else if (aff > 30 && w.rngSocial.chance(0.3)) {
      w.say(sid, 'student', 'deny');
    }
  }
  const clean = !told && !run.seen;
  w.stats.pranks.push({ id: run.id, clean });
  if (clean) w.record.counters.pranksClean = (w.record.counters.pranksClean ?? 0) + 1;
  w.emit({ type: 'prank-resolved', kind: run.id, value: clean ? 1 : 0 });
}
