#!/usr/bin/env node
/*
 * Integration tests: the strategy matrix on both levels, under a steady squad
 * and a temporarily-lagging rear member.
 *
 * Expectations are qualitative, not hard-coded times:
 *   - a squad that waits for its tail, or pre-folds in the side aisle, arrives;
 *   - a squad that never folds jams in the door with a real stop position;
 *   - a leader that refuses to wait tears away from a lagging rear member;
 *   - every run satisfies the geometric acceptance checks;
 *   - the fold window is genuinely speed/space-derived and the entrance
 *     regroup changes it.
 */
import { makeLevels } from '../src/levels/levels.js';
import { runLevel } from '../src/sim/run.js';
import { runAcceptance } from '../test/acceptance.js';
import { planRun } from '../src/sim/planner.js';
import { swapSlots } from '../src/sim/formation.js';
import { NODES_A, NODES_B_MAIN, NODES_B_SIDE } from '../src/levels/levels.js';

let failures = 0;
const results = [];

function test(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: true, detail: r });
  } catch (e) {
    failures++;
    results.push({ name, ok: false, detail: e.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run(level, strategy, scenarioId) {
  const scen = level.scenarios.find((s) => s.id === scenarioId) ?? level.scenarios[0];
  return runLevel(level, strategy, scen.lag ? { id: scen.id, lag: scen.lag } : { id: scen.id });
}

const levels = makeLevels();
const A = levels.find((l) => l.id === 'A');
const B = levels.find((l) => l.id === 'B');

/* ---------- 1. the geometry actually poses the problem ---------- */

test('A: wide formation does not fit the throat, file does', () => {
  const { plan } = run(A, 'wait', 'steady');
  const acc = runAcceptance({ plan, result: run(A, 'wait', 'steady').result, level: A });
  assert(acc.checks.formationFit.pass,
    `wide ${acc.checks.formationFit.wideSpan} vs gate ${acc.checks.formationFit.gateWidth}, file ${acc.checks.formationFit.fileSpan}`);
  assert(plan.narrow.w < 1.5, `narrowest ${plan.narrow.w}`);
});

test('B: side branch is materially longer than the direct route', () => {
  assert(B.routes.side.length > B.routes.main.length * 1.35,
    `side ${B.routes.side.length.toFixed(1)} vs main ${B.routes.main.length.toFixed(1)}`);
  // same door clearance on both branches
  const gateMain = Math.min(...B.routes.main.samples.map((s) => s.w));
  const gateSide = Math.min(...B.routes.side.samples.map((s) => s.w));
  assert(Math.abs(gateMain - gateSide) < 0.1, `doors differ: ${gateMain} / ${gateSide}`);
});

test('level nodes are exported for inspection', () => {
  assert(NODES_A.length > 3 && NODES_B_MAIN.length > 3 && NODES_B_SIDE.length > 3, 'node lists');
});

/* ---------- 2. wait / early / side succeed, steady and lagging ---------- */

for (const level of [A, B]) {
  for (const strategy of ['wait', 'early']) {
    for (const scenarioId of ['steady', 'lag']) {
      test(`${level.id}/${strategy}/${scenarioId}: arrives and passes acceptance`, () => {
        const { plan, result } = run(level, strategy, scenarioId);
        assert(result.status === 'arrived', `status ${result.status}: ${result.reason}`);
        const acc = runAcceptance({ plan, result, level });
        const failed = Object.entries(acc.checks).filter(([, v]) => !v.pass).map(([k]) => k);
        assert(failed.length === 0, `failed checks: ${failed.join(', ')}`);
      });
    }
  }
}

test('B/side/lag: route change absorbs the lagging member', () => {
  const { plan, result } = run(B, 'side', 'lag');
  assert(result.status === 'arrived', `status ${result.status}: ${result.reason}`);
  const acc = runAcceptance({ plan, result, level: B });
  for (const req of ['slotContinuity', 'velocityLimits', 'walls', 'narrowGap', 'formationFit', 'stopPosition']) {
    assert(acc.checks[req].pass, `required ${req} failed`);
  }
});

/* ---------- 3. failures remain real and are reported ---------- */

test('A/none: wide squad jams at the door with a stop position', () => {
  const { plan, result } = run(A, 'none', 'steady');
  assert(result.status !== 'arrived', `unexpected success (${result.status})`);
  assert(result.doorStop, 'no door stop reported');
  assert(result.doorStop.s <= plan.narrow.s + 3.2, `stop ${result.doorStop.s} too far past the door`);
  const acc = runAcceptance({ plan, result, level: A });
  assert(acc.checks.stopPosition.pass, acc.checks.stopPosition.note);
});

test('A/rush with a lagging rear member: squad tears', () => {
  const { result } = run(A, 'rush', 'lag');
  assert(result.status === 'torn' || result.status === 'timeout', `status ${result.status}`);
  assert(result.maxTear >= result.maxStretch, `tear ${result.maxTear} < stretch ${result.maxStretch}`);
});

test('A/rush steady: burns the fold window (fails the window check)', () => {
  const { plan } = run(A, 'rush', 'steady');
  const acc = runAcceptance({ plan, result: run(A, 'rush', 'steady').result, level: A });
  assert(!acc.checks.foldWindow.pass, 'rush should start outside the safe fold window');
});

/* ---------- 4. fold window is speed / space derived ---------- */

test('fold window responds to lateral speed and rear space', () => {
  const base = run(A, 'wait', 'steady').plan.fold;
  const slow = A.squad.map((m) => (m.slot === 4 ? { ...m, vLat: 0.2 } : m));
  const slower = planRun({ route: A.route, squad: slow, level: { ...A, squad: slow }, strategy: 'wait' }).fold;
  assert(slower.latest < base.latest, `latest ${slower.latest} !< ${base.latest}`);
  assert(slower.tFold > base.tFold, `tFold ${slower.tFold} !> ${base.tFold}`);
});

test('entrance regroup changes the safe start (slot geometry)', () => {
  const base = planRun({ route: A.route, squad: A.squad, level: A, strategy: 'wait' }).fold;
  const swapped = swapSlots(A.squad, 1, 4);
  const alt = planRun({ route: A.route, squad: swapped, level: { ...A, squad: swapped }, strategy: 'wait' }).fold;
  assert(Math.abs(alt.latestSafe - base.latestSafe) > 0.1,
    `regroup had no effect: ${alt.latestSafe} vs ${base.latestSafe}`);
});

test('lagging member is slower across the fold when its lateral speed drops', () => {
  const { result } = run(A, 'wait', 'lag');
  const t0 = result.trace.find((fr) => fr.t > 1.0);
  assert(t0, 'no frame');
  const lagging = t0.members.find((m) => m.slot === 3);
  const ideal = A.squad.find((m) => m.slot === 3).vLat;
  assert(Math.abs(lagging.vSide) <= ideal + 1e-6, 'lag not applied');
});

/* ---------- report ---------- */

for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok && r.detail ? `\n        ${r.detail}` : ''}`);
  if (!r.ok) console.log(`        ${r.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
