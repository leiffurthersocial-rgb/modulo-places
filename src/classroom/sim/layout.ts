// Room layout data model + validation. Pure TS: shared by the sim (navigation, sightlines),
// the renderer and the tests. Layout JSON lives in src/classroom/data/layouts/.

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type WallId = 'front' | 'back' | 'left' | 'right';

export interface Opening {
  id: string;
  kind: 'door' | 'window';
  wall: WallId;
  /** Distance along the wall from its start corner (front-left for back/left walls, see wallFrame). */
  offset: number;
  width: number;
  height: number;
  sill?: number;
  /** Room id this opening connects to (hallway later); null = none yet. */
  leadsTo?: string | null;
}

export interface Fixture {
  id: string;
  kind: string;
  wall: WallId;
  /** [position along the wall from its start corner, height of the centre]. */
  center: Vec2;
  size: Vec2;
}

export interface Prop {
  id: string;
  kind: string;
  /** Floor position [x, z]. */
  pos: Vec2;
  rot: number;
  size?: Vec3;
  height?: number;
  on?: string;
}

export interface Table {
  id: string;
  pos: Vec2;
  rot: number;
  /** [length, height, depth]. */
  size: Vec3;
}

export interface Seat {
  id: string;
  table: string;
  pos: Vec2;
  /** Degrees around +y; 0 = looking toward -z (the board). */
  facing: number;
  /** Front "hot seat" used for seat-change penalties. */
  hot?: boolean;
}

export interface Column {
  id: string;
  center: Vec2;
  size: Vec2;
}

export interface RoomLayout {
  id: string;
  version: number;
  room: { id: string; size: Vec3; materials: Record<string, string> };
  openings: Opening[];
  columns: Column[];
  fixtures: Fixture[];
  props: Prop[];
  tables: Table[];
  seats: Seat[];
  spareChairs: { id: string; pos: Vec2; facing: number }[];
  zones?: { id: string; kind: string; min: Vec2; max: Vec2 }[];
  spots?: Record<string, Vec2>;
  playerSeat: string;
  teacherHome: Vec2;
}

/** Wall coordinate frame: start corner (x,z), unit direction along the wall, and wall length. */
export function wallFrame(
  wall: WallId,
  size: Vec3,
): { origin: Vec2; dir: Vec2; length: number; normal: Vec2 } {
  const [w, , d] = size;
  switch (wall) {
    case 'front':
      return { origin: [0, 0], dir: [1, 0], length: w, normal: [0, 1] };
    case 'back':
      return { origin: [0, d], dir: [1, 0], length: w, normal: [0, -1] };
    case 'left':
      return { origin: [0, 0], dir: [0, 1], length: d, normal: [1, 0] };
    case 'right':
      return { origin: [w, 0], dir: [0, 1], length: d, normal: [-1, 0] };
  }
}

/** Facing angle (degrees) → unit forward vector on the floor plane [x, z]. */
export function facingDir(deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  return [-Math.sin(r), -Math.cos(r)];
}

/** Returns a list of human-readable problems; empty = valid. */
export function validateLayout(l: RoomLayout): string[] {
  const errs: string[] = [];
  const [w, h, d] = l.room.size;
  if (!(w > 0 && h > 0 && d > 0)) errs.push('room.size must be positive');
  const ids = new Set<string>();
  const all = [
    ...l.openings,
    ...l.columns,
    ...l.fixtures,
    ...l.props,
    ...l.tables,
    ...l.seats,
    ...l.spareChairs,
  ];
  for (const o of all) {
    if (ids.has(o.id)) errs.push(`duplicate id "${o.id}"`);
    ids.add(o.id);
  }
  const inside = (p: Vec2, what: string) => {
    if (p[0] < 0 || p[0] > w || p[1] < 0 || p[1] > d) errs.push(`${what} is outside the room`);
  };
  for (const o of l.openings) {
    const f = wallFrame(o.wall, l.room.size);
    if (o.offset < 0 || o.offset + o.width > f.length) errs.push(`opening ${o.id} exceeds wall`);
    if ((o.sill ?? 0) + o.height > h) errs.push(`opening ${o.id} taller than room`);
  }
  for (const fx of l.fixtures) {
    const f = wallFrame(fx.wall, l.room.size);
    if (fx.center[0] - fx.size[0] / 2 < 0 || fx.center[0] + fx.size[0] / 2 > f.length)
      errs.push(`fixture ${fx.id} exceeds wall`);
  }
  const tableIds = new Set(l.tables.map((t) => t.id));
  for (const t of l.tables) inside(t.pos, `table ${t.id}`);
  for (const p of l.props) inside(p.pos, `prop ${p.id}`);
  for (const s of l.seats) {
    inside(s.pos, `seat ${s.id}`);
    if (!tableIds.has(s.table)) errs.push(`seat ${s.id} references unknown table ${s.table}`);
  }
  if (!l.seats.some((s) => s.id === l.playerSeat)) errs.push(`playerSeat ${l.playerSeat} unknown`);
  inside(l.teacherHome, 'teacherHome');
  return errs;
}
