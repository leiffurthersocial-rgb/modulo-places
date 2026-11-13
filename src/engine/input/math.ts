// Pure helpers for input handling (no DOM) so they can be unit tested.

export const MOUSE_RAD_PER_PX = 0.0022;
export const TOUCH_RAD_PER_PX = 0.005;
export const WHEEL_RAD_PER_UNIT = 0.0025;
export const MAX_LOOK_SPIKE_PX = 300;
export const JOY_DEADZONE = 0.12;
export const JOY_SPRINT_THRESHOLD = 0.9;
export const TAP_MAX_MOVE_PX = 8;
export const TAP_MAX_MS = 300;

/** Browsers occasionally emit absurd movementX/Y spikes; drop them. */
export function clampSpike(v: number, max: number = MAX_LOOK_SPIKE_PX): number {
  if (!Number.isFinite(v) || Math.abs(v) > max) return 0;
  return v;
}

/** Digital keyboard axes -> move vector with diagonals normalised to unit length. */
export function keyboardMove(
  left: boolean,
  right: boolean,
  back: boolean,
  forward: boolean,
): { x: number; y: number } {
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const y = (forward ? 1 : 0) - (back ? 1 : 0);
  if (x !== 0 && y !== 0) {
    const inv = Math.SQRT1_2;
    return { x: x * inv, y: y * inv };
  }
  return { x, y };
}

export interface JoystickResult {
  /** x = right, y = forward (screen up), each -1..1. */
  x: number;
  y: number;
  sprint: boolean;
  /** Post-deadzone magnitude 0..1. */
  magnitude: number;
}

/**
 * Joystick displacement in screen px (dx right, dy down) -> analog move vector.
 * Deadzone is rescaled so output ramps smoothly from 0 at the deadzone edge to 1 at full radius.
 */
export function joystickVector(
  dx: number,
  dy: number,
  radius: number,
  deadzone: number = JOY_DEADZONE,
  sprintThreshold: number = JOY_SPRINT_THRESHOLD,
): JoystickResult {
  if (radius <= 0) return { x: 0, y: 0, sprint: false, magnitude: 0 };
  const len = Math.hypot(dx, dy);
  const raw = len / radius;
  const sprint = raw > sprintThreshold;
  if (raw < deadzone || len === 0) return { x: 0, y: 0, sprint: false, magnitude: 0 };
  const mag = Math.min(1, (raw - deadzone) / (1 - deadzone));
  return { x: (dx / len) * mag, y: (-dy / len) * mag, sprint, magnitude: mag };
}

/** Limit a knob offset to the joystick radius. */
export function clampToRadius(dx: number, dy: number, radius: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len <= radius || len === 0) return { x: dx, y: dy };
  const k = radius / len;
  return { x: dx * k, y: dy * k };
}

/** Pixel delta (screen space, y down) -> look radians (+x right, +y up). */
export function pixelsToLook(
  px: number,
  py: number,
  radPerPx: number,
  sensitivity: number,
  invertY: boolean,
): { x: number; y: number } {
  const s = radPerPx * sensitivity;
  return { x: px * s, y: -py * s * (invertY ? -1 : 1) };
}

export function isTap(distPx: number, durationMs: number): boolean {
  return distPx < TAP_MAX_MOVE_PX && durationMs < TAP_MAX_MS;
}

/** Client coords -> normalised device coords (-1..1, y up) within a rect. */
export function toNdc(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  const w = rect.width || 1;
  const h = rect.height || 1;
  return { x: ((clientX - rect.left) / w) * 2 - 1, y: -(((clientY - rect.top) / h) * 2 - 1) };
}
