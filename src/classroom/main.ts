// Modulo: Classroom entry (STEP 0 hello-world: greybox room from the layout JSON).
// URL parameters:
//   ?seed=<int|word>   simulation seed (shareable)
//   ?shot=N            screenshot mode: fixed time, fixed camera, render N frames, then
//                      window.__shotReady = true and stop the loop
//   ?cam=seat|overview|teacher   camera for screenshot mode (default: seat)
import * as THREE from 'three';
import layoutJson from './data/layouts/classroom-a.json';
import { buildGreybox } from './render/greybox';
import { SimClock, TICK_DT } from './sim/clock';
import { facingDir, type RoomLayout, validateLayout } from './sim/layout';
import { parseSeed, Rng } from './sim/rng';

declare global {
  interface Window {
    __shotReady?: boolean;
    __info?: Record<string, unknown>;
  }
}

const q = new URLSearchParams(location.search);
const seed = parseSeed(q.get('seed'), 1);
const shotFrames = q.has('shot') ? Math.max(1, Number(q.get('shot')) || 2) : 0;
const camName = q.get('cam') ?? 'seat';

const layout = layoutJson as unknown as RoomLayout;
const problems = validateLayout(layout);
if (problems.length) console.warn('[layout]', problems);

const host = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(host.clientWidth, host.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.1;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171a);
const room = buildGreybox(layout);
scene.add(room.root);

const [W, H, D] = layout.room.size;
// Overcast daylight through the window wall (+x) plus soft fill. Placeholder for Phase 4 lighting.
scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x3a2e24, 1.1));
const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
sun.position.set(W + 6, 5, D * 0.35);
sun.target.position.set(W * 0.4, 0, D * 0.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -6;
sun.shadow.camera.right = 6;
sun.shadow.camera.top = 6;
sun.shadow.camera.bottom = -6;
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const fill = new THREE.PointLight(0xffffff, 6, 12, 2);
fill.position.set(W / 2, H - 0.3, D / 2);
scene.add(fill);

const camera = new THREE.PerspectiveCamera(70, host.clientWidth / host.clientHeight, 0.05, 50);
function placeCamera(name: string): void {
  if (name === 'overview') {
    camera.position.set(0.5, 2.35, D - 0.45);
    camera.lookAt(W * 0.62, 0.55, D * 0.3);
  } else if (name === 'teacher') {
    camera.position.set(layout.teacherHome[0] + 0.6, 1.65, layout.teacherHome[1] + 0.3);
    camera.lookAt(W / 2, 0.9, D * 0.8);
  } else {
    const s = layout.seats.find((x) => x.id === layout.playerSeat)!;
    const f = facingDir(s.facing);
    camera.position.set(s.pos[0], 1.18, s.pos[1]);
    camera.lookAt(s.pos[0] + f[0] * 4, 1.05, s.pos[1] + f[1] * 4);
  }
}
placeCamera(camName);

// Sim heartbeat (empty for now): proves the fixed tick + seeded RNG wiring.
const clock = new SimClock();
const rng = new Rng(seed);
let simChecksum = 0;
function simTick(): void {
  simChecksum = (simChecksum * 31 + rng.nextU32()) >>> 0;
}

function resize(): void {
  const w = host.clientWidth;
  const h = host.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

let frames = 0;
let last = performance.now();
function frame(now: number): void {
  // Screenshot mode uses a fixed step so output does not depend on machine speed.
  const dt = shotFrames ? TICK_DT : (now - last) / 1000;
  last = now;
  const n = clock.advance(dt);
  for (let i = 0; i < n; i++) simTick();
  renderer.render(scene, camera);
  frames++;
  const gl = renderer.getContext();
  window.__info = {
    app: 'classroom',
    seed,
    tick: clock.tick,
    simChecksum,
    camera: camName,
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    layout: layout.id,
    layoutProblems: problems.length,
  };
  if (shotFrames && frames >= shotFrames) {
    window.__shotReady = true;
    return;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (!shotFrames) {
  const label = document.createElement('div');
  label.textContent = `Modulo: Classroom · greybox hello-world · seed ${seed} · cam: ${camName}`;
  label.style.cssText =
    'position:fixed;left:12px;bottom:12px;color:#fff;font:12px system-ui,sans-serif;opacity:.7;pointer-events:none';
  document.body.appendChild(label);
}
