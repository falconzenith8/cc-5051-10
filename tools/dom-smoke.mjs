/*
 * Minimal DOM shim to smoke-test web/app.js logic without a browser.
 * Not a layout engine: enough for renderControls/renderClearanceSummary/
 * renderChecks and the clearance hooks. Canvas methods are no-ops.
 */
class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this._listeners = {};
    this.width = 900; this.height = 460;
    this.attributes = {};
  }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  appendChild(n) { this.append(n); return n; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this._listeners[t] ??= []).push(fn); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  getContext() { return ctxStub; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 460 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  get innerHTML() { return ''; }
  set innerHTML(_) { this.children = []; }
}
const ctxStub = new Proxy({}, {
  get(_t, k) {
    if (k === 'measureText') return () => ({ width: 8 });
    if (k === 'canvas') return { width: 900, height: 460 };
    return () => {};
  },
  set() { return true; },
});

const ids = new Map();
const byId = (id) => {
  if (!ids.has(id)) { const e = new El('div'); e.id = id; ids.set(id, e); }
  return ids.get(id);
};
const canvas = new El('canvas');
canvas.id = 'view';
ids.set('view', canvas);
canvas.parentElement = new El('div');

globalThis.document = {
  createElement: (t) => new El(t),
  getElementById: byId,
  querySelector: (sel) => (sel === '#view' ? canvas : null),
  querySelectorAll: () => [],
  body: new El('body'),
};
globalThis.window = globalThis;
globalThis.performance ??= { now: () => Date.now() };
globalThis.requestAnimationFrame = () => 0;
globalThis.devicePixelRatio = 1;
globalThis.addEventListener = () => {};

await import('../web/app.js');

const q = globalThis.__squad;
const out = [];
const assert = (c, m) => { if (!c) throw new Error(m); };

q.select('C', 'file', 'steady');
assert(q.clearance && q.clearanceReport.canPass, 'C file should pass');
out.push(`C/file canPass=${q.clearanceReport.canPass}`);
{
  const base = q.clearanceReport;
  const t = byId('stats2').children.map((c) => c.textContent).join(' | ');
  out.push(`baseline file: narrow ${base.recompute.narrow.cells} / wide ${base.recompute.wide.cells}; ` +
    `wide-road skips ${base.recompute.wide.skipped}`);
  assert(t.includes('宽路省检'), 'baseline summary must show wide-road skips');
  assert(!t.includes('宽路省检 | —'), 'baseline should have non-zero wide-road skips for file');
}

const rep = q.setTemplate('wide');
assert(!rep.canPass, 'C wide should be blocked');
assert(rep.stop?.kind === 'pillar', 'stop should be the pillar');
assert(q.clearance.verify().equal, 'incremental must equal reference');
out.push(`flip -> wide: stop s=${rep.stop.s.toFixed(2)} ${rep.stop.member}, ` +
  `revalidated ${rep.revalidated.length}, narrow ${rep.recompute.narrow.cells}/wide ${rep.recompute.wide.cells}`);

const sum = byId('stats2');
const text = sum.children.map((c) => c.textContent).join(' | ');
assert(text.includes('窄路重算'), 'summary should show narrow-road recompute');
assert(text.includes('宽路省检'), 'summary should show wide-road skips');
out.push('summary rows: ' + text);

const drag = q.movePillarTo('P-bend', 2.2, 1.2);
assert(drag.stop?.s < 4, 'dragging onto the entrance should stop early');
assert(q.clearance.verify().equal, 'drag must still equal reference');
out.push(`drag -> stop s=${drag.stop.s.toFixed(2)} ${drag.stop.member}, verify=${q.clearance.verify().equal}`);

q.select('C', 'file', 'steady');
const wide = q.widenOuter(0.2);
assert(q.clearance.verify().equal, 'widen must equal reference');
out.push(`widen outer +0.20: revalidated ${wide.revalidated.length}, canPass=${wide.canPass}`);

console.log('DOM smoke ok');
for (const line of out) console.log('  ' + line);
