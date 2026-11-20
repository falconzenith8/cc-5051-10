import { buildRoute } from '../geo/route.js';
import { makeSquad } from '../sim/formation.js';

/*
 * Level A — abrupt throat.
 * Straight 3.0 m approach, then a sudden 0.6 m-long squeeze to 1.35 m.
 * The throat is shorter than the wide formation's footprint, so a squad that
 * walks in wide cannot "pinch" through: the outer bodies physically stop at
 * the narrowing and block the lane behind them.
 */
const NODES_A = [
  { x: 0.0, y: 0.0, w: 3.00 },
  { x: 5.6, y: 0.0, w: 3.00 },
  { x: 7.9, y: 0.0, w: 3.00 },
  { x: 8.55, y: 0.0, w: 1.35 },   // sudden 0.65 m-long squeeze to 1.35 m
  { x: 9.2, y: 0.0, w: 1.35 },
  { x: 12.0, y: 0.0, w: 3.00 },
  { x: 15.6, y: 0.0, w: 3.10 },
];

/*
 * Level B — two ways past the same door width.
 *  main: the direct route, same short throat as A but reached after a shallow
 *        bend; only a short run-up in which to fold.
 *  side: a branch that peels left into a wide, long aisle, then rejoins through
 *        an equally abrupt throat. Far more longitudinal room to pre-file, so
 *        the formation can absorb a rear member lagging behind.
 */
const NODES_B_MAIN = [
  { x: 0.0, y: 0.0, w: 3.05 },
  { x: 5.6, y: 0.0, w: 3.05 },
  { x: 7.6, y: -0.5, w: 3.00 },
  { x: 8.45, y: -0.9, w: 1.35 },   // sudden throat after the bend
  { x: 9.1, y: -0.9, w: 1.35 },
  { x: 11.9, y: -0.9, w: 3.00 },
  { x: 15.4, y: -0.9, w: 3.10 },
];

const NODES_B_SIDE = [
  { x: 0.0, y: 0.0, w: 3.05 },
  { x: 4.6, y: 0.0, w: 3.05 },
  { x: 7.0, y: -0.45, w: 3.00 },  // branch peels left, still wide
  { x: 10.4, y: -1.55, w: 2.95 }, // side aisle runs parallel, roomy
  { x: 13.6, y: -2.15, w: 2.85 },
  { x: 16.8, y: -2.3, w: 2.75 },  // long run-up: room to pre-file
  { x: 18.4, y: -2.1, w: 2.65 },
  { x: 19.3, y: -1.25, w: 1.40 }, // THEN the sudden deep throat
  { x: 19.9, y: -0.95, w: 1.35 },
  { x: 21.3, y: -0.95, w: 1.35 },
  { x: 23.9, y: -0.95, w: 3.10 },
];

export const SQUAD_DEFS = [
  { id: 'L', name: '队长', color: '#f59e0b', width: 0.54, vFwd: 1.40, vLat: 0.98 },
  { id: 'B', name: '阿岚', color: '#38bdf8', width: 0.60, vFwd: 1.36, vLat: 0.66 },
  { id: 'C', name: '金石', color: '#a78bfa', width: 0.64, vFwd: 1.34, vLat: 0.58 },
  { id: 'D', name: '小满', color: '#34d399', width: 0.52, vFwd: 1.44, vLat: 0.84 },
  { id: 'E', name: '青岑', color: '#fb7185', width: 0.62, vFwd: 1.30, vLat: 0.46 },
];

const SCENARIOS = [
  { id: 'steady', label: '全员齐整', lag: null },
  {
    id: 'lag',
    label: '后排小满临时落后',
    lag: { slot: 3, t0: 0.6, t1: 6.0, fwd: 0.15, lat: 0.2 },
  },
];

function gateStationOf(route) {
  let best = { w: Infinity, s: 0 };
  for (let s = 0; s <= route.length; s += 0.02) {
    const w = widthAtApprox(route, s);
    if (w < best.w) best = { w, s };
  }
  return best.s;
}
function widthAtApprox(route, s) {
  const i = Math.max(0, Math.min(route.samples.length - 1, Math.round((s / route.length) * (route.samples.length - 1))));
  return route.samples[i].w;
}

export function makeLevels() {
  const routeA = buildRoute('level-a', NODES_A, { title: 'A · 突窄门', round: 0.45, ds: 0.02 });
  const routeBMain = buildRoute('level-b-main', NODES_B_MAIN, { title: 'B · 直门', round: 2.6, ds: 0.02 });
  const routeBSide = buildRoute('level-b-side', NODES_B_SIDE, { title: 'B · 侧廊', round: 2.6, ds: 0.02 });

  return [
    {
      id: 'A',
      title: 'A · 突窄门',
      blurb: '笔直接近，然后 0.6 m 内由 3.0 m 陡收到 1.35 m。横队无法在此“挤”过去，必须在门前完成收拢。',
      route: routeA,
      squad: makeSquad(SQUAD_DEFS),
      gateStation: gateStationOf(routeA),
      startStation: 4.60,
      leaderSpeed: 1.35,
      strategies: ['wait', 'early', 'rush', 'none'],
      defaultStrategy: 'wait',
      startArea: { from: 4.0, to: 5.2 },
      scenarios: SCENARIOS,
      entryLabel: '入口宽 3.0 m',
      notes: [
        '门净宽 1.35 m ＜ 横队 2.36 m，必须换纵队',
        '横队前缘到门只有不到 1 m 余量，收拢窗口很窄',
        'wait：在门槛前等队尾收拢；rush：不等，直接冲',
      ],
    },
    {
      id: 'B',
      title: 'B · 侧廊',
      blurb: '同一道 1.35 m 窄门有两种走法：直接穿过短门前只有一小段助跑；或者左转绕进长侧廊，先排成纵队再斜插回门。',
      route: routeBMain,
      routeFor: (strategy) => (strategy === 'side' ? routeBSide : routeBMain),
      routes: { main: routeBMain, side: routeBSide },
      squad: makeSquad(SQUAD_DEFS),
      gateStation: gateStationOf(routeBMain),
      startStation: 4.60,
      leaderSpeed: 1.35,
      strategies: ['wait', 'early', 'side', 'rush', 'none'],
      defaultStrategy: 'side',
      startArea: { from: 4.0, to: 5.2 },
      scenarios: SCENARIOS,
      entryLabel: '入口分两路',
      sideAisle: {
        from: routeBSide.nodeStations[2],
        to: routeBSide.nodeStations[7],
        preFile: routeBSide.nodeStations[4],
      },
      notes: [
        '主门与侧廊门都是 1.35 m：障碍相同，助跑不同',
        '侧廊在 s≈' + routeBSide.nodeStations[4].toFixed(1) + ' m 处仍有约 2.7 m 净宽，可从容预排',
        'side：换走侧廊；early/wait：仍走直门，靠等队与提前收拢换取通过',
      ],
    },
  ];
}

export function getLevel(id) {
  return makeLevels().find((l) => l.id === id);
}

export { NODES_A, NODES_B_MAIN, NODES_B_SIDE, SCENARIOS };
