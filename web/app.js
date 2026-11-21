import { makeLevels } from '../src/levels/levels.js';
import { runLevel } from '../src/sim/run.js';
import { runAcceptance } from '../test/acceptance.js';
import { swapSlots, TEMPLATES } from '../src/sim/formation.js';
import { makeTransform, drawScene, drawSquad, drawStop, pillarAt } from '../src/render/scene.js';
import { ClearanceSession } from '../src/sim/clearance-session.js';

const STRATEGY_LABEL = {
  wait: '等队', early: '提前变形', side: '换走侧廊', rush: '抢行', none: '不收拢',
  file: '纵队检查', wide: '横队检查',
};
const STRATEGY_TIP = {
  wait: '在门槛前停下，等实际队尾收拢并完成纵队后再放行。',
  early: '入口后立即开始变形，但仍尊重放行门。',
  side: '改走较长的侧廊，用额外的纵向空间提前排成纵队。',
  rush: '完全不等待，按自己的折线直接冲门。',
  none: '从不收拢成纵队，直接以横队闯门。',
  file: '只做净空检查：按纵队逐名成员扫掠整条路线。',
  wide: '只做净空检查：按横队逐名成员扫掠整条路线。',
};
const CHECK_LABEL = {
  allArrived: '全员到达', slotContinuity: '槽位连续', velocityLimits: '速度约束',
  slotFidelity: '槽位贴合', stopPosition: '停靠位置', walls: '不越墙',
  narrowGap: '最窄间隙', formationFit: '队形适配', foldWindow: '收拢窗口',
};
const REQUIRED = ['slotContinuity', 'velocityLimits', 'walls', 'narrowGap', 'formationFit', 'stopPosition'];

const levels = makeLevels();
const state = {
  levelId: 'A',
  strategy: 'wait',
  scenarioId: 'steady',
  squadByLevel: {},
  pillarsByLevel: {},
  playing: true,
  frame: 0,
  lastT: 0,
};

for (const lv of levels) {
  state.squadByLevel[lv.id] = lv.squad;
  state.pillarsByLevel[lv.id] = (lv.pillars ?? []).map((p) => ({ ...p }));
}

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d');

let run = null; // { level, plan, result, route, trace, transform }
let view = { w: 0, h: 0 };
let clearance = null; // ClearanceSession for the level that has pillars
let clearanceReport = null;
let drag = null;      // { pillar, dx, dy }

/** Levels with pillars get a live clearance session instead of a sim run. */
function isClearanceLevel(level) {
  return Array.isArray(level.pillars) && level.pillars.length > 0;
}

/* ---------- controls ---------- */

function chosenLevel() {
  return levels.find((l) => l.id === state.levelId);
}

function currentScenario() {
  const lv = chosenLevel();
  return lv.scenarios.find((s) => s.id === state.scenarioId) ?? lv.scenarios[0];
}

function rebuild(keepFrame = false) {
  const level = chosenLevel();
  const scen = currentScenario();
  const squad = state.squadByLevel[level.id];
  const pillars = state.pillarsByLevel[level.id];
  const lv = { ...level, squad, pillars };
  // A strategy carried over from another level may not exist here (e.g. "side"
  // on level A); resolve it before planning *and* before painting the controls.
  if (!lv.strategies.includes(state.strategy)) state.strategy = lv.defaultStrategy;

  if (isClearanceLevel(lv)) {
    rebuildClearance(lv);
    renderControls();
    layout();
    draw();
    return;
  }

  clearance = null; clearanceReport = null;
  drag = null;
  const scenario = scen.lag ? { id: scen.id, lag: scen.lag } : { id: scen.id };
  const r = runLevel(lv, state.strategy, scenario);
  const acc = runAcceptance({ plan: r.plan, result: r.result, level: lv });
  run = { level: lv, ...r, acc };
  if (!keepFrame) state.frame = 0;
  state.frame = Math.max(0, Math.min(state.frame, r.result.trace.length - 1));
  renderControls();
  layout();
  draw();
}

function rebuildClearance(lv) {
  const template = state.strategy === 'wide' ? 'wide' : 'file';
  clearance = new ClearanceSession({
    route: lv.route, squad: lv.squad, template, pillars: lv.pillars,
  });
  clearanceReport = clearance.runFull();
  // No motion trace on a clearance level: the verdict is geometric.
  run = { level: lv, route: lv.route, plan: null, result: null, trace: [], acc: null };
  state.frame = 0;
  state.playing = false;
}

/** Recompute after an edit that only touches the clearance session. */
function refreshClearance(spans) {
  clearanceReport = clearance.report();
  clearanceReport.revalidatedSpans = spans ?? [];
  renderControls();
  draw();
}

function renderControls() {
  const level = chosenLevel();
  $('blurb').textContent = level.blurb;

  const lvRow = $('levels');
  lvRow.innerHTML = '';
  for (const l of levels) lvRow.append(btn(l.title, l.id === state.levelId, () => {
    state.levelId = l.id;
    state.strategy = l.strategies.includes(l.defaultStrategy) ? l.defaultStrategy : l.strategies[0];
    state.scenarioId = 'steady';
    rebuild();
  }));

  const stRow = $('strategies');
  stRow.innerHTML = '';
  for (const s of level.strategies) stRow.append(btn(STRATEGY_LABEL[s] ?? s, s === state.strategy, () => {
    state.strategy = s; rebuild();
  }));
  stRow.title = STRATEGY_TIP[state.strategy] ?? '';

  const scRow = $('scenarios');
  scRow.innerHTML = '';
  const clearanceMode = isClearanceLevel(level);
  for (const s of level.scenarios) {
    const b = btn(s.label, s.id === state.scenarioId, () => {
      state.scenarioId = s.id; rebuild();
    });
    b.disabled = clearanceMode; // clearance is static geometry, no timing scenarios
    scRow.append(b);
  }

  renderMembers(level);
  renderClearanceTools(level);
  renderChecks();
  renderClearanceSummary();
}

/**
 * Extra controls for a clearance level: flip formation, widen the outer
 * members' equipment, drag the pillar back to its home position.
 */
function renderClearanceTools(level) {
  const wrap = $('clearTools');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!isClearanceLevel(level) || !clearance) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  const h = document.createElement('h2');
  h.textContent = '净空检查（拖动柱子）';
  wrap.append(h);

  const row = document.createElement('div');
  row.className = 'row'; row.id = 'formations';
  row.append(
    btn('横队', clearance.template === 'wide', () => {
      state.strategy = 'wide';
      const rep = clearance.setTemplate('wide');
      refreshClearance(rep.revalidated.map((i) => [clearance.cells[i].s0, clearance.cells[i].s1]));
    }),
    btn('纵队', clearance.template === 'file', () => {
      state.strategy = 'file';
      const rep = clearance.setTemplate('file');
      refreshClearance(rep.revalidated.map((i) => [clearance.cells[i].s0, clearance.cells[i].s1]));
    }),
  );

  const row2 = document.createElement('div');
  row2.className = 'row';
  row2.append(
    btn('外侧 +0.10 m', false, () => {
      const rep = clearance.widenOuterMembers(0.10);
      refreshClearance(rep.revalidated.map((i) => [clearance.cells[i].s0, clearance.cells[i].s1]));
    }),
    btn('外侧 +0.20 m', false, () => {
      const rep = clearance.widenOuterMembers(0.20);
      refreshClearance(rep.revalidated.map((i) => [clearance.cells[i].s0, clearance.cells[i].s1]));
    }),
    btn('恢复装备', false, () => {
      const home = state.squadByLevel[level.id].map((m) => ({ ...m }));
      clearance = new ClearanceSession({ route: level.route, squad: home, template: clearance.template, pillars: state.pillarsByLevel[level.id] });
      clearanceReport = clearance.runFull();
      clearanceReport.revalidatedSpans = [];
      renderControls(); draw();
    }),
    btn('柱子归位', false, () => {
      state.pillarsByLevel[level.id] = (level.pillars ?? []).map((p) => ({ ...p }));
      clearance = new ClearanceSession({ route: level.route, squad: state.squadByLevel[level.id], template: clearance.template, pillars: state.pillarsByLevel[level.id] });
      clearanceReport = clearance.runFull();
      clearanceReport.revalidatedSpans = [];
      renderControls(); draw();
    }),
  );
  wrap.append(row, row2);

  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '直接拖动预览里的柱子：只重验它可达范围内的路段；'
    + '转角等不确定路段会回退到全体成员细扫。黄色虚线是被重验的区间。';
  wrap.append(hint);
}

/** A compact report of what the last clearance pass did. */
function renderClearanceSummary() {
  const wrap = $('stats2');
  if (!wrap) return;
  wrap.innerHTML = '';
  const summary = $('clearSummary');
  if (!clearanceReport || !clearance) { if (summary) summary.style.display = 'none'; return; }
  if (summary) summary.style.display = '';
  const rep = clearanceReport;
  const r = rep.last;
  const rc = rep.recompute;
  const rows = [
    ['队形', rep.template === 'wide' ? '横队' : '纵队'],
    ['能否整队通过', rep.canPass ? '能' : '不能'],
    ['首个应停位置', rep.stop ? `s=${rep.stop.s.toFixed(2)} m · ${rep.stop.member}` : '—'],
    ['原因', rep.stop ? rep.stop.reason : '全员净空足够'],
    ['路段数', `${rep.cells} 段 × ${(clearance.opts.cell * 100).toFixed(0)} cm`],
    ['上次重验', r ? `${r.cells.length} 段 · 窄路 ${rc.narrow.cells} / 宽路 ${rc.wide.cells}` : '—'],
    ['窄路重算', rc.narrow.cells ? `${rc.narrow.cells} 段全宽扫掠 · ${rc.narrow.checks} 次检查` : '—'],
    ['宽路省检', rc.wide.skipped ? `${rc.wide.skipped} 次（共 ${rc.wide.checks + rc.wide.skipped}）` : '—'],
    ['成员检查', r ? `${r.checks} 次（跳过 ${r.skipped}）` : '—'],
    ['转角回退', r ? `${r.fallbacks} 段细扫` : '—'],
    ['真正失效', r ? `${r.changed.added.length} 段新增 / ${r.changed.removed.length} 段恢复` : '—'],
  ];
  for (const [k, v] of rows) {
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('b'); b.textContent = v;
    wrap.append(a, b);
  }
}

function renderMembers(level) {
  const wrap = $('members');
  wrap.innerHTML = '';
  const squad = state.squadByLevel[level.id];
  const clearanceMode = isClearanceLevel(level);
  const ordered = squad.slice().sort((a, b) => a.slot - b.slot);
  for (const m of ordered) {
    const el = document.createElement('div');
    el.className = 'mem' + (m.slot === 0 ? ' leader' : '');
    el.draggable = m.slot !== 0 && !clearanceMode;
    el.dataset.slot = String(m.slot);
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = m.color;
    const name = document.createElement('span');
    name.textContent = m.name + (m.slot === 0 ? '（队长）' : '');
    const slot = document.createElement('span');
    slot.className = 'slot';
    const curRadius = clearance && clearanceMode
      ? clearance.radiusBySlot.get(m.slot) ?? m.radius : m.radius;
    slot.textContent = `#${m.slot + 1} · 宽 ${(2 * curRadius).toFixed(2)} · v横 ${m.vLat.toFixed(2)}`;
    el.append(dot, name, slot);

    if (m.slot !== 0 && !clearanceMode) {
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', String(m.slot));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        if (!Number.isFinite(from) || from === m.slot) return;
        state.squadByLevel[level.id] = swapSlots(state.squadByLevel[level.id], from, m.slot);
        rebuild(true);
      });
    }
    wrap.append(el);
  }
}

function renderChecks() {
  const wrap = $('checks');
  wrap.innerHTML = '';
  if (!run.acc) {
    // Clearance levels report geometry, not motion acceptance.
    const rep = clearanceReport;
    if (!rep) return;
    const rows = [
      ['整队通过', rep.canPass, rep.canPass ? '每名成员的扫掠区间都留有净空' : rep.stop?.reason ?? ''],
      ['首个停点', !!rep.stop, rep.stop ? `s=${rep.stop.s.toFixed(2)} m · ${rep.stop.member}` : '无'],
      ['判定可信', clearance.verify().equal, '增量结论与全量参考逐段一致'],
    ];
    for (const [label, ok, note] of rows) {
      const mark = document.createElement('span');
      mark.className = 'mark ' + (ok ? 'ok' : 'no');
      mark.textContent = ok ? '✓' : '✗';
      const l = document.createElement('span'); l.textContent = label;
      const small = document.createElement('small'); small.textContent = note;
      wrap.append(mark, l, small);
    }
    return;
  }
  for (const [key, c] of Object.entries(run.acc.checks)) {
    const mark = document.createElement('span');
    mark.className = 'mark ' + (c.skipped ? 'sk' : c.pass ? 'ok' : 'no');
    mark.textContent = c.skipped ? '–' : c.pass ? '✓' : '✗';
    const label = document.createElement('span');
    const req = REQUIRED.includes(key) ? '' : '（附加）';
    label.textContent = (CHECK_LABEL[key] ?? key) + req;
    const small = document.createElement('small');
    small.textContent = detail(c);
    wrap.append(mark, label, small);
  }
}

function detail(c) {
  if (c.worstJumpS !== undefined) return `相邻帧跳变 ${c.worstJumpS} m / ${c.worstJumpL} m`;
  if (c.worstAlongRatio !== undefined) return `纵向 ${(c.worstAlongRatio * 100).toFixed(0)}%，横向 ${(c.worstSideRatio * 100).toFixed(0)}% 上限`;
  if (c.worst !== undefined && c.note?.includes('槽位')) return `最大偏差 ${c.worst} m`;
  if (c.stopStation !== undefined) return `停靠 s=${c.stopStation} m（${c.stopMember ?? ''}）`;
  if (c.worstOverhang !== undefined) return `最大越界 ${c.worstOverhang} m`;
  if (c.reported !== undefined) return `报告 ${c.reported} m / 实际 ${c.actual} m`;
  if (c.gateWidth !== undefined) return `门 ${c.gateWidth} m ＜ 横队 ${c.wideSpan} m，纵队 ${c.fileSpan} m`;
  if (c.earliest !== undefined) return `窗口 [${c.earliest}, ${c.latest}]，起点 ${c.start}`;
  if (c.status) return `状态 ${c.status}`;
  return c.note ?? '';
}

function renderStats() {
  const wrap = $('stats');
  wrap.innerHTML = '';
  const st = $('status');
  const r = run.result;

  if (!r) {
    // Clearance-only level: show the geometry report, not motion stats.
    const rep = clearanceReport;
    const rows = [
      ['队形', rep.template === 'wide' ? '横队' : '纵队'],
      ['能否成队通过', rep.canPass ? '能' : '不能'],
      ['首个应停位置', rep.stop ? `s=${rep.stop.s.toFixed(2)} m · ${rep.stop.member}` : '—'],
      ['路段', `${rep.cells} × ${(clearance.opts.cell * 100).toFixed(0)} cm`],
      ['柱子', rep.pillars.map((p) => `${p.name} @s=${p.s.toFixed(1)}`).join('，') || '无'],
    ];
    for (const [k, v] of rows) {
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('b'); b.textContent = v;
      wrap.append(a, b);
    }
    st.textContent = rep.canPass ? '整队可通过' : `不能通过：${rep.stop.reason}`;
    st.className = rep.canPass ? 'ok' : 'bad';
    $('title').textContent = `${run.level.title} · ${rep.template === 'wide' ? '横队净空检查' : '纵队净空检查'}`;
    $('scrub').max = '0'; $('scrub').value = '0';
    $('clock').textContent = '静态几何';
    return;
  }

  const idx = Math.max(0, Math.min(Math.floor(state.frame), r.trace.length - 1));
  const fr = r.trace[idx] ?? r.trace[r.trace.length - 1];
  const rows = [
    ['状态', r.status],
    ['时间', `${fr.t.toFixed(2)} s`],
    ['队形', fr.fold >= 0.999 ? '纵队' : fr.fold > 0 ? `收拢 ${(fr.fold * 100).toFixed(0)}%` : '横队'],
    ['队长 s', fr.leaderS.toFixed(2)],
    ['队尾 s', Math.min(...fr.members.map((m) => m.s)).toFixed(2)],
    ['拉长', `${fr.tear.toFixed(2)} / ${r.maxStretch.toFixed(2)} m`],
    ['最窄间隙', `${run.plan.narrow.w.toFixed(2)} m @ s=${run.plan.narrow.s.toFixed(2)}`],
    ['收拢窗口', run.plan.fold.start === Infinity ? '不执行'
      : `[${run.plan.fold.earliest.toFixed(2)}, ${run.plan.fold.latestSafe.toFixed(2)}] → ${run.plan.fold.start.toFixed(2)}`],
    ['碰撞计数', String(r.collisions)],
  ];
  for (const [k, v] of rows) {
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('b'); b.textContent = v;
    wrap.append(a, b);
  }

  const arrived = r.status === 'arrived';
  st.textContent = arrived ? '全员到达' : r.reason ?? r.status;
  st.className = arrived ? 'ok' : 'bad';
  $('title').textContent = `${run.level.title} · ${STRATEGY_LABEL[state.strategy]} · ${currentScenario().label}`;
  $('scrub').max = String(r.trace.length - 1);
  $('clock').textContent = `${fr.t.toFixed(1)} / ${r.trace[r.trace.length - 1].t.toFixed(1)} s`;
}

function btn(text, on, fn) {
  const b = document.createElement('button');
  b.textContent = text;
  b.setAttribute('aria-pressed', String(on));
  b.addEventListener('click', fn);
  return b;
}

/* ---------- rendering ---------- */

function layout() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  view.w = Math.max(320, Math.floor(rect.width));
  view.h = Math.max(240, Math.floor(rect.height));
  canvas.width = Math.floor(view.w * dpr);
  canvas.height = Math.floor(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (run) run.transform = makeTransform(run.route, view.w, view.h);
}

function draw() {
  if (!run) return;
  if (!run.result) {
    // Clearance-only level: draw the corridor, swept bands, pillars, and the
    // bodies at their formation slots (so the outer sweep is visible).
    const tpl = clearance.template;
    const members = clearance.index.members.map((m) => {
      const pose = TEMPLATES[tpl].slots[m.slot];
      return {
        slot: m.slot, s: pose.back + 1.2, l: pose.lat,
        label: `#${m.slot + 1}`,
        color: clearance.squad.find((x) => x.slot === m.slot)?.color,
        radius: m.radius,
      };
    });
    drawScene(ctx, {
      route: run.route, plan: null, squad: clearance.squad, tr: run.transform,
      width: view.w, height: view.h,
      trace: [], members: null, result: null,
      pillars: clearanceReport.pillars,
      clearance: {
        intervals: clearanceReport.intervals,
        revalidatedSpans: clearanceReport.revalidatedSpans ?? [],
      },
      draggingPillar: drag?.pillar?.id,
      title: run.level.title,
      subtitle: clearanceReport.canPass ? '可整队通过' : `首停 s=${clearanceReport.stop.s.toFixed(2)} m`,
    });
    // Body preview at slots is drawn separately below the sweep overlays.
    drawSlotPreview(members);
    drawFirstStop();
    renderStats();
    return;
  }
  const idx = Math.max(0, Math.min(Math.floor(state.frame), run.result.trace.length - 1));
  const fr = run.result.trace[idx];
  if (!fr) return;
  const members = fr.members.map((p) => {
    const def = run.level.squad.find((m) => m.slot === p.slot);
    return { ...p, label: `#${p.slot + 1}`, color: def?.color, radius: def?.radius };
  });
  drawScene(ctx, {
    route: run.route, plan: run.plan, squad: run.level.squad, tr: run.transform,
    width: view.w, height: view.h,
    trace: run.result.trace.slice(0, idx + 1),
    members,
    result: run.result.status !== 'arrived' ? run.result : null,
  });
  renderStats();
}

/** Draw the squad at its formation slots for a clearance level. */
function drawSlotPreview(members) {
  drawSquad(ctx, run.route, run.transform, members);
}

/** Draw the first-stop marker for a clearance level. */
function drawFirstStop() {
  const stop = clearanceReport?.stop;
  if (!stop) return;
  drawStop(ctx, run.route, run.transform, { doorStop: { s: stop.s, l: 0 } });
}

/* ---------- playback ---------- */

let raf = 0;
function tick() {
  if (!run) return;
  if (state.playing && run.result) {
    const frames = run.result.trace;
    const last = frames[frames.length - 1];
    const now = performance.now();
    const dt = Math.min(0.1, (now - (state.lastT || now)) / 1000);
    state.lastT = now;
    const frameDt = Math.max(1e-3, (last.t - frames[0].t) / Math.max(1, frames.length - 1));
    state.frame += dt / frameDt;
    if (state.frame >= frames.length - 1) {
      state.frame = frames.length - 1;
      state.playing = false;
      $('play').textContent = '播放';
      $('play').setAttribute('aria-pressed', 'false');
    }
    $('scrub').value = String(Math.floor(state.frame));
    draw();
  }
  raf = requestAnimationFrame(tick);
}

$('play').addEventListener('click', () => {
  if (!run.result) return;
  const atEnd = state.frame >= run.result.trace.length - 1;
  if (atEnd) state.frame = 0;
  state.playing = !state.playing;
  state.lastT = performance.now();
  $('play').textContent = state.playing ? '暂停' : '播放';
  $('play').setAttribute('aria-pressed', String(state.playing));
});
$('restart').addEventListener('click', () => {
  if (!run.result) return;
  state.frame = 0; state.playing = true; state.lastT = performance.now();
  $('play').textContent = '暂停'; $('play').setAttribute('aria-pressed', 'true');
  draw();
});
$('scrub').addEventListener('input', (e) => {
  if (!run.result) return;
  state.playing = false;
  $('play').textContent = '播放'; $('play').setAttribute('aria-pressed', 'false');
  state.frame = Number(e.target.value);
  draw();
});

/* ---------- pillar dragging (clearance levels only) ---------- */

function canvasPoint(ev) {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (!clearance || !run?.transform) return;
  const p = canvasPoint(ev);
  const hit = pillarAt(clearanceReport.pillars, run.transform, p.x, p.y);
  if (!hit) return;
  const world = run.transform.fromScreen(p.x, p.y);
  drag = { pillar: hit, dx: world.x - hit.x, dy: world.y - hit.y };
  canvas.setPointerCapture(ev.pointerId);
  canvas.style.cursor = 'grabbing';
  draw();
});

canvas.addEventListener('pointermove', (ev) => {
  if (!clearance || !run?.transform) return;
  const p = canvasPoint(ev);
  if (!drag) {
    const hit = pillarAt(clearanceReport.pillars, run.transform, p.x, p.y);
    canvas.style.cursor = hit ? 'grab' : 'default';
    return;
  }
  const world = run.transform.fromScreen(p.x, p.y);
  updatePillar(drag.pillar.id, world.x - drag.dx, world.y - drag.dy);
  draw();
});

canvas.addEventListener('pointerup', (ev) => {
  if (!drag) return;
  drag = null;
  canvas.style.cursor = 'grab';
  try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
});

function updatePillar(id, x, y) {
  const level = chosenLevel();
  const next = state.pillarsByLevel[level.id].map((p) => (p.id === id ? { ...p, x, y } : p));
  state.pillarsByLevel[level.id] = next;
  const rep = clearance.setPillars(next);
  clearanceReport = rep;
  clearanceReport.revalidatedSpans = rep.revalidated.map((i) => [clearance.cells[i].s0, clearance.cells[i].s1]);
  renderClearanceSummary();
  renderChecks();
}

window.addEventListener('resize', () => { layout(); draw(); });

/* expose for headless tests */
window.__squad = {
  state, get run() { return run; },
  get clearance() { return clearance; },
  get clearanceReport() { return clearanceReport; },
  select(levelId, strategy, scenarioId) {
    state.levelId = levelId; state.strategy = strategy ?? state.strategy; state.scenarioId = scenarioId ?? state.scenarioId;
    state.playing = false; rebuild(true);
    if (run.result) state.frame = run.result.trace.length - 1;
    draw();
  },
  setFrame(i) { state.frame = Math.floor(i); state.playing = false; draw(); },
  setSlots(order) { state.squadByLevel[state.levelId] = order; rebuild(true); },
  setPlay(on) {
    state.playing = !!on; state.lastT = performance.now();
    document.getElementById('play').textContent = state.playing ? '暂停' : '播放';
    document.getElementById('play').setAttribute('aria-pressed', String(state.playing));
  },
  /* clearance-level hooks used by the UI tests */
  setTemplate(t) {
    const rep = clearance.setTemplate(t);
    clearanceReport = rep;
    clearanceReport.revalidatedSpans = rep.revalidated.map((i) => [clearance.cells[i].s0, clearance.cells[i].s1]);
    renderClearanceSummary(); renderChecks(); draw();
    return rep;
  },
  widenOuter(by) {
    const rep = clearance.widenOuterMembers(by);
    clearanceReport = rep;
    clearanceReport.revalidatedSpans = rep.revalidated.map((i) => [clearance.cells[i].s0, clearance.cells[i].s1]);
    renderClearanceSummary(); renderChecks(); draw();
    return rep;
  },
  movePillarTo(id, x, y) {
    updatePillar(id, x, y);
    draw();
    return clearanceReport;
  },
  setMemberRadius(slot, radius) {
    const rep = clearance.setMemberRadius(slot, radius);
    clearanceReport = rep;
    clearanceReport.revalidatedSpans = rep.revalidated.map((i) => [clearance.cells[i].s0, clearance.cells[i].s1]);
    renderClearanceSummary(); renderChecks(); draw();
    return rep;
  },
};

rebuild();
raf = requestAnimationFrame(tick);
