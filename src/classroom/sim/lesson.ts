// Lesson timeline: phases (game minutes), seeded event schedule, wall clock. Pure TS.
import { TICK_DT } from './clock';
import { LESSONS } from './data';
import type { World } from './world';

export interface LessonState {
  phaseIdx: number;
  gameMinutes: number;
  totalMinutes: number;
  boundaries: number[];
  events: { id: string; atMin: number; fired: boolean }[];
  over: boolean;
  surpriseTest: boolean;
}

export function scheduleLessonEvents(w: World, startPhase: number): LessonState {
  const type = LESSONS.types[w.lessonType]!;
  const boundaries: number[] = [];
  let acc = 0;
  for (const p of type.phases) {
    boundaries.push(acc);
    acc += p.minutes;
  }
  const startMin = boundaries[Math.min(startPhase, boundaries.length - 1)] ?? 0;
  // Events happen during non-break phases, never in the first two minutes.
  const windows = type.phases
    .map((p, i) => ({ p, a: boundaries[i]!, b: boundaries[i]! + p.minutes }))
    .filter((x) => !x.p.rules?.break);
  const events: LessonState['events'] = [];
  for (const [id, chance] of type.events) {
    if (w.rngLesson.next() >= chance || windows.length === 0) continue;
    const win = w.rngLesson.pick(windows);
    const a = Math.max(win.a + 1, 2);
    const atMin = a + w.rngLesson.next() * Math.max(0.5, win.b - a - 1);
    events.push({ id, atMin, fired: false });
  }
  events.sort((x, y) => x.atMin - y.atMin);
  return {
    phaseIdx: 0,
    gameMinutes: startMin,
    totalMinutes: acc,
    boundaries,
    events,
    over: false,
    surpriseTest: false,
  };
}

export function updateLesson(w: World): void {
  const L = w.lesson;
  if (L.over) return;
  L.gameMinutes += LESSONS.gameMinutesPerRealSecond * TICK_DT;
  const m = w.clockMinutes();
  let idx = 0;
  for (let i = 0; i < L.boundaries.length; i++) if (m >= L.boundaries[i]!) idx = i;
  if (idx !== L.phaseIdx) {
    const prevBreak = !!w.phase().rules?.break;
    L.phaseIdx = idx;
    const ph = w.phase();
    w.emit({ type: 'phase', kind: ph.id, text: ph.label });
    if (ph.rules?.break) w.say('teacher', 'teacher', 'breakStart');
    else if (prevBreak) w.say('teacher', 'teacher', 'breakEnd');
    if (ph.id === 'collect' || (ph.id === 'break' && w.rules().test !== undefined)) finishTest(w);
  }
  w.objects.lightsDim = !!w.rules().dim;
  for (const e of L.events) {
    if (!e.fired && L.gameMinutes >= e.atMin) {
      e.fired = true;
      fireEvent(w, e.id);
    }
  }
  // The teacher eventually notices a clock that runs fast (checks their own watch).
  if (
    w.objects.clockOffsetMin > 0 &&
    w.rngLesson.next() < 0.1 * LESSONS.gameMinutesPerRealSecond * TICK_DT
  ) {
    w.objects.clockOffsetMin = 0;
    w.say('teacher', 'teacher', 'clockFast');
    w.emit({ type: 'object', kind: 'clock-fixed' });
  }
  if (m >= L.totalMinutes) {
    if (L.surpriseTest || LESSONS.types[w.lessonType]!.phases.some((p) => p.rules?.test))
      finishTest(w);
    L.over = true;
    w.emit({ type: 'lesson-end' });
  }
}

/** Grades the player's test once (score = answered × quality). */
export function finishTest(w: World): void {
  if (w.stats.testScore !== null) return;
  const hadTest =
    w.lesson.surpriseTest || LESSONS.types[w.lessonType]!.phases.some((p) => p.rules?.test);
  if (!hadTest) return;
  const t = w.ps.test;
  const quality = t.progress > 0 ? Math.min(1, t.quality / t.progress) : 0;
  const score = Math.round(Math.min(1, t.progress) * quality * 100);
  w.stats.testScore = score;
  w.record.grades.push({
    day: w.record.day,
    label: `${LESSONS.types[w.lessonType]!.label} test`,
    value: score,
  });
  if (score >= 85 && !w.stats.cheated)
    w.record.counters.honestAce = (w.record.counters.honestAce ?? 0) + 1;
  w.emit({ type: 'test-graded', value: score });
}

function fireEvent(w: World, id: string): void {
  const present = w.students.filter((s) => s.agent.present);
  w.emit({ type: 'lesson-event', kind: id });
  switch (id) {
    case 'pop-question': {
      const target =
        w.rngLesson.chance(0.4) || present.length === 0
          ? 'player'
          : w.rngLesson.pick(present).agent.id;
      w.brain.requests.push({ kind: 'question', target, pop: true });
      break;
    }
    case 'handout':
      w.brain.requests.push({ kind: 'handout' });
      break;
    case 'door-opens': {
      const door = w.layout.spots?.door ?? [0.85, 6.75];
      w.objects.doorOpen = 3;
      w.noise({ x: door[0], z: door[1] }, 4, 'door', null);
      break;
    }
    case 'classmate-drop': {
      if (!present.length) break;
      const s = w.rngLesson.pick(present);
      s.action = 'pickup';
      s.actionT = 0;
      s.actionDur = 2;
      w.noise(s.agent.pos, 4.5, 'drop', s.agent.id);
      break;
    }
    case 'phone-buzz': {
      if (!present.length) break;
      const s = w.rngLesson.pick(present);
      w.noise(s.agent.pos, 2.4, 'buzz', s.agent.id);
      break;
    }
    case 'surprise-test':
      w.lesson.surpriseTest = true;
      w.emit({
        type: 'bark',
        who: 'teacher',
        text: 'Surprise! Books away. Short test.',
        kind: 'surprise',
      });
      break;
    case 'teacher-leaves':
      w.brain.requests.push({ kind: 'leave' });
      break;
  }
}
