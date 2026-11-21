#!/usr/bin/env node
/*
 * Headless PNG capture for the viewport.
 *
 *   node tools/capture.mjs <levelId> <strategy> <scenarioId> <frameIndex|last> <out.png>
 *
 * Renders with @napi-rs/canvas (resolved via NODE_PATH=/tmp/pw/node_modules).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// ESM resolution ignores NODE_PATH, so locate the native canvas explicitly.
const canvasUrl = process.env.CANVAS_ENTRY
  ?? pathToFileURL('/tmp/pw/node_modules/@napi-rs/canvas/index.js').href;
const { createCanvas } = await import(canvasUrl);
import { makeLevels } from '../src/levels/levels.js';
import { runLevel } from '../src/sim/run.js';
import { ClearanceSession } from '../src/sim/clearance-session.js';
import { makeTransform, drawScene, drawSquad, drawStop } from '../src/render/scene.js';
import { TEMPLATES } from '../src/sim/formation.js';

const [levelId = 'A', strategy = 'wait', scenarioId = 'steady', frameArg = 'last', out = 'out/frame.png'] =
  process.argv.slice(2);

const level = makeLevels().find((l) => l.id === levelId);
if (!level) throw new Error(`no level ${levelId}`);
const scen = level.scenarios.find((s) => s.id === scenarioId) ?? level.scenarios[0];

const W = 900, H = 460;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

if (Array.isArray(level.pillars) && level.pillars.length) {
  // Clearance-only level: the strategy names the formation to inspect.
  const template = strategy === 'wide' ? 'wide' : 'file';
  const session = new ClearanceSession({
    route: level.route, squad: level.squad, template, pillars: level.pillars,
  });
  const rep = session.runFull();
  const tr = makeTransform(level.route, W, H);
  drawScene(ctx, {
    route: level.route, plan: null, squad: session.squad, tr, width: W, height: H,
    trace: [], members: null, result: null,
    pillars: rep.pillars,
    clearance: { intervals: rep.intervals, revalidatedSpans: [] },
    title: `${level.id} / ${template}`,
    subtitle: rep.canPass ? 'formation passes' : `first stop s=${rep.stop.s.toFixed(2)} m (${rep.stop.member})`,
    ascii: true,
  });
  const members = session.index.members.map((m) => ({
    slot: m.slot, s: 1.2 + TEMPLATES[template].slots[m.slot].back,
    l: m.band.lat, radius: m.radius,
    color: session.squad.find((x) => x.slot === m.slot)?.color, label: `#${m.slot + 1}`,
  }));
  drawSquad(ctx, level.route, tr, members);
  if (rep.stop) drawStop(ctx, level.route, tr, { doorStop: { s: rep.stop.s, l: 0 } }, { ascii: true });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, canvas.toBuffer('image/png'));
  console.log(`${out}  (${rep.canPass ? 'passes' : `stop s=${rep.stop.s}`}, ${rep.cells} cells)`);
  process.exit(0);
}

const { plan, result, route } = runLevel(level, strategy, scen.lag ? { id: scen.id, lag: scen.lag } : { id: scen.id });
const tr = makeTransform(route, W, H);
const frames = result.trace;
const frame = frameArg === 'last' ? frames[frames.length - 1] : frames[Math.min(+frameArg, frames.length - 1)];
const members = frame.members.map((p) => {
  const def = level.squad.find((m) => m.slot === p.slot);
  return { ...p, label: `#${p.slot + 1}`, color: def?.color, radius: def?.radius };
});

drawScene(ctx, {
  route, plan, squad: level.squad, tr, width: W, height: H,
  trace: frames.slice(0, Math.max(1, frames.indexOf(frame) + 1)),
  members,
  result: result.status === 'arrived' ? null : result,
  title: `${level.id} / ${strategy} / ${scen.id}`,
  subtitle: `t=${frame.t.toFixed(1)}s / ${frames[frames.length - 1].t.toFixed(1)}s  ` +
    `fold=${(frame.fold * 100).toFixed(0)}%  ${result.status}`,
  ascii: true,
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, canvas.toBuffer('image/png'));
console.log(`${out}  (${result.status}, ${frames.length} frames)`);
