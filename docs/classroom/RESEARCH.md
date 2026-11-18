# RESEARCH.md: Modulo: Classroom, STEP 1

Every source below is a page or PDF I actually opened in this session (fetched with curl through the session proxy, then read as text). Search-engine snippets that I did not open are **not** cited. Where my sourcing was thin, I say so and mark the conclusion as my own design reasoning.

Short tags used in the text:

| Tag             | Source (opened)                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[SC]**        | M. Walsh, "Modeling Perception and Awareness in Tom Clancy's Splinter Cell Blacklist", _Game AI Pro 2_, ch. 28. https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter28_Modeling_Perception_and_Awareness_in_Tom_Clancy's_Splinter_Cell_Blacklist.pdf  |
| **[NINJA]**     | "How to Catch a Ninja: NPC Awareness in a 2D Stealth Platformer" (Mark of the Ninja), _Game AI Pro_, ch. 32. https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter32_How_to_Catch_a_Ninja_NPC_Awareness_in_a_2D_Stealth_Platformer.pdf                   |
| **[ALIEN]**     | T. Thompson, "The Perfect Organism: The AI of Alien: Isolation", Game Developer. https://www.gamedeveloper.com/design/the-perfect-organism-the-ai-of-alien-isolation                                                                                     |
| **[HITMAN]**    | T. Thompson, "The AI of Hitman (2016)", Game Developer. https://www.gamedeveloper.com/design/the-ai-of-hitman-2016-                                                                                                                                      |
| **[SCBAL]**     | T. Thompson, "Bringing Balance to Stealth AI in Splinter Cell: Blacklist", Game Developer. https://www.gamedeveloper.com/design/bringing-balance-to-stealth-ai-in-splinter-cell-blacklist                                                                |
| **[SEARCH]**    | "Looking for Trouble: Making NPCs Search Realistically", _Game AI Pro 2_, ch. 27. https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter27_Looking_for_Trouble_Making_NPCs_Search_Realistically.pdf                                                     |
| **[UTIL]**      | D. Graham, "An Introduction to Utility Theory", _Game AI Pro_, ch. 9. https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter09_An_Introduction_to_Utility_Theory.pdf                                                                                      |
| **[BSA]**       | "Behavior Selection Algorithms: An Overview", _Game AI Pro_, ch. 4. https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter04_Behavior_Selection_Algorithms.pdf                                                                                            |
| **[SOCIAL]**    | "A Simple and Practical Social Dynamics System", _Game AI Pro_, ch. 35. https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter35_A_Simple_and_Practical_Social_Dynamics_System.pdf                                                                        |
| **[ZONES]**     | "Smart Zones to Create the Ambience of Life", _Game AI Pro 2_, ch. 11. https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter11_Smart_Zones_to_Create_the_Ambience_of_Life.pdf                                                                          |
| **[CROWD]**     | "Efficient Crowd Simulation for Mobile Games", _Game AI Pro_, ch. 24. https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter24_Efficient_Crowd_Simulation_for_Mobile_Games.pdf (introduction only)                                                        |
| **[WP-x]**      | Wikipedia articles: Stealth game, Thief: The Dark Project, Metal Gear Solid (1998), The Sims, RimWorld, Dwarf Fortress, Persona 5, Bully (video game), Hello Neighbor, Papers, Please, Not Tonight (video game). `https://en.wikipedia.org/wiki/<title>` |
| **[RECAST]**    | recast-navigation-js README. https://raw.githubusercontent.com/isaac-mason/recast-navigation-js/main/README.md                                                                                                                                           |
| **[NAVCAT]**    | navcat README. https://raw.githubusercontent.com/isaac-mason/navcat/main/README.md                                                                                                                                                                       |
| **[3PF]**       | three-pathfinding README. https://raw.githubusercontent.com/donmccurdy/three-pathfinding/main/README.md                                                                                                                                                  |
| **[RBG]**       | Red Blob Games, "Introduction to A*" and "Grid pathfinding optimizations". https://www.redblobgames.com/pathfinding/a-star/introduction.html, https://www.redblobgames.com/pathfinding/grids/algorithms.html                                             |
| **[3D-INT]**    | "From Research To Games: Interacting With 3D Space", Game Developer. https://www.gamedeveloper.com/design/from-research-to-games-interacting-with-3d-space                                                                                               |
| **[WK-VIDEO]**  | J. Noble, "New `<video>` Policies for iOS", WebKit blog. https://webkit.org/blog/6784/new-video-policies-for-ios/                                                                                                                                        |
| **[WK-26]**     | "WebKit Features in Safari 26.0", WebKit blog. https://webkit.org/blog/17333/webkit-features-in-safari-26-0/                                                                                                                                             |
| **[MDN-AUTO]**  | MDN, "Autoplay guide for media and Web Audio APIs". https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay                                                                                                                                   |
| **[MDN-WA]**    | MDN, "Web Audio API best practices". https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices                                                                                                                                       |
| **[MDN-PL]**    | MDN, "Pointer Lock API". https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API                                                                                                                                                               |
| **[MDN-PAN]**   | MDN, "PannerNode". https://developer.mozilla.org/en-US/docs/Web/API/PannerNode                                                                                                                                                                           |
| **[MDN-BAT]**   | MDN, "Battery Status API". https://developer.mozilla.org/en-US/docs/Web/API/Battery_Status_API                                                                                                                                                           |
| **[CIU]**       | caniuse data files (Fyrd/caniuse on GitHub) for `pointerlock`, `battery-status` and `webgpu`. https://raw.githubusercontent.com/Fyrd/caniuse/main/features-json/pointerlock.json (and `battery-status.json`, `webgpu.json`)                              |
| **[3JS]**       | three.js docs pages for VideoTexture, InstancedMesh, LightProbe and SkinnedMesh. `https://threejs.org/docs/pages/<Class>.html` (these pages render mostly client-side, so I only used them to confirm the APIs)                                          |
| **[3JS-FORUM]** | "Safari/any web browser crash on iPhone when use WEBGL", three.js forum. https://discourse.threejs.org/t/safari-any-web-browser-crash-on-iphone-when-use-webgl/81629                                                                                     |

Not reachable or not usable: the three.js _manual_ pages (raw GitHub paths returned 404, and the site is client-rendered), Apple developer forum threads (client-rendered), GDC Vault, bugs.webkit.org, and Tom Leonard's 2003 Thief sensory article (I could not find a working URL). I don't cite any of these.

---

## 1. Stealth and detection

### What professionals do

- **Perception is not awareness.** [SC] separates _perceiving_ something from becoming _aware_ of what it is. Splinter Cell abstracts this into a timer/progress bar with an intermediate "investigate" state partway up the bar.
- **Body-part raycasts, not a single point.** Blacklist raycasts to **eight bones**. Detection only starts once enough bones are visible for the player's stance (cover needs more visible bones) [SC].
- **Distance-scaled timers inside vision shapes.** Inside a vision shape, unobstructed and lit, a timer starts. Its length depends on distance, lighting and NPC state; when it fills, the NPC perceives the player and becomes aware of them [SC].
- **Cone + "coffin" shape + peripheral zone.** A plain cone over-detects far off to the sides. Blacklist used a fast inner cone, a coffin-shaped box (expands, then contracts with distance) and a peripheral shape. The most inclusive shape the player is in sets the timer range [SC].
- **Hard edges are unavoidable; consistency matters more.** Every shape has a threshold, and "1 cm outside" means never seen. The goal is a _consistent_ model with good feedback, not a perfect one [SC]. Fair = predictable reaction distances and timing, with varied animations and barks [SC][SCBAL].
- **Hearing = event radius + priority, with path distance.** Every audio event has a radius and a priority. Distance is measured through room connectivity (choke points such as doors and windows), not in a straight line [SC]. Mark of the Ninja pathfinds from the sound to each agent over a "sound mesh", so a guard behind a wall inside the radius does not hear it [NINJA].
- **Off-screen fairness.** Being heard by an NPC you can't see feels unfair. Blacklist **halved hearing for off-screen NPCs** that were far enough away that not hearing was plausible, and the game "instantly became more fun" [SC].
- **Changed objects** (opened doors, lights switched off) create an event with a lifetime. The first NPC to witness it claims it and investigates. Blacklist said this gave "more bang for our buck than any other system". The reaction must be sold with an animation and a bark [SC].
- **Tiered barks** (specific → generic → "Huh?") avoid repeating memorable lines [SC].
- **Interest sources live in the world; interests live in the brain.** Mark of the Ninja had about 60 data-defined interest-source types (sight or sound, priority, radius, TTL). When several agents detect the same source, the source assigns **roles** (leader / investigator / bystanders), so a group looks coordinated with no group manager [NINJA].
- **Searching.** Search starts at the **last known position** (phase 1), then widens (phase 2). Cautious searches walk, glance around and usually stop after phase 1. Letting only one NPC investigate lets the player split groups [SEARCH].
- **Director vs. agent, and no cheating.** Alien: Isolation's director always knows where the player is but only gives the alien _hints_. The alien must find the player with its own senses. A "menace gauge" rises with proximity and line of sight, and the director **backs off when menace peaks** so the player gets breathing room. The alien has short "eyes in the back of the head" rays so walking right behind it does not work. Designers could mark areas it never looks at, to avoid unfair catches [ALIEN].
- **Routines must be predictable.** In Hitman, NPC routines must be predictable and reliable because players plan around them. "Behaviour zones" pulse out from events and set how crowd NPCs react (look, avoid, alert) [HITMAN]. Animations telegraph AI decisions so the player can read them [HITMAN].
- **Light and sound as mechanics.** Thief was the first PC stealth game to use light and sound as mechanics. Soft surfaces (carpet, grass) keep footsteps quiet; metal and tile are loud. "Moss arrows" muffle footsteps [WP-Thief]. Guards that see or hear something briefly ignore it, but react if it lasts [WP-Thief]. Stealth AI must be deliberately _ignorant_ of parts of the world [WP-Stealth game]. Metal Gear Solid's Alert → Evasion → normal cycle shows how a readable alert phase decays [WP-Metal Gear Solid].

### What I decided because of it

1. **Three awareness levels per student** (none → _suspicious_ = "watching / investigate" → _caught_), driven by a **suspicion value 0..1 per student**. It rises at a rate from senses and falls slowly. The _investigate_ threshold sits partway up, as in [SC].
2. **Vision** = inner cone (fast) + coffin-shaped mid zone + peripheral zone, all data-driven per teacher profile. **Raycasts to 6 sample points** (head, torso, left and right hand, held item, device screen) against a 2D/2.5D occluder set (tables, columns, other people as capsules). A stance-dependent minimum of visible points is needed before the timer starts [SC].
3. **"What" matters, not just "who".** A visible student is not suspicious by default. Suspicion rises from **visible evidence** (lit device screen, phone in hand, out of seat during a lesson, note in hand, looking at a neighbour's paper during a test). This is the classroom version of Hitman's "suspicious outfit" logic [HITMAN].
4. **Hearing** = noise events (radius, priority, type), attenuated by **surface material** (carpet ×0.4, hard floor ×1.0; values to tune) and by **room connectivity** (doors as choke points once there are several rooms) [SC][NINJA][WP-Thief]. Off-screen halving rule from [SC].
5. **Interest sources + roles** for every non-player agent (teacher and classmates): a dropped object makes nosy classmates glance and the teacher investigate [NINJA].
6. **Room-state memory**: the teacher keeps a snapshot of key object states (window, chairs, marker, clock offset, poster order, projector input). Differences become "changed object" interests with a bark ("Who opened the window?") [SC]. This is the core of the prank system.
7. **Telegraphing (1–2 s) and an after-action summary**: head-turn ramp, speech trailing off, footsteps turning. When caught, show _"How you got caught"_: which sense, which evidence, the distance, and how long you were visible. This is my design, built on [SC]'s "player perception wins" and [SCBAL]'s fairness framing.
8. **Lesson director with a pressure gauge** (from [ALIEN]): it gives the teacher patrol _hints_ and backs off after the class has been pressured. It never feeds the teacher information its senses don't have.

---

## 2. Social and NPC simulation

### Sources and takeaways

- **The Sims**: a goal-less sandbox where players direct Sims' moods and desires. Its design drew on Maslow's hierarchy of needs [WP-The Sims]. [UTIL] describes how The Sims uses response curves on needs (motives) to score actions, and how "bucketing" stops a starving Sim from scoring fun actions.
- **RimWorld**: a "storyteller" picks events based on what will make the most interesting narrative for the colony's current situation. Pawns have a mood meter driven by needs, traits and backstory, and break down when needs go unmet [WP-RimWorld].
- **Dwarf Fortress**: dwarves accumulate negative "thoughts" from experiences (even drinking the same alcohol again, or lacking a bedroom). Nobles get negative thoughts when their demands go unmet [WP-Dwarf Fortress]. Takeaway: **small, specific memories** that colour behaviour.
- **Persona 5**: a single school year under a day/night calendar that governs behaviour "similar to a social simulation game", plus Confidant links [WP-Persona 5]. Takeaway: a **lesson timeline** that structures when social actions are possible.
- **Bully**: attending classes is presented as minigames, and authority figures respond according to a **"trouble" meter** in the HUD [WP-Bully]. Takeaway: escalation that is _visible in effects_. I avoid its violence, as you asked.
- **Hello Neighbor**: first-person aim-to-interact, carry and throw items. Press coverage quoted on the page sold an AI that "learns from your every move", while the final game's gameplay, controls and technical performance were heavily criticised [WP-Hello Neighbor]. Takeaway: don't over-promise "learning". Make adaptation **legible** (the teacher sits you at the front and watches you more).
- **Papers, Please**: tension from small per-entrant decisions, citations for mistakes, and an end-of-day budget for your family [WP-Papers, Please]. Takeaway: the **end-of-day report** and the penalty ladder as a daily rhythm.
- **Not Tonight**: the Wikipedia page I opened gave almost no mechanics detail, so I take nothing from it.
- **Social dynamics**: gaze ("a character gazing at an object is aware of it"), proxemics (distance by relationship) and posture as readable social signals [SOCIAL]. **Smart Zones** put "living scenes" (e.g., a break-time cluster) in zones that cast available NPCs into roles [ZONES]. Hitman's per-NPC knowledge comes from sensors plus shared "services", and its behaviour trees use LOD updates for distant agents [HITMAN].

### Utility AI vs. behaviour trees vs. GOAP (for 1 teacher + ~10 students)

|                              | FSM / HFSM | Behaviour tree | Utility                                                                         | GOAP                                                                          |
| ---------------------------- | ---------- | -------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Predictability / readability | high       | high           | lower: "somewhat unpredictable", needs scripted overrides for set moments [BSA] | low: characters "can become loose cannons" and reduce authorial control [BSA] |
| Variety / emergence          | low        | medium         | high: dynamic scores give emergent behaviour [BSA]                              | high                                                                          |
| Tuning cost                  | low        | medium         | "more art than science" [BSA]                                                   | medium (actions are easy, plans hard to steer)                                |
| Oscillation risk             | none       | low            | real; fix with **inertia/commitment bonus or cooldowns** [UTIL]                 | low                                                                           |
| Cost per agent               | tiny       | small          | small (score N actions)                                                         | search per replan                                                             |

**Decision**:

- **Teacher**: explicit **hierarchical state machine** for the states you listed (needed for telegraphing and fair, readable reactions [SC][HITMAN]), plus **utility scoring only for choosing the next routine activity** (patrol vs. board vs. laptop vs. check desks), with bucketing (dual utility) and inertia [UTIL]. The lesson script and personality profile change the weights. Alarm states (Investigating / Watching / Confronting) always win via a priority bucket.
- **Students**: **utility over needs** (boredom, anxiety, sleepiness, sociability, curiosity), Sims-style, with **bucketing** so lesson phase and teacher proximity gate which actions can be scored [UTIL]. Weighted random choice from the top few options [UTIL], seeded.
- **No GOAP.** Ten agents in one room don't need planning, and it costs authorial control [BSA].
- **Relationships**: directed affinity −100..100 plus a short **memory log** of notable events (Dwarf Fortress-style thoughts) that decay. Personalities (snitch, nosy, helpful…) are weight sets.

---

## 3. Navigation in a furniture-dense room

- **recast-navigation-js**: a WebAssembly port of Recast/Detour with navmesh generation, pathfinding, **crowd simulation** and temporary obstacles, plus three.js helpers [RECAST]. Its WASM package `@recast-navigation/wasm` is ~2.0 MB unpacked (`npm view`), it needs async init, and its README itself points to **navcat** [RECAST].
- **navcat**: pure JavaScript, JSON-serialisable navmesh generation and querying, tree-shakeable, with examples for crowd simulation, dynamic obstacles and doors [NAVCAT].
- **three-pathfinding**: queries a navmesh you build elsewhere. It doesn't generate navmeshes or support dynamic obstacles; it clamps movement for FPS controls [3PF].
- **Grids**: grids are represented as graphs for A*/Dijkstra [RBG]. For one 9 × 7 m room, a **0.1 m occupancy grid is 90 × 70 = 6,300 cells**, so A* over it is trivially cheap.
- **Crowds**: flow fields pay off for **thousands** of units on mobile [CROWD]. That is overkill for 11 agents.
- Splinter Cell's **room-connectivity graph** (areas + choke nodes) is what makes hearing and "where could they come from" work across rooms [SC].

**Decision**: a **pure-TypeScript grid navigator inside `sim/`**. A 0.1 m occupancy grid is rasterised from the layout (tables, chair footprints, columns, props, walls) and inflated by agent radius. A* (octile) + line-of-sight string pulling + a tiny **local avoidance** (agents yield by priority; the teacher has right of way). It is deterministic, runs headless at 20 Hz, and has no WASM. **Moved chairs** just re-rasterise their footprint cells and bump a grid version, which invalidates affected paths. **Multi-room readiness**: one grid per room plus a **room graph** whose door nodes are choke points (for paths _and_ sound distance [SC]). If later rooms make grids awkward, swap in **navcat** behind the same `Navigator` interface.

---

## 4. Interaction design (first person, tablet-friendly)

Sourcing here is thin. [3D-INT] gives the basics: selection by **ray-casting** with clear feedback about what is about to be selected, and keeping a list of selectable objects so you don't test the whole world. Hello Neighbor's aim-a-reticle-to-interact/throw model [WP-Hello Neighbor] is the genre baseline. The rest is my design reasoning:

- One **context-sensitive primary verb** (E / tap button) on the highlighted object, plus a **verb wheel or second button** only where several verbs exist (e.g., chair: sit / swivel / move). Prompts show the verb and the _noise_ or _risk_ icon ("Sit", "Pick up (loud)").
- Interact ray from the camera, ~1.6 m reach, **sphere-cast with radius 6–8 cm** (generous for touch), with priority to the item in hand's target.
- Carry: one small item, held low on the right. Throw = hold to charge (power arc preview), release to throw. The throw makes a noise event where it lands, not where you stand. That is the distraction tool.
- Tablet: big buttons, a hold-to-act ring for held actions (do real work, quick-switch to the decoy), the look area on the right half, the joystick on the left (reusing the Places touch controls).

---

## 5. Three.js techniques

- **In-world screens**: `CanvasTexture` (mini-game) and `VideoTexture` (clips) exist as documented [3JS]. Update the canvas texture only when the game draws a frame (≤ 30 Hz), not every render.
- **Screen glow**: an emissive screen material, plus one small `PointLight`/`SpotLight` per _active_ device (max 1–2), tinted from the screen's average colour, low range (≈1.5 m). This lights the face and the desk. The teacher's vision model also reads a "screen lit" flag, so a bright screen is visible evidence. This is my design; the light API is standard three.js.
- **Interior shadows**: one shadow-casting directional "window" light. The room is small, so shadow frustum = room bounds, which gives good texel density. The fill comes from a `LightProbe` (spherical harmonics, [3JS]) baked from the greybox in Phase 4, plus baked AO. The existing Places pipeline already provides N8AO SSAO, AgX and SMAA.
- **Instancing**: tables, chair parts and ceiling slats are already `InstancedMesh` in the hello-world [3JS]. Overview camera: low tens of draw calls.
- **~12 characters**: `SkinnedMesh` with shared skeletons [3JS]. Animation LOD (update rate) per quality tier, as Hitman does with its behaviour-tree LOD [HITMAN].
- **Post-processing on iPad**: reuse the Places tiering (half-res AO on Medium, tone mapping only on Battery Saver).

## 6. iPad Safari specifics

- **Video autoplay**: muted videos (or videos with no audio track) may autoplay with `playsinline`. Un-muting without a user gesture **pauses** playback. Autoplay **only starts when the element is visible on screen**. "User gesture" means `play()` is called directly from a touchend, click, doubleclick or keydown handler [WK-VIDEO]. Consequence: start video playback **inside the gesture** that opens the device (the tap or key press), and keep the `<video>` element in the DOM (not `display:none`).
- **Web Audio**: "Create or resume context from inside a user gesture." A context can be `suspended`, `running` or `closed` [MDN-WA]. Autoplay policy can be queried, and audio contexts may need sticky activation [MDN-AUTO]. Consequence: a "Tap to enter class" screen unlocks both the AudioContext and video.
- **Pointer Lock**: not supported on iOS/iPadOS Safari, while desktop Safari supports it [CIU]. `requestPointerLock()` returns a promise and supports `unadjustedMovement` [MDN-PL]. Consequence: feature-detect. On iPad, trackpad/mouse uses press-and-drag to look, and touch uses the look area. The Places `InputManager` already does this.
- **Battery API**: not supported in any Safari version [CIU]. It is secure-context only [MDN-BAT]. Consequence: suggest Battery Saver from frame-time statistics plus a manual toggle; use `getBattery()` only where it exists.
- **WebGPU**: shipped in Safari 26.0 [WK-26]. caniuse data marks iOS Safari 26.6+ as supporting it [CIU]. Consequence: still **WebGL2 first** (our post stack, N8AO/postprocessing, is WebGL-only), but keep render code behind our own small `RenderBackend` seam and revisit after Phase 3.
- **Memory**: I found **no official per-tab WebGL memory limit**. The forum thread I opened is an anecdotal report of WebGL crashes on iPhone after some time, with dispose-everything advice [3JS-FORUM]. Consequence: a **self-imposed budget** (PLAN §5), one renderer and canvas for the app lifetime, dispose on room exit, and a `webglcontextlost` handler.

## 7. Interior realism and spatial audio for stealth

- Carpet vs. hard floors for footstep loudness is canonical since Thief [WP-Thief]. Our room has carpet, so steps are quiet. The sink corner (tiles) and the area by the door (hard floor strip) can be **loud zones**, a deliberate stealth feature.
- `PannerNode` gives positional audio with HRTF or equal-power panning and distance models (`distanceModel`, `refDistance`, `rolloffFactor`) [MDN-PAN]. Muffling behind obstacles: a per-source low-pass `BiquadFilter` driven by the same occlusion test the sim uses for hearing (my design).
- Sounds as _cues_: teacher footsteps (direction changes), the chair squeak when the teacher sits, the marker squeak while writing at the board (= back turned), speech trailing off (= attention shifting). These map 1:1 to subtitles for accessibility (Phase 6).

---

## Recommended architecture (one page)

```
src/classroom/
  sim/        PURE TS (lint-enforced: no three, no DOM, no Math.random/Date.now)
    rng.ts clock.ts layout.ts                     ← exist (STEP 0)
    world.ts        World state: rooms, agents, objects, tick(); snapshot/restore for saves
    events.ts       typed event bus (sim → render/audio/ui/hooks); events are data
    nav/            grid.ts (raster from layout), astar.ts, smooth.ts, avoid.ts, roomGraph.ts
    perception/     vision.ts (cone/coffin/peripheral + sample-point raycasts on 2.5D occluders),
                    hearing.ts (noise events, material + path attenuation, off-screen fairness),
                    interests.ts (interest sources → interests in brains, role assignment)
    teacher/        hfsm.ts (states), activities.ts (utility pick w/ buckets + inertia),
                    suspicion.ts (per-student meters, telegraph timers), profiles (data)
    students/       needs.ts, actions.ts (utility), routines, barks
    social/         relationships.ts (affinity + memory log), notes.ts (chain), opinions
    activities/     devices.ts (screen state, decoy, earbud), cheating.ts, pranks.ts (data-driven)
    lesson/         script.ts (seeded timeline), events.ts, director.ts (pressure gauge)
    record/         ladder.ts (penalties), report.ts (end-of-day), detectionLog.ts ("how you got caught")
    runner/         headless balance runner + bot play styles (Node, Phase 2)
  data/       JSON: layouts/, lessons, events, pranks, teacher-profiles, student-archetypes,
              note-templates, barks, interactables  (+ TS validators, unit-tested)
  render/     three.js: greybox.ts (exists), agents (capsules + labels), devices (Canvas/Video
              textures, glow), gizmos (vision/hearing), interpolation from sim snapshots
  audio/      reuse Places AudioEngine patterns: positional cues, occlusion low-pass
  input/      controller interface; keyboard+mouse (pointer lock), touch, iPad trackpad drag
  ui/         minimal diegetic HUD, interact prompts, notebook relationships page, menus, debug (F3)
  save/       versioned localStorage saves + migrations (try/catch, no hard dependency)
  app.ts      composition root: sim tick 20 Hz, render interpolation, menus pause sim/render
```

Key principles:

- **Sim is the single source of truth**; render/audio/UI only read snapshots and events. The same sim runs in the browser and in the headless runner.
- **Physics (Rapier) is presentation plus player collision**: thrown objects and chairs are Rapier bodies, but they only _report_ landing and noise events into the sim. Sim-critical outcomes never depend on Rapier being bit-identical. For determinism tests, landing points are resolved by the sim's own simple ballistic + grid check (the Rapier body follows the visual).
- **Everything spatial is per room** (`roomId` on every entity) plus a room graph, so a hallway is just another layout file.

## Risks

| #   | Risk                                                                   | Likelihood | Mitigation                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Fairness tuning of detection**: "caught for no reason" kills the fun | high       | Telegraph timers, the "how you got caught" summary, off-screen hearing halving [SC], the balance runner (Phase 2), debug gizmos from day 1                                                                                      |
| 2   | **NPC CPU cost on iPad** (11 agents × perception raycasts × 20 Hz)     | medium     | 2.5D occluders (≈40 boxes, no mesh raycasts), sample points ≤ 6, perception staggered across ticks (each agent senses at 5–10 Hz), grid A* only on demand. Budget: **≤ 2 ms per sim tick** on iPad (measured by the F3 overlay) |
| 3   | **Skinned characters on iPad** (Phase 5)                               | medium     | ≤ 10k tris, shared skeletons and atlases, animation LOD, capsules as fallback on Battery Saver                                                                                                                                  |
| 4   | **iPad memory**: video textures + KTX2 + render targets                | medium     | Budget in PLAN §5, video ≤ 480p on Battery Saver, one video element live at a time, dispose on exit                                                                                                                             |
| 5   | **Video/audio unlock on iPad**                                         | medium     | A "Tap to enter class" gesture unlocks AudioContext and video together; `playsinline muted`; visible-element rule [WK-VIDEO]                                                                                                    |
| 6   | **Scope**: the spec is very large                                      | high       | Strict phase gates. Greybox must be fun before any assets. Each system ships with its debug view and tests.                                                                                                                     |
| 7   | **No real GPU here**                                                   | certain    | Your device runs through the benchmark route; SwiftShader only for correctness                                                                                                                                                  |
| 8   | **Asset licensing** (Phase 4/5)                                        | medium     | LICENSES.json gate test (already exists for Places), skip NC/ND, record authors                                                                                                                                                 |
| 9   | **Two projects in one repo** grow tangled                              | low        | Separate entry, `src/classroom/` folder, shared code only through `src/engine/` modules that are already generic                                                                                                                |
