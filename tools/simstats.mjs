#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — HEADLESS BOX SCORE

   Runs the real engine.js against a stubbed DOM and a fixed timestep, plays a
   number of CPU-vs-CPU games, and prints the box score that REALISM.md is
   measured against. No browser, no renderer — a full run is a couple of
   seconds, so a realism change can be checked the moment it's written.

     node tools/simstats.mjs [--games 8] [--difficulty pro] [--seed 1] [--json]

   The engine only touches four things outside itself (getContext,
   getBoundingClientRect, devicePixelRatio, addEventListener) and data.js
   touches none, so the stub below is the whole DOM.

   Math.random is replaced with a seeded generator for the duration of the run,
   so the same seed gives the same box score and two runs are comparable.
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
const MAX_PLAY_FRAMES = 60 * 30;      // a play that runs 30s is a bug, not a play

/* ---- seeded Math.random so runs are reproducible and comparable ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = mulberry32(SEED);

/* ---- the entire DOM the engine needs ------------------------------------ */
const timers = [];
function drainTimers() {
  let n = 0;
  while (timers.length && n++ < 64) { const fn = timers.shift(); try { fn(); } catch (e) {} }
}
const noopCtx = new Proxy({}, {
  get: (t, k) => (k === 'canvas' ? canvas : () => {})
});
const canvas = {
  width: 800, height: 450, style: {},
  getContext: () => noopCtx,
  getBoundingClientRect: () => ({ width: 800, height: 450, left: 0, top: 0, right: 800, bottom: 450 })
};
const win = {
  devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {},
  requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
  // Real queue, not a no-op: the engine schedules its post-score continuations
  // (extra point, possession change, next snap) on setTimeout, and swallowing
  // them wedges the game on the first touchdown.
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout() {},
  performance: { now: () => 0 }
};
win.window = win;
win.globalThis = win;

function load(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  /* Each file is an IIFE taking the global; hand it the stub. setTimeout is
     injected as a parameter because the engine calls it BARE — an unqualified
     `setTimeout(...)` inside the wrapper would otherwise resolve to Node's
     real one, which schedules a macrotask this synchronous loop never reaches,
     and every post-score continuation would be silently dropped. */
  new Function('window', 'globalThis', 'document', 'self', 'setTimeout', 'clearTimeout', src)(
    win, win, undefined, win, win.setTimeout, win.clearTimeout);
}
load('flagster/js/data.js');
load('flagster/js/engine.js');

const F = win.FLAGSTER, D = F.data;

/* ---- play one game, collecting per-play rows ---------------------------- */
function playGame(gameIdx) {
  const rows = [];
  let ev = {};
  const e = new F.Engine(canvas, { onEvent(x) { ev[x.type] = (ev[x.type] || 0) + 1; } });
  /* Take the spot from the engine rather than inferring it. On an incompletion
     the ball object is left sitting downfield where the pass landed, so
     reading its x credits the offence with yards it never gained. */
  let lastSpot = null;
  const realEndPlay = e._endPlay.bind(e);
  e._endPlay = function (spotX, noGain) { lastSpot = spotX; return realEndPlay(spotX, noGain); };
  const home = D.NATIONS[gameIdx % D.NATIONS.length];
  const away = D.NATIONS[(gameIdx + 3) % D.NATIONS.length];
  e.newGame({
    home, away,
    homeJersey: D.jerseysFor(home.id)[0], awayJersey: D.jerseysFor(away.id)[1],
    userSide: 'home', quarters: 4, quarterLen: 150,
    demo: true, difficulty: DIFFICULTY
  });
  // setTimeout is stubbed out, so the engine's post-score continuations never
  // fire; drive the down cycle here instead, the way the demo shell does.
  let guard = 0;
  while (!e.state.gameOver && guard++ < 4000) {
    const s = e.state;
    drainTimers();                            // let scheduled continuations land
    if (s.gameOver || s.phase === 'final') break;
    if (s.phase === 'playcall') { e.autoCall(); continue; }
    if (s.phase === 'presnap') { e.snap(); continue; }
    if (s.phase !== 'live') {
      // Dead and nothing queued: nudge the down cycle. `s` aliases e.state, so
      // the before/after phase has to be captured, not compared through it.
      const was = s.phase;
      e._nextSnap();
      if (s.phase === was) break;             // genuinely wedged
      continue;
    }
    // --- a live play ---
    const type = s.offPlay ? s.offPlay.type : 'unknown';
    const isPass = /pass/.test(type);
    const startX = s.losX;
    const startYTG = s.yardsToGoal;
    const startScore = { home: s.score.home, away: s.score.away };
    ev = {}; lastSpot = null;
    let threw = false, thrownAt = null, completed = false;
    let f = 0;
    while (s.phase === 'live' && f < MAX_PLAY_FRAMES) {
      const airBefore = !!(s.ball && s.ball.inAir);
      e._update(DT); f++;
      if (!airBefore && s.ball && s.ball.inAir) { threw = true; thrownAt = f * DT; }
      if (s.carrier && threw && s.thrownTo === s.carrier) completed = true;
    }
    const scored = (s.score.home - startScore.home) + (s.score.away - startScore.away);
    const td = scored >= 6;
    const incomplete = !!ev.incomplete;
    const intercepted = !!ev.turnover;
    let gained;
    if (td) gained = startYTG;                       // in from wherever it started
    else if (incomplete || intercepted) gained = 0;  // ball comes back to the spot
    else if (lastSpot != null) gained = lastSpot - startX;
    else gained = 0;
    rows.push({
      type, isPass, threw, thrownAt, completed: !!ev.catch, intercepted, incomplete,
      gained: Math.max(-15, Math.min(50, gained)),
      td, dur: f * DT, timedOut: f >= MAX_PLAY_FRAMES
    });
    if (s.phase === 'live') break;    // play never resolved; stop this game
  }
  return rows;
}

/* ---- run and summarise --------------------------------------------------- */
const all = [];
for (let g = 0; g < GAMES; g++) all.push(...playGame(g));

const passPlays = all.filter(r => r.isPass);
const runPlays = all.filter(r => !r.isPass);
const thrown = passPlays.filter(r => r.threw);
const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0;

const box = {
  plays: all.length,
  games: GAMES,
  playsPerGame: +(all.length / GAMES).toFixed(1),
  yardsPerPassPlay: avg(passPlays.map(r => r.gained)),
  yardsPerRun: avg(runPlays.map(r => r.gained)),
  passPlaysNeverThrown: pct(passPlays.length - thrown.length, passPlays.length),
  completionPct: pct(thrown.filter(r => r.completed).length, thrown.length),
  interceptionPct: pct(thrown.filter(r => r.intercepted).length, thrown.length),
  touchdownsPerPlay: pct(all.filter(r => r.td).length, all.length),
  gainsOfThreeOrFewer: pct(all.filter(r => r.gained <= 3).length, all.length),
  timeToThrow: avg(thrown.map(r => r.thrownAt)),
  avgPlayLength: avg(all.map(r => r.dur)),
  playsThatNeverResolved: all.filter(r => r.timedOut).length
};

if (AS_JSON) { console.log(JSON.stringify(box, null, 2)); process.exit(0); }

const TARGET = {
  yardsPerPassPlay: '~7-9', yardsPerRun: '~4-5', passPlaysNeverThrown: '~2-4%',
  completionPct: '~55-65%', touchdownsPerPlay: '~5-8%', gainsOfThreeOrFewer: '~35%',
  timeToThrow: '~2.5-3.5s', playsPerGame: '45-60'
};
const row = (label, value, target) =>
  `  ${label.padEnd(28)} ${String(value).padStart(8)}   ${target || ''}`;

console.log(`\nFLAGSTER box score — ${GAMES} games, ${DIFFICULTY}, seed ${SEED}, ${all.length} plays\n`);
console.log(row('Yards per pass play', box.yardsPerPassPlay, TARGET.yardsPerPassPlay));
console.log(row('Yards per run', box.yardsPerRun, TARGET.yardsPerRun));
console.log(row('Pass plays never thrown', box.passPlaysNeverThrown + '%', TARGET.passPlaysNeverThrown));
console.log(row('Completion %', box.completionPct + '%', TARGET.completionPct));
console.log(row('Interception rate', box.interceptionPct + '%', '~3-5%'));
console.log(row('Touchdowns per play', box.touchdownsPerPlay + '%', TARGET.touchdownsPerPlay));
console.log(row('Gains of 3 yards or fewer', box.gainsOfThreeOrFewer + '%', TARGET.gainsOfThreeOrFewer));
console.log(row('Time to throw', box.timeToThrow + 's', TARGET.timeToThrow));
console.log(row('Plays per game', box.playsPerGame, TARGET.playsPerGame));
console.log(row('Avg play length', box.avgPlayLength + 's', ''));
if (box.playsThatNeverResolved) console.log(row('NEVER RESOLVED', box.playsThatNeverResolved, '<- bug'));
console.log('');
