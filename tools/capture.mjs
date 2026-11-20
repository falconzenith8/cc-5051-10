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
import { makeTransform, drawScene } from '../src/render/scene.js';

const [levelId = 'A', strategy = 'wait', scenarioId = 'steady', frameArg = 'last', out = 'out/frame.png'] =
  process.argv.slice(2);

const level = makeLevels().find((l) => l.id === levelId);
if (!level) throw new Error(`no level ${levelId}`);
const scen = level.scenarios.find((s) => s.id === scenarioId) ?? level.scenarios[0];
const { plan, result, route } = runLevel(level, strategy, scen.lag ? { id: scen.id, lag: scen.lag } : { id: scen.id });

const W = 900, H = 460;
const tr = makeTransform(route, W, H);
const frames = result.trace;
const frame = frameArg === 'last' ? frames[frames.length - 1] : frames[Math.min(+frameArg, frames.length - 1)];
const members = frame.members.map((p) => {
  const def = level.squad.find((m) => m.slot === p.slot);
  return { ...p, label: `#${p.slot + 1}`, color: def?.color, radius: def?.radius };
});

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
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
