import { TEMPLATES } from './formation.js';
import { maxLatAt, worldOf, clamp, widthAt } from '../geo/route.js';

const STEP = 0.05;

/**
 * First station at which the wide formation no longer physically fits.
 * Uses each outer member's disc footprint, so an abrupt narrowing registers
 * slightly *before* the geometric throat.
 */
export function computeSEnter(route, squad) {
  const outers = squad.filter((m) => Math.abs(TEMPLATES.wide.slots[m.slot].lat) > 0.02);
  const blocks = (s) => outers.some((m) => {
    const lat = Math.abs(TEMPLATES.wide.slots[m.slot].lat);
    return maxLatAt(route, s, m.radius) < lat - 0.02;
  });
  let run = 0, runStart = 0;
  for (let s = 0; s <= route.length + 1e-9; s += STEP) {
    if (blocks(s)) {
      if (run === 0) runStart = s;
      run += STEP;
      if (run >= 0.30) return Math.max(0, runStart);
    } else run = 0;
  }
  return route.length;
}

/** narrowest corridor width anywhere on the route */
export function narrowest(route) {
  let best = { w: Infinity, s: 0 };
  for (let s = 0; s <= route.length + 1e-9; s += STEP) {
    const w = widthAt(route, s);
    if (w < best.w) best = { w, s };
  }
  return best;
}

/**
 * Fold-window derivation.
 *
 * Leader begins the fold at station S0 and advances at vLead while the formation
 * morphs wide -> file. For member i at wide slot (latW, backW):
 *
 *   slide time    t_i   = |latW| / vLat_i            (it ends on the centreline)
 *   leader travel        = vLead * t_i
 *   its front edge at t_i = S0 - backW + r_i + vLead*t_i
 *
 * The slide must be finished before that front edge reaches the throat (sEnter),
 * giving the latest viable start
 *
 *   S0_latest_i = sEnter - r_i + backW_i - vLead * t_i
 *
 * The earliest start is set by rear space: the tail must fit on the approach at
 * spawn and the file formation must not extend behind station 0:
 *
 *   S0_earliest = max(backW_max + r_tail, fileDepth - vLead*T)  (+ margin)
 */
export function solveFold({ route, squad, sEnter, vLead, margin = 0.30, safety = 0.45 }) {
  let tFold = 0;
  let latest = Infinity;
  let worst = null;
  const perMember = [];
  let backWmax = 0;
  let rTail = 0;
  for (const m of squad) {
    const w = TEMPLATES.wide.slots[m.slot];
    const f = TEMPLATES.file.slots[m.slot];
    const dLat = Math.abs(w.lat - f.lat);
    backWmax = Math.max(backWmax, w.back + m.radius);
    rTail = Math.max(rTail, m.radius);
    if (dLat < 1e-6) continue;
    const t = dLat / Math.max(m.vLat, 1e-3);
    tFold = Math.max(tFold, t);
    const cand = sEnter - m.radius + w.back - vLead * t;
    const rec = {
      name: m.name, slot: m.slot, dLat: +dLat.toFixed(3), backW: +w.back.toFixed(2),
      tSlide: +t.toFixed(3), leaderTravel: +(vLead * t).toFixed(3),
      latest: +cand.toFixed(3), fastest: m.vLat,
    };
    perMember.push(rec);
    if (cand < latest) { latest = cand; worst = rec; }
  }
  if (!Number.isFinite(latest)) latest = sEnter;

  const fileDepth = Math.max(...squad.map((m) => TEMPLATES.file.slots[m.slot].back + m.radius));
  const earliest = Math.max(backWmax + margin, fileDepth - vLead * tFold + margin);
  const latestSafe = latest - safety;
  const feasible = latestSafe > earliest + 0.05;
  return {
    earliest: +earliest.toFixed(3),
    latest: +latest.toFixed(3),
    latestSafe: +latestSafe.toFixed(3),
    feasible, worst, perMember, tFold: +tFold.toFixed(3),
    backWmax: +backWmax.toFixed(3), fileDepth: +fileDepth.toFixed(3),
  };
}

/**
 * Strategy -> execution behaviour.
 *  wait  : honour the release gate (leader pauses at the throat until the actual
 *          tail is settled); fold at the latest safe station. Reference policy.
 *  early : fold immediately after spawn and keep moving; gate honoured.
 *  rush  : never pause, fold late; the gate is ignored so the squad tears / jams.
 *  none  : never fold; the wide file cannot enter the throat.
 *
 *  startStation is where the fold command is issued (Infinity = never).
 */
export function chooseStart(fold, sEnter, strategy, startStation) {
  switch (strategy) {
    case 'early': return Math.max(fold.earliest, startStation + 0.35);
    case 'wait': return Math.min(fold.latestSafe, fold.earliest + 2.6);
    case 'side': return Math.max(fold.earliest, startStation + 0.35);
    case 'rush': return Math.max(fold.latest + 1.4, startStation + 0.9);
    case 'none': return Infinity;
    default: return Math.min(fold.latestSafe, fold.earliest + 2.6);
  }
}

export function planRun({ route, squad, level, strategy }) {
  const vLead = level.leaderSpeed ?? 1.35;
  const startStation = level.startStation ?? 2.55;
  const sEnter = computeSEnter(route, squad);
  const narrow = narrowest(route);
  const fold = solveFold({ route, squad, sEnter, vLead });
  const start = chooseStart(fold, sEnter, strategy, startStation);
  const doFold = strategy !== 'none';

  const sComplete = Number.isFinite(start) ? start + vLead * fold.tFold : sEnter;
  const reserved = squad.map((m) => {
    const pose = TEMPLATES.file.slots[m.slot];
    const s = clamp(sComplete - pose.back, 0, route.length);
    return { slot: m.slot, name: m.name, s, l: pose.lat, world: worldOf(route, s, pose.lat) };
  });

  return {
    strategy, branch: level.branchId, vLead,
    sGate: route.minWidthStation ?? level.gateStation, sEnter, narrow, startStation,
    needs: {
      wide: Math.max(...squad.map((m) => 2 * (Math.abs(TEMPLATES.wide.slots[m.slot].lat) + m.radius))),
      file: Math.max(...squad.map((m) => 2 * (Math.abs(TEMPLATES.file.slots[m.slot].lat) + m.radius))),
    },
    fold: { ...fold, start, doFold, sComplete },
    reserved,
    control: {
      // Honour the release gate for wait/early/side. Rush ignores it (the leader
      // trusts its own polyline and never pauses); none additionally never folds.
      gate: strategy === 'wait' || strategy === 'early' || strategy === 'side',
      holdAtThroat: strategy === 'wait',
      // Only the rush policy declines to wait for its own tail. Even a squad
      // that never folds still holds together, so it jams at the door instead
      // of simply tearing away from its rear member.
      ignoreCohesion: strategy === 'rush',
      rush: strategy === 'rush',
      // "rush" still folds, but starts past the safe window and never waits.
      foldLate: strategy === 'rush',
    },
  };
}
