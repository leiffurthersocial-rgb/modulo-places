// First-person controller. Uses its own KinematicCharacterController: update() computes the
// collision-corrected movement and calls setNextKinematicTranslation(); the CALLER must call
// world.step() after update() each frame for the body (and thus the collider) to move.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { SettingsStore } from '../core/settings';
import type { InputFrame, Vec3 } from '../types';
import {
  approach,
  clamp,
  clampToBoundary,
  BOB_STRIDE,
  headBobOffset,
  shapeBoundaryVelocity,
} from './movement';

type Rapier = typeof RAPIER;

export interface PlayerOptions {
  spawn: Vec3;
  /** Radians; 0 faces -Z. */
  yaw: number;
  walkRadius: number;
  settings: SettingsStore;
  groundHeight: (x: number, z: number) => number;
}

const RADIUS = 0.3;
const STAND_H = 1.8;
const CROUCH_H = 1.2;
const EYE_STAND = 1.65;
const EYE_CROUCH = 1.05;
const SPEEDS = { walk: 1.7, sprint: 3.8, slow: 0.8, crouch: 0.9 };
const ACCEL = 8;
const DECEL = 10;
const EYE_RATE = 6;
const GRAVITY = 9.81;
const PITCH_MAX = 1.48;

export class PlayerController {
  readonly feet = new THREE.Vector3();
  yaw: number;
  pitch = 0;
  crouching = false;
  speed = 0;

  private readonly R: Rapier;
  private readonly world: RAPIER.World;
  private readonly opts: PlayerOptions;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  private height = STAND_H;
  private eye = EYE_STAND;
  private vx = 0;
  private vz = 0;
  private vy = 0;
  private grounded = false;
  private bobPhase = 0;
  private landDip = 0;

  constructor(R: Rapier, world: RAPIER.World, opts: PlayerOptions) {
    this.R = R;
    this.world = world;
    this.opts = opts;
    this.yaw = opts.yaw;
    this.feet.set(opts.spawn[0], opts.spawn[1], opts.spawn[2]);
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(
        this.feet.x,
        this.feet.y + STAND_H / 2,
        this.feet.z,
      ),
    );
    this.collider = world.createCollider(
      R.ColliderDesc.capsule((STAND_H - 2 * RADIUS) / 2, RADIUS),
      this.body,
    );
    const c = world.createCharacterController(0.02);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.enableAutostep(0.35, 0.2, true);
    c.enableSnapToGround(0.4);
    c.setMaxSlopeClimbAngle((42 * Math.PI) / 180);
    c.setMinSlopeSlideAngle((50 * Math.PI) / 180);
    c.setSlideEnabled(true);
    this.controller = c;
  }

  /** Teleport (also resets velocity). Applies immediately, no world.step() needed. */
  setPose(feet: THREE.Vector3, yaw: number, pitch: number): void {
    this.feet.copy(feet);
    this.yaw = yaw;
    this.pitch = clamp(pitch, -PITCH_MAX, PITCH_MAX);
    this.vx = this.vz = this.vy = 0;
    this.speed = 0;
    this.syncBody(true);
  }

  /**
   * Advance one frame. Queues the next kinematic translation; caller must call world.step() after.
   */
  update(dt: number, input: InputFrame, camera: THREE.PerspectiveCamera): void {
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    const settings = this.opts.settings.get();

    // Look. +look.x = turn right, which is negative yaw in three.js.
    this.yaw -= input.look.x;
    this.pitch = clamp(this.pitch + input.look.y, -PITCH_MAX, PITCH_MAX);

    // Crouch (stand only with headroom).
    if (input.crouch && !this.crouching) this.setCrouch(true);
    else if (!input.crouch && this.crouching && this.hasHeadroom()) this.setCrouch(false);
    this.eye = approach(this.eye, this.crouching ? EYE_CROUCH : EYE_STAND, EYE_RATE, dt);

    // Desired horizontal velocity.
    let mx = input.move.x;
    let my = input.move.y;
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    const top = this.crouching
      ? SPEEDS.crouch
      : input.slow
        ? SPEEDS.slow
        : input.sprint && my > 0
          ? SPEEDS.sprint
          : SPEEDS.walk;
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    // forward = (-s, -c), right = (c, -s)
    let tx = (mx * c - my * s) * top;
    let tz = (-mx * s - my * c) * top;
    [tx, tz] = shapeBoundaryVelocity(this.feet.x, this.feet.z, tx, tz, this.opts.walkRadius);
    const accelerating = Math.hypot(tx, tz) > Math.hypot(this.vx, this.vz);
    const rate = accelerating ? ACCEL : DECEL;
    this.vx = approach(this.vx, tx, rate, dt);
    this.vz = approach(this.vz, tz, rate, dt);

    // Gravity.
    if (this.grounded) this.vy = 0;
    else this.vy -= GRAVITY * dt;

    // Collision-corrected movement.
    const before = this.vy;
    this.controller.computeColliderMovement(
      this.collider,
      { x: this.vx * dt, y: this.vy * dt, z: this.vz * dt },
      undefined,
      undefined,
      (col) => col.handle !== this.collider.handle,
    );
    const m = this.controller.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && !wasGrounded && before < -3) this.landDip = Math.min(0.08, -before * 0.01);
    this.feet.x += m.x;
    this.feet.y += m.y;
    this.feet.z += m.z;

    // Hard boundary clamp.
    const [cx, cz] = clampToBoundary(this.feet.x, this.feet.z, this.opts.walkRadius);
    this.feet.x = cx;
    this.feet.z = cz;

    // Fall-through safety.
    const gh = this.opts.groundHeight(this.feet.x, this.feet.z);
    if (this.feet.y < gh - 2) {
      this.feet.y = gh + 0.1;
      this.vy = 0;
      this.grounded = false;
      this.syncBody(true);
    } else {
      this.body.setNextKinematicTranslation({
        x: this.feet.x,
        y: this.feet.y + this.height / 2,
        z: this.feet.z,
      });
    }

    // Measured horizontal speed (after collisions) for bob/footsteps.
    this.speed = dt > 0 ? Math.hypot(m.x, m.z) / dt : 0;
    if (this.grounded) this.bobPhase += (Math.hypot(m.x, m.z) / BOB_STRIDE) * Math.PI * 2;
    this.landDip = approach(this.landDip, 0, 8, dt);

    // Camera.
    let bx = 0;
    let by = 0;
    if (settings.headBob && !settings.reduceMotion) {
      const o = headBobOffset(this.bobPhase, this.grounded ? this.speed : 0);
      bx = o.x;
      by = o.y;
    }
    const dip = settings.reduceMotion ? 0 : this.landDip;
    camera.position.set(
      this.feet.x + bx * Math.cos(this.yaw),
      this.feet.y + this.eye + by - dip,
      this.feet.z - bx * Math.sin(this.yaw),
    );
    camera.rotation.order = 'YXZ';
    camera.rotation.set(this.pitch, this.yaw, 0);
  }

  dispose(): void {
    this.world.removeCharacterController(this.controller);
    this.world.removeCollider(this.collider, false);
    this.world.removeRigidBody(this.body);
  }

  private syncBody(immediate: boolean): void {
    const t = { x: this.feet.x, y: this.feet.y + this.height / 2, z: this.feet.z };
    if (immediate) this.body.setTranslation(t, true);
    this.body.setNextKinematicTranslation(t);
  }

  private setCrouch(on: boolean): void {
    this.crouching = on;
    this.height = on ? CROUCH_H : STAND_H;
    this.collider.setHalfHeight((this.height - 2 * RADIUS) / 2);
    this.syncBody(true); // keep feet where they were
  }

  /** True if a standing capsule fits above the crouched one. */
  private hasHeadroom(): boolean {
    const origin = { x: this.feet.x, y: this.feet.y + CROUCH_H - RADIUS, z: this.feet.z };
    const dist = STAND_H - CROUCH_H + RADIUS + 0.02;
    const ray = new this.R.Ray(origin, { x: 0, y: 1, z: 0 });
    const hit = this.world.castRay(ray, dist, true, undefined, undefined, this.collider, this.body);
    return hit === null;
  }
}
