// The player's device: a phone held low in the first-person view, or a laptop on the table.
// Screens are CanvasTextures: "Block Drop" arcade game, a placeholder video, or the decoy notes.
import * as THREE from 'three';

export class BlockDrop {
  score = 0;
  best = 0;
  private x = 0.5;
  private blocks: { x: number; y: number; v: number; good: boolean }[] = [];
  private t = 0;
  private spawn = 0;
  lives = 3;
  private seed = 12345;

  private rnd(): number {
    this.seed = (Math.imul(this.seed ^ (this.seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return this.seed / 4294967296;
  }

  reset(): void {
    this.score = 0;
    this.lives = 3;
    this.blocks = [];
  }

  update(dt: number, dir: number): void {
    this.t += dt;
    this.x = Math.max(0.08, Math.min(0.92, this.x + dir * dt * 0.9));
    this.spawn -= dt;
    if (this.spawn <= 0) {
      this.spawn = Math.max(0.35, 0.9 - this.score / 600);
      this.blocks.push({
        x: 0.08 + this.rnd() * 0.84,
        y: -0.05,
        v: 0.25 + this.rnd() * 0.2 + this.score / 2000,
        good: this.rnd() > 0.25,
      });
    }
    for (const b of this.blocks) b.y += b.v * dt;
    this.blocks = this.blocks.filter((b) => {
      if (b.y > 0.86 && b.y < 0.94 && Math.abs(b.x - this.x) < 0.11) {
        if (b.good) this.score += 10;
        else this.lives--;
        return false;
      }
      return b.y < 1.05;
    });
    if (this.lives <= 0) {
      this.best = Math.max(this.best, this.score);
      this.reset();
    }
    this.best = Math.max(this.best, this.score);
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number): void {
    g.fillStyle = '#0d1630';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1b2a55';
    for (let i = 0; i < 12; i++) g.fillRect(0, ((i * h) / 12 + this.t * 40) % h, w, 2);
    for (const b of this.blocks) {
      g.fillStyle = b.good ? '#5ce1a6' : '#ff5a6a';
      g.fillRect(b.x * w - w * 0.05, b.y * h, w * 0.1, w * 0.1);
    }
    g.fillStyle = '#ffd23f';
    g.fillRect(this.x * w - w * 0.11, h * 0.9, w * 0.22, h * 0.025);
    g.fillStyle = '#fff';
    g.font = `600 ${Math.round(w * 0.075)}px system-ui, sans-serif`;
    g.textAlign = 'left';
    g.fillText(`BLOCK DROP  ${this.score}`, w * 0.05, h * 0.07);
    g.textAlign = 'right';
    g.fillText('♥'.repeat(Math.max(0, this.lives)), w * 0.95, h * 0.07);
  }
}

export type ScreenMode = 'game' | 'video' | 'decoy';

export class DeviceView {
  readonly phone: THREE.Group;
  readonly laptop: THREE.Group;
  private canvas: HTMLCanvasElement;
  private tex: THREE.CanvasTexture;
  private lcanvas: HTMLCanvasElement;
  private ltex: THREE.CanvasTexture;
  readonly game = new BlockDrop();
  private videoT = 0;
  /** Average screen colour (for the glow light). */
  glowColor = 0x8fb4ff;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 240;
    this.canvas.height = 420;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.phone = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.075, 0.15, 0.008),
      new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.4, roughness: 0.4 }),
    );
    const scr = new THREE.Mesh(
      new THREE.PlaneGeometry(0.068, 0.138),
      new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }),
    );
    scr.position.z = 0.0045;
    this.phone.add(body, scr);
    this.phone.visible = false;

    this.lcanvas = document.createElement('canvas');
    this.lcanvas.width = 480;
    this.lcanvas.height = 300;
    this.ltex = new THREE.CanvasTexture(this.lcanvas);
    this.ltex.colorSpace = THREE.SRGBColorSpace;
    this.laptop = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.016, 0.23),
      new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.6, roughness: 0.35 }),
    );
    const lid = new THREE.Group();
    const lidBox = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.22, 0.01),
      new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.6, roughness: 0.35 }),
    );
    lidBox.position.y = 0.11;
    const lscr = new THREE.Mesh(
      new THREE.PlaneGeometry(0.31, 0.19),
      new THREE.MeshBasicMaterial({ map: this.ltex, toneMapped: false }),
    );
    lscr.position.set(0, 0.11, 0.0055);
    lid.add(lidBox, lscr);
    lid.position.z = -0.11;
    lid.rotation.x = -0.25;
    this.laptop.add(base, lid);
    this.laptop.visible = false;
  }

  update(
    dt: number,
    mode: ScreenMode,
    gameDir: number,
    brightness: number,
    earbud: boolean,
    kind: 'phone' | 'laptop' | null,
  ): void {
    if (!kind) return;
    const c = kind === 'phone' ? this.canvas : this.lcanvas;
    const g = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    if (mode === 'game') {
      this.game.update(dt, gameDir);
      this.game.draw(g, W, H);
      this.glowColor = 0x6f8fff;
    } else if (mode === 'video') {
      this.videoT += dt;
      drawVideo(g, W, H, this.videoT);
      this.glowColor = 0xffc89a;
    } else {
      drawNotes(g, W, H);
      this.glowColor = 0xffffff;
    }
    if (earbud) {
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.font = `${Math.round(W * 0.05)}px system-ui`;
      g.textAlign = 'right';
      g.fillText('🎧', W * 0.97, H * 0.98);
    }
    // Brightness: darken overlay.
    g.fillStyle = `rgba(0,0,0,${(1 - brightness) * 0.75})`;
    g.fillRect(0, 0, W, H);
    (kind === 'phone' ? this.tex : this.ltex).needsUpdate = true;
  }

  dispose(): void {
    this.tex.dispose();
    this.ltex.dispose();
    for (const g of [this.phone, this.laptop])
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
  }
}

/** Placeholder "episode": original procedural cartoon (no third-party footage in the greybox). */
function drawVideo(g: CanvasRenderingContext2D, W: number, H: number, t: number): void {
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#7fc8ff');
  sky.addColorStop(1, '#ffe1a8');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#5aa35a';
  g.fillRect(0, H * 0.72, W, H * 0.28);
  // A very determined duck.
  const x = ((t * 0.12) % 1.2) * W - W * 0.1;
  const y = H * 0.66 + Math.sin(t * 6) * H * 0.01;
  g.fillStyle = '#ffd23f';
  g.beginPath();
  g.ellipse(x, y, W * 0.09, W * 0.06, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(x + W * 0.07, y - W * 0.06, W * 0.04, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ff8c2a';
  g.fillRect(x + W * 0.1, y - W * 0.065, W * 0.04, W * 0.015);
  g.fillStyle = '#222';
  g.beginPath();
  g.arc(x + W * 0.08, y - W * 0.07, W * 0.008, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, H * 0.9, W, H * 0.1);
  g.fillStyle = '#fff';
  g.font = `${Math.round(W * 0.045)}px system-ui`;
  g.textAlign = 'left';
  g.fillText(
    `▶ Duck Odyssey S2E4   ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`,
    W * 0.03,
    H * 0.965,
  );
}

function drawNotes(g: CanvasRenderingContext2D, W: number, H: number): void {
  g.fillStyle = '#fbfaf5';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#c9dcef';
  g.lineWidth = 1;
  const step = H / 16;
  for (let i = 2; i < 16; i++) {
    g.beginPath();
    g.moveTo(0, i * step);
    g.lineTo(W, i * step);
    g.stroke();
  }
  g.fillStyle = '#2b3a55';
  g.font = `600 ${Math.round(step * 0.75)}px system-ui`;
  g.textAlign = 'left';
  g.fillText('Notes', W * 0.06, step * 1.3);
  g.font = `${Math.round(step * 0.55)}px system-ui`;
  const lines = [
    'The water cycle',
    '- evaporation (sun → vapour)',
    '- condensation → clouds',
    '- precipitation',
    '  (rain, snow, hail)',
    '- collection: rivers, lakes',
    'Q: why is the sea salty?',
    '→ ask',
  ];
  lines.forEach((l, i) => g.fillText(l, W * 0.06, step * (2.8 + i)));
}
