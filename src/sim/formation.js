import { clamp } from '../geo/vec.js';

/**
 * Slot pose in the leader's local frame:
 *   lat  : + = left of travel, metres from centreline
 *   back : metres behind the leader's station
 * Index 0 is the leader and is always on the centreline.
 */
export const TEMPLATES = {
  wide: {
    id: 'wide',
    label: '横队',
    short: '横',
    color: '#f59e0b',
    slots: [
      { lat: 0.0, back: 0.0 },
      { lat: -0.86, back: 0.98 },
      { lat: 0.86, back: 0.98 },
      { lat: -0.86, back: 1.96 },
      { lat: 0.86, back: 1.96 },
    ],
  },
  file: {
    id: 'file',
    label: '纵队',
    short: '纵',
    color: '#38bdf8',
    slots: [
      { lat: 0.0, back: 0.0 },
      { lat: 0.0, back: 1.18 },
      { lat: 0.0, back: 2.36 },
      { lat: 0.0, back: 3.54 },
      { lat: 0.0, back: 4.72 },
    ],
  },
};

export const TEMPLATE_LIST = [TEMPLATES.wide, TEMPLATES.file];

export function slotAt(templateId, slot) {
  return TEMPLATES[templateId].slots[slot];
}

export function makeSquad(defs) {
  return defs.map((d, i) => ({
    id: d.id,
    name: d.name,
    color: d.color,
    width: d.width,
    radius: d.width / 2,
    vFwd: d.vFwd,
    vLat: d.vLat,
    vBack: d.vBack ?? Math.max(0.25, d.vFwd * 0.55),
    role: i === 0 ? 'leader' : 'member',
    slot: i,
  }));
}

export function squadWidthSpan(squad, templateId) {
  let span = 0;
  for (const m of squad) {
    const s = TEMPLATES[templateId].slots[m.slot];
    span = Math.max(span, 2 * (Math.abs(s.lat) + m.radius));
  }
  return span;
}

export function squadColumnDepth(squad, templateId) {
  let depth = 0;
  for (const m of squad) depth = Math.max(depth, TEMPLATES[templateId].slots[m.slot].back + m.radius);
  return depth;
}

/**
 * Minimum longitudinal slot spacing minus body radii for bodies in the same
 * lateral lane. Members in different lanes cannot collide just by being at the
 * same station, so the clearance is only meaningful within a lane.
 */
export function minSlotClearance(squad, templateId) {
  let worst = Infinity;
  const slots = squad.map((m) => ({ ...TEMPLATES[templateId].slots[m.slot], r: m.radius }));
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      if (Math.abs(slots[i].lat - slots[j].lat) > 0.2) continue;   // different lane
      const a = slots[i], b = slots[j];
      worst = Math.min(worst, Math.abs(a.back - b.back) - a.r - b.r);
    }
  }
  return worst;
}

/**
 * Slowest member of a fold: ranked by the *time* to slide from its wide slot to
 * its file slot at its own lateral speed (not by raw slide distance, which is
 * equal for all outer members and would pick whichever came first).
 */
export function foldCost(squad, fromId, toId) {
  let worst = { slide: 0, member: null, backChange: 0, time: 0 };
  for (const m of squad) {
    const a = TEMPLATES[fromId].slots[m.slot];
    const b = TEMPLATES[toId].slots[m.slot];
    const slide = Math.abs(a.lat - b.lat);
    const time = slide / Math.max(m.vLat, 1e-6);
    if (time > worst.time) worst = { slide, member: m, backChange: Math.abs(a.back - b.back), time };
  }
  return worst;
}

/**
 * Entrance regrouping: swap the formation slots of two non-leader members.
 * The leader always keeps slot 0 (centre, front), so only slots 1..n-1 move.
 * Returns a new squad array; the member objects themselves are untouched.
 */
export function swapSlots(squad, a, b) {
  if (a === b || a === 0 || b === 0) return squad.slice();
  const out = squad.slice();
  const sa = out[a].slot, sb = out[b].slot;
  out[a] = { ...out[a], slot: sb };
  out[b] = { ...out[b], slot: sa };
  return out;
}

/** Apply an explicit member-index -> slot map (leader pinned to slot 0). */
export function applySlotOrder(squad, order) {
  if (!order) return squad;
  return squad.map((m, i) => ({ ...m, slot: i === 0 ? 0 : order[i] }));
}

