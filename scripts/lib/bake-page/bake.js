// Headless bake page: renders a pre-oriented patch GLB (card frame: x = right, y = up/tip, z = toward
// the camera) orthographically into an albedo+coverage image and a tangent-space normal image.
import * as THREE from 'three';
import { GLTFLoader } from '/three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();

async function loadMesh(url) {
  const gltf = await loader.loadAsync(url);
  let mesh = null;
  gltf.scene.traverse((o) => {
    if (o.isMesh && !mesh) mesh = o;
  });
  if (!mesh) throw new Error('no mesh');
  return mesh;
}

function makeRenderer(size, colorSpace) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const r = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  r.setPixelRatio(1);
  r.setSize(size, size, false);
  r.outputColorSpace = colorSpace;
  return { r, canvas };
}

/** opts: { cx, cy, extent (metres covered by the square frame), size (px), zMin, zMax } */
window.bake = async (url, opts) => {
  const mesh = await loadMesh(url);
  const srcMat = mesh.material;
  const half = opts.extent / 2;
  const cam = new THREE.OrthographicCamera(
    opts.cx - half,
    opts.cx + half,
    opts.cy + half,
    opts.cy - half,
    0.01,
    100,
  );
  cam.position.set(0, 0, 50);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);

  // Albedo: unlit texture * depth cavity shading (deeper = darker), straight alpha = coverage.
  const alb = makeRenderer(opts.size, THREE.SRGBColorSpace);
  const albMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      map: { value: srcMat.map },
      zMin: { value: opts.zMin },
      zMax: { value: opts.zMax },
      dark: { value: opts.dark ?? 0.55 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying float vZ;
      void main(){ vUv = uv; vZ = position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map; uniform float zMin; uniform float zMax; uniform float dark;
      varying vec2 vUv; varying float vZ;
      void main(){
        vec4 c = texture2D(map, vUv);
        float d = smoothstep(zMin, zMax, vZ);
        gl_FragColor = vec4(c.rgb * mix(dark, 1.0, d), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  mesh.material = albMat;
  const scene = new THREE.Scene();
  scene.add(mesh);
  alb.r.setClearColor(0x000000, 0);
  alb.r.render(scene, cam);
  const albedo = alb.canvas.toDataURL('image/png');

  // Normals: view-space normal (camera looks down -z, so view space == card tangent space), linear.
  const nor = makeRenderer(opts.size, THREE.LinearSRGBColorSpace);
  mesh.material = new THREE.MeshNormalMaterial({
    side: THREE.DoubleSide,
    normalMap: srcMat.normalMap,
  });
  nor.r.setClearColor(new THREE.Color(0.5, 0.5, 1.0), 0);
  nor.r.render(scene, cam);
  const normal = nor.canvas.toDataURL('image/png');
  alb.r.dispose();
  nor.r.dispose();
  return { albedo, normal };
};
window.bakeReady = true;
