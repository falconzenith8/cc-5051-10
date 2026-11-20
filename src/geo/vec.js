export const EPS = 1e-9;

export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function norm(a) {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export const perpLeft = (d) => ({ x: -d.y, y: d.x });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;

export function angle(a, b) {
  const d = norm(a).x * norm(b).x + norm(a).y * norm(b).y;
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

export const rot = (a, t) => ({
  x: a.x * Math.cos(t) - a.y * Math.sin(t),
  y: a.x * Math.sin(t) + a.y * Math.cos(t),
});

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

export function projectPointToSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return { point: { ...a }, t: 0, d: dist(p, a) };
  let t = dot(sub(p, a), ab) / l2;
  t = clamp(t, 0, 1);
  const point = add(a, mul(ab, t));
  return { point, t, d: dist(p, point) };
}
