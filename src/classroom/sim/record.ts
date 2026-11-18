// Persistent student record + escalating penalty ladder + end-of-day report. Pure TS.
// Ladder: (1) verbal warning → (2) written warning + seat change → (3) detention → (4) call home +
// grade drop. Strikes persist across lessons/sessions; a clean lesson removes one strike.
import { CAST } from './data';

export const RECORD_VERSION = 2;

export type PenaltyKind = 'warning' | 'written' | 'detention' | 'callhome' | 'letoff';

export interface OffenseEntry {
  day: number;
  lesson: number;
  kind: string;
  penalty: PenaltyKind;
  summary: string;
  teacher: string;
}

export interface StudentRecord {
  version: number;
  day: number;
  lessonInDay: number;
  lessonsPerDay: number;
  strikes: number;
  warnings: number;
  writtenWarnings: number;
  detentions: number;
  callsHome: number;
  grades: { day: number; label: string; value: number }[];
  /** Teacher trust per profile id, -100..100. */
  trust: Record<string, number>;
  /** Player → classmate affinity, -100..100 (persisted relationships). */
  affinity: Record<string, number>;
  /** Classmate → classmate affinity ("a>b" keys). */
  npcAffinity: Record<string, number>;
  memories: { day: number; who: string; text: string; delta: number }[];
  offenses: OffenseEntry[];
  /** Assigned seat override (seat change penalty), null = default. */
  seatOverride: string | null;
  detentionPending: boolean;
  wishlist: { active: string[]; progress: Record<string, number>; done: string[] };
  counters: Record<string, number>;
  bestScore: number;
}

export function newRecord(): StudentRecord {
  const affinity: Record<string, number> = {};
  for (const s of CAST.students) affinity[s.id] = s.affinity;
  return {
    version: RECORD_VERSION,
    day: 1,
    lessonInDay: 0,
    lessonsPerDay: 3,
    strikes: 0,
    warnings: 0,
    writtenWarnings: 0,
    detentions: 0,
    callsHome: 0,
    grades: [],
    trust: {},
    affinity,
    npcAffinity: {},
    memories: [],
    offenses: [],
    seatOverride: null,
    detentionPending: false,
    wishlist: { active: [], progress: {}, done: [] },
    counters: {},
    bestScore: 0,
  };
}

/** Migrates older saves. v1 had no npcAffinity/wishlist.done and stored grades as numbers. */
export function migrateRecord(raw: unknown): StudentRecord {
  const base = newRecord();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const v = typeof r.version === 'number' ? r.version : 0;
  const out = { ...base, ...(r as Partial<StudentRecord>) };
  if (v < 2) {
    const g = r.grades;
    out.grades = Array.isArray(g)
      ? g.map((x, i) =>
          typeof x === 'number'
            ? { day: 1, label: `Grade ${i + 1}`, value: x }
            : (x as StudentRecord['grades'][number]),
        )
      : [];
    out.npcAffinity = (r.npcAffinity as Record<string, number>) ?? {};
    const w = (r.wishlist as Partial<StudentRecord['wishlist']>) ?? {};
    out.wishlist = { active: w.active ?? [], progress: w.progress ?? {}, done: w.done ?? [] };
  }
  for (const s of CAST.students)
    if (typeof out.affinity[s.id] !== 'number') out.affinity[s.id] = s.affinity;
  out.version = RECORD_VERSION;
  return out;
}

export function gradeAverage(r: StudentRecord): number | null {
  if (!r.grades.length) return null;
  return r.grades.reduce((a, g) => a + g.value, 0) / r.grades.length;
}

export function letter(pct: number): string {
  return pct >= 90
    ? 'A'
    : pct >= 80
      ? 'B'
      : pct >= 70
        ? 'C'
        : pct >= 60
          ? 'D'
          : pct >= 50
            ? 'E'
            : 'F';
}

/**
 * Decide the penalty for a new offense and update the record. `roll` in [0,1) comes from the
 * world's seeded RNG; lenient teachers sometimes let a first-level offense go with a look.
 */
export function applyOffense(
  r: StudentRecord,
  opts: {
    kind: string;
    severity: number;
    strictness: number;
    teacher: string;
    roll: number;
    summary: string;
  },
): PenaltyKind {
  const add = opts.severity >= 0.85 ? 2 : 1;
  if (r.strikes === 0 && add === 1 && opts.roll > opts.strictness) {
    r.offenses.push({
      day: r.day,
      lesson: r.lessonInDay,
      kind: opts.kind,
      penalty: 'letoff',
      summary: opts.summary,
      teacher: opts.teacher,
    });
    r.trust[opts.teacher] = (r.trust[opts.teacher] ?? 0) - 3;
    return 'letoff';
  }
  r.strikes += add;
  let p: PenaltyKind;
  if (r.strikes <= 1) {
    p = 'warning';
    r.warnings++;
  } else if (r.strikes === 2) {
    p = 'written';
    r.writtenWarnings++;
    r.seatOverride = CAST.player.seat === 's-front' ? null : 's-front';
  } else if (r.strikes === 3) {
    p = 'detention';
    r.detentions++;
    r.detentionPending = true;
  } else {
    p = 'callhome';
    r.callsHome++;
    r.grades.push({ day: r.day, label: 'Conduct (call home)', value: 45 });
    r.strikes = 2; // the slate is not wiped, but it does not stay at "call home" forever
  }
  r.trust[opts.teacher] = (r.trust[opts.teacher] ?? 0) - 10;
  r.offenses.push({
    day: r.day,
    lesson: r.lessonInDay,
    kind: opts.kind,
    penalty: p,
    summary: opts.summary,
    teacher: opts.teacher,
  });
  return p;
}

/** Called at the end of every lesson. */
export function endLesson(r: StudentRecord, clean: boolean, teacher: string): void {
  if (clean) {
    r.strikes = Math.max(0, r.strikes - 1);
    r.trust[teacher] = Math.min(100, (r.trust[teacher] ?? 0) + 3);
    r.counters.cleanLessons = (r.counters.cleanLessons ?? 0) + 1;
    if (r.strikes === 0) r.seatOverride = null;
  }
  r.lessonInDay++;
}

export function startNewDay(r: StudentRecord): void {
  r.day++;
  r.lessonInDay = 0;
  r.counters = {};
  r.wishlist.progress = {};
}

/** Dry, comedic call-home summary (no win/lose: just consequences). */
export function callHomeText(r: StudentRecord, teacherName: string, rng: () => number): string {
  const recent = r.offenses.slice(-3).map((o) => o.summary.toLowerCase());
  const openers = [
    `${teacherName} called home at 18:42, right as dinner was served.`,
    `The phone rang. It was ${teacherName}. It is never good when it is ${teacherName}.`,
    `Your parents now know ${teacherName}'s voice. Intimately.`,
  ];
  const closers = [
    'Screen time has been "renegotiated".',
    'You are now the household expert on dishwashers.',
    'Your parent sighed in a way that will be discussed for years.',
  ];
  const pick = (a: string[]) => a[Math.floor(rng() * a.length)]!;
  return `${pick(openers)} Topics included: ${recent.join('; ') || 'general conduct'}. ${pick(closers)}`;
}
