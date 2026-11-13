// GLSL for the particle layers. All motion is computed in the vertex shader from per-particle seeds.
import { FOG_GLSL } from '../../render/materials';

/** Presets are selected with defines: P_POLLEN, P_DUST, P_MIST, P_LEAVES, P_RAIN, P_SNOW. */
export const PARTICLE_VERT = /* glsl */ `
uniform float uTime;
uniform float uRadius;
uniform float uHeightMin;
uniform float uHeightMax;
uniform float uGround;
uniform vec2 uWindOff;   // integrated wind displacement (m)
uniform vec2 uWind;      // current wind vector (m/s)
uniform vec2 uSizeRange; // metres
uniform float uFall;
uniform float uWindF;
uniform float uPixelRatio;
uniform float uViewH;
uniform vec2 uPointClamp;

attribute vec4 aSeed;

varying vec2 vUv;
varying vec3 vWorld;
varying float vFade;
varying float vId;
varying float vSizePx;
varying vec3 vNormal;

float rnd(float k) { return fract(sin((aSeed.w * 91.7 + k) * 78.233) * 43758.5453); }
vec2 wrap2(vec2 v, vec2 size) { return v - size * floor(v / size + 0.5); }

void main() {
  float t = uTime;
  float R = uRadius;
  float H = max(uHeightMax - uHeightMin, 0.01);
  float id = aSeed.w;
  vId = id;

  // Per-particle slow wander (Brownian-like, sum of incommensurate sines).
  vec3 wander = vec3(
    sin(t * (0.21 + rnd(1.0) * 0.3) + id * 40.0) + sin(t * (0.53 + rnd(2.0) * 0.4) + id * 13.0) * 0.5,
    sin(t * (0.17 + rnd(3.0) * 0.3) + id * 71.0) * 0.6,
    sin(t * (0.19 + rnd(4.0) * 0.3) + id * 27.0) + sin(t * (0.47 + rnd(5.0) * 0.4) + id * 5.0) * 0.5);

  float fallSpeed = uFall;
  float amp = 0.5;
  #if defined(P_POLLEN)
    amp = 0.6;
  #elif defined(P_DUST)
    amp = 0.35;
  #elif defined(P_MIST)
    amp = 1.2;
  #elif defined(P_LEAVES)
    fallSpeed = uFall * (0.6 + rnd(6.0) * 0.8);
    amp = 0.0;
  #elif defined(P_SNOW)
    fallSpeed = uFall * (0.7 + rnd(6.0) * 0.6);
    amp = 0.4;
  #elif defined(P_RAIN)
    fallSpeed = uFall * (0.85 + rnd(6.0) * 0.3);
    amp = 0.0;
  #endif

  vec2 box = vec2(2.0 * R);
  vec2 base = aSeed.xy * box;
  vec2 drift = uWindOff * uWindF * (0.8 + rnd(7.0) * 0.4) + wander.xz * amp;
  #if defined(P_LEAVES)
    float ph = t * (0.8 + rnd(8.0) * 0.8) + id * 30.0;
    drift += vec2(cos(ph), sin(ph)) * (0.25 + rnd(9.0) * 0.5);
  #endif
  vec2 rel = wrap2(base + drift - cameraPosition.xz, box);

  float yy = aSeed.z * H;
  if (fallSpeed > 0.0) {
    yy = yy - fallSpeed * t;
    yy = yy - H * floor(yy / H);
  } else {
    yy = clamp(yy + wander.y * amp * 0.5, 0.0, H);
  }
  float y = uGround + uHeightMin + yy;
  vec3 center = vec3(cameraPosition.x + rel.x, y, cameraPosition.z + rel.y);
  vWorld = center;

  // Fades: horizontal box edge, and top/bottom wrap for fallers.
  float edge = 1.0 - smoothstep(0.72, 1.0, length(rel) / R);
  float vert = 1.0;
  if (fallSpeed > 0.0) vert = smoothstep(0.0, 0.4, yy) * (1.0 - smoothstep(H - 0.6, H, yy));
  vFade = edge * vert;

  vec3 toCam = center - cameraPosition;
  float dist = length(toCam);
  vec3 vdir = toCam / max(dist, 1e-3);
  vNormal = vec3(0.0, 1.0, 0.0);

  #if defined(MODE_POINT)
    float sz = mix(uSizeRange.x, uSizeRange.y, rnd(10.0));
    float px = sz * projectionMatrix[1][1] * uViewH * 0.5 / max(dist, 1e-3);
    float clamped = clamp(px, uPointClamp.x, uPointClamp.y);
    vSizePx = px;
    gl_PointSize = clamped * uPixelRatio;
    vUv = vec2(0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(center, 1.0);
  #else
    vec2 c = position.xy;
    vUv = c;
    float sz = mix(uSizeRange.x, uSizeRange.y, rnd(10.0));
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 wp;
    #if defined(P_MIST)
      wp = center + (right * c.x + up * c.y) * sz * 0.5;
      vFade *= smoothstep(1.0, 4.0, dist);
    #elif defined(P_LEAVES)
      float flutterPh = t * (2.0 + rnd(11.0) * 2.5) + id * 50.0;
      float tilt = 1.5708 + 0.9 * sin(flutterPh) + 0.4 * sin(flutterPh * 0.57 + 1.3);
      float yaw = id * 6.2831 + t * (rnd(12.0) - 0.5) * 3.0;
      float ct = cos(tilt), st = sin(tilt), cy = cos(yaw), sy = sin(yaw);
      vec3 v = vec3(c.x * 0.6, c.y, 0.0) * sz * 0.5;
      vec3 n = vec3(0.0, 0.0, 1.0);
      // rotX(tilt) then rotY(yaw)
      v = vec3(v.x, v.y * ct - v.z * st, v.y * st + v.z * ct);
      n = vec3(n.x, n.y * ct - n.z * st, n.y * st + n.z * ct);
      v = vec3(v.x * cy + v.z * sy, v.y, -v.x * sy + v.z * cy);
      n = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
      wp = center + v;
      vNormal = n;
      vFade *= smoothstep(0.5, 3.0, dist);
    #else // rain streak
      vec3 vel = vec3(uWind.x * 0.35 * uWindF, -uFall, uWind.y * 0.35 * uWindF);
      float len = 0.55;
      vec3 axis = normalize(vel) * len;
      vec3 side = normalize(cross(axis, vdir));
      float w = max(0.006, dist * 0.0022);
      wp = center + axis * c.y * 0.5 + side * c.x * w;
      vFade *= smoothstep(0.8, 2.5, dist);
    #endif
    vWorld = wp;
    vSizePx = 1.0;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  #endif
}
`;

export const PARTICLE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uGround;

varying vec2 vUv;
varying vec3 vWorld;
varying float vFade;
varying float vId;
varying float vSizePx;
varying vec3 vNormal;

${FOG_GLSL}

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x), mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x), mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y);
  return mix(a, b, f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s / 0.875;
}

void main() {
  vec3 viewDir = normalize(vWorld - cameraPosition);
  float fwd = pow(max(dot(viewDir, uSunDir), 0.0), 6.0);
  vec3 col;
  float a;
  float addMix = 0.0; // 1 = purely additive, 0 = normal premultiplied

  #if defined(P_POLLEN) || defined(P_DUST) || defined(P_SNOW)
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    if (r > 1.0) discard;
    float disc = 1.0 - smoothstep(0.0, 1.0, r);
    disc *= disc;
    #if defined(P_SNOW)
      float tw = 1.0;
      col = uColor * (uAmbient * 0.9 + uSunColor * 0.35) + uSunColor * fwd * 0.5;
      a = disc * uOpacity;
    #else
      float tw = 0.55 + 0.45 * sin(uTime * (1.3 + fract(vId * 7.0) * 2.5) + vId * 90.0);
      // Strong forward scattering when backlit, subtle otherwise.
      float glow = 0.12 + 5.0 * fwd;
      col = uColor * (uAmbient * 0.6 + uSunColor * glow);
      a = disc * uOpacity * tw * (0.35 + 1.6 * fwd);
      addMix = 0.85;
    #endif
    a *= clamp(vSizePx, 0.0, 1.0); // sub-pixel particles dim instead of aliasing
  #elif defined(P_MIST)
    float ang = vId * 6.2831 + uTime * 0.02 * (fract(vId * 13.0) - 0.5);
    float ca = cos(ang), sa = sin(ang);
    vec2 q = vec2(ca * vUv.x - sa * vUv.y, sa * vUv.x + ca * vUv.y);
    float r = length(vUv);
    float falloff = 1.0 - smoothstep(0.0, 1.0, r);
    falloff = falloff * falloff * (3.0 - 2.0 * falloff);
    float tz = uTime * 0.04 + vId * 17.0;
    float n = fbm(vec3(q * 1.7 + vId * 31.0, tz));
    float dens = falloff * (0.25 + 0.95 * n);
    float hAbove = vWorld.y - uGround;
    float soft = smoothstep(0.0, 0.7, hAbove) * (1.0 - smoothstep(2.4, 4.5, hAbove) * 0.7);
    vec3 fogC = heightFogColor(viewDir);
    col = mix(fogC, uAmbient * 0.9 + fogC * 0.4, 0.25) * 1.05;
    col += uSunColor * (pow(max(dot(viewDir, uSunDir), 0.0), 3.0) * 0.55 + fwd * 0.5) * (0.4 + n * 0.6);
    a = dens * soft * uOpacity;
  #elif defined(P_LEAVES)
    float ty = vUv.y * 0.5 + 0.5;
    float wdt = pow(max(sin(3.14159 * clamp(ty, 0.0, 1.0)), 0.0), 0.75) * 0.95;
    float edgeD = wdt - abs(vUv.x);
    if (edgeD < 0.0) discard;
    float h = fract(vId * 91.3);
    vec3 brown = vec3(0.30, 0.15, 0.05), yellow = vec3(0.62, 0.45, 0.08), olive = vec3(0.26, 0.28, 0.07);
    vec3 base = h < 0.4 ? mix(brown, yellow, h / 0.4) : mix(yellow, olive, (h - 0.4) / 0.6);
    float rib = 1.0 - 0.35 * smoothstep(0.08, 0.0, abs(vUv.x));
    base *= rib * (0.8 + 0.4 * vnoise(vec3(vUv * 4.0, vId * 10.0)));
    vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
    float lam = abs(dot(n, uSunDir));
    float trans = max(-dot(n, uSunDir), 0.0) * 0.0; // two-sided lambert only
    col = base * (uAmbient + uSunColor * lam * 0.9 + trans);
    a = smoothstep(0.0, 0.06, edgeD) * uOpacity;
  #else // rain
    float ax = 1.0 - abs(vUv.x);
    float ay = smoothstep(1.0, 0.6, abs(vUv.y)) ;
    float tip = 0.35 + 0.65 * (vUv.y * 0.5 + 0.5);
    col = uColor * (uAmbient * 0.8 + uSunColor * (0.2 + fwd * 1.5));
    a = ax * ay * tip * uOpacity;
  #endif

  a *= vFade * uIntensity;
  if (a < 0.002) discard;

  #if !defined(P_MIST)
    float fogF = heightFogAmount(cameraPosition, vWorld);
    col = mix(col, heightFogColor(viewDir), fogF * 0.8);
  #endif

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a * (1.0 - addMix));
}
`;
