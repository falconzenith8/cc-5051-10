import { worldOf, frameAt } from '../geo/route.js';

/*
 * Shared Canvas2D scene renderer. It knows nothing about the DOM: it takes a 2D
 * context plus a world->screen transform, so the same code drives the browser
 * viewport and the headless PNG captures used by the tests.
 */

const COLORS = {
  bg: '#0b1220',
  floor: '#16233a',
  floorEdge: '#22344f',
  wall: '#3c556f',
  centre: '#ffffff',
  centreAlpha: 0.10,
  text: '#c8d6ea',
  dim: '#6f839c',
  reserved: '#fbbf24',
  gap: '#22d3ee',
  good: '#34d399',
  bad: '#f87171',
  pillar: '#94a3b8',
  sweepClear: '#22d3ee',
  sweepBlocked: '#f87171',
  revalidated: '#fbbf24',
};

export function makeTransform(route, width, height, padding = 30) {
  const b = route.bounds;
  const w = Math.max(1e-6, b.maxX - b.minX);
  const h = Math.max(1e-6, b.maxY - b.minY);
  const scale = Math.min((width - 2 * padding) / w, (height - 2 * padding) / h);
  const ox = (width - w * scale) / 2 - b.minX * scale;
  const oy = (height - h * scale) / 2 - b.minY * scale;
  // Canvas y grows downward; world y grows upward. Flip so the plan reads
  // like a map (the level's left branch veers toward the top of the view).
  return {
    scale,
    toScreen: (p) => ({ x: ox + p.x * scale, y: height - (oy + p.y * scale) }),
    fromScreen: (x, y) => ({ x: (x - ox) / scale, y: (height - y - oy) / scale }),
  };
}

/**
 * Corridor floor as the union of width-discs along the centreline.
 *
 * Offsetting a centreline by w/2 self-intersects wherever the inner side of a
 * bend folds through itself (curvature radius < w/2), which leaves wedge-shaped
 * holes in a polygon fill. Stamping a disc at every sample cannot fold: overlap
 * is invisible because the fill is flat, and a slightly larger rim disc first
 * gives the wall a clean, continuous outline.
 */
export function drawRoute(ctx, route, tr) {
  const ss = route.samples;
  const step = Math.max(1, Math.round(0.06 / (ss[1].s - ss[0].s || 0.02)));

  ctx.save();
  // wall rim
  ctx.fillStyle = COLORS.wall;
  for (let i = 0; i < ss.length; i += step) stampDisc(ctx, tr, ss[i].p, ss[i].w / 2 + 0.055);
  stampDisc(ctx, tr, ss[ss.length - 1].p, ss[ss.length - 1].w / 2 + 0.055);
  // floor
  ctx.fillStyle = COLORS.floor;
  for (let i = 0; i < ss.length; i += step) stampDisc(ctx, tr, ss[i].p, ss[i].w / 2);
  stampDisc(ctx, tr, ss[ss.length - 1].p, ss[ss.length - 1].w / 2);

  // centreline
  ctx.strokeStyle = COLORS.centre; ctx.globalAlpha = COLORS.centreAlpha;
  ctx.setLineDash([6, 8]); ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < ss.length; i++) {
    const p = tr.toScreen(ss[i].p);
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}

function stampDisc(ctx, tr, world, r) {
  const p = tr.toScreen(world);
  ctx.beginPath();
  ctx.arc(p.x, p.y, Math.max(0.5, r * tr.scale), 0, Math.PI * 2);
  ctx.fill();
}

/** Every body's path over time, drawn faintly. */
export function drawTrails(ctx, route, tr, trace, squad) {
  if (!trace?.length) return;
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  for (const m of squad) {
    ctx.strokeStyle = m.color;
    ctx.beginPath();
    let started = false;
    for (const fr of trace) {
      const pose = fr.members.find((x) => x.slot === m.slot);
      if (!pose) continue;
      const p = tr.toScreen(worldOf(route, pose.s, pose.l));
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** The narrowest gap: a cross-bar at the throat with its clearance labelled. */
export function drawNarrowGap(ctx, route, tr, plan, opts = {}) {
  const f = frameAt(route, plan.narrow.s);
  const half = plan.narrow.w / 2;
  const a = tr.toScreen({ x: f.p.x + f.normal.x * half, y: f.p.y + f.normal.y * half });
  const b = tr.toScreen({ x: f.p.x - f.normal.x * half, y: f.p.y - f.normal.y * half });
  ctx.save();
  ctx.strokeStyle = COLORS.gap; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.fillStyle = COLORS.gap;
  for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
  // place the caption on the outside of the route at that station
  const outward = { x: f.p.x + f.normal.x * (half + 0.45), y: f.p.y + f.normal.y * (half + 0.45) };
  const lp = tr.toScreen(outward);
  label(ctx, `${plan.narrow.w.toFixed(2)} m`, lp.x, lp.y, COLORS.gap, '11px ui-monospace, monospace');
  ctx.restore();
  void opts;
}

/** Reserved file-column positions, drawn as hollow rings. */
export function drawReserved(ctx, route, tr, plan, squad) {
  ctx.save();
  ctx.strokeStyle = COLORS.reserved; ctx.lineWidth = 1.4; ctx.setLineDash([3, 3]);
  for (const r of plan.reserved) {
    const def = squad.find((m) => m.slot === r.slot);
    const p = tr.toScreen(worldOf(route, r.s, r.l));
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(4, (def?.radius ?? 0.3) * tr.scale), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawSquad(ctx, route, tr, members, opts = {}) {
  for (const m of members) {
    const p = tr.toScreen(worldOf(route, m.s, m.l));
    const r = Math.max(2.5, (m.radius ?? 0.3) * tr.scale);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = m.color ?? '#fff';
    ctx.fill();
    ctx.lineWidth = m.slot === 0 ? 2.5 : 1.4;
    ctx.strokeStyle = m.slot === 0 ? '#ffffff' : 'rgba(0,0,0,0.45)';
    ctx.stroke();
    if (opts.labels !== false && m.label) {
      ctx.fillStyle = '#0b1220';
      ctx.font = `${Math.max(8, Math.min(13, r * 1.1))}px ui-sans-serif, system-ui`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(m.label, p.x, p.y + 0.5);
    }
  }
}

/** A failure marker: cross at the blocked body plus a caption. */
export function drawStop(ctx, route, tr, result, opts = {}) {
  const b = result?.doorStop;
  if (!b) return;
  const p = tr.toScreen(b.world ?? worldOf(route, b.s, b.l));
  ctx.save();
  ctx.strokeStyle = COLORS.bad; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(p.x - 7, p.y - 7); ctx.lineTo(p.x + 7, p.y + 7);
  ctx.moveTo(p.x + 7, p.y - 7); ctx.lineTo(p.x - 7, p.y + 7);
  ctx.stroke();
  const text = opts.ascii ? `stop s=${b.s.toFixed(2)}` : `停 s=${b.s.toFixed(2)}`;
  label(ctx, text, p.x, p.y - 14, COLORS.bad, '11px ui-monospace, monospace');
  ctx.restore();
}

/** Pillars, as solid circles with a rim. */
export function drawPillars(ctx, route, tr, pillars, opts = {}) {
  for (const p of pillars ?? []) {
    const c = tr.toScreen({ x: p.x, y: p.y });
    const r = Math.max(3, p.r * tr.scale);
    ctx.save();
    ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fillStyle = opts.dragging === p.id ? COLORS.revalidated : COLORS.pillar;
    ctx.fill();
    ctx.lineWidth = opts.highlight === p.id ? 3 : 1.5;
    ctx.strokeStyle = opts.highlight === p.id ? '#fff' : 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.restore();
  }
}

/** World point hit test for a pillar under the cursor (screen coords). */
export function pillarAt(pillars, tr, sx, sy, slopPx = 10) {
  for (const p of pillars ?? []) {
    const c = tr.toScreen({ x: p.x, y: p.y });
    if (Math.hypot(c.x - sx, c.y - sy) <= Math.max(6, p.r * tr.scale) + slopPx) return p;
  }
  return null;
}

/**
 * The swept clearance band along the route, drawn per station interval.
 * `intervals` come from the clearance session. Each region carries the real
 * lateral extent of the members swept there (`span.lo`..`span.hi`), so the
 * drawn band is the actual ground the bodies cover — not a decorative width.
 * `revalidated` is the set of station spans the last edit re-checked.
 */
export function drawSweep(ctx, route, tr, intervals, opts = {}) {
  if (!intervals?.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  for (const reg of intervals) {
    const clear = reg.status === 'clear';
    const color = clear ? COLORS.sweepClear : reg.status === 'blocked' ? COLORS.sweepBlocked : COLORS.dim;
    const lo = reg.span ? reg.span.lo : -0.5;
    const hi = reg.span ? reg.span.hi : 0.5;
    ctx.globalAlpha = opts.alpha ?? 0.26;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, (opts.bandPx ?? 8));
    for (const lateral of [lo, hi]) {
      ctx.beginPath();
      let started = false;
      for (let s = reg.from; s <= reg.to + 1e-9; s += 0.08) {
        const f = frameAt(route, Math.min(s, route.length));
        const p = tr.toScreen({ x: f.p.x + f.normal.x * lateral, y: f.p.y + f.normal.y * lateral });
        if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Halo around the station spans that the last edit revalidated. */
export function drawRevalidated(ctx, route, tr, spans, opts = {}) {
  if (!spans?.length) return;
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = COLORS.revalidated;
  ctx.lineWidth = Math.max(6, (opts.widthPx ?? 14));
  ctx.setLineDash([5, 5]);
  for (const span of spans) {
    const [from, to] = Array.isArray(span) ? span : [span.from, span.to];
    ctx.beginPath();
    let started = false;
    for (let s = from; s <= to + 1e-9; s += 0.08) {
      const f = frameAt(route, Math.min(s, route.length));
      const p = tr.toScreen(f.p);
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function label(ctx, text, x, y, color, font, align = 'center') {  ctx.save();
  ctx.font = font;
  const w = ctx.measureText(text).width;
  const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.globalAlpha = 0.82; ctx.fillStyle = COLORS.bg;
  ctx.fillRect(bx - 3, y - 13, w + 6, 15);
  ctx.globalAlpha = 1; ctx.fillStyle = color;
  ctx.textAlign = align; ctx.textBaseline = 'bottom';
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function clear(ctx, w, h) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Full scene. `state` carries the run: plan, trace sliced to the current frame,
 * the live member poses, and an optional result for the failure marker.
 * `ascii` swaps CJK captions for Latin ones (headless canvases often have no CJK
 * font installed; the browser always uses the real labels).
 */
export function drawScene(ctx, state) {
  const { route, plan, squad, tr, width, height, trace, members, result, title, subtitle, ascii } = state;
  const { pillars, clearance, draggingPillar } = state;
  clear(ctx, width, height);
  drawRoute(ctx, route, tr);
  drawTrails(ctx, route, tr, trace, squad);
  if (pillars?.length) {
    if (clearance) drawSweep(ctx, route, tr, clearance.intervals, { alpha: 0.22 });
    drawPillars(ctx, route, tr, pillars, { dragging: draggingPillar });
  }
  if (clearance?.revalidatedSpans?.length) {
    drawRevalidated(ctx, route, tr, clearance.revalidatedSpans);
  }
  if (plan) {
    drawReserved(ctx, route, tr, plan, squad);
    drawNarrowGap(ctx, route, tr, plan, { ascii });
  }
  if (members) drawSquad(ctx, route, tr, members);
  if (result) drawStop(ctx, route, tr, result, { ascii });

  if (title) {
    ctx.save();
    ctx.fillStyle = '#e7eefb';
    ctx.font = '600 15px ui-sans-serif, system-ui';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(title, 14, 12);
    if (subtitle) {
      ctx.fillStyle = COLORS.dim; ctx.font = '12px ui-monospace, monospace';
      ctx.fillText(subtitle, 14, 32);
    }
    ctx.restore();
  }
  return COLORS;
}

export { COLORS };
