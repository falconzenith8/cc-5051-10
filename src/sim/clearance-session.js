import {
  CLEARANCE, buildCells, buildIndex, radiusMap, validate, sweptIntervals,
  firstStop, formationCanPass, fullReference, compareVerdicts, diffFailures,
  normalizePillar, evaluateCell,
} from './clearance.js';

/*
 * Stateful clearance session backing the viewport and the tests.
 *
 * It owns the per-cell, per-member cache, an event log of exactly which cells
 * each edit touched, and cheap incremental updates for the three edits the
 * viewport offers (drag a pillar, widen the tail, flip formation). Cells are
 * built once from the route, so the swept intervals (station spans) stay stable
 * and a revalidation can be painted directly onto the preview.
 */
export class ClearanceSession {
  constructor({ route, squad, template = 'file', pillars = [], opts = CLEARANCE }) {
    this.route = route;
    this.squad = squad;
    this.opts = opts;
    this.template = template;
    this.radiusBySlot = radiusMap(squad);
    this.cells = buildCells(route, opts);
    this.updates = [];
    this.lastUpdate = null;
    this.baseline = null;
    this._reindex(pillars.map((p) => normalizePillar(route, p)));
  }

  _reindex(pillars = this.pillars) {
    this.pillars = pillars;
    this.index = buildIndex({
      route: this.route, squad: this.squad, template: this.template,
      cells: this.cells, pillars, radiusBySlot: this.radiusBySlot, opts: this.opts,
    });
  }

  /* ---------------------------- full pass ---------------------------- */

  runFull() {
    const all = this.index.cells.map((c) => c.i);
    const res = validate(this.index, { full: true });
    this.baseline = this._snapshot();
    this._record({ kind: 'full', cells: all, ...res,
      changed: { added: [], removed: [], changed: [] } });
    return this.report(res, all);
  }

  /** Independent reference: same verdicts with every skip and cache disabled. */
  verify() {
    const ref = fullReference({
      route: this.route, squad: this.squad, template: this.template,
      pillars: this.pillars, radiusBySlot: this.radiusBySlot, opts: this.opts,
    });
    const cmp = compareVerdicts(this.index, ref.idx);
    return {
      equal: cmp.equal, issues: cmp.issues,
      pass: formationCanPass(this.index), referencePass: formationCanPass(ref.idx),
      reference: ref,
    };
  }

  /* --------------------------- incremental --------------------------- */

  /** Drag / add / remove a pillar. Revalidates only cells its reach covers. */
  setPillars(nextPillars) {
    const prev = this.pillars;
    const next = nextPillars.map((p) => normalizePillar(this.route, p));
    const before = this._snapshot();
    this._reindex(next);
    const affected = this._cellsNearPillars(next, prev);
    const res = validate(this.index, { cells: affected, recheck: true });
    this._record({ kind: 'pillars', cells: affected, ...res, changed: this._diff(before) });
    return this.report(res, affected);
  }

  /** One member picks up wider equipment; only its own band is swept. */
  setMemberRadius(slot, radius) {
    const before = this._snapshot();
    const old = this.radiusBySlot.get(slot) ?? 0;
    this.radiusBySlot.set(slot, radius);
    this._reindex();
    const affected = this._cellsForRadius(slot, old, radius);
    const res = validate(this.index, { cells: affected, members: [slot], recheck: true });
    this._record({ kind: 'radius', slot, radius, cells: affected, ...res, changed: this._diff(before) });
    return this.report(res, affected);
  }

  /**
   * Same route, same slots, only the outer members carry wider equipment.
   * The squad-centre path is unchanged; only the per-member bands grow, which is
   * exactly the case a centre-point cache cannot represent.
   */
  widenOuterMembers(by) {
    const before = this._snapshot();
    const prevRadii = new Map(this.radiusBySlot);
    this.squad = this.squad.map((m) => (m.slot === 0 ? m : { ...m, radius: m.radius + by }));
    this.radiusBySlot = radiusMap(this.squad);
    this._reindex();
    const affected = new Set();
    for (const m of this.squad) {
      if (m.slot === 0) continue;
      for (const i of this._cellsForRadius(m.slot, prevRadii.get(m.slot) ?? 0, m.radius)) affected.add(i);
    }
    const list = [...affected].sort((a, b) => a - b);
    const res = validate(this.index, { cells: list, recheck: true });
    this._record({ kind: 'widen-outer', by, slots: this.squad.filter((m) => m.slot !== 0).map((m) => m.slot), cells: list, ...res, changed: this._diff(before) });
    return this.report(res, list);
  }

  /** Flip formation. Only members whose lateral slot really moved are swept. */
  setTemplate(template) {
    if (template === this.template) return this.report(null, []);
    const before = this._snapshot();
    const prevMembers = this.index.members;
    const prevTemplate = this.template;
    this.template = template;
    this._reindex();
    const slots = [];
    for (const m of this.index.members) {
      const old = prevMembers.find((x) => x.slot === m.slot).band;
      if (Math.abs(old.lat - m.band.lat) > 1e-6) slots.push(m.slot);
    }
    const affected = this._cellsForSlots(slots, prevMembers, this.index.members);
    const res = validate(this.index, { cells: affected, members: slots, recheck: true });
    this._record({ kind: 'template', from: prevTemplate, to: template, slots, cells: affected, ...res, changed: this._diff(before) });
    return this.report(res, affected);
  }

  /* ------------------------------ probes ----------------------------- */

  /**
   * Split the given cells into "narrow road" (the corridor is tighter than the
   * formation's own band plus the opening margin) and "wide road", and tabulate
   * the member checks performed vs the checks a safe-skip certificate removed.
   * This is the narrow-recompute / wide-skip accounting the report is about.
   */
  splitNarrowWide(cellIds = this.cells.map((c) => c.i)) {
    const reach = Math.max(...this.index.members.map((m) => m.band.edge), 0.3);
    const out = {
      reach: +reach.toFixed(3),
      narrow: { cells: 0, checks: 0, skipped: 0, fallbacks: 0 },
      wide: { cells: 0, checks: 0, skipped: 0, fallbacks: 0 },
    };
    for (const i of cellIds) {
      const c = this.cells[i];
      if (!c) continue;
      const bin = c.wMinCell / 2 < reach + CLEARANCE.openMargin ? out.narrow : out.wide;
      bin.cells++;
      bin.checks += c.covMembers?.length ?? 0;
      bin.skipped += c.skipped?.length ?? 0;
      if (c.uncertain) bin.fallbacks++;
    }
    return out;
  }

  /**
   * Cells whose geometry can be touched by the pillars in `next`/`prev`.
   * A member centre can be at most `edge + p.r + pad` from the pillar's nearest
   * station, so this is a superset of affected cells.
   */
  _cellsNearPillars(next, prev) {
    const out = new Set();
    const maxEdge = Math.max(...this.index.members.map((m) => m.band.edge), 0.3);
    const addAround = (p) => {
      const halo = maxEdge + (p.r ?? 0.22) + CLEARANCE.pad;
      for (const cell of this.cells) if (cell.s1 >= p.s - halo && cell.s0 <= p.s + halo) out.add(cell.i);
    };
    for (const p of next) addAround(p);
    for (const p of prev) {
      const same = next.some((q) => q.id === p.id
        && Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6 && q.r === p.r);
      if (!same) addAround(p);
    }
    return [...out].sort((a, b) => a - b);
  }

  /**
   * Cells a radius change on `slot` can affect: cells that already failed for
   * it, cells whose worst wall is within the new band's reach, and cells near a
   * pillar the band could now touch. Conservative by construction; the actual
   * sweep still uses the full true geometry.
   */
  _cellsForRadius(slot, a, b) {
    const out = new Set();
    const member = this.index.members.find((m) => m.slot === slot);
    if (!member) return [];
    const reach = member.band.edge;
    for (const cell of this.cells) {
      const priorFail = !!cell.memberClear[slot];
      const wallClose = cell.wMinPad / 2 < reach + CLEARANCE.openMargin
        || cell.wMinCell / 2 < reach + CLEARANCE.openMargin;
      const pillarClose = this.pillars.some((p) =>
        Math.abs(p.s - cell.mid) <= reach + p.r + CLEARANCE.pad
        && Math.abs(p.l) <= reach + p.r + CLEARANCE.openMargin);
      if (priorFail || wallClose || pillarClose) out.add(cell.i);
    }
    return [...out].sort((x, y) => x - y);
  }

  /** Cells a formation flip of `slots` can affect. */
  _cellsForSlots(slots, prevMembers, nextMembers) {
    if (!slots.length) return [];
    let reach = 0;
    for (const slot of slots) {
      reach = Math.max(reach,
        prevMembers.find((m) => m.slot === slot)?.band.edge ?? 0,
        nextMembers.find((m) => m.slot === slot)?.band.edge ?? 0);
    }
    const out = new Set();
    for (const cell of this.cells) {
      const priorFail = slots.some((slot) => !!cell.memberClear[slot]);
      const wallClose = cell.wMinPad / 2 < reach + CLEARANCE.openMargin;
      const pillarClose = this.pillars.some((p) =>
        Math.abs(p.s - cell.mid) <= reach + p.r + CLEARANCE.pad
        && Math.abs(p.l) <= reach + p.r + CLEARANCE.openMargin);
      if (priorFail || wallClose || pillarClose) out.add(cell.i);
    }
    return [...out].sort((x, y) => x - y);
  }

  /**
   * Cells whose failure state changed since `snapshot`: the genuinely broken or
   * recovered segments, as opposed to `cells` (the work that was revalidated).
   */
  _diff(snapshot) {
    const before = new Map(snapshot.map((c) => [c.i, c]));
    const added = [], removed = [], changed = [];
    for (const cell of this.cells) {
      const b = before.get(cell.i);
      const was = !!b && b.failures.length > 0;
      const now = cell.failures.length > 0;
      const entry = { cell: cell.i, from: +cell.s0.toFixed(3), to: +cell.s1.toFixed(3), failures: cell.failures };
      if (now && !was) added.push(entry);
      else if (!now && was) removed.push({ cell: cell.i, from: +cell.s0.toFixed(3), to: +cell.s1.toFixed(3) });
      else if (now && was) changed.push(entry);
    }
    return { added, removed, changed };
  }

  _snapshot() {
    return this.cells.map((c) => ({ i: c.i, clear: c.clear, failures: c.failures.map((f) => ({ ...f })) }));
  }

  _record(update) {
    this.lastUpdate = update;
    this.updates.push(update);
    return update;
  }

  /* ------------------------------ report ----------------------------- */

  report(res, revalidated = null) {
    const idx = this.index;
    const touched = revalidated ?? res?.revised ?? this.lastUpdate?.cells ?? [];
    return {
      template: this.template,
      cells: idx.cells.length,
      intervals: sweptIntervals(idx),
      stop: firstStop(idx),
      canPass: formationCanPass(idx).canPass,
      revalidated: touched,
      recompute: this.splitNarrowWide(touched),
      last: this.lastUpdate,
      stats: res,
      events: this.updates,
      pillars: this.pillars.map((p) => ({ ...p })),
    };
  }

  /** Failing-cell differences between the session baseline and now. */
  diffSinceBaseline() {
    if (!this.baseline) return null;
    return diffFailures(this.baseline, this.cells);
  }

  /** Reference-check a single cell, e.g. after toggling an uncertain fallback. */
  cellReference(cellIndex) {
    const cell = this.cells[cellIndex];
    const fine = { ...cell, fallback: true };
    const failures = evaluateCell(fine, this.index, null, true);
    return { cell: cellIndex, failures: failures ?? [], referenceClear: !failures };
  }
}

/** One-shot helper for tools/tests: full pass plus intervals and stop point. */
export function evaluateFormation({ route, squad, template, pillars = [], radiusBySlot, opts = CLEARANCE }) {
  const session = new ClearanceSession({ route, squad, template, pillars, opts });
  if (radiusBySlot) {
    session.radiusBySlot = radiusBySlot;
    session._reindex();
  }
  const report = session.runFull();
  return { session, ...report };
}
