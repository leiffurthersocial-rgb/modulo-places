# PLAN.md: Modulo: Classroom

Status: **draft, waiting for your OK.** STEP 0 (environment + hello-world deploy) and STEP 1 (research) are done. I won't start Phase 1 until you approve.

Docs: `ENVIRONMENT.md`, `SETUP.md`, `RESEARCH.md` (sources + recommended architecture + risks) and `DECISIONS.md` (C-001…C-016), all in `docs/classroom/`.

---

## 1. Where it lives (needs your OK, see question 1)

Classroom is a **second app in the `modulo-places` repo**: entry `classroom.html` → `src/classroom/`, deployed at `/classroom`. Places is untouched. Classroom reuses Places' generic engine pieces where they fit: touch/keyboard input with the iPad pointer-lock fallback, settings persistence, quality presets, the post pipeline (N8AO, AgX, SMAA), the KTX2/meshopt asset pipeline, `/lab`, the licence gate test, and Playwright profiles. All classroom-specific code stays under `src/classroom/`.

## 2. Milestones and review stops

Phases follow your spec. I commit after every milestone and **stop for review at the end of each phase**.

| #                                   | Milestone              | Done when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1: Greybox vertical slice**      |                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| M1.1                                | App shell + player     | `app.ts` composition root (sim 20 Hz + render interpolation + pause). First-person controller on a Rapier capsule with collision against the layout (walk, sprint, crouch/sneak, lean, look down). Controller interface: keyboard+mouse with Pointer Lock, iPad trackpad drag-look, touch joystick and buttons (reused). FOV, sensitivity and remap settings.                                                                                                                                                                             |
| M1.2                                | Interaction + seats    | Data-driven interactables (id, verbs, noise profile, effect hooks). Sphere-cast highlight + prompt. Sit/stand at chairs. Carry and throw one small item (paper ball), with a noise event on landing.                                                                                                                                                                                                                                                                                                                                      |
| M1.3                                | Nav + students         | Grid navigator (A*, smoothing, yield-avoidance, moved-chair re-raster). 6 student capsules with name labels, simple utility routines (notes, doodle, whisper, yawn, glance, fidget) and seat/pencil-sharpener trips.                                                                                                                                                                                                                                                                                                                      |
| M1.4                                | Teacher + senses       | Teacher HFSM (all 14 states; the P1 subset fully playable: board, facing class, patrol, laptop, investigate noise, watching, confronting, penalty). Vision (cone/coffin/peripheral, 6-point raycasts on 2.5D occluders, light and screen glow). Hearing (material-attenuated noise events, off-screen fairness). Per-student suspicion with telegraphs. **F3 debug**: FPS, draw calls, tick ms, teacher state, suspicion bars, vision and hearing gizmos, free camera, time scale, force-event buttons.                                   |
| M1.5                                | Device + lesson        | Phone and laptop with a placeholder arcade mini-game on a `CanvasTexture`, brightness, screen glow. Quick-switch to the decoy notebook, with the fumble rule and the switch-frequency rule. Lesson timeline (seeded script) and a working wall clock. "Out of seat" suspicion with cover reasons (pencil, bin, question).                                                                                                                                                                                                                 |
| M1.6                                | First penalty + polish | Verbal warning: confront bark, a "How you got caught" card, the teacher's attention raised for the rest of the lesson. Unit tests (cone/occlusion, hearing attenuation, determinism, navigation). Playwright: screenshots (desktop + iPad) + scripted interaction test (sit → device → get warned) + console-error gate. Deployed preview.                                                                                                                                                                                                |
| **Stop 1**                          | Review                 | Summary, screenshots, sim tick cost, open questions, P2 proposal                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **P2: Greybox depth**               |                        | Relationships + memory log. Note chains (visible in transit, interceptable). Cheating in tests. ≥ 6 pranks (data-driven). Full penalty ladder (warning → seat change → detention mode → call home + grade drop). 5 teacher profiles incl. Substitute. 8 lesson types + events. Earbud. Break time. Wishlist challenges. Save/load (versioned, migrations). End-of-day report. **Headless balance runner: 500 seeds × bot play styles**, reporting catch rate, penalty frequency, catches without telegraph and "boring" runs. **Stop 2.** |
| **P3: Performance + Battery Saver** |                        | Presets Ultra/High/Medium/Low/Battery Saver/Custom (classroom table in §5). FPS cap, paused rendering in menus or a hidden tab, reduced sim tick in menus. Watchdog. Benchmark route. iPad memory budget verified via the estimator plus your device run. Media unlock flow. **Stop 3.**                                                                                                                                                                                                                                                  |
| **P4: Assets + look dev**           |                        | `fetch-assets.ts` / `process-assets.ts` extended for classroom sources; `LICENSES.json` gate; `/lab` with ≥ 8 candidates for concrete, carpet, ceiling slats and table top; PBR swap; original posters/decals; 3 lighting moods; baked AO + light probes; dust motes. **Stop 4.**                                                                                                                                                                                                                                                         |
| **P5: Characters**                  |                        | Fictional, permissively licensed or parametric characters on a shared skeleton, the listed animations, ≤ 10k tris, licences recorded. **Stop 5.**                                                                                                                                                                                                                                                                                                                                                                                         |
| **P6: Polish**                      |                        | Main menu, settings, accessibility (subtitles for audio cues, reduced motion, colour-blind-safe cues, UI scale), tutorial lesson, credits, final perf pass. **Stop 6.**                                                                                                                                                                                                                                                                                                                                                                   |

## 3. Core system designs (Phase 1–2 detail)

### 3.1 Sim loop and events

- `World.tick()` at 20 Hz runs, in order: lesson script → director → perception (staggered: each agent senses at 10 Hz on alternating ticks) → teacher HFSM → students → social/notes → record. Everything random comes from `rng.fork(system)`.
- **Event bus** (sim → render/audio/UI/hooks): `noise`, `bark`, `suspicion-telegraph`, `caught`, `penalty`, `note-passed`, `prank-effect`, `object-changed`, `lesson-phase`, … Events are plain data, so they can be logged in the runner and replayed in tests. Future systems (e.g. a horror director) subscribe here. I'm only preparing the hook, not building it.

### 3.2 Teacher (C-006)

HFSM super-states: **Routine** {TeachBoard (back turned), TeachFacing, Patrol, StandBehind, CheckDesks, HandOut, AnswerQuestion, UseLaptop (distracted), LeaveRoom, Return} and **Alarm** {Investigate, Watch(target), Confront(target), ApplyPenalty}. Inside Routine, the next activity is picked by utility (bucketed, inertia, top-k weighted random). The lesson script biases weights (lecture → board; worksheet → patrol + check desks; film day → laptop + lights dimmed).

**Suspicion per student** (hidden; shown only in F3):

```
each perception tick (0.1 s):
  v = visible sample points / required points (stance-dependent), clamp 0..1
  z = zone factor (inner 1.0 · coffin 0.6 · peripheral 0.3)
  d = 1 − (dist / zoneRange)²
  ℓ = light factor (dim 0.5 … lit 1.0; lit device screen ≥ 0.9)
  e = max weight of visible evidence (phone/laptop content 1.0, glance at neighbour in test 0.7,
      note in hand 0.6, out of seat without cover 0.4, decoy fumble 1.2 …)
  S += rate · profile.vision · v · z · d · ℓ · e · dt
  hearing: S += loudness_at_teacher · typeWeight (impulse, then becomes an interest source)
  no evidence: S −= decay · dt, floored at the "heat" baseline (raised by past warnings)
thresholds: 0.35 → Watch (telegraph: head turn, speech slows)
            0.70 → approach / investigate the last known position
            1.00 held ≥ 0.75 s with evidence still visible → Confront → penalty
```

Each threshold crossing schedules a **telegraph of ≥ 1 s** before the next state takes effect (C-014). The detection log records why.

### 3.3 Students

Needs: boredom, anxiety, sleepiness, sociability, curiosity (0..1, drift per tick, lesson phase modifiers). Actions are scored by utility with buckets (lesson-compliant / idle fidget / social / disruptive). Personality = weight set + traits (helpful, nosy, anxious, rebellious, goody-goody, snitch). Each student also senses the player (narrower cone) for "neighbour sees your screen" reactions.

### 3.4 Player and "cover"

Out of seat during teaching is evidence (0.4). Cover actions (sharpen pencil, bin, hand in papers, bathroom pass, pick up a dropped item, ask a question) give a **cover token** with a duration and a plausible route. Leaving the route or overstaying turns the evidence back on. Sneaking: crouch halves visible points and noise but makes "crouched out of seat" stronger evidence if seen.

### 3.5 Data files (`src/classroom/data/`, validated + unit-tested)

`layouts/*.json` (exists) · `interactables.json` · `teacher-profiles.json` · `student-archetypes.json` · `lessons.json` · `events.json` · `pranks.json` · `note-templates.json` · `barks.json` (tiered specific → generic → "Huh?") · `penalties.json` · `devices.json`.

### 3.6 Multi-room readiness

Every entity carries a `roomId`; layouts declare openings with `leadsTo`; the nav and hearing use a room graph with door choke nodes. Adding a hallway = a new layout file + a `leadsTo` link. **No other rooms are built** until you ask.

## 4. Lesson timing (proposal, see question 7)

A 45-minute in-game lesson runs in **~10 real minutes** (the wall clock runs 4.5× real time). Phases come from the lesson-type script (e.g. lecture: 5 min intro facing class → 25 min board with patrols → 10 min worksheet → 5 min break-time free roam). The runner uses `timeScale` to simulate a lesson in well under a second.

## 5. Quality tiers and iPad memory budget (classroom)

The room is small, so the budgets are tighter than Places'.

| Setting                     | Ultra              | High               | Medium (iPad default) | Low         | Battery Saver           |
| --------------------------- | ------------------ | ------------------ | --------------------- | ----------- | ----------------------- |
| Render scale (× DPR, cap 2) | 1.0                | 1.0 (DPR ≤ 1.5)    | 0.85                  | 0.75        | 0.75–1.0 at DPR 1       |
| FPS cap                     | 60                 | 60                 | 60                    | 30          | 30                      |
| Window shadow               | 2048, PCF soft     | 2048               | 1024                  | 1024 hard   | off (baked AO only)     |
| Screen-glow lights          | 2                  | 2                  | 1                     | 1           | emissive only           |
| AO                          | N8AO high          | N8AO medium        | N8AO half-res         | baked only  | baked only              |
| Post                        | bloom, grade, SMAA | bloom, grade, SMAA | grade, SMAA           | grade, FXAA | tone map only           |
| Textures                    | 2k                 | 2k                 | 1k                    | 1k          | 512/1k                  |
| Video texture               | 720p               | 720p               | 720p                  | 480p        | 480p                    |
| NPC animation rate          | full               | full               | 30 Hz                 | 20 Hz       | 15 Hz, far agents 10 Hz |
| Audio voices                | 32                 | 32                 | 24                    | 16          | 12                      |

**iPad memory target (Medium) ≤ ~500 MB**: GPU textures ≤ 180 MB, geometry ≤ 40 MB, render targets ≤ 80 MB, video ≤ 20 MB, JS heap incl. Rapier ≤ 180 MB. **Battery Saver ≤ ~350 MB**. Both stay well under your ~1 GB ceiling. The F3 overlay shows the running estimate. These are self-imposed budgets: no official Safari limit was found (RESEARCH §6).

## 6. Testing

- **Vitest**: detection math (cone/coffin/peripheral membership, occlusion by tables/columns/people, sample-point thresholds), hearing attenuation (material, distance, off-screen rule), suspicion thresholds and telegraph timing, determinism (same seed → identical event log hash after N ticks), navigation (paths around the U, moved-chair invalidation, no path through tables), layout/data schema validation. P2 adds relationships, note chains, pranks, penalty ladder, save round trip + migration.
- **Playwright**: screenshots per camera × {desktop, iPad keyboard, iPad touch}; a scripted interaction test; a console-error gate; and (P4) one smoke test per lighting mood.
- **Balance runner** (P2), **benchmark route** (P3).

## 7. What I need from you

1. **OK on this plan**, especially **keeping Classroom in this repo** as `/classroom` (C-001). If you prefer a separate repo, create it and add it to the session; moving `src/classroom` is easy now.
2. **Reference photos**: I kept them local and gitignored because the repo is public and the photos show real people (C-002). OK?
3. **Vercel**: Vercel reports the preview of this branch as deployed, but I can't open `*.vercel.app` from here. Please open the branch preview at `/classroom` on your desktop and iPad and tell me whether it renders.
4. **Test hardware**: iPad model, iPadOS version, and whether you use a Magic Keyboard/trackpad.
5. **Language**: English UI only, or English + German (the room looks like a German-speaking school)? I'd build English with all strings in data tables so adding German later is cheap.
6. **Cast**: about 10 fictional upper-secondary students (ages implied 16–18) with invented names from a mixed, neutral name pool. OK?
7. **Lesson length**: ~10 real minutes per 45-minute lesson (§4), or shorter?

## 8. Top risks

See RESEARCH.md "Risks". In short: (1) detection fairness tuning, (2) NPC CPU cost on iPad (budget ≤ 2 ms per sim tick), (3) skinned characters on iPad, (4) iPad memory with video, (5) media unlock on iPad, (6) scope, (7) no real GPU in the container.
