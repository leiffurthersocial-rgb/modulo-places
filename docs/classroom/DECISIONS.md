# DECISIONS.md: Modulo: Classroom

Format: **what**, **why**, **alternatives rejected**. IDs use the prefix `C-` to stay separate from the Places log (`/DECISIONS.md`, D-001…). Citations refer to tags in `RESEARCH.md`.

---

### C-001: Build Classroom in the existing `modulo-places` repo, as a separate entry

- **What**: `classroom.html` → `src/classroom/main.ts`, served at `/classroom.html` (Vercel rewrite `/classroom`). Docs live in `docs/classroom/`. Places stays untouched at `/`.
- **Why**: GitHub access in this session is scoped to this repo, and I can't create a new one. The repo already has the toolchain you asked for (Vite + TS strict, ESLint/Prettier, Vitest, Playwright with SwiftShader, CI, Vercel Git integration, KTX2/meshopt asset pipeline, `/lab`, quality presets, touch input with an iPad pointer-lock fallback). Rebuilding that would cost days.
- **Rejected**: (a) a new repo: needs you to create it and add it to the session; easy to switch later because `src/classroom` is self-contained. (b) Replacing Places: destructive. **Open question 1 in PLAN.md.**

### C-002: Reference photos are kept local only

- **What**: `reference/*.jpg|png|heic` is gitignored. `reference/README.md` holds my written observations of layout, proportions and materials.
- **Why**: the repo is **public**, and the photos show identifiable real people (apparently students). Committing them would publish them.
- **Rejected**: committing as-is; blurring faces myself (still publishes the room and bodies, and is your call).

### C-003: The sim is pure TypeScript, enforced by lint

- **What**: `src/classroom/sim/**` may not import three, render, ui, audio or input, and may not use `window`, `document`, `performance`, `Math.random` or `Date.now`. ESLint enforces this (verified: a probe file fails with 3 errors).
- **Why**: determinism per seed, the headless balance runner (500 seeds in Node), and testability.
- **Rejected**: convention only (drifts); a separate package/workspace (overhead now; possible later).

### C-004: PRNG = sfc32 seeded via splitmix32; seeds from `?seed=` (integers or words)

- **Why**: sfc32 has 128-bit state, is fast, has full state save/restore (for saves), and `fork(label)` gives independent per-system streams. Word seeds ("monday") are friendlier to share.
- **Rejected**: mulberry32 (used in Places; 32-bit state, fine for scatter but short for long sims); `Math.random`.

### C-005: Fixed 20 Hz simulation tick with render interpolation and `timeScale`

- **Why**: requested; decouples sim from the 30/60 FPS caps; the runner uses `timeScale` ≫ 1; menus can use 0. At most 8 ticks per frame (no spiral of death). A float-rounding epsilon makes 120 × 1/120 s exactly 20 ticks (unit-tested).

### C-006: Teacher AI = hierarchical state machine + utility scoring for routine choice

- **What**: the 14 listed states are explicit HFSM states with entry/exit telegraphs. Inside the _routine_ super-state, the next activity (board, facing class, patrol, laptop, check desks…) is chosen by utility with **buckets** (alarm > lesson-script > routine) and **inertia/cooldowns**, using seeded weighted random from the top-k choices [UTIL]. Profiles (Strict/Lazy/Distracted/Hawk/Substitute) are data: sense ranges, rates, weights, penalty strictness.
- **Why**: stealth needs consistent, readable reactions with telegraphing [SC][SCBAL][HITMAN]; a utility layer gives variety without losing control [BSA][UTIL].
- **Rejected**: a pure BT (fine, but awkward for long-lived states like "watching student X" with timers and telegraphs, and an HFSM is easier to show in debug); GOAP (reduces authorial control, unnecessary for one room [BSA]); pure utility (unpredictable at exactly the moments that must be readable [BSA]).

### C-007: Students = utility over needs with buckets; relationships = affinity + memory log

- **Why**: Sims-style needs/motives [WP-The Sims][UTIL] give believable fidgeting; buckets keep the lesson phase in charge; Dwarf Fortress-style "thoughts" [WP-Dwarf Fortress] make relationships explainable ("Mara remembers you snitched").
- **Rejected**: BT per student (more authoring per archetype); numeric-only relationships (not explainable in the notebook UI).

### C-008: Perception model (from Splinter Cell Blacklist + Mark of the Ninja)

- Vision: inner cone + coffin mid zone + peripheral zone; up to 6 sample points per student; a stance-dependent visible-point threshold; timers scaled by distance, light and teacher state [SC]. Occluders: 2.5D boxes (tables, columns, people capsules), not mesh raycasts (cost, determinism).
- Hearing: noise events with radius/priority, attenuated by surface material and path through the room graph; off-screen hearing ×0.5 [SC][NINJA].
- Interest sources with roles (leader / investigator / bystander) [NINJA]; changed-object events with a lifetime [SC]; tiered barks [SC].
- Search: last known position first, then widen; a cautious search ends after phase 1 [SEARCH].
- **Rejected**: plain cone + single raycast (over-detects at distance; binary feel [SC]); simulation-accurate hearing (feels unfair [SC]).

### C-009: Navigation = pure-TS grid A* in the sim; navcat as a future drop-in

- **What**: 0.1 m occupancy grid per room, rasterised from the layout and inflated by agent radius; A* (octile) + string pulling + simple priority-yield avoidance; moved furniture re-rasterises its footprint. Room graph with door choke nodes for multi-room.
- **Why**: deterministic, headless, tiny (6,300 cells), no WASM, and trivially handles moved chairs.
- **Rejected for now**: recast-navigation-js (WASM ~2 MB unpacked, async init, overkill for one room [RECAST]); three-pathfinding (no navmesh generation, no dynamic obstacles [3PF]); flow fields (for thousands of units [CROWD]). **navcat** (pure JS, dynamic obstacles, crowds [NAVCAT]) is the candidate if more rooms make grids awkward.

### C-010: Rapier for the player capsule and loose props only; NPCs are kinematic on the grid

- **Why**: NPC movement must be deterministic and headless; physics props are presentation that _report_ noise and landing events. Sim outcomes never depend on bit-exact Rapier results.
- **Rejected**: Rapier character controllers for all NPCs (cost on iPad, determinism across devices not guaranteed by us).

### C-011: WebGL2 first, behind a thin renderer seam; WebGPU revisited after Phase 3

- **Why**: WebGPU shipped in Safari 26 [WK-26][CIU], but our post stack (pmndrs postprocessing, N8AO) is WebGL-only, and older iPadOS has no WebGPU. A seam keeps a later port contained.

### C-012: iPad input and media unlock

- No Pointer Lock on iPadOS Safari [CIU] → drag-to-look and the touch look area (reuse Places `InputManager`). One "Tap to enter class" gesture resumes the AudioContext [MDN-WA] and primes video (`playsinline muted`, element kept in the DOM because autoplay needs it visible [WK-VIDEO]). The device's video `play()` is always called inside the input handler that opens the device.

### C-013: Battery Saver suggestion from frame time, not the Battery API

- The Battery API is unsupported in all Safari versions [CIU] and secure-context only [MDN-BAT]. Use `getBattery()` opportunistically elsewhere; on iPad rely on p90 frame time plus a manual toggle.

### C-014: Detection fairness contract (design rule)

- Every catch is preceded by a **≥ 1 s telegraph** (≥ 2 s at long range) unless the evidence is extreme and in the inner cone (e.g., a phone playing audio at 1 m). Every catch produces a **detection log entry** (sense, evidence, body points visible, distance, exposure time) that drives the "How you got caught" card. The balance runner reports catches without telegraph as a bug.

### C-015: Layout coordinate convention

- 1 unit = 1 m. Origin = front-left floor corner; +x toward the window wall, +z toward the back, +y up. Seat `facing` 0° looks at the board (−z). Wall fixtures use (along-wall, height) from each wall's start corner. Validated in `sim/layout.ts`, unit-tested.

### C-016: Greybox palette approximates the reference materials

- Brown carpet, warm-grey concrete, honey-wood slats over a dark gap, white tables, chrome, plywood chairs, red-brown door, yellow pinboard. This keeps Phase-4 material swaps intuitive and keeps the greybox readable in screenshots.

---

## Build decisions (Phases 1–3, greybox)

### C-017: Player collision runs in the sim (circle vs. oriented boxes), not Rapier

- **What**: the player is a 0.22 m circle resolved against the layout's static boxes and other people, inside `sim/player.ts`. Rapier is not used by Classroom yet.
- **Why**: the balance runner's bots must drive the _same_ player code headless and deterministically (500 lessons in about a minute). The room is flat, so a capsule-in-physics adds nothing yet. Thrown paper balls and planes use a deterministic ballistic + collider march.
- **Deviation from the brief** ("Rapier for the player capsule and loose props"): flagged here. Rapier can be added later for purely visual props (tumbling chairs) that only _report_ noise to the sim (C-010).

### C-018: Nav radius 0.25 m; the layout was reshaped for connectivity

- The first layout split the room into disconnected regions: the teacher's desk sealed the left lane off from the front, and the sink sealed the back lane. The desk got smaller, the sink and bin moved, and the rows shifted (`classroom-a.json`). A unit test now checks paths between all spots and seats.

### C-019: Laptop vs. phone visibility asymmetry (core stealth rule)

- Phone held in the lap: the tabletop slab hides it from a far viewer. It is visible from close by (looking over the table, < 1.3 m) or from behind or the side.
- Laptop on the table: content is readable only from behind the student (screen side). From the front the teacher only sees "absorbed in the screen" (weak evidence).
- So the two devices are opposite risks: the phone is risky when the teacher patrols behind or close, the laptop when the teacher is behind you. This came from the 2.5D occluder model, not from special cases.

### C-020: Post-penalty grace period

- After a penalty the target gets 25 s (player) / 20 s (classmates) of no new suspicion. Before this, bots out of their seat were re-caught every ~5 s, escalating to "call home" within a minute (unfair and unreadable). This is enforced by tests.

### C-021: The phone is confiscated on a device catch

- Consequences change the sandbox: a confiscated phone means the laptop (riskier from behind) or nothing. A written warning moves your assigned seat to the front "hot seat".

### C-022: The substitute goes by the seating chart

- `knowsNames: false`. If you're caught sitting in someone else's seat, the substitute writes down that seat's owner. You escape the penalty, they lose 20 affinity and remember it. That is the "seating trick" from the brief, with a social cost.

### C-023: Evidence-based suspicion (what, not who)

- Being visible is never suspicious by itself. Suspicion comes from visible _evidence_ (device content, fumbling the quick-switch, out of seat without cover, a note in hand, peeking, cheat sheet, prank setup, throwing) times zone factor × distance falloff × light × teacher focus/distraction. Hearing adds impulses for attributable noises, or sends the teacher to investigate unattributed ones (thrown objects = distractions).

### C-024: Synthesized audio for the greybox

- All sounds (steps, chair squeaks, marker squeak, teacher speech murmur, radiator knocks, bell, device audio) are WebAudio synthesis (`audio/audio.ts`). There are no asset licences to track before Phase 4, and it works offline. The AudioContext is created and resumed only inside the "Enter class" gesture (iPad).

### C-025: Placeholder "video" is procedural

- The in-class "episode" is an original canvas cartoon ("Duck Odyssey"). Real CC-BY / CC0 clips (e.g. Blender open movies) are Phase 4 work with licence entries.

### C-026: Work split with cheaper models

- At your request, self-contained parts went to Sonnet subagents: the audio engine, the unit-test suite + balance runner, and the benchmark route + memory estimate. Architecture, sim and gameplay code stayed in the main session. Every subagent change was reviewed, typechecked and tested before commit.
