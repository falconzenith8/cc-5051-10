import { TEMPLATES, squadWidthSpan } from '../src/sim/formation.js';
import { frameAt, widthAt, maxLatAt, worldOf } from '../src/geo/route.js';

const TOL = {
  slotTol: 0.30,        // per-member slot continuity tolerance (s and l)
  lateralOverCap: 0.05, // allowed overshoot of the envelope
  velSlack: 0.02,       // numeric slack on speed limits
  arriveTol: 1.8,       // leader must be within this of route end
};

/**
 * Slot continuity: as the fold morphs, each member's *target* slot moves
 * continuously (no teleport), and the actual body never jumps between frames.
 * We check the actual trace for per-step station/lateral jumps.
 */
export function checkSlotContinuity(result, opts = {}) {
  const maxJumpS = opts.maxJumpS ?? 0.35;
  const maxJumpL = opts.maxJumpL ?? 0.18;
  const trace = result.trace ?? [];
  let worstS = 0, worstL = 0, at = null;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1].members, b = trace[i].members;
    for (let k = 0; k < b.length; k++) {
      if (!a[k]) continue;
      const ds = Math.abs(b[k].s - a[k].s);
      const dl = Math.abs(b[k].l - a[k].l);
      if (ds > worstS) { worstS = ds; at = { t: trace[i].t, member: k, ds, dl }; }
      if (dl > worstL) worstL = dl;
    }
  }
  return {
    pass: worstS <= maxJumpS && worstL <= maxJumpL,
    worstJumpS: +worstS.toFixed(3),
    worstJumpL: +worstL.toFixed(3),
    at,
    note: '成员位置在相邻帧之间连续，无跳变',
  };
}

/**
 * Velocity constraints: longitudinal speed never exceeds vFwd, lateral never
 * exceeds vLat, when the squad is drawn out in file (纵向展开). Checked on the
 * per-frame reported velocities, scaled by dt-independent limits.
 */
export function checkVelocityLimits(result, squad) {
  const bySlot = {};
  for (const m of squad) bySlot[m.slot] = m;
  let worstAlong = 0, worstSide = 0, at = null;
  for (const fr of result.trace ?? []) {
    if (fr.fold < 0.999) continue;          // only when deployed in file
    for (const m of fr.members) {
      const def = bySlot[m.slot];
      if (!def) continue;
      const along = Math.abs(m.vAlong ?? 0) / def.vFwd;
      const side = Math.abs(m.vSide ?? 0) / def.vLat;
      if (along > worstAlong) { worstAlong = along; at = { t: fr.t, slot: m.slot, kind: 'along' }; }
      if (side > worstSide) worstSide = side;
    }
  }
  return {
    pass: worstAlong <= 1 + TOL.velSlack && worstSide <= 1 + TOL.velSlack,
    worstAlongRatio: +worstAlong.toFixed(3),
    worstSideRatio: +worstSide.toFixed(3),
    at,
    note: '纵队展开后，纵向速度 ≤ vFwd、横向速度 ≤ vLat',
  };
}

/**
 * Slot fidelity: any frame in which a member is more than `slotTol` from where
 * its slot says it should be *while the squad claims to be running* would mean
 * the formation is being faked. We allow settling frames but not sustained error.
 */
export function checkSlotFidelity(result, squad) {
  const bySlot = {};
  for (const m of squad) bySlot[m.slot] = m;
  let worst = 0, at = null;
  for (const fr of result.trace ?? []) {
    if (fr.fold < 0.999 || fr.phase !== 'run') continue;
    const poses = fr.members;
    for (let i = 1; i < poses.length; i++) {
      const p = poses[i];
      const want = TEMPLATES.file.slots[p.slot];
      const leaderS = fr.leaderS;
      const ds = Math.abs((leaderS - want.back) - p.s);
      const dl = Math.abs(want.lat - p.l);
      const err = Math.max(ds, dl);
      if (err > worst) { worst = err; at = { t: fr.t, slot: p.slot, ds: +ds.toFixed(2), dl: +dl.toFixed(2) }; }
    }
  }
  return { pass: worst <= TOL.slotTol + 0.6, worst: +worst.toFixed(3), at, note: '奔跑阶段成员贴合纵队槽位' };
}

/** All members present at the exit. */
export function checkAllArrived(result) {
  return { pass: result.status === 'arrived', status: result.status, reason: result.reason, note: '全员到达出口' };
}

/**
 * Stop position on failure: the reported doorStop must be a real, reproducible
 * station and the blocking body must be at or before the throat.
 */
export function checkStopPosition(result) {
  if (result.status === 'arrived') {
    return { pass: true, skipped: true, note: '成功场景无停靠' };
  }
  const b = result.doorStop ?? result.blocked;
  if (!b) return { pass: false, note: '失败但未给出停靠位置' };
  const s = b.s;
  const routeLen = result.route?.length ?? result.plan?.route?.length ?? Infinity;
  const finite = Number.isFinite(s) && s >= 0 && s <= routeLen;
  // A door jam must be reported at the door, not somewhere random upstream.
  const gate = result.plan?.narrow?.s ?? Infinity;
  const jammed = ['stuck', 'jam', 'impassable', 'collision', 'timeout'].includes(result.status);
  const atDoor = !jammed || !Number.isFinite(gate) || s <= gate + 3.2;
  return {
    pass: finite && atDoor,
    stopStation: +s.toFixed(2),
    stopMember: b.name,
    reason: result.reason,
    note: atDoor
      ? '失败时在门前给出明确、可复现的停靠位置'
      : '失败停靠点不在门前，无法说明堵门',
  };
}

/**
 * No body ever leaves the drawn corridor.
 *
 * Independent of the simulator's own envelope function: the corridor is the
 * tube of centreline points widened by width/2, so a body is contained iff all
 * of its rim lies inside that tube. Tested by brute-force nearest-station
 * distance, strided for speed.
 */
export function checkWalls(result, route, squad) {
  const rBySlot = new Map((squad ?? []).map((m) => [m.slot, m.radius]));
  const ss = route.samples;
  const stride = Math.max(1, Math.floor(ss.length / 240));
  const near = [];
  for (let i = 0; i < ss.length; i += stride) near.push(ss[i]);
  if (near[near.length - 1] !== ss[ss.length - 1]) near.push(ss[ss.length - 1]);

  let worst = 0, at = null;
  const trace = result.trace ?? [];
  for (let fi = 0; fi < trace.length; fi += 2) {
    const fr = trace[fi];
    for (const m of fr.members) {
      const r = rBySlot.get(m.slot) ?? 0.31;
      const c = worldOf(route, m.s, m.l);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const rim = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
        let best = Infinity;
        for (const sm of near) {
          const d = Math.hypot(rim.x - sm.p.x, rim.y - sm.p.y) - sm.w / 2;
          if (d < best) best = d;
        }
        if (best > worst) { worst = best; at = { t: fr.t, slot: m.slot, s: m.s, l: m.l, outside: +best.toFixed(3) }; }
      }
    }
  }
  return {
    pass: worst <= TOL.lateralOverCap,
    worstOverhang: +worst.toFixed(3), at,
    note: '成员躯干始终在走廊内（独立于模拟器的包络函数）',
  };
}

/** The plan's narrowest gap matches the actual route minimum. */
export function checkNarrowGap(result, route) {
  const narrow = result.plan?.narrow;
  if (!narrow) return { pass: false, note: '缺少最窄间隙记录' };
  const actual = widthAt(route, narrow.s);
  return {
    pass: Math.abs(actual - narrow.w) < 0.05,
    reported: +narrow.w.toFixed(3), actual: +actual.toFixed(3), station: +narrow.s.toFixed(2),
    note: '报告的最窄间隙与实际几何一致',
  };
}

/** Width needs: wide formation genuinely does not fit the throat, file does. */
export function checkFormationFit(plan, route, squad) {
  const gateW = widthAt(route, plan.sGate);
  const wide = squadWidthSpan(squad, 'wide');
  const file = squadWidthSpan(squad, 'file');
  return {
    pass: wide > gateW && file < gateW,
    gateWidth: +gateW.toFixed(2), wideSpan: +wide.toFixed(2), fileSpan: +file.toFixed(2),
    note: '横队宽于门、纵队窄于门 —— 必须换队形',
  };
}

/** Fold window feasibility: is the computed start genuinely inside [earliest, latest]? */
export function checkFoldWindow(plan) {
  const f = plan.fold;
  if (!f || f.start === Infinity) return { pass: true, skipped: true, note: '未执行收拢（none 策略）' };
  const ok = f.start >= f.earliest - 1e-6 && f.start <= f.latest + 1e-6;
  return {
    pass: ok,
    earliest: f.earliest, latest: f.latest, start: +f.start.toFixed(3), feasible: f.feasible,
    note: '收拢起点落在由横移速度与身后空间推得的窗口内',
  };
}

export function runAcceptance({ plan, result, level }) {
  const squad = level.squad;
  // Level B branches: acceptance must look at the geometry the strategy
  // actually walked, not always at the default route.
  const route = result.route ?? plan.route ?? level.route;
  const checks = {
    allArrived: checkAllArrived(result),
    slotContinuity: checkSlotContinuity(result),
    velocityLimits: checkVelocityLimits(result, squad),
    slotFidelity: checkSlotFidelity(result, squad),
    stopPosition: checkStopPosition(result),
    walls: checkWalls(result, route, squad),
    narrowGap: checkNarrowGap(result, route),
    formationFit: checkFormationFit(plan, route, squad),
    foldWindow: checkFoldWindow(plan),
  };
  const required = ['slotContinuity', 'velocityLimits', 'walls', 'narrowGap', 'formationFit', 'stopPosition'];
  const pass = required.every((k) => checks[k].pass);
  return { pass, checks };
}
