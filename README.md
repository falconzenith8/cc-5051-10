# 小队编队 · 俯视关卡

A top-down level about moving a squad as one body: member widths, formation
slots, a fold window derived from each member's lateral speed and the space
behind them, a release gate driven by the *measured* tail, and a viewport that
shows trajectories, the narrowest gap and reserved positions.

Zero runtime dependencies. Node 22+, ES modules, Canvas2D shared by the browser
and the headless captures.

## Run

```bash
npm test              # integration tests (strategy matrix + acceptance)
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

Each level has a steady squad and a scenario where rear member 小满 temporarily
lags (reduced forward and lateral speed for a few seconds). Waiting for the
tail, folding early, and taking the side aisle each absorb the lag differently;
the tests assert that wait/early/side arrive while `none` jams in the door and
`rush` tears away from the lagging member.

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
