# 小队编队 · 俯视关卡

A top-down level about moving a squad as one body: member widths, formation
slots, a fold window derived from each member's lateral speed and the space
behind them, a release gate driven by the *measured* tail, and a viewport that
shows trajectories, the narrowest gap and reserved positions.

Zero runtime dependencies. Node 22+, ES modules, Canvas2D shared by the browser
and the headless captures.

## Run

```bash
npm test              # integration tests + clearance tests + headless DOM smoke
npm run serve         # http://localhost:8137/web/
```

Verifying the browser UI needs Playwright in `PW_ROOT` (default `/tmp/pw`) and a
Chromium build with its libraries on `LD_LIBRARY_PATH`; `tools/chrome.sh` sets
those up:

```bash
node tools/serve.mjs 8137 . &
tools/chrome.sh tools/ui-test.mjs
```

Headless PNG captures use `@napi-rs/canvas` from the same tree:

```bash
CANVAS_ENTRY=/tmp/pw/node_modules/@napi-rs/canvas/index.js \
  node tools/capture.mjs B side lag last out/b.png
```

## Model

**Route** (`src/geo/route.js`). Nodes carry `(x, y, w)`; bends are rounded with
tangent arcs, then resampled by arc length (`ds≈0.02`). `widthAt` interpolates
the wall clearance along the centreline. `maxLatAt(route, s, r)` is the largest
lateral offset a disc of radius `r` can hold: it samples the disc footprint
along the centreline, so a sudden narrowing acts as a wall rather than a funnel,
and applies a curvature correction so tight bends do not admit wall penetration.
`corridorViolations` reports any bend whose radius is smaller than the corridor
half-width (an invalid corridor that folds over itself).

**Formation** (`src/sim/formation.js`). Two templates: `wide` (two columns) and
`file` (one column). The fold is staged — backs settle first, the lateral slide
occupies the last 45% — so members sharing a wide/file station cannot collide
mid-morph. `foldCost` finds the member that takes longest to slide; `swapSlots`
regroups the entrance.

**Planner** (`src/sim/planner.js`). The leader's walkable polyline is only a
candidate. `computeSEnter` finds the first station where the wide formation
stops fitting. `solveFold` derives the window from each member's slide time and
the space behind the rear body:

    slide time   t_i = |latW_i| / vLat_i
    latest start S0_i = sEnter - r_i + backW_i - vLead * t_i
    earliest        = max(rear space, file depth - vLead * tFold) + margin

**Engine** (`src/sim/engine.js`). Motion is in `(s, l)`. Members are advanced
toward their slot, clamped by their own forward/lateral limits and the wall
envelope; an analytic per-lane queue keeps bodies from overlapping. A release
gate holds the leader at the throat until `tailSettled()` — the fold is complete
*and* the measured leader-to-tail span fits the maximum column stretch. Strategies
only change discipline, not physics: `wait` honours the gate, `early` folds at
spawn but still honours it, `side` takes the branch with more run-up, `rush`
ignores the gate, `none` never folds.

## Levels

- **A · 突窄门** — a short, abrupt squeeze (3.0 m → 1.35 m) on a straight
  approach. There is only about a metre of run-up, so the window for folding is
  tight.
- **B · 侧廊** — the same 1.35 m door twice: a direct route with its own short
  throat, and a long side aisle with room to pre-file.
- **C · 弯外柱** — a long left bend whose outer apex carries a pillar, followed
  by a short 1.35 m throat. The wide formation clips the pillar with 阿岚; the
  file formation slips past it. This level is checked by the per-member
  clearance system below, and its preview lets you drag the pillar.

Each level has a steady squad and a scenario where rear member 小满 temporarily
lags (reduced forward and lateral speed for a few seconds). Waiting for the
tail, folding early, and taking the side aisle each absorb the lag differently;
the tests assert that wait/early/side arrive while `none` jams in the door and
`rush` tears away from the lagging member.

## Clearance (`src/sim/clearance.js`, `src/sim/clearance-session.js`)

The planner answers "when should the squad fold?". The clearance system answers
"can this *formation* physically get through, and where does it stop?" — with a
cache keyed on the route and the members, **never on a squad-centre point**.

**Units.** The route is cut into 0.4 m *cells* (50 for Level C). Each cell
stores its tangent frame, worst wall half-width, curvature pad, and an
`uncertain` flag: true where the curvature is sharp, the width jumps, or a node
falls inside the cell. For every cell and every member the cache holds a
verdict and the failure record (member, kind, station, margin).

**Sweep.** `evaluateCell` walks the member's slot lateral plus its radius along
the cell's fine station grid, and tests both walls (via the conservative
`capLowerBound`) and pillars. Each cell keeps the set of members it actually
swept (`covMembers`) and the pillars it actually tested, so a clean cell is a
claim about named bodies, not a scalar.

**Safe-skip certificates.** A cell can skip a member only when both hold:

    walls:   capLowerBound(cell, r) >= edge - small tolerance
    pillars: no pillar's station window can reach the band's lateral reach

`cellCoverage` records which members were skipped and why. `stats.skipped`
counts those skipped member checks; `stats.checks` counts the ones performed.
Uncertain cells never take a skip: they drop to the 0.02 m fallback grid and
sweep **all** members, so a corner is never certified by coarser geometry. That
is the rule this feature is built around — speed must come from provably-safe
skips, never from reducing collider precision.

**Swept intervals.** `sweptIntervals` merges per-cell verdicts into contiguous
`clear` / `blocked` / `unknown` spans. Each span carries the members swept
there, the real lateral band they cover (`span:{lo,hi}`), and their `reach`, so
the preview draws the ground the bodies actually occupy. A blocked span names
the bodies that broke it.

**Incremental operations** (`ClearanceSession`):

| operation | revalidates | why |
| --- | --- | --- |
| drag a pillar (`setPillars`) | cells within `maxEdge + r + pad` of the moved station, old and new | only those can newly touch or clear the band |
| widen a tail member (`setMemberRadius`) | cells whose prior verdict failed, whose wall is near the new reach, or lie near a pillar | only its own band changed |
| flip formation (`setTemplate`) | cells reachable by slots whose lateral offset actually moved | unchanged slots keep their verdicts |
| widen every outer kit (`widenOuterMembers`) | union of the per-slot radius windows | centre path unchanged, only bands grow |

Every update returns the work done (`stats`), the cells revalidated, the
`firstStop`, and a `changed` diff of spans that truly flipped state.

**Full reference.** `fullReference(..., {strict:true})` disables every skip and
cache and sweeps all members on the fine grid. `session.verify()` compares the
incremental per-cell, per-member verdicts against it and asserts equality — the
tests run this after each operation and after 12 random pillar drags.

**Level C measurements.** Full reference = 250 member checks (50 cells × 5).

    baseline wide : 180 checks, 70 skipped (28%), 32 corner fallbacks -> stop s=9.58 阿岚
    baseline file : 160 checks, 90 skipped (36%), 32 corner fallbacks -> passes
    file -> wide  : revalidates 26/50 cells (12 narrow-road, 14 wide-road),
                    125 checks, 21 corner fallbacks, 12 spans newly fail
    wide -> file  : revalidates 26/50 cells, 105 checks, 12 spans recover
    tail +0.22 m  : revalidates 10/50 cells (4 narrow, 6 wide), 38 checks
    pillar drag   : revalidates 8-10/50 cells for a 0.6-2.5 m move, 40-50 checks

So on the narrow road every affected cell is recomputed at full member width
(the fallback sweeps all members at corners); the savings come entirely from
the wide road, where cells certify themselves per member. On Level C's wide
formation, 68 of the 122 checks on wide-road cells are skipped by certificate,
and on the file formation 90 of 160.

**Same centre path, wider outer kit.** `widenOuterMembers` is the case a
centre-point cache cannot represent: slots and route are identical, only the
outer members' radii grow (#2-#5 by +0.10 m). The session reports 0 revalidated
cells when the gain stays inside the certified clearance, and 10-12 cells once
a band reaches the wall or a pillar — then it re-checks only those.

**First stop per switch.** `firstStop` returns the earliest failing station
along travel with the responsible body. Flipping file → wide moves the stop
from "passes" to `s=9.58 阿岚 (pillar)` at the bend; dragging a pillar onto the
entrance moves it to `s=2.00 金石`; an oversized tail makes the throat the
first stop instead. There is no aggregate "formation fits" boolean without this
per-body station.

## Acceptance (`test/acceptance.js`)

Required: slot continuity (no per-frame jumps), velocity limits once in file,
walls (independent tube-containment test, not the simulator's own envelope),
narrow-gap reporting, wide-does-not-fit / file-does, and a reproducible stop
position when a run fails. Additional informative checks: all-arrived, slot
fidelity and fold-window membership.

## Viewport (`web/`, `src/render/scene.js`)

Faint per-member trajectories, hollow rings for reserved file positions, a
cyan cross-bar at the narrowest gap, and a red stop marker with its station on
failure. The entrance list lets you drag non-leader members between slots; the
planner is recomputed immediately, so the fold window visibly changes. Playback
and scrubbing follow the recorded trace.

On Level C the preview instead paints the clearance result: a thin band at each
member's real lateral extent along every swept span, red where a span fails, a
solid pillar (yellow while dragged), and yellow dashed halos over the cells the
last edit revalidated. Dragging a pillar recomputes only the cells it can reach,
so the halo visibly shrinks and the first-stop marker moves live. A compact
report beside the canvas lists the revalidated cell count, member checks,
skipped checks, corner fallbacks, and how many spans truly failed or recovered.
