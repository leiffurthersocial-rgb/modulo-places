// Runtime validator for scene.json files. Dependency-free; mirrors the SceneDef contract in
// engine/types.ts. Problems are reported as "<path>: <message>", e.g. "scatter[2].scale: ...".
import type { SceneDef } from '../engine/types';

type Rec = Record<string, unknown>;
type Errs = string[];
type Check = (v: unknown, path: string, errs: Errs) => void;

interface NumOpts {
  int?: boolean;
  gt?: number;
  min?: number;
  max?: number;
}

interface ListOpts {
  nonEmpty?: boolean;
  unique?: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

function isObj(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function fail(errs: Errs, path: string, msg: string): void {
  errs.push(`${path || '<root>'}: ${msg}`);
}

const sub = (path: string, key: string): string => (path ? `${path}.${key}` : key);
const at = (path: string, i: number): string => `${path}[${i}]`;

function numRule(o: NumOpts): string {
  const bounds: string[] = [];
  if (o.gt !== undefined) bounds.push(`> ${o.gt}`);
  if (o.min !== undefined) bounds.push(`>= ${o.min}`);
  if (o.max !== undefined) bounds.push(`<= ${o.max}`);
  const tail = bounds.length > 0 ? ` ${bounds.join(' and ')}` : '';
  return `expected ${o.int ? 'integer' : 'number'}${tail}`;
}

function checkObj(v: unknown, path: string, errs: Errs): Rec | undefined {
  if (isObj(v)) return v;
  fail(errs, path, 'expected object');
  return undefined;
}

function checkNum(v: unknown, path: string, errs: Errs, o: NumOpts = {}): number | undefined {
  if (
    isNum(v) &&
    (!o.int || Number.isInteger(v)) &&
    (o.gt === undefined || v > o.gt) &&
    (o.min === undefined || v >= o.min) &&
    (o.max === undefined || v <= o.max)
  ) {
    return v;
  }
  fail(errs, path, `${numRule(o)} (got ${String(v)})`);
  return undefined;
}

function checkOpt(v: unknown, path: string, errs: Errs, o: NumOpts = {}): void {
  if (v !== undefined) checkNum(v, path, errs, o);
}

function checkStr(v: unknown, path: string, errs: Errs, nonEmpty = true): void {
  if (typeof v !== 'string' || (nonEmpty && v.trim() === '')) {
    fail(errs, path, nonEmpty ? 'expected non-empty string' : 'expected string');
  }
}

function checkBool(v: unknown, path: string, errs: Errs): void {
  if (typeof v !== 'boolean') fail(errs, path, 'expected boolean');
}

function checkHex(v: unknown, path: string, errs: Errs): void {
  if (typeof v !== 'string' || !HEX.test(v)) {
    fail(errs, path, `expected "#rrggbb" hex color (got ${String(v)})`);
  }
}

function checkEnum(v: unknown, path: string, errs: Errs, values: readonly string[]): void {
  if (typeof v !== 'string' || !values.includes(v)) {
    fail(errs, path, `expected one of ${values.join(' | ')}`);
  }
}

function checkVec3(v: unknown, path: string, errs: Errs, positive = false): void {
  const good = (x: unknown): boolean => isNum(x) && (!positive || x > 0);
  if (!Array.isArray(v) || v.length !== 3 || !v.every(good)) {
    fail(
      errs,
      path,
      positive ? 'expected [x,y,z] of positive numbers' : 'expected [x,y,z] of finite numbers',
    );
  }
}

/** A [min,max] pair with min<=max (optionally both positive). */
function checkRange(v: unknown, path: string, errs: Errs, positive = false): void {
  const arr: unknown[] = Array.isArray(v) ? v : [];
  const [lo, hi] = arr;
  if (!(arr.length === 2 && isNum(lo) && isNum(hi)) || lo > hi) {
    fail(errs, path, 'expected [min,max] with min<=max');
  } else if (positive && lo <= 0) {
    fail(errs, path, 'expected positive numbers in [min,max]');
  }
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

/** Duplicate ids within one list (items without a usable id are reported by their own check). */
function checkUniqueIds(list: unknown[], path: string, errs: Errs): void {
  const seen = new Set<string>();
  list.forEach((x, i) => {
    const id = isObj(x) ? x.id : undefined;
    if (!isNonEmptyStr(id)) return;
    if (seen.has(id)) fail(errs, `${at(path, i)}.id`, `duplicate id "${id}"`);
    seen.add(id);
  });
}

function checkList(v: unknown, path: string, errs: Errs, check: Check, o: ListOpts = {}): void {
  if (!Array.isArray(v)) {
    fail(errs, path, 'expected array');
    return;
  }
  if (o.nonEmpty && v.length === 0) fail(errs, path, 'expected non-empty array');
  v.forEach((x: unknown, i) => check(x, at(path, i), errs));
  if (o.unique) checkUniqueIds(v, path, errs);
}

// ---------------------------------------------------------------------------------------------
// Scene sections
// ---------------------------------------------------------------------------------------------

function checkSource(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  if (o.type === 'procedural') {
    checkOpt(o.seedOffset, sub(p, 'seedOffset'), errs, { int: true });
  } else if (o.type === 'image') {
    checkStr(o.url, sub(p, 'url'), errs);
  } else {
    fail(errs, sub(p, 'type'), "expected 'procedural' or 'image'");
  }
}

function checkFlatten(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  checkNum(o.x, sub(p, 'x'), errs);
  checkNum(o.z, sub(p, 'z'), errs);
  checkNum(o.radius, sub(p, 'radius'), errs, { gt: 0 });
  checkOpt(o.height, sub(p, 'height'), errs);
}

function checkLayer(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  checkStr(o.id, sub(p, 'id'), errs);
  checkStr(o.material, sub(p, 'material'), errs);
  checkHex(o.color, sub(p, 'color'), errs);
  checkNum(o.roughness, sub(p, 'roughness'), errs, { min: 0, max: 1 });
  if (o.slope !== undefined) checkRange(o.slope, sub(p, 'slope'), errs);
  if (o.height !== undefined) checkRange(o.height, sub(p, 'height'), errs);
  checkOpt(o.noise, sub(p, 'noise'), errs);
}

function checkTerrain(v: unknown, p: string, errs: Errs): number | undefined {
  const o = checkObj(v, p, errs);
  if (!o) return undefined;
  const size = checkNum(o.size, sub(p, 'size'), errs, { min: 20, max: 2000 });
  checkNum(o.resolution, sub(p, 'resolution'), errs, { int: true, min: 17, max: 2049 });
  checkNum(o.height, sub(p, 'height'), errs, { min: 0 });
  checkNum(o.baseFrequency, sub(p, 'baseFrequency'), errs, { gt: 0 });
  checkNum(o.octaves, sub(p, 'octaves'), errs, { int: true, min: 1, max: 10 });
  checkNum(o.warp, sub(p, 'warp'), errs);
  checkSource(o.source, sub(p, 'source'), errs);
  if (o.flatten !== undefined) checkList(o.flatten, sub(p, 'flatten'), errs, checkFlatten);
  checkList(o.layers, sub(p, 'layers'), errs, checkLayer, { nonEmpty: true, unique: true });
  return size;
}

function checkLods(v: unknown, p: string, errs: Errs): void {
  if (!Array.isArray(v)) {
    fail(errs, p, 'expected array of positive numbers');
    return;
  }
  let prev = 0;
  v.forEach((d: unknown, i) => {
    const ip = at(p, i);
    if (!isNum(d) || d <= 0) {
      fail(errs, ip, 'expected positive number');
    } else if (d <= prev) {
      fail(errs, ip, `expected strictly increasing distances (${d} <= ${prev})`);
    } else {
      prev = d;
    }
  });
}

function checkMask(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  const f = (k: string): string => sub(p, k);
  switch (o.type) {
    case 'slope':
    case 'height':
      checkOpt(o.min, f('min'), errs);
      checkOpt(o.max, f('max'), errs);
      checkOpt(o.soft, f('soft'), errs);
      if (isNum(o.min) && isNum(o.max) && o.min > o.max) {
        fail(errs, f('min'), `expected min<=max (got ${o.min} > ${o.max})`);
      }
      break;
    case 'noise':
      checkNum(o.frequency, f('frequency'), errs, { gt: 0 });
      checkNum(o.threshold, f('threshold'), errs);
      checkOpt(o.soft, f('soft'), errs);
      checkOpt(o.seedOffset, f('seedOffset'), errs, { int: true });
      break;
    case 'exclude':
      checkNum(o.x, f('x'), errs);
      checkNum(o.z, f('z'), errs);
      checkNum(o.radius, f('radius'), errs, { gt: 0 });
      checkOpt(o.soft, f('soft'), errs);
      break;
    case 'layer':
      checkStr(o.layer, f('layer'), errs);
      if (o.min === undefined && o.max === undefined)
        fail(errs, f('min'), 'expected min and/or max');
      if (o.min !== undefined) checkNum(o.min, f('min'), errs);
      if (o.max !== undefined) checkNum(o.max, f('max'), errs);
      break;
    default:
      fail(errs, f('type'), "expected one of 'slope' | 'height' | 'noise' | 'exclude' | 'layer'");
  }
}

function checkScatter(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  const f = (k: string): string => sub(p, k);
  checkStr(o.id, f('id'), errs);
  checkStr(o.mesh, f('mesh'), errs);
  checkNum(o.density, f('density'), errs, { min: 0 });
  checkNum(o.minDistance, f('minDistance'), errs, { min: 0 });
  checkRange(o.scale, f('scale'), errs, true);
  for (const k of ['tilt', 'alignToNormal', 'sink', 'colorVariation'] as const) {
    checkOpt(o[k], f(k), errs);
  }
  checkOpt(o.cullDistance, f('cullDistance'), errs, { gt: 0 });
  if (o.masks !== undefined) checkList(o.masks, f('masks'), errs, checkMask);
  if (o.cluster !== undefined) {
    const c = checkObj(o.cluster, f('cluster'), errs);
    if (c) {
      checkNum(c.frequency, sub(f('cluster'), 'frequency'), errs);
      checkNum(c.strength, sub(f('cluster'), 'strength'), errs);
    }
  }
  if (o.lods !== undefined) checkLods(o.lods, f('lods'), errs);
  if (o.color !== undefined) checkHex(o.color, f('color'), errs);
  if (o.collision !== undefined)
    checkEnum(o.collision, f('collision'), errs, ['none', 'cylinder', 'sphere']);
  if (o.castShadow !== undefined) checkBool(o.castShadow, f('castShadow'), errs);
  if (o.detail !== undefined) checkBool(o.detail, f('detail'), errs);
}

function checkProp(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  const f = (k: string): string => sub(p, k);
  checkStr(o.id, f('id'), errs);
  checkStr(o.mesh, f('mesh'), errs);
  checkVec3(o.position, f('position'), errs);
  if (o.rotation !== undefined) checkVec3(o.rotation, f('rotation'), errs);
  if (Array.isArray(o.scale)) checkVec3(o.scale, f('scale'), errs, true);
  else if (o.scale !== undefined) checkNum(o.scale, f('scale'), errs, { gt: 0 });
  if (o.collision !== undefined)
    checkEnum(o.collision, f('collision'), errs, ['none', 'box', 'cylinder', 'mesh']);
  if (o.color !== undefined) checkHex(o.color, f('color'), errs);
}

function checkSpawn(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  checkVec3(o.position, sub(p, 'position'), errs);
  checkNum(o.yaw, sub(p, 'yaw'), errs);
}

function checkBounds(v: unknown, size: number | undefined, errs: Errs): void {
  const o = checkObj(v, 'bounds', errs);
  if (!o) return;
  const walk = checkNum(o.walkRadius, 'bounds.walkRadius', errs, { gt: 0 });
  if (walk !== undefined && size !== undefined && walk >= size / 2) {
    fail(errs, 'bounds.walkRadius', `expected < terrain.size/2 (${size / 2}) (got ${walk})`);
  }
  checkNum(o.photoHalfExtent, 'bounds.photoHalfExtent', errs, { gt: 0 });
  checkNum(o.photoMaxHeight, 'bounds.photoMaxHeight', errs, { gt: 0 });
}

function checkMood(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  const f = (k: string): string => sub(p, k);
  checkStr(o.id, f('id'), errs);
  checkStr(o.name, f('name'), errs);

  const sky = checkObj(o.sky, f('sky'), errs);
  if (sky) {
    const sp = f('sky');
    checkHex(sky.zenith, sub(sp, 'zenith'), errs);
    checkHex(sky.horizon, sub(sp, 'horizon'), errs);
    checkHex(sky.ground, sub(sp, 'ground'), errs);
    if (sky.hdri !== undefined) checkStr(sky.hdri, sub(sp, 'hdri'), errs);
    checkOpt(sky.hdriIntensity, sub(sp, 'hdriIntensity'), errs, { min: 0 });
  }

  const sun = checkObj(o.sun, f('sun'), errs);
  if (sun) {
    const sp = f('sun');
    checkNum(sun.azimuth, sub(sp, 'azimuth'), errs);
    checkNum(sun.elevation, sub(sp, 'elevation'), errs, { min: -90, max: 90 });
    checkHex(sun.color, sub(sp, 'color'), errs);
    checkNum(sun.intensity, sub(sp, 'intensity'), errs, { min: 0 });
    checkOpt(sun.discSize, sub(sp, 'discSize'), errs, { min: 0 });
  }

  const amb = checkObj(o.ambient, f('ambient'), errs);
  if (amb) {
    const ap = f('ambient');
    checkHex(amb.sky, sub(ap, 'sky'), errs);
    checkHex(amb.ground, sub(ap, 'ground'), errs);
    checkNum(amb.intensity, sub(ap, 'intensity'), errs, { min: 0 });
  }

  const fog = checkObj(o.fog, f('fog'), errs);
  if (fog) {
    const fp = f('fog');
    checkHex(fog.color, sub(fp, 'color'), errs);
    checkNum(fog.density, sub(fp, 'density'), errs, { min: 0 });
    checkNum(fog.heightFalloff, sub(fp, 'heightFalloff'), errs);
    checkNum(fog.baseHeight, sub(fp, 'baseHeight'), errs);
    checkNum(fog.sunScatter, sub(fp, 'sunScatter'), errs, { min: 0, max: 1 });
  }

  const post = checkObj(o.post, f('post'), errs);
  if (post) {
    const pp = f('post');
    for (const k of [
      'exposure',
      'contrast',
      'saturation',
      'temperature',
      'tint',
      'bloom',
      'vignette',
    ] as const) {
      checkNum(post[k], sub(pp, k), errs);
    }
  }

  if (o.particles !== undefined) checkList(o.particles, f('particles'), errs, checkStr);
  if (o.ambience !== undefined) checkList(o.ambience, f('ambience'), errs, checkStr);
}

function checkCamera(v: unknown, p: string, errs: Errs): void {
  const o = checkObj(v, p, errs);
  if (!o) return;
  checkStr(o.id, sub(p, 'id'), errs);
  checkVec3(o.position, sub(p, 'position'), errs);
  checkVec3(o.target, sub(p, 'target'), errs);
  checkOpt(o.fov, sub(p, 'fov'), errs, { gt: 0, max: 180 });
}

function checkDefaultMood(o: Rec, errs: Errs): void {
  const moodIds: unknown[] = Array.isArray(o.moods)
    ? o.moods.map((m: unknown) => (isObj(m) ? m.id : undefined))
    : [];
  if (!isNonEmptyStr(o.defaultMood)) {
    fail(errs, 'defaultMood', 'expected non-empty string');
  } else if (!moodIds.includes(o.defaultMood)) {
    fail(errs, 'defaultMood', `"${o.defaultMood}" is not one of the mood ids`);
  }
}

function checkScene(v: unknown, errs: Errs): void {
  const o = checkObj(v, '', errs);
  if (!o) return;
  checkStr(o.id, 'id', errs);
  checkStr(o.name, 'name', errs);
  checkStr(o.description, 'description', errs, false);
  if (o.preview !== undefined) checkStr(o.preview, 'preview', errs, false);
  checkNum(o.seed, 'seed', errs, { int: true, min: 0 });
  const size = checkTerrain(o.terrain, 'terrain', errs);
  checkList(o.scatter, 'scatter', errs, checkScatter, { unique: true });
  checkList(o.props, 'props', errs, checkProp, { unique: true });
  checkSpawn(o.spawn, 'spawn', errs);
  checkBounds(o.bounds, size, errs);
  checkList(o.moods, 'moods', errs, checkMood, { nonEmpty: true, unique: true });
  checkDefaultMood(o, errs);
  checkList(o.cameras, 'cameras', errs, checkCamera, { unique: true });
}

/** Validate untrusted scene JSON. On success `scene` is the same object, typed as SceneDef. */
export function validateSceneDef(
  input: unknown,
): { ok: true; scene: SceneDef } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  checkScene(input, errors);
  return errors.length === 0 ? { ok: true, scene: input as SceneDef } : { ok: false, errors };
}
