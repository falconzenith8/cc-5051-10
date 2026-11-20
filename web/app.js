import { makeLevels } from '../src/levels/levels.js';
import { runLevel } from '../src/sim/run.js';
import { runAcceptance } from '../test/acceptance.js';
import { swapSlots } from '../src/sim/formation.js';
import { makeTransform, drawScene } from '../src/render/scene.js';

const STRATEGY_LABEL = {
  wait: '等队', early: '提前变形', side: '换走侧廊', rush: '抢行', none: '不收拢',
};
const STRATEGY_TIP = {
  wait: '在门槛前停下，等实际队尾收拢并完成纵队后再放行。',
  early: '入口后立即开始变形，但仍尊重放行门。',
  side: '改走较长的侧廊，用额外的纵向空间提前排成纵队。',
  rush: '完全不等待，按自己的折线直接冲门。',
  none: '从不收拢成纵队，直接以横队闯门。',
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
  playing: true,
  frame: 0,
  lastT: 0,
};

for (const lv of levels) state.squadByLevel[lv.id] = lv.squad;

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d');

let run = null; // { level, plan, result, route, trace, transform }
let view = { w: 0, h: 0 };

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
  const lv = { ...level, squad };
  // A strategy carried over from another level may not exist here (e.g. "side"
  // on level A); resolve it before planning *and* before painting the controls.
  if (!lv.strategies.includes(state.strategy)) state.strategy = lv.defaultStrategy;
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

function renderControls() {
  const level = chosenLevel();
  $('blurb').textContent = level.blurb;

  const lvRow = $('levels');
  lvRow.innerHTML = '';
  for (const l of levels) lvRow.append(btn(l.title, l.id === state.levelId, () => {
    state.levelId = l.id; state.strategy = l.defaultStrategy; state.scenarioId = 'steady'; rebuild();
  }));

  const stRow = $('strategies');
  stRow.innerHTML = '';
  for (const s of level.strategies) stRow.append(btn(STRATEGY_LABEL[s] ?? s, s === state.strategy, () => {
    state.strategy = s; rebuild();
  }));
  stRow.title = STRATEGY_TIP[state.strategy] ?? '';

  const scRow = $('scenarios');
  scRow.innerHTML = '';
  for (const s of level.scenarios) scRow.append(btn(s.label, s.id === state.scenarioId, () => {
    state.scenarioId = s.id; rebuild();
  }));

  renderMembers(level);
  renderChecks();
}

function renderMembers(level) {
  const wrap = $('members');
  wrap.innerHTML = '';
  const squad = state.squadByLevel[level.id];
  const ordered = squad.slice().sort((a, b) => a.slot - b.slot);
  for (const m of ordered) {
    const el = document.createElement('div');
    el.className = 'mem' + (m.slot === 0 ? ' leader' : '');
    el.draggable = m.slot !== 0;
    el.dataset.slot = String(m.slot);
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = m.color;
    const name = document.createElement('span');
    name.textContent = m.name + (m.slot === 0 ? '（队长）' : '');
    const slot = document.createElement('span');
    slot.className = 'slot'; slot.textContent = `#${m.slot + 1} · v横 ${m.vLat.toFixed(2)}`;
    el.append(dot, name, slot);

    if (m.slot !== 0) {
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
  const r = run.result;
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
  wrap.innerHTML = '';
  for (const [k, v] of rows) {
    const a = document.createElement('span'); a.textContent = k;
    const b = document.createElement('b'); b.textContent = v;
    wrap.append(a, b);
  }

  const st = $('status');
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

/* ---------- playback ---------- */

let raf = 0;
function tick() {
  if (!run) return;
  if (state.playing) {
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
  const atEnd = state.frame >= run.result.trace.length - 1;
  if (atEnd) state.frame = 0;
  state.playing = !state.playing;
  state.lastT = performance.now();
  $('play').textContent = state.playing ? '暂停' : '播放';
  $('play').setAttribute('aria-pressed', String(state.playing));
});
$('restart').addEventListener('click', () => {
  state.frame = 0; state.playing = true; state.lastT = performance.now();
  $('play').textContent = '暂停'; $('play').setAttribute('aria-pressed', 'true');
  draw();
});
$('scrub').addEventListener('input', (e) => {
  state.playing = false;
  $('play').textContent = '播放'; $('play').setAttribute('aria-pressed', 'false');
  state.frame = Number(e.target.value);
  draw();
});

window.addEventListener('resize', () => { layout(); draw(); });

/* expose for headless tests */
window.__squad = {
  state, get run() { return run; },
  select(levelId, strategy, scenarioId) {
    state.levelId = levelId; state.strategy = strategy ?? state.strategy; state.scenarioId = scenarioId ?? state.scenarioId;
    state.playing = false; rebuild(true); state.frame = run.result.trace.length - 1; draw();
  },
  setFrame(i) { state.frame = Math.floor(i); state.playing = false; draw(); },
  setSlots(order) { state.squadByLevel[state.levelId] = order; rebuild(true); },
  setPlay(on) {
    state.playing = !!on; state.lastT = performance.now();
    document.getElementById('play').textContent = state.playing ? '暂停' : '播放';
    document.getElementById('play').setAttribute('aria-pressed', String(state.playing));
  },
};

rebuild();
raf = requestAnimationFrame(tick);
