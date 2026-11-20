#!/usr/bin/env node
/*
 * Browser smoke test for the viewport.
 *
 * Needs Playwright; resolves it from PW_ROOT (default /tmp/pw), the same tree
 * tools/chrome.sh sets up. Serves the repo itself, so run with:
 *
 *   node tools/serve.mjs 8137 . &      # or npm run serve
 *   tools/chrome.sh tools/ui-test.mjs
 *
 * Exits non-zero on console errors, missing controls, or a run whose displayed
 * acceptance disagrees with the simulation.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const PW = process.env.PW_ROOT ?? '/tmp/pw';
const { default: pw } = await import(pathToFileURL(join(PW, 'node_modules/playwright/index.js')).href);
const BASE = process.env.BASE_URL ?? 'http://localhost:8137/web/';

const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 780 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failed++;
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__squad?.run, null, { timeout: 8000 });

const boot = await page.evaluate(() => ({
  canvas: !!document.querySelector('#view'),
  levels: [...document.querySelectorAll('#levels button')].map((b) => b.textContent),
  strategies: [...document.querySelectorAll('#strategies button')].map((b) => b.textContent),
  members: document.querySelectorAll('.mem').length,
}));
check('page boots with a canvas', boot.canvas);
check('two levels offered', boot.levels.length === 2, boot.levels.join('/'));
check('five members listed at the entrance', boot.members === 5, String(boot.members));

/* every level x strategy x scenario renders and reports its own status */
const combos = await page.evaluate(async () => {
  const levels = ['A', 'B'];
  const out = [];
  for (const lid of levels) {
    const strat = lid === 'A' ? ['wait', 'early', 'rush', 'none'] : ['wait', 'early', 'side', 'rush', 'none'];
    for (const st of strat) for (const sc of ['steady', 'lag']) {
      window.__squad.select(lid, st, sc);
      const r = window.__squad.run;
      const cols = [...document.querySelectorAll('#checks .mark')].map((e) => e.className);
      out.push({
        key: `${lid}/${st}/${sc}`, status: r.result.status,
        frame: window.__squad.state.frame, frames: r.result.trace.length,
        header: document.querySelector('#status').textContent,
        checks: cols.length,
      });
    }
  }
  return out;
});
for (const c of combos) {
  check(`${c.key}: renders ${c.frames} frames, status "${c.status}"`,
    c.frames > 1 && c.frame === c.frames - 1 && c.checks === 9,
    `frame ${c.frame}/${c.frames}, checks ${c.checks}`);
}
const fails = combos.filter((c) => c.status !== 'arrived' && !/堵|未到齐|挤/.test(c.header));
check('every failure is explained in the status bar', fails.length === 0, JSON.stringify(fails));

/* entrance regroup: swapping two non-leaders changes the computed fold start */
const regroup = await page.evaluate(() => {
  window.__squad.select('A', 'wait', 'steady');
  const before = window.__squad.run.plan.fold.latestSafe;
  const order = window.__squad.run.level.squad.map((m) => ({ ...m }));
  const i = order.findIndex((m) => m.slot === 1), j = order.findIndex((m) => m.slot === 4);
  const s1 = order[i].slot; order[i].slot = order[j].slot; order[j].slot = s1;
  window.__squad.setSlots(order);
  const after = window.__squad.run.plan.fold.latestSafe;
  return { before, after, members: [...document.querySelectorAll('.mem')].map((e) => e.textContent) };
});
check('regroup changes the safe fold start', Math.abs(regroup.after - regroup.before) > 0.1,
  `${regroup.before} -> ${regroup.after}`);
check('regrouped order is reflected in the entrance list', regroup.members[1].includes('#2'), regroup.members.join('|'));

/* scrub moves the depiction */
const scrub = await page.evaluate(() => {
  window.__squad.select('A', 'wait', 'steady');
  window.__squad.setFrame(10);
  const t10 = window.__squad.run.result.trace[10].t;
  window.__squad.setFrame(60);
  return { t10, t60: window.__squad.run.result.trace[60].t, clock: document.querySelector('#clock').textContent };
});
check('timeline scrubbing updates the clock', scrub.t60 > scrub.t10 && scrub.clock.startsWith(scrub.t60.toFixed(1)),
  `${scrub.t10} -> ${scrub.t60}, clock ${scrub.clock}`);

/* playback advances on its own */
const played = await page.evaluate(async () => {
  window.__squad.select('A', 'wait', 'steady');
  window.__squad.setFrame(0);
  window.__squad.setPlay(true);
  await new Promise((r) => setTimeout(r, 400));
  const f = window.__squad.state.frame;
  window.__squad.setPlay(false);
  return f;
});
check('playback advances frames', played > 1, `frame after 400 ms: ${played}`);

check('no console or page errors', errors.length === 0, errors.join('\n'));

await page.screenshot({ path: 'out/ui-test.png' });
await browser.close();
console.log(`\n${failed === 0 ? 'ui: ok' : `ui: ${failed} failed`}`);
process.exit(failed ? 1 : 0);
