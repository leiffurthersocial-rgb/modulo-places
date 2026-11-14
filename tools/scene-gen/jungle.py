#!/usr/bin/env python3
# Generates src/scenes/jungle/scene.json (deterministic). Run: python3 gen.py
import json, math, random

R = random.Random(7)
OUT = '/home/user/modulo-places/src/scenes/jungle/scene.json'

def r2(v): return round(v, 2)

# ---------------------------------------------------------------- terrain
terrain = {
  "size": 232, "resolution": 289,
  "source": {"type": "procedural", "seedOffset": 3},
  "height": 11, "baseFrequency": 0.009, "octaves": 5, "warp": 22,
  "flatten": [
    {"x": 0, "z": -14, "radius": 40, "height": 0},
    {"x": 0, "z": 14, "radius": 46, "height": 0},
  ],
  "creek": {
    "points": [[-108, -60], [-72, -38], [-50, -12], [-40, 16], [-44, 44], [-62, 70], [-100, 92]],
    "width": 3.4, "depth": 0.9, "bedMaterial": "jungle/creek-bed", "bankLayer": "mud",
  },
  "paths": [
    {"points": [[0, -4], [0, 12], [0, 30]], "width": 34, "layer": "mossy-stone"},
    {"points": [[7, 90], [5, 72], [2.5, 54], [0.8, 38], [0, 30], [0, 22]], "width": 3.4, "layer": "mud"},
  ],
  "layers": [
    {"id": "jungle-floor", "material": "jungle/jungle-floor", "scale": 3.0, "surface": "leaves",
     "color": "#4d5c2e", "roughness": 0.95, "slope": [0, 40], "noise": 0.5},
    {"id": "mud", "material": "jungle/mud", "scale": 2.4, "surface": "dirt",
     "color": "#5a4330", "roughness": 0.97, "slope": [0, 6], "height": [-40, -2.4], "noise": 0.4},
    {"id": "mossy-stone", "material": "jungle/mossy-stone", "scale": 2.0, "surface": "rock",
     "color": "#6f7458", "roughness": 0.9, "slope": [88, 90]},
    {"id": "rock", "material": "jungle/rock", "scale": 4.0, "triplanar": True, "surface": "rock",
     "color": "#6e6a5c", "roughness": 0.85, "slope": [34, 90]},
  ],
}

# ---------------------------------------------------------------- masks
def ex(x, z, rad, soft=4): return {"type": "exclude", "x": x, "z": z, "radius": rad, "soft": soft}
def lay(l, mn=None, mx=None):
    m = {"type": "layer", "layer": l}
    if mn is not None: m["min"] = mn
    if mx is not None: m["max"] = mx
    return m
def slope(mx, soft=4): return {"type": "slope", "max": mx, "soft": soft}

# Ruin footprint, scaled by k (k=1 keeps tall trees out; k~0.55 lets plants into the courtyard edge).
def ruin(k, soft=4):
    return [ex(0, 14, 25 * k, soft), ex(0, -18, 27 * k, soft), ex(0, -2, 20 * k, soft)]
PATHC = [(0, 36), (0.8, 44), (1.5, 52), (2.2, 60), (3, 68), (4, 76), (5, 84)]
def pathx(rad, soft=3): return [ex(x, z, rad, soft) for x, z in PATHC]
def noise(f, th, soft=0.12, so=0): return {"type": "noise", "frequency": f, "threshold": th, "soft": soft, "seedOffset": so}

scatter = []
def rule(id, mesh, density, minD, scale, **kw):
    d = {"id": id, "mesh": mesh, "density": density, "minDistance": minD, "scale": scale}
    d.update(kw); scatter.append(d)

# -- canopy / structure (detail:false = independent of vegetation density)
rule("giants", "jungle:giant-tree", 0.9, 12.5, [0.85, 1.2], tilt=1.5, sink=0.3, detail=False, castShadow=True,
     collision="cylinder", collisionRadius=1.3, lods=[34, 85], cullDistance=200, cell=64, colorVariation=0.1,
     masks=[slope(30, 5), lay("mud", mx=0.4)] + ruin(1.0, 6) + pathx(8, 4) + [ex(-32, 22, 8, 3), ex(-38, 8, 7, 3), ex(-24, -4, 7, 2), ex(27, -10, 7, 2), ex(-26, 24, 7, 2), ex(28, 30, 7, 2), ex(-12, -42, 7, 2), ex(14, -44, 7, 2)],
     cluster={"frequency": 0.02, "strength": 0.3})
rule("giants-far", "jungle:giant-far", 2.0, 9, [0.9, 1.35], sink=0.3, detail=False, castShadow=False, cell=64,
     colorVariation=0.12, masks=[ex(0, 0, 95, 5), slope(45, 6)])
rule("canopy-trees", "jungle:canopy-tree", 1.5, 6, [0.8, 1.25], tilt=2, sink=0.2, detail=False, castShadow=True,
     collision="cylinder", collisionRadius=0.5, lods=[30, 72], cullDistance=150, colorVariation=0.12,
     masks=[slope(32, 5), lay("mud", mx=0.4)] + ruin(0.9, 5) + pathx(7, 3),
     cluster={"frequency": 0.03, "strength": 0.4})
rule("palms", "jungle:palm", 1.4, 4.5, [0.8, 1.3], tilt=3, sink=0.2, detail=True, castShadow=True,
     collision="cylinder", collisionRadius=0.25, lods=[24, 58], cullDistance=115, colorVariation=0.1,
     masks=[slope(30, 5), lay("mud", mx=0.5)] + ruin(0.85, 4) + pathx(6, 2),
     cluster={"frequency": 0.045, "strength": 0.5})
rule("tree-ferns", "jungle:tree-fern", 2.6, 3.0, [0.8, 1.4], tilt=4, sink=0.15, detail=True, castShadow=True,
     lods=[18, 46], cullDistance=90, colorVariation=0.12,
     masks=[slope(34, 5), lay("mud", mx=0.5)] + ruin(0.8, 3) + pathx(5, 2),
     cluster={"frequency": 0.05, "strength": 0.55})
rule("saplings", "jungle:sapling", 2.6, 2.8, [0.8, 1.4], tilt=5, sink=0.1, detail=True, castShadow=True,
     lods=[18, 46], cullDistance=80, colorVariation=0.12,
     masks=[slope(34, 5), lay("mud", mx=0.5)] + ruin(0.8, 3) + pathx(5, 2),
     cluster={"frequency": 0.06, "strength": 0.5})
# -- understory broad leaves
rule("bananas", "jungle:banana", 1.1, 4, [0.9, 1.5], tilt=3, sink=0.05, detail=True, castShadow=True,
     lods=[16, 40], cullDistance=90, colorVariation=0.1,
     masks=[slope(22, 4), lay("mud", mx=0.7)] + ruin(0.85, 3) + pathx(1.8, 1.5),
     cluster={"frequency": 0.035, "strength": 0.85})
rule("monstera", "jungle:monstera", 6.5, 1.5, [0.8, 1.6], tilt=3, detail=True, castShadow=False,
     lods=[14, 34], cullDistance=62, colorVariation=0.14,
     masks=[slope(36, 5), lay("mud", mx=0.7), lay("mossy-stone", mx=0.5)] + ruin(0.6, 3) + pathx(1.4, 1.2),
     cluster={"frequency": 0.06, "strength": 0.65})
rule("elephant-ears", "jungle:elephant-ear", 5, 1.3, [0.8, 1.5], tilt=3, detail=True, castShadow=False,
     lods=[14, 34], cullDistance=60, colorVariation=0.14,
     masks=[slope(30, 5), lay("mud", mn=0.12), lay("mossy-stone", mx=0.5)] + ruin(0.6, 3),
     cluster={"frequency": 0.07, "strength": 0.5})
rule("ferns-big", "jungle:fern-big", 14, 0.9, [0.8, 1.6], alignToNormal=0.4, detail=True, castShadow=False,
     lods=[12, 30], cullDistance=55, colorVariation=0.16,
     masks=[slope(40, 5), lay("mossy-stone", mx=0.6)] + ruin(0.5, 3),
     cluster={"frequency": 0.05, "strength": 0.5})
rule("ginger", "jungle:ginger", 3.5, 1.8, [0.8, 1.5], tilt=4, detail=True, castShadow=False,
     lods=[14, 34], cullDistance=60, colorVariation=0.14,
     masks=[slope(30, 5), lay("mossy-stone", mx=0.5)] + ruin(0.6, 3) + pathx(1.4, 1.2),
     cluster={"frequency": 0.06, "strength": 0.7})
rule("shrubs", "jungle:shrub", 4.5, 1.6, [0.8, 1.6], tilt=3, detail=True, castShadow=False,
     lods=[14, 34], cullDistance=60, colorVariation=0.14,
     masks=[slope(36, 5), lay("mossy-stone", mx=0.5)] + ruin(0.6, 3) + pathx(1.4, 1.2),
     cluster={"frequency": 0.05, "strength": 0.6})
# -- ground layer
rule("ground-leaf", "jungle:ground-leaf", 30, 0.6, [0.9, 1.7], alignToNormal=0.5, detail=True, castShadow=False,
     lods=[8, 20], cullDistance=38, colorVariation=0.18,
     masks=[slope(40, 5), lay("mossy-stone", mx=0.75)] + pathx(1.2, 1.0),
     cluster={"frequency": 0.08, "strength": 0.5})
rule("ferns-low", "jungle:fern-low", 34, 0.5, [0.9, 1.8], alignToNormal=0.5, detail=True, castShadow=False,
     lods=[8, 18], cullDistance=30, colorVariation=0.18,
     masks=[slope(40, 5), lay("mossy-stone", mx=0.8)] + pathx(1.0, 0.8),
     cluster={"frequency": 0.09, "strength": 0.5})
# -- natural stone/wood
rule("boulders", "jungle:boulder", 0.45, 9, [0.9, 2.3], tilt=8, sink=0.3, detail=False, castShadow=True,
     collision="sphere", lods=[25, 60], cullDistance=120, colorVariation=0.12,
     masks=[lay("mossy-stone", mx=0.3)] + ruin(0.9, 3) + pathx(3, 2))
rule("creek-boulders", "jungle:boulder", 7, 2.4, [0.45, 1.5], tilt=10, sink=0.25, detail=False, castShadow=True,
     collision="sphere", lods=[25, 60], cullDistance=100, colorVariation=0.12,
     masks=[lay("mud", mn=0.7), ex(4, 48, 36, 3), ex(0, 30, 16, 3)])
rule("logs", "jungle:log", 0.3, 14, [0.9, 1.3], alignToNormal=1, sink=0.1, detail=False, castShadow=True,
     lods=[20, 50], cullDistance=90, colorVariation=0.12,
     masks=[slope(22, 4), lay("mud", mx=0.4), lay("mossy-stone", mx=0.3)] + ruin(0.9, 3) + pathx(4, 2))
rule("surface-roots", "jungle:root-spread", 0.7, 5, [0.7, 1.4], alignToNormal=0.6, sink=0.04, detail=True, castShadow=False,
     lods=[15, 40], cullDistance=70, colorVariation=0.12,
     masks=[lay("mud", mx=0.5)] + pathx(2.5, 1.5) + [ex(0, 14, 10, 4), ex(0, -2, 8, 3)])
# -- ruin litter on the paved ground
rule("paving", "jungle:slab", 55, 1.6, [0.9, 1.25], tilt=3, sink=0.0, detail=False, castShadow=False,
     lods=[10, 24], cullDistance=48, colorVariation=0.12,
     masks=[lay("mossy-stone", mn=0.5), noise(0.11, 0.36, 0.14, 4), ex(-9, -10, 8, 1.5), ex(9, -10, 8, 1.5), ex(0, -13, 8, 1.5)])
rule("loose-blocks", "jungle:block", 2.2, 3.5, [0.8, 1.3], tilt=8, sink=0.1, detail=False, castShadow=True,
     lods=[16, 40], cullDistance=70, colorVariation=0.1,
     masks=[lay("mossy-stone", mn=0.3), ex(-9, -10, 8, 1.5), ex(9, -10, 8, 1.5), ex(0, -13, 8, 1.5), ex(0, 14, 5, 3)])
rule("rubble-piles", "jungle:rubble", 0.7, 7, [0.8, 1.3], sink=0.1, detail=False, castShadow=True,
     lods=[16, 40], cullDistance=70, colorVariation=0.1,
     masks=[lay("mossy-stone", mn=0.2, mx=0.8), ex(-9, -10, 8, 1.5), ex(9, -10, 8, 1.5), ex(0, -13, 8, 1.5), ex(0, 14, 7, 3)])
rule("lianas", "jungle:liana", 0.55, 6, [0.9, 1.2], detail=False, castShadow=False,
     lods=[40], cullDistance=95, colorVariation=0.1,
     masks=[slope(30, 5)] + ruin(0.8, 3) + pathx(3, 2))

# ---------------------------------------------------------------- props
props = []
def prop(id, mesh, x, y, z, rot=None, scale=None, collision=None, color=None):
    d = {"id": id, "mesh": mesh, "position": [r2(x), r2(y), r2(z)]}
    if rot and any(rot): d["rotation"] = [r2(v) for v in rot]
    if scale is not None: d["scale"] = scale if isinstance(scale, (int, float)) else [r2(v) for v in scale]
    if collision: d["collision"] = collision
    if color: d["color"] = color
    props.append(d)

def collider(id, x0, x1, y0, y1, z0, z1, shape="box"):
    prop(id, "jungle:collider", (x0 + x1) / 2, y0, (z0 + z1) / 2, scale=[x1 - x0, y1 - y0, z1 - z0], collision=shape)

prop("temple", "jungle:temple", 0, 0, 0, collision="none")
prop("temple-growth", "jungle:temple-growth", 0, 0, 0, collision="none")

# Temple colliders (invisible): tiers, stair steps, shrine walls.
sh = 3.4
for i, (w, h, z0, z1) in enumerate([(16, 2.4, -34, -6), (12.5, 4.8, -33, -9.2), (9, 7.2, -32, -12.4)], 1):
    collider(f"tier{i}-l", -w, -sh, -3, h, z0, z1)
    collider(f"tier{i}-r", sh, w, -3, h, z0, z1)
collider("tier3-mid", -sh, sh, -3, 7.2, -32, -15.4)
for i in range(1, 25):
    zf = -6 - 0.4 * (i - 1)
    collider(f"step{i:02d}", -sh, sh, -1.0, 0.3 * i, zf - 0.4, zf)
y0 = 7.2; yt = y0 + 6.4; hw = 1.3; dz = -19.5
collider("shrine-fl", -5.8, -hw, y0 - 0.1, yt, dz - 2.2, dz)
collider("shrine-fr", hw, 5.8, y0 - 0.1, yt, dz - 2.2, dz)
collider("shrine-l", -5.8, -3.6, y0 - 0.1, yt, -30.5, dz - 2.2)
collider("shrine-r", 3.6, 5.8, y0 - 0.1, yt, -30.5, dz - 2.2)
collider("shrine-b", -3.6, 3.6, y0 - 0.1, yt, -30.5, -28.3)
collider("shrine-altar", -1.1, 1.1, y0, y0 + 1.2, -27.8, -26.0)

# Guardians + steles at the stair foot / courtyard.
prop("guardian-l", "jungle:guardian", -6.2, 0, -4.2, [0, 8, 0], collision="box")
prop("guardian-r", "jungle:guardian", 6.2, 0, -4.4, [0, -6, 0], 1.0, collision="box")
prop("stele-a", "jungle:stele", -13.5, 0, 7, [0, 12, 5], collision="box")
prop("stele-b", "jungle:stele", 14.5, 0, 13, [0, -24, -8], collision="box")

# Pillar avenue.
left = [("jungle:pillar", 22), ("jungle:pillar-broken", 16), ("jungle:pillar", 10), ("jungle:pillar-stump", 4)]
right = [("jungle:pillar-broken", 22), ("jungle:pillar", 16), ("jungle:pillar-fallen", 10), ("jungle:pillar", 4)]
for i, (m, z) in enumerate(left):
    prop(f"pillar-l{i}", m, -8.2 + R.uniform(-0.15, 0.15), 0, z, [0, R.uniform(-8, 8), 0], collision="box")
for i, (m, z) in enumerate(right):
    if m.endswith("fallen"):
        prop(f"pillar-r{i}", m, 8.9, 0, z, [0, 82, 0], collision="box")
    else:
        prop(f"pillar-r{i}", m, 8.2 + R.uniform(-0.15, 0.15), 0, z, [0, R.uniform(-8, 8), 0], collision="box")
# Gate.
prop("gate-l", "jungle:pillar", -5.6, 0, 30, [0, 3, 0], 1.25, collision="box")
prop("gate-r", "jungle:pillar-broken", 5.7, 0, 30.4, [0, -6, 0], 1.25, collision="box")
prop("gate-lintel", "jungle:block", -1.5, 0, 28.6, [0, 14, 4], [5.0, 1.3, 1.5], collision="box")

# Perimeter walls (collapsed in places) + rubble at the breaks.
def wall(id, mesh, x, z, yaw, scale=1.0): prop(id, mesh, x, 0, z, [0, yaw, 0], scale, collision="box")
wall("wall-e0", "jungle:wall", 21.5, -1.0, 90)
wall("wall-e1", "jungle:wall-b", 21.2, 7.5, 92)
wall("wall-e2", "jungle:wall-low", 21.5, 15.5, 88)
wall("wall-e3", "jungle:wall", 21.8, 24.0, 90)
wall("wall-w0", "jungle:wall-b", -21.4, 0.5, 90)
wall("wall-w1", "jungle:wall-low", -21.2, 8.5, 91)
wall("wall-w2", "jungle:wall", -21.6, 17.5, 90)
wall("wall-w3", "jungle:wall-b", -21.3, 26.0, 89)
wall("wall-s0", "jungle:wall-low", 13.5, 31.5, 0)
wall("wall-s1", "jungle:wall-b", -13.5, 31.8, 2)
for i, (x, z) in enumerate([(21.5, 11.8), (-21, 4.4), (-21.2, 13), (20.5, 20), (11, 31), (-10, 32)]):
    prop(f"rubble-{i}", "jungle:rubble", x, 0, z, [0, R.uniform(0, 360), 0], R.uniform(1.0, 1.5))
for i, (x, z) in enumerate([(-8, -3), (9.5, -2.5), (-3.5, 3), (2, 8)]):
    prop(f"rubble-s{i}", "jungle:rubble", x, 0, z, [0, R.uniform(0, 360), 0], R.uniform(0.9, 1.3))

# Carved blocks scattered through the courtyard (hand placed so the layout stays readable).
for i in range(30):
    for _ in range(40):
        x = R.uniform(-19, 19); z = R.uniform(-3, 27)
        if abs(x) < 4.2 and z < 5: continue            # keep the procession axis near the stairs clear
        if abs(abs(x) - 8.2) < 1.0 and abs(((z - 4) % 6)) < 1.5: continue   # not on pillars
        break
    prop(f"block-{i:02d}", "jungle:block", x, 0, z, [R.uniform(-6, 6), R.uniform(0, 360), R.uniform(-8, 8)], R.uniform(0.8, 1.35), collision="box")

# Roots reclaiming the courtyard.
for i in range(10):
    x = R.uniform(-17, 17); z = R.uniform(0, 27)
    prop(f"roots-{i}", "jungle:root-spread", x, 0, z, [0, R.uniform(0, 360), 0], R.uniform(0.8, 1.3))
for i, (x, z) in enumerate([(-9, -5.5), (9.5, -5.5), (-4, -6.5), (3.6, -6.8)]):
    prop(f"roots-stair-{i}", "jungle:root-spread", x, 0, z, [0, R.uniform(0, 360), 0], R.uniform(0.9, 1.3))

# Plants growing on the temple: terraces, shrine roof.
def plant(id, mesh, x, y, z, s): prop(id, mesh, x, y, z, [0, R.uniform(0, 360), 0], s)
for i, (x, y, z) in enumerate([(-13, 2.4, -20), (13, 2.4, -22), (-14, 2.4, -9), (14, 2.4, -8), (-10.5, 4.8, -22), (10.5, 4.8, -20), (-9, 4.8, -11), (8.8, 4.8, -11.5), (-7.5, 7.2, -16), (7.5, 7.2, -15), (-7, 7.2, -25), (7.2, 7.2, -26)]):
    plant(f"terrace-shrub-{i}", "jungle:shrub" if i % 3 else "jungle:fern-big", x, y, z, R.uniform(1.4, 2.2))
for i, (x, z) in enumerate([(-4, -26), (1.5, -23), (3.5, -29)]):
    plant(f"roof-shrub-{i}", "jungle:shrub", x, 14.5 + (1.0 if i != 1 else 0), z, R.uniform(1.8, 2.6))
plant("roof-sapling-0", "jungle:sapling", 3.0, 14.6, -28, 1.3)
plant("roof-sapling-1", "jungle:sapling", -5.0, 14.5, -24, 1.0)
plant("terrace-sapling", "jungle:sapling", -11, 4.8, -26, 1.1)
plant("terrace-palm", "jungle:palm", 10.5, 4.8, -27, 0.9)

# Hero giants framing the ruin (full-detail props) with trunk colliders.
heroes = [(-24, -4, 0), (27, -10, 1), (-27, 40, 2), (28, 30, 0), (-12, -42, 1), (14, -44, 2), (-38, -22, 2), (37, -28, 0)]
for i, (x, z, v) in enumerate(heroes):
    prop(f"hero-giant-{i}", "jungle:giant-tree", x, 0, z, [0, R.uniform(0, 360), 0], R.uniform(0.95, 1.15), collision="none")
    prop(f"hero-giant-{i}-trunk", "jungle:collider", x, 0, z, scale=[2.3, 4, 2.3], collision="cylinder")

# ---------------------------------------------------------------- moods
moods = [
 {"id": "midday", "name": "Midday shafts", "audio": "jungle-midday",
  "sky": {"zenith": "#5a96cc", "horizon": "#cfe4d2", "ground": "#3c4a2c"},
  "sun": {"azimuth": 25, "elevation": 68, "color": "#fff1d2", "intensity": 3.4, "discSize": 0.6},
  "ambient": {"sky": "#a3cc98", "ground": "#40502a", "intensity": 0.55, "ibl": 0.3},
  "fog": {"color": "#a9c8a2", "density": 0.0036, "heightFalloff": 0.03, "baseHeight": 0, "sunScatter": 0.5},
  "post": {"exposure": 0.38, "contrast": 0.22, "saturation": 0.3, "temperature": 0.08, "tint": -0.04, "bloom": 0.6, "vignette": 0.32, "shafts": 1.5},
  "particles": ["pollen", "dust"]},
 {"id": "storm", "name": "Storm", "audio": "jungle-storm",
  "sky": {"zenith": "#4b5a62", "horizon": "#8a9a9a", "ground": "#2b3329"},
  "sun": {"azimuth": 40, "elevation": 35, "color": "#a9bdc2", "intensity": 0.5, "discSize": 1.2},
  "ambient": {"sky": "#7f9a98", "ground": "#1f2a20", "intensity": 0.9, "ibl": 0.3},
  "fog": {"color": "#70827f", "density": 0.015, "heightFalloff": 0.03, "baseHeight": 0, "sunScatter": 0.05},
  "post": {"exposure": 0.3, "contrast": 0.14, "saturation": -0.2, "temperature": -0.12, "tint": -0.04, "bloom": 0.35, "vignette": 0.5, "shafts": 0},
  "particles": ["rain", "mist"]},
 {"id": "golden-hour", "name": "Golden hour", "audio": "jungle-golden-hour",
  "sky": {"zenith": "#7a8fb0", "horizon": "#f2b878", "ground": "#4a3a28"},
  "sun": {"azimuth": 60, "elevation": 9, "color": "#ffb35c", "intensity": 2.8, "discSize": 0.8},
  "ambient": {"sky": "#e0b890", "ground": "#4a3a22", "intensity": 0.7, "ibl": 0.35},
  "fog": {"color": "#e0a468", "density": 0.009, "heightFalloff": 0.02, "baseHeight": 0, "sunScatter": 0.9},
  "post": {"exposure": 0.38, "contrast": 0.2, "saturation": 0.25, "temperature": 0.3, "tint": 0.05, "bloom": 0.9, "vignette": 0.35, "shafts": 1.7},
  "particles": ["pollen", "mist", "dust"]},
]

cameras = [
  {"id": "spawn", "position": [2.6, 1.65, 56], "target": [0, 6.5, 0], "fov": 60},
  {"id": "stairs", "position": [0.5, 1.65, 8], "target": [0, 8.6, -21], "fov": 58},
  {"id": "courtyard", "position": [15, 1.65, 27], "target": [-5, 2.6, 4], "fov": 64},
  {"id": "canopy-up", "position": [-18, 1.3, 3], "target": [-26, 30, -6], "fov": 70},
  {"id": "creek", "position": [-32, 1.65, 26], "target": [-41, -0.6, 6], "fov": 62},
  {"id": "doorway", "position": [0, 8.85, -21.2], "target": [0, 1.0, -4], "fov": 66},
]

import os
if os.environ.get('DBG'):
    cameras += [
      {"id": "dbg-top", "position": [0, 150, 30], "target": [0, 0, 0], "fov": 70},
      {"id": "dbg-side", "position": [60, 14, 60], "target": [0, 5, 0], "fov": 70},
      {"id": "dbg-creek", "position": [-25, 12, 10], "target": [-42, 0, 35], "fov": 70},
    ]
scene = {
  "id": "jungle", "name": "Jungle Ruin",
  "description": "Overgrown stone, vines and humid light shafts.",
  "seed": 20261113,
  "terrain": terrain, "scatter": scatter, "props": props,
  "spawn": {"position": [2.6, 0, 56], "yaw": 0.04},
  "bounds": {"walkRadius": 94, "photoHalfExtent": 108, "photoMaxHeight": 60},
  "defaultMood": "midday", "moods": moods, "cameras": cameras,
}
json.dump(scene, open(OUT, 'w'), indent=1)
print("props", len(props), "rules", len(scatter))
