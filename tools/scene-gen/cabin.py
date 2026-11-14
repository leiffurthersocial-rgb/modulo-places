import json, math
CAB = (0.0, -8.0)
HOLLOW = (-38.0, 12.0)
FENCE = [(6.5,-2.5),(8.2,3.0),(8.8,8.5)]

CAMS = {
    "spawn": ([5.5, 1.65, 29], [0, 2.8, -8]),
    "cabin-front": ([-3.5, 1.65, 9.0], [0.5, 2.9, -8]),
    "porch": ([1.6, 1.65, 0.3], [-0.2, 1.7, -6.0]),
    "woodpile": ([-4.0, 1.65, 0.6], [-9.4, 1.0, -6.6]),
    "treeline": ([-6, 1.65, 27], [4, 3.0, -4]),
    "sky": ([3, 0.9, 6], [-6, 38, -30]),
}
def sight_excl(r_tree, step=4.5, reach=45):
    out = []
    for name, (p, t) in CAMS.items():
        dx, dz = t[0] - p[0], t[2] - p[2]
        L = math.hypot(dx, dz)
        n = int(min(L, reach) / step)
        for i in range(0, n + 1):
            f = i * step / L
            out.append(excl(round(p[0] + dx * f, 2), round(p[2] + dz * f, 2), r_tree, 1.5))
    return out

def path_excl(r, pts, step=5.0):
    out = []
    for (a, b) in zip(pts[:-1], pts[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        n = max(1, int(L / step))
        for i in range(n + 1):
            f = i / n
            out.append(excl(round(a[0] + (b[0] - a[0]) * f, 2), round(a[1] + (b[1] - a[1]) * f, 2), r, 1.5))
    return out
MAIN_PATH = [[9, 47], [6, 35], [1.5, 24], [-1.5, 13], [0.4, 3], [0, -2.2]]

def excl(x, z, r, soft): return {"type": "exclude", "x": x, "z": z, "radius": r, "soft": soft}

# clearing shapes (trees stay out); soft edges feather a natural treeline
def clearing(scale=1.0):
    return [
        excl(0, -8, 17 * scale, 8),
        excl(-9, -4, 9 * scale, 5),
        excl(2, 12, 8 * scale, 6),
        excl(4, 26, 5.5 * scale, 5),
        excl(8, 40, 4.5 * scale, 4),
        excl(HOLLOW[0], HOLLOW[1], 10 * scale, 5),
    ]

PATH_MASK = {"type": "layer", "layer": "trodden", "max": 0.35, "soft": 0.15}
SLOPE = lambda m: {"type": "slope", "max": m, "soft": 4}
ROCKFACE = {"type": "layer", "layer": "rock", "max": 0.5, "soft": 0.2}

def tree(id, mesh, density, minD, extra=None):
    r = {"id": id, "mesh": mesh, "density": density, "minDistance": minD, "scale": [0.8, 1.2], "tilt": 2, "sink": 0.3,
         "detail": False, "castShadow": True, "collision": "cylinder", "collisionRadius": 0.35, "impostor": True,
         "wind": 0.3, "flutter": 0.02, "lods": [18, 40, 85], "colorVariation": 0.08,
         "masks": [SLOPE(40), PATH_MASK] + clearing() + sight_excl(2.6) + path_excl(3.2, MAIN_PATH),
         "cluster": {"frequency": 0.025, "strength": 0.5}}
    if extra: r.update(extra)
    return r

def sapling(id, mesh, density, cd):
    return {"id": id, "mesh": mesh, "density": density, "minDistance": 2.4, "scale": [0.7, 1.3], "tilt": 4,
            "wind": 0.12, "flutter": 0.02, "castShadow": True, "lods": [10, 25], "cullDistance": cd,
            "masks": [SLOPE(32), PATH_MASK] + clearing(0.85) + sight_excl(1.6) + path_excl(2.0, MAIN_PATH),
            "cluster": {"frequency": 0.05, "strength": 0.6}, "impostor": False}

scatter = [
    tree("fir", "conifer:fir", 2.2, 4.8),
    tree("pine", "conifer:pine", 1.2, 5.5, {"collisionRadius": 0.3}),
    sapling("fir-sapling", "conifer:fir-sapling", 1.6, 70),
    sapling("pine-sapling", "conifer:pine-sapling", 1.0, 65),
    {"id": "backdrop", "mesh": "conifer:fir", "density": 2.8, "minDistance": 5, "scale": [0.9, 1.3], "sink": 0.3,
     "detail": False, "castShadow": False, "impostor": True, "wind": 0.3, "lods": [1, 2, 3], "cell": 64,
     "masks": [excl(0, 0, 96, 6), SLOPE(50)]},
    {"id": "boulders", "mesh": "cabin:snowrock", "density": 0.22, "minDistance": 10, "scale": [1.0, 2.4], "tilt": 8,
     "sink": 0.35, "detail": False, "castShadow": True, "collision": "sphere", "lods": [25, 60], "cullDistance": 130,
     "colorVariation": 0.06,
     "masks": [PATH_MASK, excl(0, -8, 12, 6), excl(2, 14, 4, 3), excl(7, 32, 4, 3)] + sight_excl(3.6, 4.0, 28),
     "cluster": {"frequency": 0.03, "strength": 0.6}},
    {"id": "rocks", "mesh": "cabin:snowrock", "density": 1.0, "minDistance": 3.2, "scale": [0.3, 0.75], "tilt": 14,
     "alignToNormal": 0.6, "sink": 0.1, "detail": True, "castShadow": True, "lods": [14, 32], "cullDistance": 70,
     "colorVariation": 0.06,
     "masks": [PATH_MASK, excl(0, -8, 11, 4), excl(2, 14, 3, 2), excl(7, 32, 3, 2)] + sight_excl(1.5, 4.0, 14) + path_excl(1.8, MAIN_PATH, 3.0),
     "cluster": {"frequency": 0.05, "strength": 0.7}},
    {"id": "drifts", "mesh": "cabin:drift", "density": 2.2, "minDistance": 3.0, "scale": [0.9, 2.2],
     "sink": 0.08, "detail": True, "castShadow": False, "lods": [20, 45], "cullDistance": 85, "colorVariation": 0.03,
     "masks": [PATH_MASK, excl(0, -8, 8.5, 2), excl(-9, -5, 4.5, 2), {"type": "slope", "max": 30, "soft": 6}] + sight_excl(1.8, 3.0, 22) + path_excl(2.4, MAIN_PATH, 3.0),
     "cluster": {"frequency": 0.06, "strength": 0.7}},
    {"id": "shrubs", "mesh": "cabin:shrub", "density": 3.0, "minDistance": 2.2, "scale": [0.7, 1.4],
     "sink": 0.05, "detail": True, "castShadow": True, "lods": [10, 25], "cullDistance": 55, "colorVariation": 0.1,
     "masks": [PATH_MASK, SLOPE(34), excl(0, -8, 17, 6), excl(2, 14, 9, 5), excl(7, 32, 5, 3), excl(HOLLOW[0], HOLLOW[1], 5, 3)],
     "cluster": {"frequency": 0.05, "strength": 0.7}},
    {"id": "snowlogs", "mesh": "cabin:snowlog", "density": 0.35, "minDistance": 8, "scale": [0.8, 1.2],
     "alignToNormal": 1, "sink": 0.1, "detail": False, "castShadow": True, "lods": [18, 40], "cullDistance": 90,
     "collision": "none", "colorVariation": 0.06,
     "masks": [SLOPE(22), PATH_MASK, excl(0, -8, 18, 6), excl(2, 14, 8, 4)] },
]

def fence_points(poly, step=3.0):
    # walk the polyline, emit (cx, cz, yawdeg) per section
    out = []
    pts = poly
    seg = 0
    px, pz = pts[0]
    i = 1
    while i < len(pts):
        # advance 'step' along the polyline
        remaining = step
        sx, sz = px, pz
        cx, cz = px, pz
        while remaining > 1e-6 and i < len(pts):
            tx, tz = pts[i]
            d = math.hypot(tx - cx, tz - cz)
            if d <= remaining:
                remaining -= d
                cx, cz = tx, tz
                i += 1
            else:
                cx += (tx - cx) / d * remaining
                cz += (tz - cz) / d * remaining
                remaining = 0
        if remaining > 0.5: break
        dx, dz = cx - sx, cz - sz
        yaw = math.degrees(math.atan2(-dz, dx))
        out.append(((sx + cx) / 2, (sz + cz) / 2, yaw))
        px, pz = cx, cz
    return out

props = []
def prop(id, mesh, x, z, yaw=0, scale=1, collision="none", y=0):
    p = {"id": id, "mesh": mesh, "position": [round(x, 2), y, round(z, 2)], "rotation": [0, round(yaw, 1), 0]}
    if scale != 1: p["scale"] = scale
    if collision != "none": p["collision"] = collision
    props.append(p)

prop("cabin", "cabin:house", CAB[0], CAB[1], 0, 1, "box")
prop("woodpile", "cabin:woodpile", -9.4, -6.6, 6, 1, "box")
prop("chop-block", "cabin:chopblock", -5.2, -2.0, 0, 1, "cylinder")
prop("shed", "cabin:shed", 14.5, -13.5, -42, 1, "box")
for i, (x, z, yaw) in enumerate(fence_points(FENCE)):
    prop(f"fence-{i+1}", "cabin:fence", x, z, yaw, 1, "box")
# drifts hugging the cabin and outbuildings
for i, (x, z, s, yaw) in enumerate([
    (-4.4, -4.6, 1.2, 10), (4.6, -4.4, 1.3, 70), (-5.6, -9.0, 1.7, 30), (0, -13.6, 2.4, 0), (-3.5, -13.2, 1.8, 90),
    (5.8, -12.4, 1.6, 40), (-12.4, -6.0, 1.5, 120), (-9.6, -8.6, 1.6, 0), (13.0, -12.0, 1.3, 20), (16.4, -14.8, 1.5, 50),
    (-2.4, -2.1, 0.8, 0), (2.5, -2.0, 0.8, 80), (8.0, -6.5, 1.5, 15), (-7.6, -4.2, 0.9, 0)]):
    prop(f"drift-{i+1}", "cabin:drift", x, z, yaw, s)
# ring of snow-capped boulders around the frozen hollow
for i in range(9):
    a = i / 9 * math.tau + 0.4
    r = 9.2 + 1.6 * math.sin(i * 2.3)
    prop(f"hollow-rock-{i+1}", "cabin:snowrock", HOLLOW[0] + math.cos(a) * r, HOLLOW[1] + math.sin(a) * r, i * 47, 1.0 + 0.9 * ((i * 7) % 5) / 4, "none", -0.15)

terrain = {
    "size": 230, "resolution": 321, "source": {"type": "procedural"},
    "height": 34, "baseFrequency": 0.0045, "octaves": 5, "warp": 20,
    "flatten": [
        {"x": CAB[0], "z": CAB[1], "radius": 30, "height": 0.4},
        {"x": HOLLOW[0], "z": HOLLOW[1], "radius": 15, "height": 3.2},
    ],
    "paths": [
        {"points": MAIN_PATH, "width": 1.5, "layer": "trodden", "smoothing": 1.0},
        {"points": [[-0.8, 8.5], [-4.5, 2.2], [-8.5, -2.2], [-9.2, -4.6]], "width": 1.2, "layer": "trodden", "smoothing": 1.0},
        {"points": [[3.4, -2.6], [7.5, -6.5], [11.5, -10.5], [14.2, -11.8]], "width": 1.1, "layer": "trodden", "smoothing": 1.0},
    ],
    "layers": [
        {"id": "snow", "material": "cabin/snow", "scale": 3.0, "surface": "snow", "color": "#e9eff6", "roughness": 0.92, "slope": [0, 36], "noise": 0.3},
        {"id": "trodden", "material": "cabin/trodden-snow", "scale": 2.4, "surface": "snow", "color": "#b9c6d6", "roughness": 0.85, "slope": [88, 90]},
        {"id": "snow-rock", "material": "cabin/snow-rock", "scale": 4.0, "triplanar": True, "surface": "rock", "color": "#aeb5be", "roughness": 0.8, "slope": [30, 52], "noise": 0.5},
        {"id": "rock", "material": "cabin/rock", "scale": 5.0, "triplanar": True, "surface": "rock", "color": "#5c5f66", "roughness": 0.78, "slope": [46, 90]},
    ],
}

def mood(id, name, **kw): 
    kw.update(id=id, name=name); return kw

moods = [
    mood("blue-hour", "Blue hour",
         sky={"zenith": "#1c3768", "horizon": "#9fb3d8", "ground": "#34415e", "stars": 0.3},
         sun={"azimuth": 255, "elevation": -1.5, "color": "#ff9a6e", "intensity": 0.5, "discSize": 0.6},
         ambient={"sky": "#6a8fd0", "ground": "#3d4d70", "intensity": 1.1, "ibl": 0.6},
         fog={"color": "#6d88b8", "density": 0.005, "heightFalloff": 0.05, "baseHeight": 0, "sunScatter": 0.1},
         post={"exposure": 0.0, "contrast": 0.14, "saturation": 0.1, "temperature": -0.2, "tint": 0.0, "bloom": 1.3, "vignette": 0.35, "nightLights": 1, "shafts": 0},
         particles=["snow"], audio="cabin-blue-hour"),
    mood("midday", "Midday",
         sky={"zenith": "#2f6dbd", "horizon": "#bcd8ee", "ground": "#dde7f1"},
         sun={"azimuth": 165, "elevation": 33, "color": "#fff3e0", "intensity": 5.2, "discSize": 0.55},
         ambient={"sky": "#a3c3ea", "ground": "#c9d7e7", "intensity": 1.1, "ibl": 0.5},
         fog={"color": "#bfd3e6", "density": 0.0022, "heightFalloff": 0.04, "baseHeight": 0, "sunScatter": 0.15},
         post={"exposure": -0.3, "contrast": 0.12, "saturation": 0.05, "temperature": 0.0, "tint": 0.0, "bloom": 0.25, "vignette": 0.2, "nightLights": 0, "shafts": 0.3},
         audio="cabin-midday"),
    mood("aurora-night", "Aurora night",
         sky={"zenith": "#040a1e", "horizon": "#12254c", "ground": "#0a1226", "aurora": 1, "stars": 1},
         sun={"azimuth": 205, "elevation": 52, "color": "#a9c1ff", "intensity": 0.7, "discSize": 1.2},
         ambient={"sky": "#3b5c9c", "ground": "#1d2944", "intensity": 0.6, "ibl": 0.4},
         fog={"color": "#17294f", "density": 0.004, "heightFalloff": 0.05, "baseHeight": 0, "sunScatter": 0.05},
         post={"exposure": 0.0, "contrast": 0.14, "saturation": 0.1, "temperature": -0.15, "tint": -0.1, "bloom": 1.0, "vignette": 0.35, "nightLights": 1, "shafts": 0},
         particles=["snow"], audio="cabin-aurora-night"),
]

def yaw_to(fx, fz, tx, tz): return math.atan2(-(tx - fx), -(tz - fz))

cameras = [{"id": k, "position": v[0], "target": v[1], **({"fov": 50} if k == "cabin-front" else {})} for k, v in CAMS.items()] + [
    {"id": "dbg-aerial", "position": [0, 55, 85], "target": [0, 0, -30], "fov": 60},
    {"id": "dbg-east", "position": [18, 2.2, -8], "target": [0, 3, -8], "fov": 55},
    {"id": "dbg-back", "position": [4, 2.5, -24], "target": [0, 3, -8], "fov": 55},
    {"id": "dbg-hollow", "position": [-22, 1.65, 22], "target": [-38, 0.5, 12], "fov": 60},
]

scene = {
    "id": "cabin", "name": "Snowy Mountain Cabin",
    "description": "Deep snow, pines and a lit window at blue hour.",
    "seed": 20261113,
    "terrain": terrain, "scatter": scatter, "props": props,
    "spawn": {"position": [5.5, 0, 29], "yaw": round(yaw_to(5.5, 29, 0, -8), 3)},
    "bounds": {"walkRadius": 95, "photoHalfExtent": 108, "photoMaxHeight": 70},
    "moods": moods, "defaultMood": "blue-hour", "cameras": cameras,
}
json.dump(scene, open('/home/user/modulo-places/src/scenes/cabin/scene.json', 'w'), indent=2)
print('wrote', len(scatter), 'rules', len(props), 'props')
