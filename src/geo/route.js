import {
  EPS, add, sub, mul, len, dist, dot, cross, norm, perpLeft, lerp, clamp,
} from './vec.js';

function roundPath(nodes, defaultRound) {
  const n = nodes.length;
  const pts = [{ x: nodes[0].x, y: nodes[0].y }];
  for (let i = 1; i < n - 1; i++) {
    const A = nodes[i - 1], P = nodes[i], B = nodes[i + 1];
    const d1 = norm(sub(P, A)), d2 = norm(sub(B, P));
    const L1 = dist(P, A), L2 = dist(B, P);
    if (L1 < EPS || L2 < EPS) { pts.push({ x: P.x, y: P.y }); continue; }
    // heading change at this node (0 = straight ahead)
    const turn = Math.acos(clamp(dot(d1, d2), -1, 1));
    if (turn < 1e-3) { pts.push({ x: P.x, y: P.y }); continue; }
    const halfTan = Math.tan(turn / 2);
    const Rmax = nodes[i].round ?? defaultRound;
    // tangent length limited both by the requested radius and by available leg room
    const R = Math.min(Rmax, (0.45 * L1) / halfTan, (0.45 * L2) / halfTan);
    if (R < 1e-3) { pts.push({ x: P.x, y: P.y }); continue; }
    const t = R * halfTan;
    const side = cross(d1, d2) > 0 ? 1 : -1;
    const E = add(P, mul(d1, -t));
    const X = add(P, mul(d2, t));
    const O = add(E, mul(perpLeft(d1), R * side));
    let a0 = Math.atan2(E.y - O.y, E.x - O.x);
    let a1 = Math.atan2(X.y - O.y, X.x - O.x);
    if (side > 0) { while (a1 <= a0) a1 += Math.PI * 2; }
    else { while (a1 >= a0) a1 -= Math.PI * 2; }
    pts.push(E);
    const steps = Math.max(2, Math.ceil((Math.abs(a1 - a0) * R) / 0.05));
    for (let k = 1; k <= steps; k++) {
      const a = a0 + ((a1 - a0) * k) / steps;
      pts.push({ x: O.x + R * Math.cos(a), y: O.y + R * Math.sin(a) });
    }
  }
  pts.push({ x: nodes[n - 1].x, y: nodes[n - 1].y });
  return pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-6);
}

function resample(pts, ds) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  const N = Math.max(2, Math.ceil(total / ds));
  const out = [];
  let j = 0;
  for (let k = 0; k <= N; k++) {
    const s = (total * k) / N;
    while (j < cum.length - 2 && cum[j + 1] < s) j++;
    const segLen = cum[j + 1] - cum[j];
    const t = segLen < EPS ? 0 : (s - cum[j]) / segLen;
    out.push({ s, p: lerp(pts[j], pts[j + 1], clamp(t, 0, 1)) });
  }
  return out;
}

function widthOnNodePolyline(nodes, p) {
  let best = { d: Infinity, w: nodes[0].w };
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 < EPS ? 0 : clamp(dot(sub(p, a), ab) / l2, 0, 1);
    const q = add(a, mul(ab, t));
    const d = dist(p, q);
    if (d < best.d) best = { d, w: a.w + (b.w - a.w) * t };
  }
  return best.w;
}

export function buildRoute(name, nodes, extras = {}) {
  const pts = roundPath(nodes, extras.round ?? 0.9);
  const samples = resample(pts, extras.ds ?? 0.025);
  for (const sm of samples) sm.w = widthOnNodePolyline(nodes, sm.p);
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)].p;
    const b = samples[Math.min(samples.length - 1, i + 1)].p;
    const t = norm(sub(b, a));
    samples[i].tangent = t;
    samples[i].normal = perpLeft(t);
  }
  // discrete curvature: angle swept per metre, signed. Used to correct the
  // lateral envelope on bends (a disc's footprint curves with the corridor).
  for (let i = 0; i < samples.length; i++) {
    const a = samples[Math.max(0, i - 1)].tangent;
    const b = samples[Math.min(samples.length - 1, i + 1)].tangent;
    const dsArc = samples[Math.min(samples.length - 1, i + 1)].s - samples[Math.max(0, i - 1)].s;
    const ang = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    samples[i].kappa = dsArc > EPS ? ang / dsArc : 0;
  }
  const route = {
    name,
    title: extras.title ?? name,
    nodes: nodes.map((n) => ({ ...n })),
    pts,
    samples,
    length: samples[samples.length - 1].s,
    meta: extras.meta ?? {},
  };
  route.nodeStations = nodes.map((n) => nearestStation(route, n).station);
  route.minWidth = Math.min(...samples.map((s) => s.w));
  route.minWidthStation = samples.reduce((a, b) => (b.w < a.w ? b : a), samples[0]).s;
  route.bounds = boundsOfSamples(samples);
  return route;
}

function boundsOfSamples(samples) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.p.x); maxX = Math.max(maxX, s.p.x);
    minY = Math.min(minY, s.p.y); maxY = Math.max(maxY, s.p.y);
  }
  return { minX, minY, maxX, maxY };
}

function sampleIndexAt(route, s) {
  const ss = route.samples;
  if (s <= 0) return 0;
  if (s >= route.length) return ss.length - 1;
  let lo = 0, hi = ss.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (ss[m].s <= s) lo = m; else hi = m;
  }
  return lo;
}

export function frameAt(route, s) {
  const st = clamp(s, 0, route.length);
  const ss = route.samples;
  const i = sampleIndexAt(route, st);
  const a = ss[i], b = ss[Math.min(i + 1, ss.length - 1)];
  const span = b.s - a.s;
  const t = span < EPS ? 0 : (st - a.s) / span;
  return {
    s: st,
    p: lerp(a.p, b.p, t),
    tangent: norm(lerp(a.tangent, b.tangent, t)),
    normal: norm(lerp(a.normal, b.normal, t)),
    w: a.w + (b.w - a.w) * t,
    kappa: (a.kappa ?? 0) + ((b.kappa ?? 0) - (a.kappa ?? 0)) * t,
  };
}

export function widthAt(route, s) {
  return frameAt(route, s).w;
}

const MAXLAT_STEP = 0.04;
/**
 * Greatest |lateral| offset a disc of radius r can hold at station s without
 * crossing a wall. The disc footprint is sampled along the centreline, so an
 * abrupt narrowing behaves as a wall rather than a funnel.
 */
export function maxLatAt(route, s, r) {
  if (r <= 0) return widthAt(route, s) / 2;
  let best = Infinity;
  const n = Math.max(2, Math.ceil((2 * r) / MAXLAT_STEP));
  for (let i = 0; i <= n; i++) {
    const u = -r + (2 * r * i) / n;
    const st = clamp(s + u, 0, route.length);
    const span = Math.sqrt(Math.max(0, r * r - u * u));
    // Curvature correction: on a bend, a point at arc offset u from the disc
    // centre sits ~kappa*u^2/2 further to the inside of the corridor than a
    // straight-corridor footprint predicts. Without this the envelope admits
    // up to a few centimetres of wall penetration on tight corners.
    const f = frameAt(route, st);
    const corr = 0.5 * Math.abs(f.kappa ?? 0) * u * u;
    best = Math.min(best, f.w / 2 - span - corr);
  }
  return best;
}

/** widest disc that can pass station s */
export function maxRadiusAt(route, s) {
  let lo = 0, hi = widthAt(route, s) / 2;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (maxLatAt(route, s, mid) >= -1e-6) lo = mid; else hi = mid;
  }
  return lo;
}

export function worldOf(route, s, l) {
  const f = frameAt(route, s);
  return add(f.p, mul(f.normal, l));
}

export function nearestStation(route, p) {
  const ss = route.samples;
  let best = { d: Infinity, station: 0 };
  for (let i = 0; i < ss.length; i++) {
    const d = dist(p, ss[i].p);
    if (d < best.d) best = { d, station: ss[i].s };
  }
  return best;
}

export function localOf(route, p) {
  const near = nearestStation(route, p);
  const f = frameAt(route, near.station);
  return { s: near.station, l: dot(sub(p, f.p), f.normal) };
}

export function boundaries(route) {
  const left = [], right = [];
  for (const sm of route.samples) {
    left.push(add(sm.p, mul(sm.normal, sm.w / 2)));
    right.push(add(sm.p, mul(sm.normal, -sm.w / 2)));
  }
  return { left, right };
}

/** max forward station reachable from (s,l) for a disc of radius r before the wall blocks it */
export function maxReachAt(route, s, l, r) {
  const absL = Math.abs(l);
  if (maxLatAt(route, s, r) < absL - 1e-9) return s;
  let lo = s, hi = route.length;
  if (maxLatAt(route, hi, r) >= absL - 1e-9) return hi;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (maxLatAt(route, mid, r) >= absL - 1e-9) lo = mid; else hi = mid;
  }
  return lo;
}

export { len, dist, dot, cross, add, sub, mul, lerp, clamp, norm };

/**
 * A corridor of half-width h can only turn with radius >= h; if it turns
 * tighter, the inner wall passes through the centreline and the floor folds
 * over itself. Returns every sample where that happens.
 */
export function corridorViolations(route, tol = 0.05) {
  const bad = [];
  for (const sm of route.samples) {
    const k = Math.abs(sm.kappa ?? 0);
    if (k < 1e-6) continue;
    const R = 1 / k;
    const h = sm.w / 2;
    if (R < h - tol) bad.push({ s: +sm.s.toFixed(3), radius: +R.toFixed(3), halfWidth: +h.toFixed(3) });
  }
  return bad;
}
