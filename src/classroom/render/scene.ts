// Renders a World: greybox room + capsule characters (with readable head/gaze) + items + room
// object states + lighting moods + debug gizmos. Reads sim state only; never mutates it.
import * as THREE from 'three';
import { TICK_DT } from '../sim/clock';
import { yawDir } from '../sim/geom';
import { EYE_HEIGHT } from '../sim/perception';
import type { Agent } from '../sim/types';
import type { World } from '../sim/world';
import { buildGreybox, type GreyboxRoom } from './greybox';
import type { QualitySettings } from '../quality';

interface AgentView {
  root: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Group;
  label: THREE.Sprite;
  hand: THREE.Mesh;
  phone: THREE.Mesh;
  susBar: THREE.Mesh;
  prev: { x: number; z: number };
  cur: { x: number; z: number };
}

const UP = new THREE.Vector3(0, 1, 0);

function labelSprite(text: string, sub?: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = sub ? 80 : 56;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(15,17,20,0.55)';
  g.beginPath();
  g.roundRect(4, 4, c.width - 8, c.height - 8, 14);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '600 28px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(text, c.width / 2, 38);
  if (sub) {
    g.font = '20px system-ui, sans-serif';
    g.fillStyle = '#c9ced6';
    g.fillText(sub, c.width / 2, 66);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }),
  );
  s.scale.set(0.42, (0.42 * c.height) / c.width, 1);
  s.renderOrder = 10;
  return s;
}

export class RoomView {
  readonly scene = new THREE.Scene();
  readonly room: GreyboxRoom;
  private agents = new Map<string, AgentView>();
  private items = new Map<string, THREE.Mesh>();
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private fill: THREE.PointLight;
  private glow: THREE.PointLight;
  private screen: THREE.Mesh;
  private screenCanvas: HTMLCanvasElement;
  private screenTex: THREE.CanvasTexture;
  private beam: THREE.Mesh;
  private sticker: THREE.Mesh;
  private plane: THREE.Mesh;
  private marker: THREE.Mesh;
  private sash: THREE.Group;
  private gizmos = new THREE.Group();
  private visionFans: THREE.Mesh[] = [];
  private rings: { mesh: THREE.Mesh; t0: number; r: number }[] = [];
  private pathLine: THREE.Line;
  private posterBase: THREE.Vector3[] = [];
  debug = false;
  private worldRef: World | null = null;

  constructor(world: World) {
    const layout = world.layout;
    this.scene.background = new THREE.Color(0x1a1d21);
    this.room = buildGreybox(layout);
    this.scene.add(this.room.root);
    const [W, H, D] = layout.room.size;

    this.hemi = new THREE.HemisphereLight(0xe3ebf2, 0x3a2e24, 1.15);
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
    this.sun.position.set(W + 6, 5.5, D * 0.35);
    this.sun.target.position.set(W * 0.4, 0, D * 0.5);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -6;
    sc.right = 6;
    sc.top = 6;
    sc.bottom = -6;
    sc.near = 1;
    sc.far = 20;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.fill = new THREE.PointLight(0xfff6ea, 7, 13, 2);
    this.fill.position.set(W / 2, H - 0.3, D / 2);
    this.glow = new THREE.PointLight(0x9ec4ff, 0, 1.6, 2);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.fill, this.glow);

    // Pull-down projector screen over the board (visible in dim lessons).
    this.screenCanvas = document.createElement('canvas');
    this.screenCanvas.width = 512;
    this.screenCanvas.height = 288;
    this.screenTex = new THREE.CanvasTexture(this.screenCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screen = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 1.8),
      new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }),
    );
    this.screen.position.set(4.5, 1.55, 0.08);
    this.screen.visible = false;
    const beamGeo = new THREE.ConeGeometry(1.0, 3.1, 4, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.rotateZ(Math.PI / 4);
    this.beam = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({
        color: 0xbfd6ff,
        transparent: true,
        opacity: 0.05,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    this.beam.position.set(4.5, 2.0, 1.6);
    this.beam.lookAt(4.5, 1.5, 0.1);
    this.beam.rotateX(Math.PI);
    this.beam.visible = false;
    this.scene.add(this.screen, this.beam);

    // Small prank props.
    this.sticker = new THREE.Mesh(
      new THREE.CircleGeometry(0.07, 24),
      new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.6 }),
    );
    this.sticker.position.set(5.6, 1.6, 0.05);
    this.plane = new THREE.Mesh(
      new THREE.ConeGeometry(0.06, 0.22, 3),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    this.plane.rotation.set(Math.PI / 2, 0, 0.6);
    this.plane.position.set(1.3, 1.1, 1.05);
    this.marker = new THREE.Mesh(
      new THREE.CylinderGeometry(0.01, 0.01, 0.13, 8),
      new THREE.MeshStandardMaterial({ color: 0x1f5fbf }),
    );
    this.marker.rotation.z = Math.PI / 2;
    this.marker.position.set(4.5, 0.86, 0.08);
    this.scene.add(this.sticker, this.plane, this.marker);
    // Window sash (window-a) that tilts open.
    const win = layout.openings.find((o) => o.id === 'window-a');
    this.sash = new THREE.Group();
    if (win) {
      const sash = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, win.height * 0.5, win.width * 0.5),
        new THREE.MeshStandardMaterial({
          color: 0xdfe9f2,
          transparent: true,
          opacity: 0.35,
          roughness: 0.1,
        }),
      );
      sash.position.y = win.height * 0.25;
      this.sash.add(sash);
      this.sash.position.set(
        W - 0.02,
        (win.sill ?? 0.9) + win.height * 0.5,
        win.offset + win.width * 0.3,
      );
      this.scene.add(this.sash);
    }
    for (let i = 1; i <= 4; i++) {
      const p = this.room.root.getObjectByName(`poster-${i}`);
      this.posterBase.push(p ? p.position.clone() : new THREE.Vector3());
    }

    for (const a of world.allAgents()) {
      if (a.kind === 'player') continue;
      this.agents.set(
        a.id,
        this.makeAgent(a, a.kind === 'teacher' ? world.profile.label : undefined),
      );
    }

    // Debug gizmos
    this.gizmos.visible = false;
    const fanMat = (c: number, o: number) =>
      new THREE.MeshBasicMaterial({
        color: c,
        transparent: true,
        opacity: o,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    const v = world.profile.vision;
    const fan = (r: number, deg: number, mat: THREE.Material) => {
      const g = new THREE.CircleGeometry(
        r,
        48,
        Math.PI / 2 - (deg * Math.PI) / 360,
        (deg * Math.PI) / 180,
      );
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, mat);
      m.position.y = 0.02;
      m.renderOrder = 5;
      return m;
    };
    this.visionFans = [
      fan(v.periphRange, v.periphAngle, fanMat(0x4fa3ff, 0.1)),
      fan(v.midRange, v.midAngle, fanMat(0xffc34f, 0.12)),
      fan(v.innerRange, v.innerAngle, fanMat(0xff5a4f, 0.16)),
    ];
    this.gizmos.add(...this.visionFans);
    this.pathLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x7cff7c }),
    );
    this.gizmos.add(this.pathLine);
    this.scene.add(this.gizmos);
    this.worldRef = world;
  }

  private makeAgent(a: Agent, sub?: string): AgentView {
    const root = new THREE.Group();
    const teacher = a.kind === 'teacher';
    const bodyMat = new THREE.MeshStandardMaterial({
      color: teacher ? 0x39424f : a.color,
      roughness: 0.8,
    });
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(teacher ? 0.21 : 0.19, 1, 6, 12),
      bodyMat,
    );
    body.castShadow = true;
    const head = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({
      color: teacher ? 0xd9b08c : 0xe0bb98,
      roughness: 0.7,
    });
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 14), skin);
    skull.castShadow = true;
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.017, 8, 6), eyeMat);
    const eyeR = eyeL.clone();
    eyeL.position.set(-0.04, 0.02, -0.1);
    eyeR.position.set(0.04, 0.02, -0.1);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.035, 0.04), skin);
    nose.position.set(0, -0.01, -0.12);
    head.add(skull, eyeL, eyeR, nose);
    if (teacher) {
      // Glasses band: makes the gaze direction readable from across the room.
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(0.15, 0.03, 0.02),
        new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.6, roughness: 0.3 }),
      );
      band.position.set(0, 0.02, -0.112);
      head.add(band);
    }
    const label = labelSprite(a.name, sub);
    const hand = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.01, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    hand.visible = false;
    const phone = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.01, 0.14),
      new THREE.MeshStandardMaterial({
        color: 0x111111,
        emissive: 0x6fa8ff,
        emissiveIntensity: 1.2,
      }),
    );
    phone.visible = false;
    const susBar = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.04),
      new THREE.MeshBasicMaterial({ color: 0xff4040, depthTest: false }),
    );
    susBar.renderOrder = 11;
    susBar.visible = false;
    root.add(body, head, label, hand, phone, susBar);
    this.scene.add(root);
    return { root, body, head, label, hand, phone, susBar, prev: { ...a.pos }, cur: { ...a.pos } };
  }

  /** Call once per sim tick (before sync) so positions can be interpolated. */
  onTick(world: World): void {
    for (const a of world.allAgents()) {
      const v = this.agents.get(a.id);
      if (!v) continue;
      v.prev = v.cur;
      v.cur = { ...a.pos };
    }
  }

  applyQuality(q: QualitySettings): void {
    this.sun.castShadow = q.shadows;
    if (q.shadows) {
      this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.glow.visible = q.glowLights > 0;
  }

  sync(w: World, alpha: number, camPos: THREE.Vector3): void {
    const renderT = w.t + alpha * TICK_DT;
    const o = w.objects;
    const dim = o.lightsDim;
    const k = dim ? 0.22 : 1;
    this.hemi.intensity = 1.15 * (dim ? 0.3 : 1);
    this.sun.intensity = 2.3 * (dim ? 0.25 : 1);
    this.fill.intensity = 7 * k;
    this.screen.visible = dim || o.projectorInput === 2;
    this.beam.visible = dim;
    if (this.screen.visible) this.drawScreen(w, renderT);

    // Agents
    for (const a of w.allAgents()) {
      const v = this.agents.get(a.id);
      if (!v) continue;
      v.root.visible = a.present;
      if (!a.present) continue;
      const x = v.prev.x + (v.cur.x - v.prev.x) * alpha;
      const z = v.prev.z + (v.cur.z - v.prev.z) * alpha;
      v.root.position.set(x, 0, z);
      const eye = EYE_HEIGHT[a.stance];
      const sit = a.stance === 'sit';
      // Body capsule from hips/feet to shoulders.
      const bottom = sit ? 0.42 : 0.05;
      const top = eye - 0.17;
      // Capsule geometry is 1 m of cylinder + 2r of caps; scale it to span bottom..top.
      const r = a.kind === 'teacher' ? 0.21 : 0.19;
      v.body.scale.set(1, Math.max(0.2, (top - bottom) / (1 + 2 * r)), 1);
      v.body.position.y = (bottom + top) / 2;
      v.body.rotation.y = a.yaw;
      v.head.position.y = eye;
      v.head.rotation.y = a.headYaw;
      const bob = a.moving ? Math.abs(Math.sin(renderT * 9)) * 0.02 : 0;
      v.head.position.y += bob;
      v.label.position.y = eye + 0.3;
      v.label.visible = camPos.distanceTo(v.root.position) < 7 || a.kind === 'teacher';
      // Held note / NPC phone
      const f = yawDir(a.yaw);
      const holdingNote = w.notes.some((n) => n.state === 'moving' && n.carrier === a.id);
      v.hand.visible = holdingNote;
      v.hand.position.set(f.x * 0.28, sit ? 0.78 : 1.0, f.z * 0.28);
      const st = w.student(a.id);
      v.phone.visible = st?.action === 'phone';
      v.phone.position.set(f.x * 0.2, sit ? 0.62 : 1.1, f.z * 0.2);
      v.phone.rotation.y = a.yaw;
      // Debug suspicion bar
      const s = w.suspicion.get(a.id)?.s ?? 0;
      v.susBar.visible = this.debug && s > 0.01;
      v.susBar.position.y = eye + 0.48;
      v.susBar.scale.x = Math.min(1.6, s);
      v.susBar.quaternion.copy(
        new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(camPos.x - x, camPos.z - z)),
      );
    }

    // Items (paper balls, planes, notes in transit)
    const seen = new Set<string>();
    for (const it of w.items) {
      if (it.heldBy === 'player') continue;
      if (it.kind === 'note' && it.heldBy) continue; // drawn as the carrier's hand
      seen.add(it.id);
      let m = this.items.get(it.id);
      if (!m) {
        m =
          it.kind === 'paper-plane'
            ? new THREE.Mesh(
                new THREE.ConeGeometry(0.05, 0.2, 3),
                new THREE.MeshStandardMaterial({ color: 0xffffff }),
              )
            : new THREE.Mesh(
                new THREE.IcosahedronGeometry(it.kind === 'note' ? 0.03 : 0.045, 1),
                new THREE.MeshStandardMaterial({ color: 0xf4f4ee, roughness: 0.9 }),
              );
        m.castShadow = true;
        this.items.set(it.id, m);
        this.scene.add(m);
      }
      const fl = it.flight;
      if (fl && renderT < fl.t1) {
        const u = Math.max(0, (renderT - fl.t0) / (fl.t1 - fl.t0));
        m.position.set(
          fl.from.x + (fl.to.x - fl.from.x) * u,
          fl.y0 + (fl.y1 - fl.y0) * u + Math.sin(u * Math.PI) * fl.arc,
          fl.from.z + (fl.to.z - fl.from.z) * u,
        );
        m.rotation.set(u * 9, u * 5, 0);
      } else {
        m.position.set(it.pos.x, it.y + 0.03, it.pos.z);
      }
    }
    for (const [id, m] of this.items) {
      if (!seen.has(id)) {
        this.scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
        this.items.delete(id);
      }
    }

    // Room objects
    this.sticker.visible = o.sticker;
    this.plane.visible = o.planeOnDesk;
    this.marker.visible = !o.markerHidden;
    this.sash.rotation.z = o.windowOpen ? 0.18 : 0;
    const door = this.room.root.getObjectByName('door-main');
    if (door) {
      const leaf = door.getObjectByName('leaf');
      if (leaf)
        leaf.rotation.y = THREE.MathUtils.lerp(leaf.rotation.y, o.doorOpen > 0 ? -1.2 : 0, 0.15);
    }
    for (let i = 0; i < 4; i++) {
      const p = this.room.root.getObjectByName(`poster-${i + 1}`);
      const target = this.posterBase[o.posterOrder[i] ?? i];
      if (p && target) p.position.x = target.x;
    }
    const cam = this.room.root.getObjectByName('doccam-head');
    if (cam) cam.rotation.z = o.docCamFlipped ? Math.PI : 0;
    const clock = this.room.root.getObjectByName('clock');
    if (clock) {
      const mins = 8 * 60 + w.clockMinutes();
      const hh = clock.getObjectByName('hand-h');
      const mh = clock.getObjectByName('hand-m');
      if (hh) hh.rotation.z = -((mins / 720) * Math.PI * 2);
      if (mh) mh.rotation.z = -(((mins % 60) / 60) * Math.PI * 2);
    }

    this.updateGizmos(w, renderT);
  }

  /** Screen glow from the player's device (position in world space). */
  setGlow(pos: THREE.Vector3 | null, color: number, intensity: number): void {
    if (!pos || intensity <= 0) {
      this.glow.intensity = 0;
      return;
    }
    this.glow.position.copy(pos);
    this.glow.color.setHex(color);
    this.glow.intensity = intensity;
  }

  addNoiseRing(x: number, z: number, radius: number, t: number): void {
    if (!this.debug) return;
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.96, 1, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: 0x66ffcc,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    );
    m.position.set(x, 0.03, z);
    this.gizmos.add(m);
    this.rings.push({ mesh: m, t0: t, r: radius });
  }

  private updateGizmos(w: World, t: number): void {
    this.gizmos.visible = this.debug;
    if (!this.debug) return;
    const T = w.teacher;
    for (const f of this.visionFans) {
      f.visible = T.present;
      f.position.set(T.pos.x, 0.02, T.pos.z);
      f.rotation.y = T.headYaw;
    }
    const pts = [
      new THREE.Vector3(T.pos.x, 0.05, T.pos.z),
      ...(T.path ?? []).map((p) => new THREE.Vector3(p.x, 0.05, p.z)),
    ];
    this.pathLine.geometry.setFromPoints(pts);
    this.rings = this.rings.filter((r) => {
      const u = (t - r.t0) / 0.6;
      if (u >= 1) {
        this.gizmos.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        return false;
      }
      r.mesh.scale.setScalar(Math.max(0.01, r.r * Math.min(1, u * 1.5)));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - u);
      return true;
    });
  }

  private drawScreen(w: World, t: number): void {
    const c = this.screenCanvas;
    const g = c.getContext('2d')!;
    const o = w.objects;
    if (o.projectorInput === 2) {
      g.fillStyle = '#1b3fae';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fff';
      g.font = '600 34px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('NO SIGNAL · HDMI 2', c.width / 2, c.height / 2);
    } else if (w.lessonType === 'film') {
      // Abstract "film": slow gradient scenes (placeholder, no copyrighted content).
      const h = (t * 8) % 360;
      const grd = g.createLinearGradient(0, 0, c.width, c.height);
      grd.addColorStop(0, `hsl(${h},45%,35%)`);
      grd.addColorStop(1, `hsl(${(h + 60) % 360},50%,20%)`);
      g.fillStyle = grd;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      for (let i = 0; i < 6; i++)
        g.fillRect(((t * 30 + i * 97) % (c.width + 80)) - 80, 60 + i * 30, 80, 8);
    } else {
      g.fillStyle = '#f3f4f6';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#1f2937';
      g.font = '600 28px system-ui, sans-serif';
      g.textAlign = 'left';
      const slide = Math.floor(t / 20) % 4;
      g.fillText(['The water cycle', 'Evaporation', 'Condensation', 'Questions?'][slide]!, 30, 50);
      g.font = '20px system-ui, sans-serif';
      for (let i = 0; i < 4; i++)
        g.fillText(`• Point ${slide + 1}.${i + 1}: something very important`, 40, 100 + i * 36);
    }
    if (o.docCamFlipped && w.lessonType !== 'film') {
      g.save();
      g.translate(c.width, c.height);
      g.rotate(Math.PI);
      g.drawImage(c, 0, 0);
      g.restore();
    }
    this.screenTex.needsUpdate = true;
  }

  dispose(): void {
    this.room.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mm = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mm)) mm.forEach((x) => x.dispose());
      else if (mm) {
        const map = (mm as THREE.MeshBasicMaterial).map;
        map?.dispose();
        mm.dispose();
      }
    });
    this.screenTex.dispose();
    this.worldRef = null;
  }
}
