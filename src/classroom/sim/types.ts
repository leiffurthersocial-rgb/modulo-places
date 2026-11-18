// Shared sim types. Pure TS.
import type { V2 } from './geom';

export type Stance = 'stand' | 'crouch' | 'sit';
export type DeviceKind = 'phone' | 'laptop';
export type DeviceMode = 'off' | 'game' | 'video' | 'decoy';
export type AgentKind = 'teacher' | 'student' | 'player';

export interface DeviceState {
  kind: DeviceKind | null;
  mode: DeviceMode;
  content: 'game' | 'video';
  brightness: number;
  earbud: boolean;
  /** Seconds left in the quick-switch fumble window. */
  fumble: number;
  /** Times of recent switches (for the "twitchy switching" rule). */
  switches: number[];
}

export interface Agent {
  id: string;
  name: string;
  kind: AgentKind;
  color: string;
  pos: V2;
  /** Body yaw (radians, 0 = looking toward -z). */
  yaw: number;
  /** Head yaw (what vision uses). */
  headYaw: number;
  /** Head pitch (radians, negative = looking down). Player only (from input). */
  pitch: number;
  stance: Stance;
  /** Assigned seat id (may change with seat-change penalty). */
  seat: string | null;
  /** Seat currently sat in (null = not seated). */
  sittingIn: string | null;
  path: V2[] | null;
  pathVersion: number;
  speed: number;
  moving: boolean;
  /** Item id held in hand. */
  holding: string | null;
  present: boolean;
  /** Distance walked since the last footstep event. */
  stepAcc?: number;
}

export type EvidenceKind =
  | 'device'
  | 'device-glow'
  | 'fumble'
  | 'twitchy'
  | 'out-of-seat'
  | 'wrong-seat'
  | 'note'
  | 'peek'
  | 'cheatsheet'
  | 'prank'
  | 'throw'
  | 'talking'
  | 'sprinting'
  | 'reported'
  | 'absorbed';

export type SamplePoint = 'head' | 'torso' | 'handL' | 'handR' | 'device' | 'lap';

export interface Evidence {
  kind: EvidenceKind;
  weight: number;
  point: SamplePoint;
  /** For laptop screens: the screen faces this yaw; content only visible from behind it. */
  screenYaw?: number;
}

export interface NoiseEvent {
  pos: V2;
  radius: number;
  kind: string;
  /** Agent that made it, if attributable. */
  source: string | null;
}

export type ItemKind = 'paper-ball' | 'paper-plane' | 'note' | 'marker' | 'sticker' | 'cheatsheet';

export interface Item {
  id: string;
  kind: ItemKind;
  /** Floor/world position when not held. */
  pos: V2;
  y: number;
  heldBy: string | null;
  /** In-flight animation (render reads it): from → to over [t0, t1]. */
  flight?: {
    from: V2;
    to: V2;
    y0: number;
    y1: number;
    t0: number;
    t1: number;
    arc: number;
    done?: boolean;
  };
  /** Lies on a table (y ≈ 0.75) rather than the floor. */
  onTable?: boolean;
}

export interface SimEvent {
  type: string;
  t: number;
  who?: string;
  target?: string;
  text?: string;
  pos?: V2;
  radius?: number;
  kind?: string;
  value?: number;
}

export interface DetectionEntry {
  t: number;
  target: string;
  evidence: EvidenceKind;
  point: SamplePoint;
  distance: number;
  zone: 'inner' | 'mid' | 'peripheral' | 'near' | 'heard' | 'report';
  exposure: number;
  teacherState: string;
}

/** Player intent for one tick. One-shot fields are consumed by the tick that receives them. */
export interface PlayerCommand {
  /** World-space desired move direction, length 0..1. */
  move: V2;
  sprint: boolean;
  crouch: boolean;
  yaw: number;
  pitch: number;
  lean: number;
  work: boolean;
  peek: boolean;
  cheat: boolean;
  interact?: { target: string; verb: string };
  device?:
    'phone' | 'laptop' | 'switch' | 'earbud' | 'bright-up' | 'bright-down' | 'content' | 'close';
  throwPower?: number;
  make?: 'paper-ball' | 'paper-plane';
  note?: { template: string; to: string };
  raiseHand?: boolean;
  /** Mini-game score reported by the client (sim keeps the best). */
  gameScore?: number;
}

export const idleCommand = (yaw = 0, pitch = 0): PlayerCommand => ({
  move: { x: 0, z: 0 },
  sprint: false,
  crouch: false,
  yaw,
  pitch,
  lean: 0,
  work: false,
  peek: false,
  cheat: false,
});
