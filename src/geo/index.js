import { widthAt, frameAt, maxLatAt, buildRoute, worldOf, nearestStation, localOf } from './route.js';

const GRID = 0.04;

export class RouteIndex {
  constructor(route, radii) {
    this.route = route;
    this.radii = [...new Set(radii)].sort((a, b) => a - b);
    this.n = Math.ceil(route.length / GRID) + 1;
    this.tables = new Map();
    this.trees = new Map();
    for (const r of this.radii) {
      const tab = new Float64Array(this.n);
      for (let i = 0; i < this.n; i++) {
        const s = Math.min(i * GRID, route.length);
        tab[i] = Math.max(0, maxLatAt(route, s, r));
      }
      this.tables.set(r, tab);
      this.trees.set(r, buildMinTree(tab));
    }
  }

  nearestRadius(r) {
    let best = this.radii[0];
    for (const x of this.radii) if (Math.abs(x - r) < Math.abs(best - r)) best = x;
    return best;
  }

  maxLat(r, s) {
    const rr = this.nearestRadius(r);
    const tab = this.tables.get(rr);
    const x = Math.max(0, Math.min(this.n - 1, s / GRID));
    const i = Math.floor(x);
    const f = x - i;
    if (i >= this.n - 1) return tab[this.n - 1];
    return tab[i] * (1 - f) + tab[i + 1] * f;
  }

  /** first station at or after `from` where the envelope drops below `need`; Infinity if none */
  firstBlockedFor(r, from, need) {
    const tab = this.tables.get(this.nearestRadius(r));
    const tree = this.trees.get(this.nearestRadius(r));
    const i0 = Math.max(0, Math.floor(from / GRID));
    const idx = firstBelow(tree, this.n, i0, need);
    return idx >= this.n ? Infinity : Math.min(idx * GRID, this.route.length);
  }

  lastBlockedFor(r, to, need) {
    const tree = this.trees.get(this.nearestRadius(r));
    const i0 = Math.min(this.n - 1, Math.ceil(to / GRID));
    const idx = lastBelow(tree, this.n, i0, need);
    return idx < 0 ? -Infinity : Math.max(0, idx * GRID);
  }

  maxReach(r, s, l) {
    const b = this.firstBlockedFor(r, s, Math.abs(l));
    return b === Infinity ? this.route.length : Math.max(s, b - GRID);
  }

  minReach(r, s, l) {
    const b = this.lastBlockedFor(r, s, Math.abs(l));
    return b === -Infinity ? 0 : Math.min(s, b + GRID);
  }

  bottleneckFor(r) {
    const tab = this.tables.get(this.nearestRadius(r));
    let bi = 0;
    for (let i = 1; i < this.n; i++) if (tab[i] < tab[bi]) bi = i;
    const s = Math.min(bi * GRID, this.route.length);
    return { station: s, maxLat: tab[bi], width: widthAt(this.route, s) };
  }
}

function buildMinTree(tab) {
  const size = 1;
  let cap = 1;
  while (cap < tab.length) cap <<= 1;
  const tree = new Float64Array(cap * 2).fill(Infinity);
  for (let i = 0; i < tab.length; i++) tree[cap + i] = tab[i];
  for (let i = cap - 1; i >= 1; i--) tree[i] = Math.min(tree[2 * i], tree[2 * i + 1]);
  return { tree, cap, size: tab.length };
}

function firstBelow(node, n, i0, need) {
  const { tree, cap } = node;
  if (i0 >= n) return n;
  return descendFirst(1, 0, cap - 1, i0, need, tree) ?? n;
}

function descendFirst(v, l, r, i0, need, tree) {
  if (r < i0 || tree[v] >= need) return null;
  if (l === r) return l < tree.length ? l : null;
  const mid = (l + r) >> 1;
  const a = descendFirst(2 * v, l, mid, i0, need, tree);
  if (a !== null) return a;
  return descendFirst(2 * v + 1, mid + 1, r, i0, need, tree);
}

function lastBelow(node, n, i0, need) {
  const { tree, cap } = node;
  const i = Math.min(i0, n - 1);
  if (i < 0) return -1;
  return descendLast(1, 0, cap - 1, i, need, tree) ?? -1;
}

function descendLast(v, l, r, i0, need, tree) {
  if (l > i0 || tree[v] >= need) return null;
  if (l === r) return l;
  const mid = (l + r) >> 1;
  const b = descendLast(2 * v + 1, mid + 1, r, i0, need, tree);
  if (b !== null) return b;
  return descendLast(2 * v, l, mid, i0, need, tree);
}

export { buildRoute, frameAt, widthAt, worldOf, nearestStation, localOf, maxLatAt };
