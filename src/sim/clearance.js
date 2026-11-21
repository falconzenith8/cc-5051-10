import { TEMPLATES } from './formation.js';
import { frameAt, maxLatAt, localOf, dot, sub, widthAt } from '../geo/route.js';

/*
 * Per-member swept clearance along a route.
 *
 * The cache key is (station interval, member). A cell is a short station span;
 * each member contributes its own lateral position (formation slot) and its own
 * true radius. A cell is clear only when every member disc clears the walls and
 * every pillar. Nothing here looks at a "squad centre": when the centre path is
 * unchanged but an outer member is wider, or when the squad flips formation, the
 * per-member intervals are what change.
 *
 * Geometry is never coarsened to go faster. Bodies keep their real radii,
 * pillars stay circles, walls use the route envelope. Cells that contain a bend,
 * a width change or a level node are *uncertain*: they fall back to sweeping
 * every member on a finer station grid (strictly more work). The speed gain
 * comes only from not re-sweeping intervals that provably cannot change, and
 * a full reference mode disables every one of those skips so tests can prove
 * the incremental verdicts are identical rather than merely cheaper.
 */

export const CLEARANCE = {
  cell: 0.4,
  substep: 0.05,          // every cell; the same collider resolution everywhere
  fallbackSubstep: 0.02,  // uncertain cells: finer, so a bend never loses detail
  kappaAngle: 0.06,       // swept angle (rad) that makes one cell uncertain
  widthJump: 0.10,        // width change (m) that makes one cell uncertain
  pad: 0.7,               // halo used for conservative skip bounds
  wallTol: 0.02,
  pillarTol: 0.02,
  openMargin: 0.20,       // certified slack required to skip a member check
  maxRadius: 1.2,         // largest body radius the halo bound is built for
};

export function latOf(template, slot) {
  return TEMPLATES[template].slots[slot].lat;
}

export function bandOf(template, slot, radius) {
  const lat = latOf(template, slot);
  return { lat, lo: lat - radius, hi: lat + radius, edge: Math.abs(lat) + radius };
}

export function normalizePillar(route, p) {
  const near = localOf(route, { x: p.x, y: p.y });
  return {
    id: p.id ?? `p${Math.round(p.x * 100)}_${Math.round(p.y * 100)}`,
    name: p.name ?? p.id ?? '柱子',
    x: p.x, y: p.y, r: p.r ?? 0.22,
    s: near.s, l: near.l,
  };
}

function stationsBetween(route, s0, s1, step) {
  const out = [];
  for (let s = s0; s < s1 - 1e-9; s += step) out.push(s);
  out.push(s1);
  return out.map((s) => Math.min(route.length, Math.max(0, s)));
}

function firstIndexAtOrAfter(samples, s) {
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (samples[m].s < s) lo = m + 1; else hi = m;
  }
  return lo;
}

export function buildCells(route, opts = CLEARANCE) {
  const cells = [];
  const ss = route.samples;
  const nodeSet = route.nodeStations ?? [];
  for (let s0 = 0, i = 0; s0 < route.length - 1e-9; s0 += opts.cell, i++) {
    const s1 = Math.min(route.length, s0 + opts.cell);
    // A disc's footprint reaches maxRadius ahead/behind its centre, so any
    // disc inside this cell samples width and curvature over [s0-halo, s1+halo].
    const halo = opts.maxRadius + 0.05;
    const a = firstIndexAtOrAfter(ss, s0 - halo);
    const b = firstIndexAtOrAfter(ss, s1 + halo);
    let kappaCell = 0, kappaPad = 0, wMinCell = Infinity, wMaxCell = -Infinity, wMinPad = Infinity;
    for (let k = a; k <= b && k < ss.length; k++) {
      kappaCell = Math.max(kappaCell, Math.abs(ss[k].kappa ?? 0));
      kappaPad = Math.max(kappaPad, Math.abs(ss[k].kappa ?? 0));
      wMinPad = Math.min(wMinPad, ss[k].w);
      const inside = ss[k].s >= s0 - 1e-9 && ss[k].s <= s1 + 1e-9;
      if (inside) {
        wMinCell = Math.min(wMinCell, ss[k].w);
        wMaxCell = Math.max(wMaxCell, ss[k].w);
      }
    }
    const angle = kappaCell * (s1 - s0);
    const nodeInside = nodeSet.some((n) => n > s0 + 1e-6 && n < s1 - 1e-6);
    const mid = (s0 + s1) / 2;
    cells.push({
      i, s0, s1,
      mid,
      frame: frameAt(route, mid),
      stations: stationsBetween(route, s0, s1, opts.substep),
      fineStations: stationsBetween(route, s0, s1, opts.fallbackSubstep),
      kappaCell, kappaPad, wMinCell, wMaxCell, wMinPad,
      uncertain: angle > opts.kappaAngle || (wMaxCell - wMinCell) > opts.widthJump || nodeInside,
      clear: null, failures: [], memberClear: {}, fallback: false, evaluated: false,
    });
  }
  return cells;
}

export function radiusMap(squad) {
  const m = new Map();
  for (const x of squad) m.set(x.slot, x.radius);
  return m;
}

export function buildIndex({ route, squad, template, cells, pillars = [], radiusBySlot, opts = CLEARANCE }) {
  const radii = radiusBySlot ?? radiusMap(squad);
  const members = squad.map((m) => {
    const radius = radii.get(m.slot) ?? m.radius;
    return { slot: m.slot, name: m.name, radius, band: bandOf(template, m.slot, radius) };
  });
  return {
    route, template, cells, members,
    pillars: pillars.map((p) => normalizePillar(route, p)),
    opts,
  };
}

function stationsFor(cell) {
  return cell.uncertain || cell.fallback ? cell.fineStations : cell.stations;
}

/**
 * Rigorous lower bound on maxLatAt over a cell for a disc of radius r.
 * maxLatAt = min(w/2 - sqrt(r^2-u^2) - 0.5*|k|u^2) and the two non-constant
 * terms are bounded above by r and 0.5*kappaPad*r^2, so no sample is needed.
 */
export function capLowerBound(cell, r) {
  return cell.wMinPad / 2 - r - 0.5 * cell.kappaPad * r * r;
}

/**
 * Sweep one cell over the given members.
 *   strict: ignore every skip (reference path).
 * Statistics land in `stats` as true member-station evaluations; they are the
 * cost measure, and they are never reduced by shrinking a body or a pillar.
 */
export function evaluateCell(cell, idx, stats, strict = false) {
  const { route, members, pillars, opts } = idx;
  const st = stationsFor(cell);
  const f = cell.frame;
  const out = [];
  for (const m of members) {
    const lat = m.band.lat;
    const r = m.radius;

    // --- wall: can be skipped only on a certificate, not a heuristic ---
    const wallCertified = !strict && cell.uncertain === false
      && capLowerBound(cell, r) >= Math.abs(lat) + opts.openMargin;
    // --- pillars: a pillar can only be reached if its station lies within the
    // band's longitudinal footprint of this cell. Longitudinal bound is exact
    // (a body centre at station s can only touch a pillar with |p.s - s| <=
    // r + p.r). The lateral test is a conservative prefilter; an uncertain cell
    // sweeps every pillar regardless.
    const nearPillars = (strict || cell.uncertain)
      ? pillars
      : pillars.filter((p) => Math.abs(p.s - cell.mid) <= r + p.r + (cell.s1 - cell.s0) / 2 + 1e-6);

    if (stats) stats.samples += st.length;
    if (wallCertified && nearPillars.length === 0) {
      if (stats) { stats.skippedMembers++; stats.samples -= st.length; }
      continue;
    }
    if (stats) stats.evaluatedMembers++;

    let worst = null;
    const consider = (cand) => { if (!worst || cand.margin < worst.margin) worst = cand; };

    for (const s of st) {
      if (!wallCertified) {
        const cap = maxLatAt(route, s, r);
        if (cap < Math.abs(lat) - opts.wallTol) {
          consider({ member: m.name, slot: m.slot, kind: 'fit', margin: cap - Math.abs(lat), s, lat, allowed: cap });
        }
      }
      if (nearPillars.length) {
        const fr = frameAt(route, s);
        const c = { x: fr.p.x + fr.normal.x * lat, y: fr.p.y + fr.normal.y * lat };
        for (const p of nearPillars) {
          if (Math.abs(p.s - s) > r + p.r + 1e-6) { continue; }
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          const needD = r + p.r;
          if (d < needD - opts.pillarTol) {
            consider({ member: m.name, slot: m.slot, kind: 'pillar', margin: d - needD, s, pillar: p.name, pillarId: p.id, dist: d, need: needD });
          }
        }
      }
    }
    if (worst) out.push({ ...worst, margin: +worst.margin.toFixed(4), s: +worst.s.toFixed(3), radius: r });
  }
  return out.length ? out : null;
}

function newStats() {
  return { evaluatedMembers: 0, skippedMembers: 0, samples: 0 };
}

function cellPillarsSig(idx) {
  return idx.pillars.map((p) => `${p.id}:${p.x.toFixed(2)}:${p.y.toFixed(2)}:${p.r.toFixed(2)}`).join(';');
}

function range(a, b, n) {
  const out = [];
  for (let i = Math.max(0, a); i <= Math.min(b, n - 1); i++) out.push(i);
  return out;
}

/** Which members and pillars were actually consulted in an evaluation. */
export function cellCoverage(cell, idx) {
  const { route, members, pillars, opts } = idx;
  const st = stationsFor(cell);
  const f = cell.frame;
  const evalMembers = [], skippedMembers = [], evalPillars = new Set();
  for (const m of members) {
    const lat = m.band.lat, r = m.radius;
    const wallCertified = !cell.uncertain && capLowerBound(cell, r) >= Math.abs(lat) + opts.openMargin;
    const nearPillars = cell.uncertain ? pillars : pillars.filter((p) => {
      if (Math.abs(p.s - cell.mid) > r + p.r + (cell.s1 - cell.s0) / 2 + 1e-6) return false;
      const lateral = Math.abs(dot(sub({ x: p.x, y: p.y }, f.p), f.normal) - lat);
      return lateral <= r + p.r + opts.openMargin;
    });
    if (wallCertified && nearPillars.length === 0) { skippedMembers.push(m.slot); continue; }
    evalMembers.push(m.slot);
    for (const p of nearPillars) {
      const touching = st.some((s) => Math.abs(p.s - s) <= r + p.r + 1e-6);
      if (touching) evalPillars.add(p.id);
    }
  }
  return { members: evalMembers, skipped: skippedMembers, pillars: [...evalPillars] };
}

/**
 * Validate cells and merge per-member verdicts.
 *
 *   opts.cells     explicit cell indices (else cellRange, else all)
 *   opts.members   restrict the sweep to these slots (ignored on uncertain cells)
 *   opts.recheck   re-sweep cells already marked clear (needed when a new
 *                  obstacle appears in a cell that was clear)
 *   opts.full      every cell, every member, ignore the cache
 *   opts.strict    reference: no skips, no cache
 *
 * A cell whose configuration differs from the last time it was evaluated (its
 * member set, or whether a pillar is now near it) is always swept again, even
 * when a caller passes only a subset of members.
 */
export function validate(idx, opts = {}) {
  const { cells } = idx;
  const list = opts.cells ?? range(opts.cellRange?.[0] ?? 0, opts.cellRange?.[1] ?? cells.length - 1, cells.length);
  const revised = [];
  const stats = newStats();
  let fallbacks = 0, cellsChecked = 0;
  const setting = `${idx.template}|${idx.members.map((m) => `${m.slot}:${m.radius.toFixed(4)}`).join(',')}`;
  const pillarSig = cellPillarsSig(idx);
  for (const i of list) {
    const cell = cells[i];
    if (!cell) continue;
    // A cell already proven with exactly this configuration, pillar set and
    // this full set of members needs no work. Every other case is swept.
    const sameSetting = cell.setting === setting && cell.pillarSig === pillarSig;
    if (!opts.full && !opts.strict && sameSetting && !opts.recheck && !cell.uncertain) {
      continue;
    }
    // Cells the session asks for always include the neighbourhood of any
    // obstacle that moved, and the sweep covers all members there, so a cached
    // failure cannot outlive the geometry that caused it.
    const members = opts.members && !cell.uncertain
      ? idx.members.filter((m) => opts.members.includes(m.slot))
      : idx.members;
    if (cell.uncertain) { fallbacks++; cell.fallback = true; }
    cellsChecked++;
    const before = cell.clear;
    const failures = evaluateCell(cell, { ...idx, members }, stats, opts.strict);
    const failedBySlot = new Map((failures ?? []).map((x) => [x.slot, x]));
    for (const m of members) {
      cell.memberClear[m.slot] = failedBySlot.get(m.slot) ?? null;
    }
    // Keep the aggregate honest: a partial sweep must not erase failures found
    // for members outside this subset.
    if (!opts.members) cell.memberClear = Object.fromEntries(
      Object.entries(cell.memberClear).filter(([slot]) => members.some((m) => m.slot === +slot)));
    const remaining = Object.values(cell.memberClear).filter(Boolean);
    cell.failures = remaining;
    cell.clear = remaining.length === 0;
    cell.evaluated = true;
    const cov = cellCoverage(cell, { ...idx, members });
    cell.covMembers = cov.members;
    cell.covPillars = cov.pillars;
    cell.skipped = cov.skipped;
    if (members.length === idx.members.length) { cell.setting = setting; cell.pillarSig = pillarSig; }
    if (before !== cell.clear || (failures && failures.length)) revised.push(i);
  }
  return {
    revised, cellsChecked, fallbacks,
    checks: stats.evaluatedMembers,
    skipped: stats.skippedMembers,
    samples: stats.samples,
  };
}

/** Merge per-cell verdicts into contiguous swept intervals with their members. */
export function sweptIntervals(idx) {
  const regions = [];
  let cur = null;
  for (const cell of idx.cells) {
    const key = cell.failures.length ? 'blocked' : !cell.evaluated ? 'unknown' : 'clear';
    if (!cur || cur.status !== key || Math.abs(cur.to - cell.s0) > 1e-9) {
      if (cur) regions.push(cur);
      cur = { status: key, from: cell.s0, to: cell.s1, cells: [cell.i], members: [], skipped: [], failures: [] };
    } else {
      cur.to = cell.s1;
      cur.cells.push(cell.i);
    }
    if (key === 'clear') {
      for (const [slot, v] of Object.entries(cell.memberClear)) {
        if (v === null && !cur.members.includes(+slot)) cur.members.push(+slot);
      }
      for (const m of idx.members) {
        if (!(m.slot in cell.memberClear) && !cur.skipped.includes(m.slot)) cur.skipped.push(m.slot);
      }
    } else if (key === 'blocked') {
      cur.failures.push(...cell.failures);
    }
  }
  if (cur) regions.push(cur);
  for (const r of regions) {
    r.from = +r.from.toFixed(3); r.to = +r.to.toFixed(3);
    r.members.sort((a, b) => a - b); r.skipped.sort((a, b) => a - b);
    // The drawn band is the union of the swept members' real lateral extents,
    // so a blocked span shows which body's band broke it.
    const swept = idx.members.filter((m) => r.members.includes(m.slot) || r.failures.some((f) => f.slot === m.slot));
    r.span = swept.length
      ? { lo: +Math.min(...swept.map((m) => m.band.lo)).toFixed(3), hi: +Math.max(...swept.map((m) => m.band.hi)).toFixed(3) }
      : null;
    r.reach = swept.length ? +Math.max(...swept.map((m) => m.band.edge)).toFixed(3) : 0;
  }
  return regions;
}

/** Earliest failure along travel: where the whole squad must first stop. */
export function firstStop(idx) {
  const fails = [];
  for (const cell of idx.cells) for (const f of cell.failures) fails.push(f);
  if (!fails.length) return null;
  fails.sort((a, b) => a.s - b.s || a.margin - b.margin);
  const f = fails[0];
  return {
    s: f.s, member: f.member, slot: f.slot, kind: f.kind,
    reason: f.kind === 'pillar'
      ? `${f.member} 在 s=${f.s.toFixed(2)} m 处与柱子「${f.pillar}」净空差 ${(-f.margin).toFixed(2)} m`
      : `${f.member} 在 s=${f.s.toFixed(2)} m 处横向需 ${f.lat.toFixed(2)} m > 可用 ${f.allowed.toFixed(2)} m`,
    failure: f,
  };
}

export function formationCanPass(idx) {
  const stop = firstStop(idx);
  return { canPass: !stop, stop, cells: idx.cells.length };
}

/**
 * Independent full reference. Fresh cells and index, every cell, every member,
 * every pillar, every sample, no skips. If an incremental verdict ever differs
 * from this, the cache is lying and the tests fail.
 */
export function fullReference({ route, squad, template, pillars = [], radiusBySlot, opts = CLEARANCE }) {
  const cells = buildCells(route, opts);
  const idx = buildIndex({ route, squad, template, cells, pillars, radiusBySlot, opts });
  const res = validate(idx, { full: true, strict: true });
  return { idx, cells, ...res, canPass: formationCanPass(idx), intervals: sweptIntervals(idx) };
}

/** Compare per-cell, per-member verdicts from two indexes. */
export function compareVerdicts(a, b) {
  const issues = [];
  const n = Math.max(a.cells.length, b.cells.length);
  for (let i = 0; i < n; i++) {
    const ca = a.cells[i], cb = b.cells[i];
    if (!ca || !cb) { issues.push({ cell: i, why: 'cell count' }); continue; }
    if (ca.clear !== cb.clear) issues.push({ cell: i, why: 'cell', a: ca.clear, b: cb.clear });
    const slots = new Set([...Object.keys(ca.memberClear), ...Object.keys(cb.memberClear)]);
    for (const s of slots) {
      const fa = !!ca.memberClear[s], fb = !!cb.memberClear[s];
      if (fa !== fb) issues.push({ cell: i, slot: +s, why: 'member', a: fa, b: fb });
    }
  }
  return { equal: issues.length === 0, issues };
}

/** Cells that fail after but not before (and vice versa), with spans. */
export function diffFailures(beforeCells, afterCells) {
  const A = new Set(beforeCells.filter((c) => c.failures.length).map((c) => c.i));
  const B = new Set(afterCells.filter((c) => c.failures.length).map((c) => c.i));
  const added = [...B].filter((i) => !A.has(i)).sort((x, y) => x - y);
  const removed = [...A].filter((i) => !B.has(i)).sort((x, y) => x - y);
  return {
    added: added.map((i) => ({ cell: i, from: +afterCells[i].s0.toFixed(3), to: +afterCells[i].s1.toFixed(3), failures: afterCells[i].failures })),
    removed: removed.map((i) => ({ cell: i, from: +beforeCells[i].s0.toFixed(3), to: +beforeCells[i].s1.toFixed(3) })),
    addedSpans: added.map((i) => [beforeCells[i].s0, beforeCells[i].s1]),
    removedSpans: removed.map((i) => [afterCells[i].s0, afterCells[i].s1]),
  };
}

export { widthAt };
