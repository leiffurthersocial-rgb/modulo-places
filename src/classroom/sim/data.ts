// Typed access to the JSON content + validation. Pure TS.
import barksJson from '../data/barks.json';
import layoutJson from '../data/layouts/classroom-a.json';
import lessonsJson from '../data/lessons.json';
import notesJson from '../data/notes.json';
import pranksJson from '../data/pranks.json';
import studentsJson from '../data/students.json';
import teachersJson from '../data/teachers.json';
import wishlistJson from '../data/wishlist.json';
import type { RoomLayout } from './layout';

export type RoutineKey = 'board' | 'facing' | 'patrol' | 'behind' | 'check' | 'laptop' | 'leave';

export interface TeacherProfile {
  id: string;
  name: string;
  label: string;
  vision: {
    innerAngle: number;
    innerRange: number;
    midAngle: number;
    midRange: number;
    periphAngle: number;
    periphRange: number;
  };
  visionRate: number;
  hearing: number;
  decay: number;
  reaction: number;
  walkSpeed: number;
  turnSpeed: number;
  strictness: number;
  knowsNames: boolean;
  variance: number;
  weights: Record<RoutineKey, number>;
  durations: Record<'board' | 'facing' | 'laptop', [number, number]>;
}

export interface Traits {
  helpful: number;
  nosy: number;
  anxious: number;
  rebellious: number;
  goody: number;
  snitch: number;
}

export interface StudentDef {
  id: string;
  name: string;
  seat: string;
  color: string;
  affinity: number;
  knowledge: number;
  traits: Traits;
}

export interface PhaseRules {
  talkOk?: boolean;
  seatFree?: boolean;
  quiet?: number;
  dim?: boolean;
  test?: boolean;
  group?: boolean;
  break?: boolean;
  detention?: boolean;
}

export interface PhaseDef {
  id: string;
  label: string;
  minutes: number;
  bias?: Partial<Record<RoutineKey, number>>;
  rules?: PhaseRules;
}

export interface LessonType {
  label: string;
  phases: PhaseDef[];
  events: [string, number][];
}

export interface PrankDef {
  id: string;
  name: string;
  target: string;
  setup: number;
  delay: number;
  effect: { kind: string; minutes?: number; duration?: number };
  distraction: number;
  heat: number;
  requires?: string;
}

export interface NoteTemplate {
  id: string;
  text: string;
  affinity: number;
  severity: number;
  answers?: boolean;
}

export interface Challenge {
  id: string;
  text: string;
  counter: string;
  goal: number;
}

export type BarkTiers = string[][];

export const LAYOUT = layoutJson as unknown as RoomLayout;
export const TEACHERS = (teachersJson as unknown as { profiles: TeacherProfile[] }).profiles;
export const CAST = studentsJson as unknown as {
  player: { id: string; name: string; seat: string };
  students: StudentDef[];
};
export const LESSONS = lessonsJson as unknown as {
  gameMinutesPerRealSecond: number;
  types: Record<string, LessonType>;
};
export const PRANKS = (pranksJson as unknown as { pranks: PrankDef[] }).pranks;
export const NOTES = (notesJson as unknown as { templates: NoteTemplate[] }).templates;
export const BARKS = barksJson as unknown as {
  teacher: Record<string, BarkTiers>;
  student: Record<string, BarkTiers>;
};
export const CHALLENGES = (wishlistJson as unknown as { challenges: Challenge[] }).challenges;

export const LESSON_TYPES = Object.keys(LESSONS.types);
export const PLAYABLE_LESSON_TYPES = LESSON_TYPES.filter((t) => t !== 'detention');

export function teacherProfile(id: string): TeacherProfile {
  return TEACHERS.find((t) => t.id === id) ?? TEACHERS[0]!;
}

/** Cross-file validation. Returns problems (empty = ok). */
export function validateContent(): string[] {
  const errs: string[] = [];
  const seats = new Set(LAYOUT.seats.map((s) => s.id));
  const used = new Set<string>([CAST.player.seat]);
  for (const s of CAST.students) {
    if (!seats.has(s.seat)) errs.push(`student ${s.id}: unknown seat ${s.seat}`);
    if (used.has(s.seat)) errs.push(`student ${s.id}: seat ${s.seat} taken twice`);
    used.add(s.seat);
    for (const v of Object.values(s.traits))
      if (v < 0 || v > 1) errs.push(`student ${s.id}: trait out of range`);
  }
  if (!seats.has(CAST.player.seat)) errs.push('player seat unknown');
  for (const [id, l] of Object.entries(LESSONS.types)) {
    const total = l.phases.reduce((a, p) => a + p.minutes, 0);
    if (total < 10 || total > 60) errs.push(`lesson ${id}: ${total} minutes`);
  }
  const ids = new Set([
    'marker',
    'projector-remote',
    'window-a',
    'window-b',
    'seat',
    'clock',
    'poster-1',
    'teacher-desk',
    'board',
    'radiator',
    'doc-camera',
  ]);
  for (const p of PRANKS)
    if (!ids.has(p.target)) errs.push(`prank ${p.id}: unknown target ${p.target}`);
  for (const t of TEACHERS) {
    if (t.vision.innerRange > t.vision.midRange) errs.push(`teacher ${t.id}: inner > mid range`);
    for (const k of ['board', 'facing', 'laptop'] as const) {
      const d = t.durations[k];
      if (!d || d[0] > d[1]) errs.push(`teacher ${t.id}: bad duration ${k}`);
    }
  }
  return errs;
}
