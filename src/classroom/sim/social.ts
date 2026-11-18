// Relationships (affinity + memory log, Dwarf Fortress-style "thoughts") and note chains that
// travel seat to seat; every link may pass, read, delay, refuse or snitch. Pure TS.
import { TICK_DT } from './clock';
import { NOTES, type StudentDef } from './data';
import type { StudentRecord } from './record';
import type { World } from './world';

export class Relations {
  private record: StudentRecord;
  private defs: Map<string, StudentDef>;

  constructor(record: StudentRecord, defs: StudentDef[]) {
    this.record = record;
    this.defs = new Map(defs.map((d) => [d.id, d]));
  }

  /** How much classmate `id` likes the player (-100..100). */
  toPlayer(id: string): number {
    return this.record.affinity[id] ?? this.defs.get(id)?.affinity ?? 0;
  }

  change(id: string, delta: number, why: string, w: World): void {
    if (!delta) return;
    const v = Math.max(-100, Math.min(100, this.toPlayer(id) + delta));
    this.record.affinity[id] = Math.round(v * 10) / 10;
    this.record.memories.push({ day: this.record.day, who: id, text: why, delta });
    if (this.record.memories.length > 300)
      this.record.memories.splice(0, this.record.memories.length - 300);
    w.emit({ type: 'affinity', who: id, value: delta, text: why });
  }

  /** Classmate → classmate affinity, seeded from trait similarity. */
  between(a: string, b: string): number {
    const k = `${a}>${b}`;
    const v = this.record.npcAffinity[k];
    if (typeof v === 'number') return v;
    const A = this.defs.get(a)?.traits;
    const B = this.defs.get(b)?.traits;
    if (!A || !B) return 0;
    const diff =
      Math.abs(A.rebellious - B.rebellious) +
      Math.abs(A.goody - B.goody) +
      Math.abs(A.nosy - B.nosy);
    return Math.round(30 - diff * 25);
  }

  changeBetween(a: string, b: string, delta: number): void {
    const k = `${a}>${b}`;
    this.record.npcAffinity[k] = Math.max(-100, Math.min(100, this.between(a, b) + delta));
  }

  /** Affinity of `who` toward `about` (player or classmate). */
  of(who: string, about: string): number {
    if (about === 'player') return this.toPlayer(who);
    if (who === 'player') return this.toPlayer(about);
    return this.between(who, about);
  }
}

export interface NoteState {
  id: string;
  itemId: string;
  from: string;
  to: string;
  template: string;
  carrier: string;
  /** Seat ids from the sender's seat to the recipient's seat. */
  route: string[];
  hop: number;
  hopT: number;
  hopDur: number;
  read: boolean;
  state: 'moving' | 'delivered' | 'lost' | 'intercepted';
  passedBy: string[];
}

let noteCounter = 0;

/** Breadth-first route over the seat adjacency graph. */
function route(w: World, fromSeat: string, toSeat: string): string[] | null {
  const prev = new Map<string, string | null>([[fromSeat, null]]);
  const q = [fromSeat];
  while (q.length) {
    const cur = q.shift()!;
    if (cur === toSeat) break;
    for (const n of w.seatNeighbours(cur)) {
      if (prev.has(n)) continue;
      // Only route through seats with someone in them (empty seats break the chain).
      if (n !== toSeat && !w.allAgents().some((a) => a.sittingIn === n && a.present)) continue;
      prev.set(n, cur);
      q.push(n);
    }
  }
  if (!prev.has(toSeat)) return null;
  const out: string[] = [];
  for (let s: string | null = toSeat; s; s = prev.get(s) ?? null) out.push(s);
  return out.reverse();
}

export function sendNote(w: World, from: string, to: string, template: string): boolean {
  const fa = w.agent(from);
  const ta = w.agent(to);
  if (!fa?.sittingIn || !ta?.sittingIn) {
    if (from === 'player')
      w.emit({ type: 'hint', text: `${ta?.name ?? 'They'} isn't at a seat right now.` });
    return false;
  }
  const r = route(w, fa.sittingIn, ta.sittingIn);
  if (!r || r.length < 2) {
    if (from === 'player') w.emit({ type: 'hint', text: 'No chain of classmates reaches them.' });
    return false;
  }
  const item = w.addItem('note', fa.pos, 0.8, from);
  const n: NoteState = {
    id: `note-${++noteCounter}-${w.tick}`,
    itemId: item.id,
    from,
    to,
    template,
    carrier: from,
    route: r,
    hop: 0,
    hopT: 0,
    hopDur: 1.6 + w.rngSocial.next(),
    read: false,
    state: 'moving',
    passedBy: [],
  };
  w.notes.push(n);
  if (from === 'player') w.ps.passingNote = true;
  w.emit({ type: 'note-sent', who: from, target: to, kind: template });
  return true;
}

function finish(w: World, n: NoteState, state: NoteState['state']): void {
  n.state = state;
  if (n.carrier === 'player' || n.from === 'player')
    w.ps.passingNote = w.notes.some(
      (x) => x !== n && x.state === 'moving' && x.carrier === 'player',
    );
  const item = w.items.find((i) => i.id === n.itemId);
  if (!item) return;
  if (state === 'lost') {
    const c = w.agent(n.carrier);
    item.heldBy = null;
    item.pos = c ? { x: c.pos.x + 0.3, z: c.pos.z } : item.pos;
    item.y = 0.03;
  } else w.removeItem(n.itemId);
}

export function updateNotes(w: World): void {
  for (const n of w.notes) {
    if (n.state !== 'moving') continue;
    const carrier = w.agent(n.carrier);
    const item = w.items.find((i) => i.id === n.itemId);
    if (!carrier || !item) {
      finish(w, n, 'lost');
      continue;
    }
    item.heldBy = carrier.id;
    item.pos = { ...carrier.pos };
    // Carriers wait while the teacher is close or looking at them.
    const T = w.teacher;
    const near = T.present && Math.hypot(T.pos.x - carrier.pos.x, T.pos.z - carrier.pos.z) < 2.5;
    n.hopT += near ? TICK_DT * 0.25 : TICK_DT;
    if (n.hopT < n.hopDur) continue;
    const nextSeat = n.route[n.hop + 1];
    const next = nextSeat
      ? w.allAgents().find((a) => a.sittingIn === nextSeat && a.present)
      : undefined;
    if (!next) {
      finish(w, n, 'lost');
      w.emit({ type: 'note-lost', who: n.carrier, target: n.to });
      continue;
    }
    if (next.id === n.to) {
      deliver(w, n, next.id);
      continue;
    }
    if (next.id === 'player') {
      // Notes through the player are passed on automatically.
      hand(w, n, next.id);
      continue;
    }
    const s = w.student(next.id)!;
    const t = s.def.traits;
    const likeSender = w.relations.of(next.id, n.from);
    const tpl = NOTES.find((x) => x.id === n.template);
    // Nosy carriers read it first (costs time, sometimes a giggle).
    if (!n.read && w.rngSocial.next() < t.nosy * 0.6) {
      n.read = true;
      n.hopT = n.hopDur - 1.5;
      w.say(next.id, 'student', 'noteRead');
      if (n.from === 'player' && tpl?.affinity && tpl.affinity > 4)
        w.relations.change(next.id, 1, 'read your note and laughed', w);
      continue;
    }
    const snitchP =
      t.snitch *
      (likeSender < -10 ? 1.4 : 0.25) *
      (tpl?.severity ?? 0.3) *
      (w.teacher.present ? 1 : 0);
    if (w.rngSocial.next() < snitchP) {
      w.say(next.id, 'student', 'snitch', {
        teacher: w.profile.name,
        target: w.agent(n.from)?.name ?? 'someone',
      });
      interceptNote(w, n, 'handed to the teacher');
      if (n.from === 'player')
        w.relations.change(next.id, -8, 'handed your note to the teacher', w);
      continue;
    }
    const passP = 0.55 + likeSender / 150 + t.helpful * 0.35;
    if (w.rngSocial.next() > passP) {
      w.say(next.id, 'student', 'noteRefuse');
      finish(w, n, 'lost');
      w.emit({ type: 'note-lost', who: next.id, target: n.to });
      if (n.from === 'player') w.relations.change(next.id, -1, 'refused to pass your note', w);
      continue;
    }
    hand(w, n, next.id);
  }
  w.notes = w.notes.filter((n) => n.state === 'moving');
}

function hand(w: World, n: NoteState, to: string): void {
  n.passedBy.push(n.carrier);
  const prevCarrier = n.carrier;
  n.carrier = to;
  n.hop++;
  n.hopT = 0;
  n.hopDur = 1.8 + w.rngSocial.next() * 1.6;
  if (prevCarrier === 'player' || to === 'player')
    w.ps.passingNote =
      to === 'player' ||
      w.notes.some((x) => x !== n && x.state === 'moving' && x.carrier === 'player');
  w.emit({ type: 'note-hop', who: prevCarrier, target: to });
}

function deliver(w: World, n: NoteState, to: string): void {
  const tpl = NOTES.find((x) => x.id === n.template);
  finish(w, n, 'delivered');
  w.emit({ type: 'note-delivered', who: n.from, target: to, kind: n.template });
  if (n.from === 'player') {
    w.relations.change(to, tpl?.affinity ?? 3, `got your note: “${tpl?.text ?? '…'}”`, w);
    if (!w.stats.notesDelivered.includes(to)) w.stats.notesDelivered.push(to);
    for (const c of n.passedBy)
      if (c !== 'player' && w.student(c)) w.relations.change(c, 1, 'passed your note along', w);
    // A friendly recipient may answer.
    const s = w.student(to);
    if (s && w.rngSocial.next() < 0.35 + w.relations.toPlayer(to) / 200) {
      w.studentReplies.push({
        from: to,
        at: w.t + 6 + w.rngSocial.next() * 8,
        template: tpl?.answers ? 'answers' : w.rngSocial.pick(['joke', 'lunch', 'bored']),
      });
    }
  } else if (to === 'player') {
    const s = w.student(n.from);
    if (tpl?.answers && s) {
      // Answers from a classmate: the rest of your test quality leans toward their knowledge.
      const t = w.ps.test;
      t.quality = Math.max(t.quality, t.progress * s.knowledge * 0.95);
      const before = t.progress;
      t.progress = Math.min(1, before + 0.15);
      t.quality += (t.progress - before) * s.knowledge;
      w.stats.cheated = true;
    }
    w.emit({ type: 'note-received', who: n.from, kind: n.template, text: tpl?.text });
  } else {
    w.relations.changeBetween(to, n.from, 2);
  }
}

/** The teacher takes a note: the sender is identified (notes are signed) and punished. */
export function interceptNote(w: World, n: NoteState, how: string): void {
  finish(w, n, 'intercepted');
  const tpl = NOTES.find((x) => x.id === n.template);
  w.say('teacher', 'teacher', 'noteIntercept');
  w.emit({ type: 'note-intercepted', who: n.from, target: n.to, text: how });
  if (n.from === 'player') {
    w.stats.notesIntercepted++;
    const st = w.susp('player');
    st.s = Math.max(st.s, 1.05);
    st.lastEvidence = { kind: 'note', point: 'handR', zone: 'report', dist: 0 };
    st.lastEvidenceT = w.t;
    w.brain.pendingPunish.push({
      target: 'player',
      kind: 'note',
      severity: tpl?.severity ?? 0.5,
      summary: `Passing a note (“${tpl?.text ?? ''}”)`,
    });
  }
}

/** Fire queued replies from classmates. Called by the students update. */
export function updateReplies(w: World): void {
  const due = w.studentReplies.filter((r) => w.t >= r.at);
  if (!due.length) return;
  w.studentReplies = w.studentReplies.filter((r) => w.t < r.at);
  for (const r of due) sendNote(w, r.from, 'player', r.template);
}
