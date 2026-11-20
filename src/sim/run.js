import { RouteIndex } from '../geo/index.js';
import { planRun } from './planner.js';
import { SquadSim } from './engine.js';

export function buildIndex(route, squad) {
  return new RouteIndex(route, squad.map((m) => m.radius));
}

export function routeFor(level, strategy) {
  return level.routeFor?.(strategy) ?? level.route;
}

export function runLevel(level, strategy, scenario = {}, opts = {}) {
  const route = routeFor(level, strategy);
  const index = buildIndex(route, level.squad);
  const plan = planRun({ route, squad: level.squad, level, strategy });
  plan.route = route;
  const sim = new SquadSim({ route, squad: level.squad, plan, level, index, scenario, opts });
  const result = sim.run();
  result.route = route;
  return { plan, result, sim, route };
}

export function runAll(level) {
  return level.strategies.map((strategy) => ({ strategy, ...runLevel(level, strategy) }));
}
