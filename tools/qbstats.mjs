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

const hyp = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

/* THE READ IS THE ENGINE'S, NOT A SECOND COPY OF IT.

   This used to re-implement `_readReceiver` here — the same lead solve, the
   same closing model, its own lane test — so that the probe could say what the
   quarterback saw. Two copies of one rule is the failure `rig-def.mjs` exists
   to prevent one level up, and they had already drifted apart in two places:
   this one handed the defence the whole flight rather than the flight less the
   read on it, and it floored separation at zero, which makes a defender who
   beats the ball to the spot indistinguishable from one who arrives level with
   it. The column headed "what decides the play" was not the number that
   decided the play.

   So it asks the engine. The probe's job is to judge the decision, and it can
   only do that against the decision that was actually made. */
function arrivalRead(e, qb, r, def) {
  const v = e._readReceiver(qb, r, def);
  return { sep: v.sep, lane: v.lane, t: v.air, px: v.x, py: v.y };
}

function playGame(gameIdx, rows) {
  let ev = {};
  const e = new F.Engine(canvas, { onEvent(x) { ev[x.type] = (ev[x.type] || 0) + 1; } });
  let pending = null, lastSpot = null;
  const realEndPlay = e._endPlay.bind(e);
  e._endPlay = function (spotX, noGain) { lastSpot = spotX; return realEndPlay(spotX, noGain); };
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
          depth: mine.px - s.losX, snapT: s.snapT,
          /* THE DOWN HE IS ON. No chains: four downs to reach midfield, three
             to score once you have — so `need` is the distance to whichever
             line is live, and `downsLeft` counts this one. */
          downsLeft: (s.crossedMid ? 3 : 4) - s.down + 1,
          need: (s.crossedMid ? 60 : 35) - s.losX,
          startX: s.losX
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
    ev = {}; pending = null; lastSpot = null;
    let f = 0;
    while (s.phase === 'live' && f < MAX_PLAY_FRAMES) { e._update(DT); f++; }
    if (pending) {
      pending.pick = !!ev.turnover;
      pending.caught = !!ev.catch;
      pending.away = !!ev.throwaway;
      /* A touchdown reaches every line there is, and scoring does not go
         through _endPlay, so it never sets a spot. */
      pending.moved = !!ev.touchdown ||
        (lastSpot != null && (lastSpot - pending.startX) >= pending.need);
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
  }, {}),
  /* WHAT HE AIMED AT, BY WHAT THE DOWN NEEDED. The quarterback used to throw
     the identical pass whatever down it was — 4.9 yards with four in hand and
     4.6 on the last one, needing 13.5. A last down he cannot reach is a
     turnover whether the ball is caught or not. */
  byDown: [4, 3, 2, 1].map(dl => {
    const set = real.filter(r => r.downsLeft === dl);
    return {
      downsLeft: dl, n: set.length,
      need: avg(set.map(r => r.need)), aimed: avg(set.map(r => r.depth)),
      moved: pct(set.filter(r => r.moved).length, set.length)
    };
  }).filter(x => x.n)
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
console.log(row('Average closing window', out.avgAir + 's', 'flight, less the read on it'));
console.log('');
console.log(`  ${'downs left'.padEnd(12)} ${'n'.padStart(5)} ${'needed'.padStart(7)} ${'aimed'.padStart(6)} ${'moved the sticks'.padStart(17)}`);
for (const d of out.byDown) {
  console.log(`  ${String(d.downsLeft).padEnd(12)} ${String(d.n).padStart(5)} ${(d.need + 'yd').padStart(7)} ` +
    `${(d.aimed + 'yd').padStart(6)} ${(d.moved + '%').padStart(17)}`);
}
console.log('');
