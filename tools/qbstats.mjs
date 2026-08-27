#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — WHAT THE QUARTERBACK ACTUALLY THREW AT

   The box score says how many passes were completed and how many were picked;
   it cannot say whether the man they went to was the right one. This does.

   At the instant a CPU quarterback commits to a throw it freezes the field and
   answers four questions about the decision itself:

     * how open the chosen man was, RIGHT NOW (the number _aiThrow reads)
     * how open he will be WHEN THE BALL GETS THERE — separation measured at
       the arrival point against every defender's own closing speed, which is
       the number that actually decides the play
     * how open the best available man would have been on the same measure
     * whether a defender was sitting IN THE LANE, in front of the receiver
       between him and the passer, which is where interceptions come from

   `openRank` is the chosen man's place in the field ranked by arrival
   separation: 1 means he was the most open receiver on the field, 4 means he
   was the least.

     node tools/qbstats.mjs [--games 8] [--difficulty pro] [--seed 1] [--json]
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const GAMES = parseInt(arg('games', '8'), 10);
const DIFFICULTY = arg('difficulty', 'pro');
const SEED = parseInt(arg('seed', '1'), 10);
const AS_JSON = process.argv.includes('--json');
const DT = 1 / 60;
const MAX_PLAY_FRAMES = 60 * 30;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(SEED);

const timers = [];
function drainTimers() {
  let n = 0;
  while (timers.length && n++ < 64) { const fn = timers.shift(); try { fn(); } catch (e) {} }
}
const noopCtx = new Proxy({}, { get: (t, k) => (k === 'canvas' ? canvas : () => {}) });
const canvas = {
  width: 800, height: 450, style: {},
  getContext: () => noopCtx,
  getBoundingClientRect: () => ({ width: 800, height: 450, left: 0, top: 0, right: 800, bottom: 450 })
};
const win = {
  devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout() {},
  performance: { now: () => 0 }
};
win.window = win; win.globalThis = win;
function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  new Function('window', 'globalThis', 'document', 'self', 'setTimeout', 'clearTimeout', src)(
    win, win, undefined, win, win.setTimeout, win.clearTimeout);
}
load('flagster/js/data.js');
load('flagster/js/engine.js');
const F = win.FLAGSTER, D = F.data;

const THROW_SPEED = (p) => 18 + (Math.max(40, Math.min(99, p.data.throw)) - 40) / 59 * 12;
const hyp = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/* Separation at the spot the ball is going to, not at the spot the receiver is
   standing in. Every defender gets the flight time to close on that spot at
   their own top speed; whoever gets nearest is the coverage. */
function arrivalRead(e, qb, r, def) {
  const spd = THROW_SPEED(qb);
  let t = hyp(qb.x, qb.y, r.x, r.y) / spd, px = r.x, py = r.y;
  for (let i = 0; i < 3; i++) {
    px = r.x + (r.vx || 0) * t; py = r.y + (r.vy || 0) * t;
    t = hyp(qb.x, qb.y, px, py) / spd;
  }
  let sep = 99, lane = 0;
  const dQR = hyp(qb.x, qb.y, px, py);
  for (const d of def) {
    if (d.flagPulled) continue;
    const ds = e.speedYds(d.data.speed) * e.staminaScale(d);
    const gap = Math.max(0, hyp(d.x, d.y, px, py) - ds * t);   // closed by arrival
    if (gap < sep) sep = gap;
    // In the lane: nearer the passer than the ball is, and near the line of it.
    const dQD = hyp(qb.x, qb.y, d.x, d.y);
    if (dQD < dQR - 0.3 && hyp(d.x, d.y, px, py) < dQR * 0.55 + 2) lane = 1;
  }
  return { sep, lane, t, px, py };
}

function playGame(gameIdx, rows) {
  let ev = {};
  const e = new F.Engine(canvas, { onEvent(x) { ev[x.type] = (ev[x.type] || 0) + 1; } });
  let pending = null;
  const realThrow = e.throwTo.bind(e);
  e.throwTo = function (slot) {
    const s = this.state;
    // Freeze the read BEFORE the engine acts on it, and only for a CPU passer
    // committing a legal throw — a refused call is not a decision.
    if (s && s.phase === 'live' && s.carrier && s.carrier === s.passer && !s.passThrown &&
        !s.ball.inAir && !s.pendingThrow) {
      const qb = s.carrier;
      const off = s.players.filter(p => p.team === e.offenseTeam() && p !== qb && !p.flagPulled);
      const def = s.players.filter(p => p.team === e.defenseTeam());
      const target = off.filter(p => p.slot === slot)[0];
      if (target) {
        const reads = off.map(r => ({ r, ...arrivalRead(e, qb, r, def) }));
        reads.sort((a, b) => b.sep - a.sep);
        const mine = reads.filter(x => x.r === target)[0];
        let nowSep = 99;
        for (const d of def) { if (!d.flagPulled) nowSep = Math.min(nowSep, hyp(d.x, d.y, target.x, target.y)); }
        let heat = 99;
        for (const d of def) { if (!d.flagPulled) heat = Math.min(heat, hyp(d.x, d.y, qb.x, qb.y)); }
        pending = {
          slot, nowSep, arrSep: mine.sep, lane: mine.lane, air: mine.t, heat,
          bestSep: reads[0].sep,
          openRank: reads.findIndex(x => x.r === target) + 1, choices: reads.length,
          depth: mine.px - s.losX, snapT: s.snapT
        };
      }
    }
    return realThrow(slot);
  };
  const home = D.NATIONS[gameIdx % D.NATIONS.length];
  const away = D.NATIONS[(gameIdx + 3) % D.NATIONS.length];
  e.newGame({
    home, away, homeJersey: D.jerseysFor(home.id)[0], awayJersey: D.jerseysFor(away.id)[1],
    userSide: 'home', demo: true, difficulty: DIFFICULTY
  });
  let guard = 0;
  while (!e.state.gameOver && guard++ < 4000) {
    const s = e.state;
    drainTimers();
    if (s.gameOver || s.phase === 'final') break;
    if (s.phase === 'playcall') { e.autoCall(); continue; }
    if (s.phase === 'presnap') { e.snap(); continue; }
    if (s.phase !== 'live') {
      const was = s.phase; e._nextSnap();
      if (s.phase === was) break;
      continue;
    }
    ev = {}; pending = null;
    let f = 0;
    while (s.phase === 'live' && f < MAX_PLAY_FRAMES) { e._update(DT); f++; }
    if (pending) {
      pending.pick = !!ev.turnover;
      pending.caught = !!ev.catch;
      pending.away = !!ev.throwaway;
      rows.push(pending);
    }
    if (s.phase === 'live') break;
  }
}

const rows = [];
for (let g = 0; g < GAMES; g++) playGame(g, rows);

const real = rows.filter(r => !r.away);
const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0;
const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
const bucket = (f) => ({ n: real.filter(f).length, pick: pct(real.filter(r => f(r) && r.pick).length, real.filter(f).length) });

const out = {
  throws: real.length,
  throwaways: rows.length - real.length,
  sepAtThrow: avg(real.map(r => r.nowSep)),
  sepAtArrival: avg(real.map(r => r.arrSep)),
  bestAvailable: avg(real.map(r => r.bestSep)),
  sepLeftOnField: avg(real.map(r => r.bestSep - r.arrSep)),
  choseMostOpen: pct(real.filter(r => r.openRank === 1).length, real.length),
  choseWorstHalf: pct(real.filter(r => r.openRank > r.choices / 2).length, real.length),
  intoTheLane: pct(real.filter(r => r.lane).length, real.length),
  coveredThrows: pct(real.filter(r => r.arrSep < 1.0).length, real.length),
  pickRate: pct(real.filter(r => r.pick).length, real.length),
  pickWhenCovered: bucket(r => r.arrSep < 1.0).pick,
  pickWhenOpen: bucket(r => r.arrSep >= 2.0).pick,
  pickInLane: bucket(r => r.lane).pick,
  avgDepth: avg(real.map(r => r.depth)),
  avgAir: avg(real.map(r => r.air)),
  /* WHO GETS THE BALL. The read order is WR1, WR2, RB, C unless the play names
     one, and under the old rule the first man over the bar got it — so the two
     receivers took nearly everything and the back and the centre, who are the
     open men on a collapsing pocket, were reads nobody reached. */
  targets: ['WR1', 'WR2', 'RB', 'C'].reduce((a, sl) => {
    a[sl] = pct(real.filter(r => r.slot === sl).length, real.length); return a;
  }, {})
};

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
const row = (l, v, n) => `  ${l.padEnd(30)} ${String(v).padStart(8)}   ${n || ''}`;
console.log(`\nQB DECISIONS — ${GAMES} games, ${DIFFICULTY}, seed ${SEED}, ${rows.length} throws\n`);
console.log(row('Separation at the throw', out.sepAtThrow + 'yd', 'what _aiThrow reads'));
console.log(row('Separation on arrival', out.sepAtArrival + 'yd', 'what decides the play'));
console.log(row('Best man available', out.bestAvailable + 'yd', 'on the same measure'));
console.log(row('Separation left on the field', out.sepLeftOnField + 'yd', 'lower is better'));
console.log(row('Threw to the most open man', out.choseMostOpen + '%', ''));
console.log(row('Threw to the worse half', out.choseWorstHalf + '%', 'lower is better'));
console.log(row('Threw into the lane', out.intoTheLane + '%', 'defender in front'));
console.log(row('Threw into coverage (<1yd)', out.coveredThrows + '%', 'lower is better'));
console.log(row('Throwaways', out.throwaways, ''));
console.log('');
console.log(row('Interception rate', out.pickRate + '%', '~3-5%'));
console.log(row('  ...when covered (<1yd)', out.pickWhenCovered + '%', ''));
console.log(row('  ...when open (>2yd)', out.pickWhenOpen + '%', ''));
console.log(row('  ...into the lane', out.pickInLane + '%', ''));
console.log(row('Who got the ball',
  Object.entries(out.targets).map(([k, v]) => `${k} ${v}%`).join('  '), ''));
console.log(row('Average depth', out.avgDepth + 'yd', ''));
console.log(row('Average hang time', out.avgAir + 's', ''));
console.log('');
