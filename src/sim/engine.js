import { TEMPLATES, foldCost } from './formation.js';
import { frameAt, worldOf, maxLatAt } from '../geo/route.js';
import { clamp } from '../geo/vec.js';

export const SIM_DEFAULTS = {
  dt: 1 / 90,
  accel: 2.6,
  latAccel: 2.2,
  maxTime: 90,
  settleTol: 0.14,
  queueGap: 0.06,
  collisionTol: 0.035,
  traceEvery: 4,
  releaseSlack: 0.9,
  stretchSlack: 0.7,
};

/**
 * Squad simulator in route coordinates (s = station, l = lateral offset).
 *
 * The leader's polyline is only a *candidate* path. Between path segments a
 * release gate inspects the **actual tail** (the rearmost body's station and
 * lateral offset) and only lets the leader continue once the squad is contiguous
 * and folded. Whether a strategy honours that gate decides success or a jam.
 *
 * Hard physics:
 *   - forward reach depends on the body's current |l| (a wide body cannot enter
 *     a station narrower than its footprint);
 *   - lateral motion is capped by the member's own vLat;
 *   - bodies cannot pass or overlap (queue + collision check);
 *   - the squad cannot stretch beyond `maxStretch` without tearing (未到齐).
 */
export class SquadSim {
  constructor({ route, squad, plan, level, index, scenario = {}, opts = {} }) {
    this.route = route;
    this.squad = squad;
    this.plan = plan;
    this.level = level;
    this.index = index;
    this.scenario = scenario;
    this.o = { ...SIM_DEFAULTS, ...(level.sim ?? {}), ...opts };

    this.time = 0;
    this.stepNo = 0;
    this.phase = 'approach';
    this.template = 'wide';
    this.foldP = 0;
    this.events = [];
    this.trace = [];
    this.result = null;
    this.stallTimer = 0;
    this.collisions = 0;
    this.maxTear = 0;
    this.tearAtRelease = null;
    this.leaderSpeedAtStretch = null;

    const s0 = level.startStation ?? 2.55;
    this.startStation = s0;
    this.members = squad.map((m) => {
      const w = TEMPLATES.wide.slots[m.slot];
      return {
        def: m, s: clamp(s0 - w.back, 0.02, route.length), l: w.lat,
        vAlong: 0, vSide: 0, blockedFor: 0, squeeze: 0, minClear: Infinity,
      };
    });
    this.leader = this.members[0];
    this.leaderS = s0;
    this.leaderV = 0;

    const fileDepth = Math.max(...squad.map((m) => TEMPLATES.file.slots[m.slot].back + m.radius));
    this.maxStretch = fileDepth + this.o.stretchSlack;
    this.releaseLine = Math.max(0.8, plan.sEnter - this.o.releaseSlack);
    this.leaderGate = plan.control.gate;
    this.releaseOpen = !this.leaderGate;
    // With the gate switched off there is nothing to open, so the squad is
    // "released" from the start: tearing must be detectable for rush/none.
    this.released = !this.leaderGate;

    this.log('spawn', { s: +s0.toFixed(2), template: 'wide' });
    this.capture(true);
  }

  log(type, data = {}) { this.events.push({ t: +this.time.toFixed(3), type, ...data }); }

  /**
   * Staged slot pose.
   * The longitudinal (back) component settles first, then the lateral slide.
   * Wide->file only ever *increases* each slot's back offset, so settling backs
   * first preserves slot order and opens gaps before anyone moves towards the
   * centreline; otherwise two members sharing a wide-file station would collide
   * mid-fold. The lateral phase occupies the last 45% of the morph.
   */
  pose(slot) {
    if (this.template === 'wide' && this.foldP <= 0) return TEMPLATES.wide.slots[slot];
    const w = TEMPLATES.wide.slots[slot];
    const f = TEMPLATES.file.slots[slot];
    const p = this.foldP;
    const eBack = clamp(p * 3, 0, 1);
    const eLat = clamp((p - 0.55) / 0.45, 0, 1);
    const sb = eBack * eBack * (3 - 2 * eBack);
    const sl = eLat * eLat * (3 - 2 * eLat);
    return { lat: w.lat + (f.lat - w.lat) * sl, back: w.back + (f.back - w.back) * sb };
  }

  lagFactor(m) {
    const lag = this.scenario.lag;
    if (!lag || lag.slot !== m.def.slot) return { fwd: 1, lat: 1 };
    if (this.time >= lag.t0 && this.time <= lag.t1) return { fwd: lag.fwd ?? 0.4, lat: lag.lat ?? 0.4 };
    return { fwd: 1, lat: 1 };
  }

  /* ---------------- leader ---------------- */

  maxLag() {
    let worst = 0;
    for (const m of this.members) {
      if (m.def.slot === 0) continue;
      worst = Math.max(worst, this.leaderS - this.pose(m.def.slot).back - m.s);
    }
    return worst;
  }

  /** the actual tail: rearmost body of the whole squad */
  tailS() { return Math.min(...this.members.map((m) => m.s)); }

  /**
   * Release condition: the squad is contiguous (leader-to-tail span within the
   * maximum column stretch) and the fold has finished. This is the "实际队尾
   * 位置" check — it uses measured body stations, not slot targets.
   */
  tailSettled() {
    if (this.foldP < 0.999) return false;
    const span = this.leaderS - this.tailS();
    if (span > this.maxStretch - 0.1) return false;
    const wideLeft = this.members.some((m) => Math.abs(m.l) > 0.18);
    return !wideLeft;
  }

  leaderSpeedWant(dt) {
    const p = this.plan;
    // speed constraint when the queue is fully extended: never outrun the tail.
    // Applies to every strategy: the leader's path is only a candidate, and the
    // measured tail decides whether the squad can keep moving.
    const tear = this.leaderS - this.tailS();
    const room = this.maxStretch - tear;
    if (room < 0.6 && !p.control.rush) {
      const tail = this.rearMember();
      const cap = (tail?.def.vFwd ?? 1.2) * 0.94;
      return Math.min(p.vLead, cap);
    }
    // "rush" means the leader refuses to pause for cohesion — not that it runs
    // faster than a person can. Speed stays at cruise; the cost is that it burns
    // through the fold window before the tail is ready.
    if (p.control.rush) return p.vLead;
    if (!p.control.ignoreCohesion) {
      // 等队: while the formation is still changing, or whenever a rear member
      // has been left behind, hold cruise for the tail instead of pressing on.
      const lag = this.maxLag();
      if (lag > 0.9) return 0;
      if (lag > 0.5) return p.vLead * 0.6;
    }
    if (!p.control.ignoreCohesion && this.template === 'wide' && this.leaderS >= p.fold.start) {
      const lag = this.maxLag();
      if (lag > 0.5) return p.vLead * 0.6;
    }
    return p.vLead;
  }

  rearMember() {
    let best = null;
    for (const m of this.members) if (!best || m.s < best.s) best = m;
    return best;
  }

  advanceLeader(dt) {
    const want = this.leaderSpeedWant(dt);
    this.leaderV += clamp(want - this.leaderV, -this.o.accel * dt, this.o.accel * dt);
    this.leaderV = Math.max(0, this.leaderV);
    if (want <= 0) this.leaderV = 0;

    let next = Math.min(this.route.length, this.leaderS + this.leaderV * dt);
    if (maxLatAt(this.route, next, this.leader.def.radius) < -0.01) next = this.leaderS;

    if (this.leaderGate && !this.releaseOpen) {
      // clamp at the line and re-evaluate the release every step (not only on the
      // step that happens to cross it, which numerical overshoot can skip)
      if (next >= this.releaseLine) {
        next = Math.min(next, this.releaseLine);
        if (!this._holdLogged && this.stepNo > 2) {
          this.log('hold', { s: +this.leaderS.toFixed(2), tear: +(this.leaderS - this.tailS()).toFixed(2), reason: '等队：队尾未就位' });
          this._holdLogged = true;
        }
        if (this.tailSettled()) {
          this.releaseOpen = true;
          this.released = true;
          this.tearAtRelease = +(this.leaderS - this.tailS()).toFixed(3);
          this.log('release', { s: +this.leaderS.toFixed(2), tear: this.tearAtRelease });
        } else {
          this.leaderV = 0;
        }
      }
    }
    this.leaderS = next;
    this.leader.s = next;
    this.leader.l = 0;
    this.leader.vAlong = this.leaderV;
  }

  /* ---------------- fold command ---------------- */

  updateFoldCommand(dt) {
    const g = this.plan.fold;
    if (this.phase !== 'folding' && this.template === 'wide' && g.doFold && this.leaderS >= g.start) {
      this.phase = 'folding';
      this.foldStartS = this.leaderS;
      this.log('fold-command', { s: +this.leaderS.toFixed(2), planned: +g.start.toFixed(2) });
    }
    if (this.phase !== 'folding' || this.template !== 'wide') return;

    // The slide takes tSlow = slide/vLat seconds for the slowest member. The
    // formation can advance meanwhile, but only at a pace the sliding member can
    // match; a leader that runs flat-out spends the window too quickly. What
    // actually decides success is whether the *throat* lies beyond the station
    // the leader has already reached when the slide finishes.
    const cost = foldCost(this.squad, 'wide', 'file');
    const slow = (this.members.find((m) => m.def.slot === cost.member.slot) ?? this.members[0]).def;
    const tSlow = cost.slide / Math.max(slow.vLat, 1e-3);

    // effective pace while folding: a forming column cannot outrun its slowest
    // lateral mover, so cap leader speed at the pace the fold can keep up with
    const foldPace = Math.max(0.25, (this.plan.sEnter - g.start) / Math.max(tSlow, 0.4));
    void foldPace;

    // advance morph by time
    this.foldP = Math.min(1, this.foldP + dt / Math.max(tSlow, 0.4));
    if (this.foldP >= 1) {
      this.foldP = 1;
      this.template = 'file';
      this.phase = 'run';
      this.log('fold-complete', { s: +this.leaderS.toFixed(2) });
    }
  }

  /** continuous 0..1 display of lateral fold progress */
  foldProgress() { return this.foldP; }

  /* ---------------- members ---------------- */

  target(m) {
    const p = this.pose(m.def.slot);
    // Slots must never target a negative station; instead the whole column
    // compresses at the start line (the leader keeps waiting until it opens).
    return { s: Math.max(0.02, this.leaderS - p.back), l: p.lat, back: p.back };
  }

  advanceMember(m, dt) {
    const r = m.def.radius;
    const tgt = this.target(m);
    const lag = this.lagFactor(m);

    /* longitudinal: follow slot, respect the body ahead in the same lane */
    const vFwdMax = m.def.vFwd * lag.fwd;
    const vBackMax = Math.max(0.2, m.def.vFwd * 0.5 * lag.fwd);
    let vWant = clamp((tgt.s - m.s) * 2.4, -vBackMax, vFwdMax);

    const front = this.frontNeighbour(m);
    if (front) {
      const lane = Math.abs(front.l - m.l) < (front.def.radius + r) * 0.95;
      if (lane) {
        // keep at least queueGap between our leading edge and their trailing edge
        const maxS = front.s - front.def.radius - r - this.o.queueGap;
        if (m.s > maxS - 0.30) {
          const approach = (maxS - m.s);
          vWant = Math.min(vWant, approach * 4.0);
          if (approach < 0) vWant = Math.min(vWant, -0.6);
        }
      }
    }
    let vAlong = m.vAlong + clamp(vWant - m.vAlong, -this.o.accel * dt, this.o.accel * dt);
    vAlong = clamp(vAlong, -vBackMax, vFwdMax);

    /* wall: cannot advance into a station narrower than the current |l| */
    const reach = this.index.maxReach(r, m.s, m.l);
    let nextS = m.s + vAlong * dt;
    if (nextS > reach + 1e-6) {
      nextS = Math.max(m.s, reach);
      vAlong = Math.min(vAlong, 0);
      if (Math.abs(m.l) > 0.05) m.blockedFor += dt;
    } else {
      m.blockedFor = Math.max(0, m.blockedFor - dt);
    }
    nextS = Math.max(0, Math.min(nextS, this.route.length));

    /* lateral: vLat-limited, envelope-limited at the body's station. Sliding is
       attempted before committing the station, so a body that is still wide
       stays just short of the narrowing rather than being pulled through it. */
    const cap = Math.max(0, maxLatAt(this.route, m.s, r));
    const lGoal = clamp(tgt.l, -cap, cap);
    const vLatMax = m.def.vLat * lag.lat;
    let vSide = m.vSide + clamp((lGoal - m.l) * 3.2 - m.vSide, -this.o.latAccel * dt, this.o.latAccel * dt);
    vSide = clamp(vSide, -vLatMax, vLatMax);
    const newL = clamp(m.l + vSide * dt, -cap, cap);

    // If advancing would require a lateral offset we have not reached yet, and
    // the body cannot slide there at this station, hold it at the reachable line.
    if (Math.abs(newL) > this.index.maxLat(r, nextS) + 0.02) {
      const holdReach = this.index.maxReach(r, m.s, newL);
      if (nextS > holdReach) nextS = Math.max(m.s, holdReach);
      if (Math.abs(m.l) > 0.05) m.blockedFor += dt * 0.5;
    }

    m.vAlong = vAlong;
    m.vSide = vSide;
    m.s = nextS;
    m.l = newL;
    m.minClear = Math.min(m.minClear, cap - Math.abs(m.l));
  }

  frontNeighbour(m) {
    let best = null, bd = Infinity;
    for (const o of this.members) {
      if (o === m) continue;
      const d = o.s - m.s;
      if (d > 0 && d < bd) { bd = d; best = o; }
    }
    return best;
  }

  /**
   * Position-based separation: resolve body overlap by moving the *later*
   * member backwards along its own lane (a queue-forming response). This is
   * done in (s,l) space, where distance is locally Euclidean. It prevents the
   * spurious "everyone stacked at the throat" overlaps that a pure velocity
   * model produces when a wide file hits a wall.
   */
  separateBodies() {
    // Sort front-to-back and enforce, per pair, that bodies in the same lateral
    // lane keep at least (rA+rB+gap) of station between them. A body may only
    // yield backwards one small step per call, so the queue forms smoothly
    // instead of teleporting.
    const order = this.members.slice().sort((a, b) => b.s - a.s);
    const step = Math.max(0.02, 6.0 * this.o.dt);
    for (let i = 1; i < order.length; i++) {
      const m = order[i];
      if (m === this.leader) continue;
      let limit = Infinity;
      for (let j = 0; j < i; j++) {
        const o = order[j];
        if (Math.abs(o.l - m.l) > (o.def.radius + m.def.radius) * 0.98) continue; // different lane
        limit = Math.min(limit, o.s - (o.def.radius + m.def.radius + this.o.queueGap));
      }
      if (m.s > limit) {
        m.s = clamp(Math.max(limit, m.s - step), 0.01, m.s);
        if (m.vAlong > 0) m.vAlong = 0;
      }
    }
  }

  /* ---------------- collision (bodies are discs; s/l is locally orthonormal) ---------------- */

  detectCollisions() {
    let worst = 0, pair = null;
    for (let i = 0; i < this.members.length; i++) {
      for (let j = i + 1; j < this.members.length; j++) {
        const a = this.members[i], b = this.members[j];
        const ds = a.s - b.s, dl = a.l - b.l;
        const d = Math.hypot(ds, dl);
        const minD = a.def.radius + b.def.radius;
        const overlap = minD - d;
        if (overlap > worst) { worst = overlap; pair = [a, b]; }
      }
    }
    if (worst > this.o.collisionTol) {
      this.collisions += 1;
      this.lastCollision = { overlap: +worst.toFixed(3), pair: pair.map((p) => p.def.name) };
      return true;
    }
    return false;
  }

  /* ---------------- evaluation ---------------- */

  evaluate() {
    const endS = this.route.length;
    const tear = this.leaderS - this.tailS();
    this.maxTear = Math.max(this.maxTear, tear);

    const leaderDone = this.leaderS >= endS - 0.12;
    const allSettled = this.members.every((m) => {
      if (m.def.slot === 0) return true;
      const t = this.target(m);
      return Math.abs(t.s - m.s) < this.o.settleTol && Math.abs(t.l - m.l) < 0.12;
    });
    if (leaderDone && allSettled && tear <= this.maxStretch) return this.finish('arrived');

    // a body wider than the tightest station it must cross can never pass
    for (const m of this.members) {
      const ml = this.index.maxLat(m.def.radius, this.plan.narrow.s);
      if (ml < -0.005) return this.finish('impassable', { culprit: m });
    }

    // Mutual jam: two bodies are wider than the corridor allows side-by-side and
    // neither can slide past. This is a genuine door jam, not a solver artifact.
    const overWide = this.members.find((m) => Math.abs(m.l) + m.def.radius >
      frameAt(this.route, m.s).w / 2 + 0.12);
    if (overWide) return this.finish('jam', { culprit: overWide });

    if (tear > this.maxStretch + 0.05 && this.released) return this.finish('torn');
    // A body that is still laterally wide cannot pass a station narrower than
    // its offset; if it is wedged against such a station the whole squad halts.
    // Report this as a door jam (not a collision) with the exact stop position.
    if (this.collisions > 40) return this.finish('collision');
    if (this.time > this.o.maxTime) return this.finish('timeout');

    // A jam: leader halted (or fully extended against the tail) and at least one
    // body is pressed against a wall it cannot pass at its current offset.
    const wedged = this.members.find((m) => m.blockedFor > 0.6 && Math.abs(m.l) > 0.2);
    const leaderStalled = this.leaderV < 0.03;
    if (wedged && leaderStalled && this.time > 2) this.stallTimer += this.o.dt;
    else this.stallTimer = 0;
    if (this.stallTimer > 3.0) return this.finish('stuck');
    return null;
  }

  finish(status, extra = {}) {
    const members = this.members.map((m) => ({
      name: m.def.name, slot: m.def.slot, color: m.def.color, radius: m.def.radius,
      s: +m.s.toFixed(3), l: +m.l.toFixed(3), world: worldOf(this.route, m.s, m.l),
      cap: +Math.max(0, maxLatAt(this.route, m.s, m.def.radius)).toFixed(3),
      vAlong: +m.vAlong.toFixed(3), vSide: +m.vSide.toFixed(3),
      vAlongRatio: +(Math.abs(m.vAlong) / Math.max(m.def.vFwd, 1e-9)).toFixed(3),
      blockedFor: +m.blockedFor.toFixed(2),
    }));
    let reason = null, blocked = null;
    const stop = (x) => ({ name: x.name, slot: x.slot, s: x.s, l: x.l, world: x.world, widthHere: +(2 * x.cap + 2 * x.radius).toFixed(3) });

    if (status === 'impassable') {
      const c = extra.culprit;
      blocked = members.find((x) => x.slot === c.def.slot);
      reason = `${blocked.name}（宽 ${(2 * blocked.radius).toFixed(2)} m）无法通过净宽 ${this.plan.narrow.w.toFixed(2)} m 的窄门，停在 s=${blocked.s.toFixed(2)} m`;
    } else if (status === 'torn') {
      blocked = members.slice().sort((a, b) => a.s - b.s)[0];
      reason = `未到齐：队列被拉断（队长领先队尾 ${this.maxTear.toFixed(1)} m > ${this.maxStretch.toFixed(1)} m），${blocked.name} 落在 s=${blocked.s.toFixed(2)} m`;
    } else if (status === 'collision') {
      blocked = members.slice().sort((a, b) => b.blockedFor - a.blockedFor)[0];
      reason = `碰撞：${this.lastCollision?.pair.join(' / ')} 重叠 ${this.lastCollision?.overlap} m`;
    } else if (status === 'jam') {
      const c = extra.culprit;
      blocked = members.find((x) => x.slot === c.def.slot);
      const w = frameAt(this.route, blocked.s).w;
      reason = `挤不下：${blocked.name} 在 s=${blocked.s.toFixed(2)} m 处横向仍占 ${(Math.abs(blocked.l) + blocked.radius).toFixed(2)} m，而此处半宽仅 ${(w / 2).toFixed(2)} m`;
    } else if (status === 'stuck' || status === 'timeout') {
      const worst = status === 'stuck'
        ? members.slice().sort((a, b) => b.blockedFor - a.blockedFor)[0]
        : (members.filter((x) => x.slot !== 0).sort((a, b) => a.s - b.s)[0] ?? members[0]);
      blocked = worst;
      const leaderOut = this.leaderS >= this.route.length - 1.0;
      const inThroat = worst.s > this.plan.sGate - 1.6 && worst.s < this.plan.sGate + 3.0;
      if (inThroat) {
        reason = `堵在门中：${worst.name} 停在 s=${worst.s.toFixed(2)} m（此处净宽 ${frameAt(this.route, worst.s).w.toFixed(2)} m）`;
      } else if (leaderOut) {
        reason = `未到齐：队长已到出口，${worst.name} 仍落后在 s=${worst.s.toFixed(2)} m（差 ${(this.route.length - worst.s).toFixed(1)} m）`;
      } else {
        reason = `未到齐：${worst.name} 停在 s=${worst.s.toFixed(2)} m`;
      }
    }
    return (this.result = {
      status, t: +this.time.toFixed(3), reason, blocked,
      doorStop: blocked && status !== 'arrived' ? stop(blocked) : null,
      maxTear: +this.maxTear.toFixed(3),
      tearAtRelease: this.tearAtRelease,
      maxStretch: +this.maxStretch.toFixed(2),
      collisions: this.collisions,
      maxLag: +Math.max(...this.members.filter((m) => m.def.slot !== 0)
        .map((m) => Math.abs(this.target(m).s - m.s))).toFixed(3),
      members, events: this.events, trace: this.trace, plan: this.plan,
      scenario: this.scenario.id ?? null,
      template: this.template,
    });
  }

  capture(force = false) {
    if (!force && this.stepNo % this.o.traceEvery !== 0) return;
    this.trace.push({
      t: +this.time.toFixed(3), leaderS: +this.leaderS.toFixed(3),
      fold: +this.foldProgress().toFixed(3), phase: this.phase,
      tear: +(this.leaderS - this.tailS()).toFixed(3),
      released: this.released,
      members: this.members.map((m) => ({ slot: m.def.slot, s: +m.s.toFixed(3), l: +m.l.toFixed(3), vAlong: +m.vAlong.toFixed(3), vSide: +m.vSide.toFixed(3) })),
    });
  }

  step() {
    if (this.result) return this.result;
    const dt = this.o.dt;
    this.time += dt;
    this.stepNo++;
    this.advanceLeader(dt);
    this.updateFoldCommand(dt);
    for (const m of this.members) if (m !== this.leader) this.advanceMember(m, dt);
    this.separateBodies();
    this.detectCollisions();
    this.capture();
    return this.evaluate();
  }

  run(maxSteps = 40000) {
    let r = null, n = 0;
    while (!r && n++ < maxSteps) r = this.step();
    return r ?? this.finish('timeout');
  }
}
