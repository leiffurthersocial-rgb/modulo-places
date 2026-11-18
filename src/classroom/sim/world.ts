// The simulation world: all state for one lesson in one room, advanced in fixed 20 Hz ticks.
// Render/audio/UI read it and drain `events`; bots and the headless runner drive it directly.
// Pure TS (lint-enforced). Everything random goes through forks of the seeded Rng.
import { BarkPicker } from './barks';
import { TICK_DT } from './clock';
import {
  BARKS,
  CAST,
  LAYOUT,
  LESSONS,
  type PhaseDef,
  type PhaseRules,
  type StudentDef,
  type TeacherProfile,
  teacherProfile,
} from './data';
import { buildStaticGeometry, dist2, type StaticGeometry, type V2, yawTo } from './geom';
import { facingDir, type RoomLayout, type Seat } from './layout';
import { scheduleLessonEvents, updateLesson, type LessonState } from './lesson';
import { NavGrid } from './nav';
import { updatePerception } from './perception-system';
import { updatePlayer, type PlayerState, newPlayerState } from './player';
import { updatePranks, type PrankRun } from './pranks';
import { applyOffense, type PenaltyKind, type StudentRecord, newRecord } from './record';
import { hashString, Rng } from './rng';
import { type NoteState, updateNotes, Relations } from './social';
import { updateStudents, type StudentState } from './students';
import { newTeacherBrain, type TeacherBrain, updateTeacher } from './teacher';
import type {
  Agent,
  DetectionEntry,
  EvidenceKind,
  Item,
  NoiseEvent,
  PlayerCommand,
  SamplePoint,
  SimEvent,
} from './types';

export interface WorldOptions {
  seed: number;
  lessonType: string;
  teacher: string;
  record?: StudentRecord;
  /** Students absent this lesson (detention: most are absent). */
  absent?: string[];
  /** Skip straight to a phase (debug). */
  startPhase?: number;
}

export interface SuspicionState {
  s: number;
  /** Floor that suspicion decays to (raised by warnings this lesson). */
  heat: number;
  lastEvidence: {
    kind: EvidenceKind;
    point: SamplePoint;
    zone: DetectionEntry['zone'];
    dist: number;
  } | null;
  lastEvidenceT: number;
  exposure: number;
  /** After a penalty the target gets a grace period to comply (no new suspicion). */
  graceUntil?: number;
}

export interface RoomObjects {
  markerHidden: boolean;
  windowOpen: boolean;
  posterOrder: number[];
  sticker: boolean;
  docCamFlipped: boolean;
  projectorInput: 1 | 2;
  wobblySeat: string | null;
  planeOnDesk: boolean;
  clockOffsetMin: number;
  lightsDim: boolean;
  doorOpen: number;
}

export interface Interactable {
  id: string;
  kind: string;
  label: string;
  pos: V2;
  y: number;
  verbs: { verb: string; label: string; risk?: 'loud' | 'risky' }[];
  /** Max distance from the player's feet. */
  reach: number;
}

export interface LessonStats {
  offenses: { kind: string; penalty: PenaltyKind; t: number }[];
  pranks: { id: string; clean: boolean }[];
  notesDelivered: string[];
  notesIntercepted: number;
  videoSeconds: number;
  gameSeconds: number;
  workSeconds: number;
  bestScore: number;
  sneakSeconds: number;
  testScore: number | null;
  cheated: boolean;
  caughtCards: CaughtCard[];
  affinityStart: Record<string, number>;
}

export interface CaughtCard {
  t: number;
  penalty: PenaltyKind;
  title: string;
  lines: string[];
}

export class World {
  readonly layout: RoomLayout = LAYOUT;
  readonly geo: StaticGeometry;
  readonly nav: NavGrid;
  readonly seed: number;
  readonly rng: Rng;
  readonly rngTeacher: Rng;
  readonly rngStudents: Rng;
  readonly rngLesson: Rng;
  readonly rngSocial: Rng;
  readonly barks = new BarkPicker();
  readonly profile: TeacherProfile;
  readonly lessonType: string;
  readonly record: StudentRecord;

  t = 0;
  tick = 0;
  lesson: LessonState;
  teacher: Agent;
  brain: TeacherBrain;
  students: StudentState[] = [];
  player: Agent;
  ps: PlayerState;
  items: Item[] = [];
  notes: NoteState[] = [];
  pranks: PrankRun[] = [];
  studentReplies: { from: string; at: number; template: string }[] = [];
  noises: NoiseEvent[] = [];
  /** Output queue; the client drains it each frame (`drainEvents`). */
  events: SimEvent[] = [];
  /** Rolling hash of every emitted event: determinism fingerprint. */
  eventHash = 0;
  suspicion = new Map<string, SuspicionState>();
  detectionLog: DetectionEntry[] = [];
  relations: Relations;
  objects: RoomObjects;
  stats: LessonStats;
  private nextItemId = 1;
  private seatsById = new Map<string, Seat>();

  constructor(opts: WorldOptions) {
    this.seed = opts.seed >>> 0;
    this.rng = new Rng(this.seed);
    this.rngTeacher = this.rng.fork('teacher');
    this.rngStudents = this.rng.fork('students');
    this.rngLesson = this.rng.fork('lesson');
    this.rngSocial = this.rng.fork('social');
    this.profile = teacherProfile(opts.teacher);
    this.lessonType = LESSONS.types[opts.lessonType] ? opts.lessonType : 'lecture';
    this.record = opts.record ?? newRecord();
    this.geo = buildStaticGeometry(this.layout);
    const [W, , D] = this.layout.room.size;
    this.nav = new NavGrid(W, D, this.geo.colliders);
    for (const s of this.layout.seats) this.seatsById.set(s.id, s);

    const home = this.layout.teacherHome;
    this.teacher = makeAgent(
      'teacher',
      this.profile.name,
      'teacher',
      '#e8e2d0',
      { x: home[0], z: home[1] },
      Math.PI,
    );
    this.teacher.speed = this.profile.walkSpeed;
    this.brain = newTeacherBrain();

    const pSeatId = this.record.seatOverride ?? CAST.player.seat;
    const pSeat = this.seat(pSeatId) ?? this.seat(CAST.player.seat)!;
    this.player = makeAgent(
      'player',
      CAST.player.name,
      'player',
      '#ffffff',
      { x: pSeat.pos[0], z: pSeat.pos[1] },
      (pSeat.facing * Math.PI) / 180,
    );
    this.player.seat = pSeat.id;
    this.player.sittingIn = pSeat.id;
    this.player.stance = 'sit';
    this.ps = newPlayerState();

    const absent = new Set(opts.absent ?? []);
    for (const def of CAST.students) {
      if (absent.has(def.id)) continue;
      // If the player was moved to another seat, nobody else sits in the player's default seat.
      const seat = this.seat(def.seat)!;
      const a = makeAgent(
        def.id,
        def.name,
        'student',
        def.color,
        { x: seat.pos[0], z: seat.pos[1] },
        (seat.facing * Math.PI) / 180,
      );
      a.seat = seat.id;
      a.sittingIn = seat.id;
      a.stance = 'sit';
      a.speed = 1.1;
      this.students.push(newStudent(a, def));
    }
    this.relations = new Relations(
      this.record,
      this.students.map((s) => s.def),
    );

    for (const a of this.allAgents())
      this.suspicion.set(a.id, {
        s: 0,
        heat: 0,
        lastEvidence: null,
        lastEvidenceT: -99,
        exposure: 0,
      });
    // Low teacher trust carries over as a raised baseline.
    const trust = this.record.trust[this.profile.id] ?? 0;
    this.susp('player').heat = trust < 0 ? Math.min(0.25, -trust / 200) : 0;

    this.objects = {
      markerHidden: false,
      windowOpen: false,
      posterOrder: [0, 1, 2, 3],
      sticker: false,
      docCamFlipped: false,
      projectorInput: 1,
      wobblySeat: null,
      planeOnDesk: false,
      clockOffsetMin: 0,
      lightsDim: false,
      doorOpen: 0,
    };
    const affinityStart: Record<string, number> = {};
    for (const s of this.students) affinityStart[s.def.id] = this.relations.toPlayer(s.def.id);
    this.stats = {
      offenses: [],
      pranks: [],
      notesDelivered: [],
      notesIntercepted: 0,
      videoSeconds: 0,
      gameSeconds: 0,
      workSeconds: 0,
      bestScore: 0,
      sneakSeconds: 0,
      testScore: null,
      cheated: false,
      caughtCards: [],
      affinityStart,
    };
    this.lesson = scheduleLessonEvents(this, opts.startPhase ?? 0);
  }

  // ---------------------------------------------------------------------------------------------
  // Queries

  seat(id: string | null | undefined): Seat | undefined {
    return id ? this.seatsById.get(id) : undefined;
  }

  allAgents(): Agent[] {
    return [this.teacher, this.player, ...this.students.map((s) => s.agent)];
  }

  agent(id: string): Agent | undefined {
    if (id === 'teacher') return this.teacher;
    if (id === 'player') return this.player;
    return this.students.find((s) => s.agent.id === id)?.agent;
  }

  student(id: string): StudentState | undefined {
    return this.students.find((s) => s.agent.id === id);
  }

  susp(id: string): SuspicionState {
    let s = this.suspicion.get(id);
    if (!s) {
      s = { s: 0, heat: 0, lastEvidence: null, lastEvidenceT: -99, exposure: 0 };
      this.suspicion.set(id, s);
    }
    return s;
  }

  phase(): PhaseDef {
    const phases = LESSONS.types[this.lessonType]!.phases;
    return phases[Math.min(this.lesson.phaseIdx, phases.length - 1)]!;
  }

  rules(): PhaseRules {
    const r = { ...(this.phase().rules ?? {}) };
    if (this.lesson.surpriseTest) {
      r.test = true;
      r.quiet = Math.max(r.quiet ?? 1, 1.6);
      r.talkOk = false;
    }
    return r;
  }

  /** Lesson clock in game minutes as shown on the wall clock (includes the clock prank). */
  clockMinutes(): number {
    return this.lesson.gameMinutes + this.objects.clockOffsetMin;
  }

  /** Seat in front of which a laptop would sit (table centre side). */
  laptopSpot(a: Agent): V2 | undefined {
    const seat = this.seat(a.sittingIn);
    if (!seat) return undefined;
    const f = facingDir(seat.facing);
    return { x: seat.pos[0] + f[0] * 0.45, z: seat.pos[1] + f[1] * 0.45 };
  }

  /** Seats adjacent to a seat (note chain graph). */
  seatNeighbours(id: string): string[] {
    const s = this.seat(id);
    if (!s) return [];
    return this.layout.seats
      .filter(
        (o) => o.id !== id && !o.hot && Math.hypot(o.pos[0] - s.pos[0], o.pos[1] - s.pos[1]) <= 2.0,
      )
      .map((o) => o.id);
  }

  /** Agent sitting in or assigned to a seat. */
  occupantOf(seatId: string): Agent | undefined {
    return (
      this.allAgents().find((a) => a.sittingIn === seatId) ??
      this.allAgents().find((a) => a.seat === seatId)
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Output helpers

  emit(e: Omit<SimEvent, 't'>): void {
    const ev: SimEvent = { ...e, t: this.t };
    this.events.push(ev);
    this.eventHash = (Math.imul(
      this.eventHash ^
        hashString(`${ev.type}|${ev.who ?? ''}|${ev.target ?? ''}|${ev.kind ?? ''}|${this.tick}`),
      0x01000193,
    ) >>> 0) as number;
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  noise(pos: V2, radius: number, kind: string, source: string | null): void {
    this.noises.push({ pos: { ...pos }, radius, kind, source });
    this.emit({ type: 'noise', pos: { ...pos }, radius, kind, who: source ?? undefined });
  }

  say(
    who: string,
    group: 'teacher' | 'student',
    key: string,
    vars: Record<string, string> = {},
  ): string {
    const tiers = (group === 'teacher' ? BARKS.teacher : BARKS.student)[key];
    const text = this.barks.pick(`${who}:${key}`, tiers, this.rngSocial, vars);
    if (text) this.emit({ type: 'bark', who, text, kind: key });
    return text;
  }

  addItem(kind: Item['kind'], pos: V2, y: number, heldBy: string | null): Item {
    const it: Item = { id: `${kind}-${this.nextItemId++}`, kind, pos: { ...pos }, y, heldBy };
    this.items.push(it);
    return it;
  }

  removeItem(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
  }

  /** Player-attributable offense → penalty ladder. Returns the penalty. */
  punishPlayer(kind: string, severity: number, summary: string): PenaltyKind {
    const p = applyOffense(this.record, {
      kind,
      severity,
      strictness: this.profile.strictness,
      teacher: this.profile.id,
      roll: this.rngTeacher.next(),
      summary,
    });
    this.stats.offenses.push({ kind, penalty: p, t: this.t });
    if (p === 'written' && this.record.seatOverride) {
      this.player.seat = this.record.seatOverride;
    }
    const s = this.susp('player');
    s.heat = Math.min(0.3, s.heat + 0.12);
    return p;
  }

  // ---------------------------------------------------------------------------------------------
  // Tick

  step(cmd: PlayerCommand): void {
    this.t += TICK_DT;
    this.tick++;
    this.noises = [];
    updateLesson(this);
    updatePlayer(this, cmd);
    updateStudents(this);
    updateNotes(this);
    updatePranks(this);
    updatePerception(this);
    updateTeacher(this);
    this.objects.doorOpen = Math.max(0, this.objects.doorOpen - TICK_DT);
  }

  get over(): boolean {
    return this.lesson.over;
  }

  /** Distance helper for UI/bots. */
  distTo(a: V2, id: string): number {
    const ag = this.agent(id);
    return ag ? dist2(a, ag.pos) : Infinity;
  }

  /** Yaw from player to an agent (UI helpers). */
  yawToAgent(id: string): number {
    const ag = this.agent(id);
    return ag ? yawTo(this.player.pos, ag.pos) : 0;
  }
}

export function makeAgent(
  id: string,
  name: string,
  kind: Agent['kind'],
  color: string,
  pos: V2,
  yaw: number,
): Agent {
  return {
    id,
    name,
    kind,
    color,
    pos: { ...pos },
    yaw,
    headYaw: yaw,
    pitch: 0,
    stance: 'stand',
    seat: null,
    sittingIn: null,
    path: null,
    pathVersion: -1,
    speed: 1.2,
    moving: false,
    holding: null,
    present: true,
  };
}

function newStudent(agent: Agent, def: StudentDef): StudentState {
  return {
    agent,
    def,
    needs: { bored: 0.2, sleepy: 0.1, social: 0.3, anxious: def.traits.anxious * 0.4 },
    action: 'listen',
    actionT: 0,
    actionDur: 3,
    target: null,
    goal: null,
    cooldowns: {},
    knowledge: def.knowledge,
    testProgress: 0,
    warnedT: -99,
    lookAt: null,
    lookT: 0,
  };
}
