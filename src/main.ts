// STEP 0 pipeline proof: Three.js + pmndrs/postprocessing + Rapier WASM, with a deterministic
// "screenshot mode" (?shot=N renders N fixed frames, then sets window.__shotReady).
import * as THREE from 'three';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import RAPIER from '@dimforge/rapier3d-compat';

declare global {
  interface Window {
    __shotReady?: boolean;
    __info?: Record<string, unknown>;
  }
}

const params = new URLSearchParams(location.search);
const shotFrames = Number(params.get('shot') ?? 0);

const container = document.getElementById('app')!;
const hud = document.getElementById('hud')!;

const renderer = new THREE.WebGLRenderer({
  powerPreference: 'high-performance',
  antialias: false,
  stencil: false,
  depth: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb3c4);
scene.fog = new THREE.FogExp2(0x9fb3c4, 0.035);

const camera = new THREE.PerspectiveCamera(
  55,
  container.clientWidth / container.clientHeight,
  0.1,
  200,
);
camera.position.set(0, 1.7, 6);
camera.lookAt(0, 1, 0);

scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x3a3326, 0.9));
const sun = new THREE.DirectionalLight(0xfff1dc, 3);
sun.position.set(6, 10, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x4a5a3a, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// Instanced "trees" as a stand-in for the scatter system.
const trunkGeo = new THREE.CylinderGeometry(0.15, 0.25, 4, 8).translate(0, 2, 0);
const trunks = new THREE.InstancedMesh(
  trunkGeo,
  new THREE.MeshStandardMaterial({ color: 0x5b4636 }),
  200,
);
const m = new THREE.Matrix4();
let seed = 1337;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < trunks.count; i++) {
  const x = (rnd() - 0.5) * 50;
  const z = (rnd() - 0.5) * 50 - 8;
  m.makeTranslation(x, 0, z);
  trunks.setMatrixAt(i, m);
}
trunks.castShadow = true;
scene.add(trunks);

const orb = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.6, 4),
  new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffb36b, emissiveIntensity: 4 }),
);
orb.position.set(0, 1.2, 0);
orb.castShadow = true;
scene.add(orb);

const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera));
composer.addPass(
  new EffectPass(
    camera,
    new BloomEffect({ intensity: 1.2, luminanceThreshold: 1.0, mipmapBlur: true }),
    new ToneMappingEffect({ mode: ToneMappingMode.AGX }),
    new VignetteEffect({ darkness: 0.45 }),
    new SMAAEffect(),
  ),
);

addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
  composer.setSize(container.clientWidth, container.clientHeight);
});

async function boot(): Promise<void> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.createCollider(RAPIER.ColliderDesc.cuboid(30, 0.1, 30));
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 5, 0));
  world.createCollider(RAPIER.ColliderDesc.ball(0.5), body);
  for (let i = 0; i < 120; i++) world.step();

  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  window.__info = {
    webgl2: gl instanceof WebGL2RenderingContext,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    rapierBallY: Number(body.translation().y.toFixed(3)),
    three: THREE.REVISION,
  };
  hud.textContent = `Modulo: Places — pipeline check · three r${THREE.REVISION} · rapier ball y=${window.__info.rapierBallY}`;

  if (shotFrames > 0) {
    for (let i = 0; i < shotFrames; i++) composer.render(1 / 60);
    window.__shotReady = true;
    return;
  }
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    orb.position.y = 1.2 + Math.sin(t) * 0.2;
    composer.render(clock.getDelta());
  });
}

void boot();
