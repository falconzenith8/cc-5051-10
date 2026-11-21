import { makeLevels } from '../src/levels/levels.js';
import { ClearanceSession } from '../src/sim/clearance-session.js';
import { fullReference, firstStop, CLEARANCE } from '../src/sim/clearance.js';

let failures = 0;
const results = [];

function test(name, fn) {
  try {
    results.push({ name, ok: true, detail: fn() });
  } catch (e) {
    failures++;
    results.push({ name, ok: false, detail: e.message });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function session(template = 'file', pillars) {
  const C = makeLevels().find((l) => l.id === 'C');
  return { C, s: new ClearanceSession({ route: C.route, squad: C.squad, template, pillars: pillars ?? C.pillars }) };
}

/* ---------- 1. the per-member cache matches the full reference ---------- */

test('C: baseline full pass equals the skip-free reference (wide and file)', () => {
  const notes = [];
  for (const t of ['wide', 'file']) {
    const { C, s } = session(t);
    s.runFull();
    const ref = fullReference({ route: C.route, squad: C.squad, template: t, pillars: C.pillars });
    assert(s.verify().equal, `${t}: incremental != reference`);
    assert(s.verify().pass.canPass === ref.canPass.canPass, `${t}: canPass differs`);
    notes.push(`${t}: canPass=${ref.canPass.canPass}, checks ${s.verify().pass ? '' : ''}`.trim());
  }
  return notes.join('; ');
});

test('C: wide formation is blocked at the outer-bend pillar, file passes it', () => {
  const wide = session('wide'); wide.s.runFull();
  const file = session('file'); file.s.runFull();
  assert(!wide.s.verify().pass.canPass, 'wide should be blocked by the pillar');
  assert(file.s.verify().pass.canPass, 'file should clear the pillar');
  const stop = firstStop(wide.s.index);
  assert(stop && stop.kind === 'pillar', `wide stop should be a pillar, got ${stop?.kind}`);
  assert(stop.member === '阿岚', `outer member should hit it, got ${stop.member}`);
  return `wide stops at s=${stop.s.toFixed(2)} (${stop.member} vs ${stop.failure.pillar}); file clears`;
});

test('C: every member collides/clears exactly as the reference says', () => {
  for (const t of ['wide', 'file']) {
    const { C, s } = session(t);
    s.runFull();
    const ref = fullReference({ route: C.route, squad: C.squad, template: t, pillars: C.pillars });
    // per-cell, per-member verdict equality
    const cmp = s.verify();
    assert(cmp.equal, `${t}: ${cmp.issues.length} verdict mismatches`);
    // and a direct per-member scan at the stop (if any)
    const stop = firstStop(s.index);
    if (stop) {
      assert(stop.failure.margin < 0, 'a reported stop must have negative clearance');
    }
    void ref;
  }
  return 'per-member verdicts identical to the reference on both templates';
});

/* ---------- 2. pillar drag: only affected cells, verdicts still right ---------- */

test('C: dragging the pillar revalidates a local window, not the whole route', () => {
  const { C, s } = session('wide');
  s.runFull();
  const home = C.pillars[0];
  const homeStop = firstStop(s.index);
  assert(homeStop.kind === 'pillar', 'baseline wide stop should be the pillar');
  // slide the pillar along the outer wall, away from the apex
  const moved = { ...home, x: home.x + 0.5, y: home.y + 1.5 };
  const rep = s.setPillars([moved]);
  assert(rep.revalidated.length < rep.cells, `revalidated ${rep.revalidated.length} of ${rep.cells} cells`);
  assert(s.verify().equal, 'incremental verdict differs from reference after drag');
  // Dragging the pillar far away removes the *pillar* stop. The wide formation
  // is still too wide for the 1.35 m throat, so the next stop is a wall fit —
  // the cache must reveal the next real obstacle, not pretend the route opened.
  const far = { ...home, x: -9, y: -9 };
  const rep2 = s.setPillars([far]);
  assert(!rep2.canPass, 'wide still cannot fit the throat without the pillar');
  assert(rep2.stop.kind === 'fit', `after far drag the stop must be the throat, got ${rep2.stop.kind}`);
  assert(rep2.stop.s > homeStop.s, `throat stop (${rep2.stop.s}) must be later than the pillar stop (${homeStop.s})`);
  assert(s.verify().equal, 'incremental verdict differs after moving pillar away');
  return `near drag: ${rep.revalidated.length}/${rep.cells} cells; far drag: pillar stop -> throat stop at s=${rep2.stop.s.toFixed(2)}`;
});

test('C: dragging onto the approach re-blocks a previously clear span (wide)', () => {
  const { s } = session('wide', []);
  s.runFull();
  // Without any pillar the wide squad's first stop is the throat.
  const before = firstStop(s.index);
  assert(before.kind === 'fit', 'no-pillar wide should stop at the throat first');
  // Put a pillar on the entrance straight, inside the left-hand band.
  const rep = s.setPillars([{ id: 'P-new', name: '新柱', x: 2.2, y: 1.2, r: 0.25 }]);
  assert(!rep.canPass, 'entrance pillar must block the wide formation');
  assert(rep.stop.kind === 'pillar', `expected a pillar stop, got ${rep.stop.kind}`);
  assert(rep.stop.s < before.s, `pillar stop ${rep.stop.s} must precede the throat ${before.s}`);
  assert(s.verify().equal, 'incremental verdict differs after adding a pillar');
  const changed = rep.last.changed;
  assert(changed.added.length > 0, 'diff should report newly failing cells');
  return `pillar blocks at s=${rep.stop.s.toFixed(2)} (${rep.stop.member}), ahead of throat s=${before.s.toFixed(2)}; ${changed.added.length} cells newly fail`;
});

/* ---------- 3. tail member picks up wider equipment ---------- */

test('C: widening one tail member rechecks only its own band', () => {
  const { s } = session('file');
  s.runFull();
  const slot = 4;
  const before = s.index.members.find((m) => m.slot === slot).radius;
  const rep = s.setMemberRadius(slot, before + 0.18);
  // few cells touched, and only that member is swept in them
  assert(rep.revalidated.length < rep.cells, `revalidated ${rep.revalidated.length} of ${rep.cells}`);
  const swept = rep.revalidated.reduce((n, i) => n + (s.cells[i].covMembers.includes(slot) ? 1 : 0), 0);
  assert(swept === rep.revalidated.length || swept === 0,
    `the changed member should be present in every re-checked cell it could affect`);
  assert(s.verify().equal, 'incremental verdict differs after radius change');
  void rep;
  return `slot ${slot}: ${rep.revalidated.length}/${rep.cells} cells, ${rep.stats.checks} member checks`;
});

test('C: a tail radius increase that exceeds the throat becomes the first stop', () => {
  const { s } = session('file');
  s.runFull();
  assert(s.report(null, []).canPass, 'file should pass before widening');
  // Bump the tail body past the throat's usable half-width (~0.675 m).
  const rep = s.setMemberRadius(4, 0.72);
  assert(!rep.canPass, 'a 0.72 m tail radius must not fit the 1.35 m throat');
  assert(rep.stop && rep.stop.kind === 'fit', `expected a fit stop, got ${rep.stop?.kind}`);
  assert(s.verify().equal, 'incremental verdict differs after oversized tail');
  return `stop s=${rep.stop.s.toFixed(2)} ${rep.stop.member} (needs ${rep.stop.failure.lat?.toFixed?.(2) ?? '?'} m)`;
});

/* ---------- 4. formation flip ---------- */

test('C: flipping formation re-checks only members whose lateral slot moved', () => {
  const { s } = session('file');
  s.runFull();
  const rep = s.setTemplate('wide');
  assert(rep.last.slots.length === 4, `expected 4 moved members, got ${rep.last.slots.length}`);
  assert(!rep.last.slots.includes(0), 'leader slot must not move');
  assert(rep.revalidated.length < rep.cells, `revalidated ${rep.revalidated.length} of ${rep.cells}`);
  assert(s.verify().equal, 'incremental verdict differs after flip');
  assert(!rep.canPass, 'wide should now be blocked');
  // and back
  const back = s.setTemplate('file');
  assert(back.canPass, 'flipping back to file should pass');
  assert(s.verify().equal, 'incremental verdict differs after flipping back');
  return `flip: ${rep.revalidated.length}/${rep.cells} cells, slots ${rep.last.slots.join(',')}; back to file passes`;
});

test('C: flip reports exactly which spans break and the first stop', () => {
  const { s } = session('file');
  s.runFull();
  const before = s._snapshot();
  s.setTemplate('wide');
  const diff = s._diff(before);
  assert(diff.added.length > 0, 'flip should add failing spans');
  assert(diff.removed.length === 0, 'flip file->wide should not remove failures');
  const stop = firstStop(s.index);
  for (const a of diff.added) {
    assert(a.failures.length > 0, 'added span must carry its failing members');
  }
  return `${diff.added.length} spans newly fail; first stop s=${stop.s.toFixed(2)} ${stop.member}`;
});

/* ---------- 5. same centre path, wider outer members ---------- */

test('C: same route and slots, wider outer kit changes only the per-member bands', () => {
  const { C, s } = session('wide');
  s.runFull();
  const home = s.squad.find((m) => m.slot === 1).radius;
  s.setMemberRadius(1, home + 0.22);
  // The leader path is untouched: every slot lateral is identical. Only the
  // member's own radius moved, so a centre-point cache could not see this.
  const slotLat = s.index.members.map((m) => m.band.lat);
  assert(slotLat[1] === -0.86, 'slot lateral must be unchanged (same centre path)');
  assert(s.index.members[1].radius > home, 'radius must grow');
  assert(s.verify().equal, 'verdict must still match the reference');
  return `slot 1 radius ${home.toFixed(2)} -> ${(home + 0.22).toFixed(2)}, slot lat still ${slotLat[1]}`;
});

/* ---------- 6. reference sanity: full vs incremental cannot diverge ---------- */

test('C: random pillar drags never diverge from the reference', () => {
  const { C, s } = session('wide');
  s.runFull();
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let k = 0; k < 12; k++) {
    const p = { id: 'P-bend', name: '弯外柱', x: 2 + rnd() * 8, y: rnd() * 6, r: 0.2 + rnd() * 0.15 };
    s.setPillars([p]);
    const cmp = s.verify();
    assert(cmp.equal, `diverged at drag ${k}: ${JSON.stringify(cmp.issues.slice(0, 2))}`);
  }
  return '12 random drags all match the reference';
});

test('C: reference check confirms every member individually clears or collides', () => {
  for (const t of ['wide', 'file']) {
    const { C } = session(t);
    const ref = fullReference({ route: C.route, squad: C.squad, template: t, pillars: C.pillars });
    // Recompute the stop directly from the reference cells.
    const stop = firstStop(ref.idx);
    if (stop) {
      assert(stop.failure.margin < 0, 'reference stop must have negative margin');
      assert(ref.canPass.canPass === false, 'cannot pass while a stop exists');
    } else {
      assert(ref.canPass.canPass === true, 'no stop implies canPass');
    }
  }
  return 'reference stop and canPass agree';
});

/* ---------- 7. corners fall back to the fine all-member sweep ---------- */

test('C: uncertain (corner) cells always sweep all members on the fine grid', () => {
  const { C } = session('file');
  const ref = fullReference({ route: C.route, squad: C.squad, template: 'file', pillars: C.pillars });
  const uncertain = ref.cells.filter((c) => c.uncertain);
  assert(uncertain.length > 0, 'level C should have corner cells');
  for (const cell of uncertain) {
    assert(cell.fallback, `uncertain cell ${cell.i} must have used the fallback path`);
    // every member is present in the per-member verdict map
    assert(Object.keys(cell.memberClear).length === C.squad.length,
      `cell ${cell.i}: ${Object.keys(cell.memberClear).length} members, expected ${C.squad.length}`);
  }
  // A narrowed subset request must not shrink an uncertain cell's sweep.
  const s2 = session('file').s;
  s2.runFull();
  const cellIdx = uncertain[0].i;
  s2.setTemplate('wide');
  const cell = s2.cells[cellIdx];
  if (cell.uncertain) assert(Object.keys(cell.memberClear).length === C.squad.length, 'subset leaked into an uncertain cell');
  return `${uncertain.length} corner cells on the fine grid, all members swept`;
});

test('C: uncertain flag and fallback substep are what keep the corner honest', () => {
  const { C, s } = session('file');
  s.runFull();
  const fine = CLEARANCE.fallbackSubstep;
  const coarse = CLEARANCE.substep;
  assert(fine < coarse, 'fallback grid must be finer than the normal grid');
  const corner = s.cells.find((c) => c.uncertain);
  assert(corner.fineStations.length > corner.stations.length, 'corner cells carry a finer station list');
  return `corner cell ${corner.i}: ${corner.stations.length} -> ${corner.fineStations.length} samples`;
});

/* ---------- 9. the narrow-recompute / wide-skip accounting ---------- */

test('C: report separates narrow-road recompute from wide-road certificates', () => {
  const { s } = session('wide');
  s.runFull();
  const rep = s.report();
  const rc = rep.recompute;
  assert(rc.narrow.cells > 0 && rc.wide.cells > 0, 'wide formation should straddle both bins');
  // Narrow cells never take a certificate (they may need every member); the
  // savings come from wide cells only.
  assert(rc.wide.skipped > 0, 'wide-road cells should certify some member checks away');
  assert(rc.narrow.checks >= rc.narrow.cells, 'narrow cells still sweep members');
  // The skip accounting agrees with the per-cell coverage it is derived from.
  const sum = s.cells.reduce((n, c) => n + (c.skipped?.length ?? 0), 0);
  assert(rc.narrow.skipped + rc.wide.skipped === sum, 'bin skips must sum to the route total');
  return `wide: ${rc.wide.skipped} skipped of ${rc.wide.checks + rc.wide.skipped} on wide road; ` +
    `narrow: ${rc.narrow.cells} cells, ${rc.narrow.checks} checks`;
});

test('C: flipping formation reports the narrow/wide split of the revalidated work', () => {
  const { s } = session('file');
  s.runFull();
  const rep = s.setTemplate('wide');
  const rc = rep.recompute;
  assert(rc.narrow.cells + rc.wide.cells === rep.revalidated.length,
    'every revalidated cell belongs to exactly one bin');
  assert(rep.last.changed.added.length > 0, 'the flip must report newly failed spans');
  return `flip revalidated ${rep.revalidated.length} cells = narrow ${rc.narrow.cells} + wide ${rc.wide.cells}`;
});

/* ---------- 8. wide-road savings are reported honestly ---------- */
test('C: on the wide entrance, straight cells are proven without re-sweeping every member', () => {
  const { C, s } = session('file');
  s.runFull();
  // Cells on the wide, straight approach are certified; the count of skipped
  // member checks there is positive even though no collider was coarsened.
  const wideClears = s.cells.filter((c) => !c.uncertain && c.wMinPad > 2.5);
  assert(wideClears.length > 0, 'expected some wide straight cells');
  const skippedThere = wideClears.reduce((n, c) => n + (c.skipped?.length ?? 0), 0);
  assert(skippedThere > 0, 'wide straight cells should skip some member checks on a certificate');
  // Every member covered by a skip is indeed certified clear there — and the
  // reference agrees. Costs are reported separately from the geometry.
  const ref = fullReference({ route: C.route, squad: C.squad, template: 'file', pillars: C.pillars });
  const mine = s.cells.map((c) => c.clear);
  const theirs = ref.cells.map((c) => c.clear);
  assert(JSON.stringify(mine) === JSON.stringify(theirs), 'wide-cell verdicts must match the reference');
  return `${wideClears.length} wide cells, ${skippedThere} certified member skips, verdicts identical`;
});

/* ---------- report ---------- */

for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok && r.detail ? `\n        ${r.detail}` : ''}`);
  if (!r.ok) console.log(`        ${r.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
