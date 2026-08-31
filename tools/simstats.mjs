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
const finals = [];
const pats = [];
function playGame(gameIdx) {
  const rows = [];
  let ev = {};
  const e = new F.Engine(canvas, { onEvent(x) {
    ev[x.type] = (ev[x.type] || 0) + 1;
    /* A CONVERSION'S RESULT ARRIVES AS AN EVENT AND NOTHING WAS LISTENING.
       Counting events by type alone threw away the `good` flag, and reading the
       score delta on the conversion's own play row reports 0% every time — the
       points post from a drained continuation, one row later. The engine says
       plainly whether it was good; take that. */
    if (x.type === 'patresult') pats.push({ good: !!x.good, points: x.points,
      play: (e.state.offPlay && e.state.offPlay.name) || '?', type: (e.state.offPlay && e.state.offPlay.type) || '?' });
  } });
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
    userSide: 'home',                       // periods left at the engine default (2 x 20min)
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
    const isPat = !!s.patActive;   // a conversion is a play, and it was never counted as one
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
      scrambled: !!ev.scramble, flicked: ev.fleaback || 0, pastLine: !!ev.passerpastline, pat: isPat,
      gained: Math.max(-15, Math.min(50, gained)), scoredPts: scored,
      td, dur: f * DT, timedOut: f >= MAX_PLAY_FRAMES
    });
    if (s.phase === 'live') break;    // play never resolved; stop this game
  }
  /* THE SCOREBOARD, which this harness tracked and never once reported. Every
     other number here is a rate, and a rate can be right while the game it adds
     up to is nothing like the sport — points per game is the one figure a real
     result can be held against directly. */
  finals.push({ home: e.state.score.home, away: e.state.score.away });
  return rows;
}

/* ---- run and summarise --------------------------------------------------- */
const all = [];
for (let g = 0; g < GAMES; g++) all.push(...playGame(g));

const passPlays = all.filter(r => r.isPass);
/* A TRICK IS NOT A RUN, and calling it one made this line lie. `isPass` is
   `/pass/.test(type)`, so all three trick plays fell into the run bucket — and
   once Flea Flicker became a genuine deep shot instead of a quarterback keeper,
   its completions dragged "yards per run" from 4.5 to 8.0 without a single
   handoff changing. Runs are runs; tricks get their own line. */
const runPlays = all.filter(r => r.type === 'run');
const trickPlays = all.filter(r => r.type === 'trick');
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
  playsThatNeverResolved: all.filter(r => r.timedOut).length,
  regulationPlaysPerGame: +((all.filter(r => !r.ot && !r.pat).length) / GAMES).toFixed(1),
  overtimePlays: all.filter(r => r.ot).length,
  patPlays: all.filter(r => r.pat).length
};

if (AS_JSON) { console.log(JSON.stringify(box, null, 2)); process.exit(0); }

const TARGET = {
  yardsPerPassPlay: '~7-9', yardsPerRun: '~4-5', passPlaysNeverThrown: '~2-4%',
  completionPct: '~55-65%', touchdownsPerPlay: '~5-8%', gainsOfThreeOrFewer: '~35%',
  timeToThrow: '~2.5-3.5s', playsPerGame: '45-60',
  /* MEASURED OFF REAL RESULTS, not guessed. Twenty games from the 2024 IFAF
     Men's Flag Football World Championship — group stage and the whole knockout
     bracket including the final — average **64.5 combined points**, median 66,
     range 36 to 86. At six for a touchdown plus the conversion that is about
     **9.2 touchdowns a game between the two sides**.

     WHICH IS WHY `touchdownsPerPlay: '~5-8%'` IS WRONG, and has been the whole
     time. Hold it against this file's own play count: 45-60 plays a game at
     5-8% is 2.2 to 4.8 touchdowns, i.e. **16 to 34 combined points** — half of
     what the sport actually scores, or less. The two targets cannot both be
     right, and the one with a source behind it is the scoreline. At ~57 plays
     a game, 9.2 touchdowns is **16% of plays**. REALISM.md has called this
     metric "about double where it should be" since v2.17.0; it was the target
     that was out, not the game. */
  pointsPerGame: '~55-75', touchdownsPerGame: '~8-10'
};
/* AND THE ONES WITHOUT A SOURCE ARE MARKED. `pointsPerGame` and
   `touchdownsPerGame` come from twenty real scorelines. The rest of this table
   was inherited unsourced, and at least one of them was demonstrably wrong, so
   the others get no more credit than they have earned: `gainsOfThreeOrFewer` at
   ~35% is hard to square with a 61% completion rate on its own (every
   incompletion is a nought-yard play, so ~39% of pass plays land in that bucket
   before a single short completion does), and `playsPerGame` at 45-60 sits just
   under what two 20-minute halves on a running clock actually produce here. Do
   not tune the game to an unsourced number. Find the number first. */
const row = (label, value, target) =>
  `  ${label.padEnd(28)} ${String(value).padStart(8)}   ${target || ''}`;

console.log(`\nFLAGSTER box score — ${GAMES} games, ${DIFFICULTY}, seed ${SEED}, ${all.length} plays\n`);
console.log(row('Yards per pass play', box.yardsPerPassPlay, TARGET.yardsPerPassPlay));
console.log(row('Yards per run', box.yardsPerRun, TARGET.yardsPerRun));
console.log(row('Yards per trick play', avg(trickPlays.map(r => r.gained)) + '  (' + trickPlays.length + ' plays)', ''));
console.log(row('Pass plays never thrown', box.passPlaysNeverThrown + '%', TARGET.passPlaysNeverThrown));
console.log(row('Completion %', box.completionPct + '%', TARGET.completionPct));
console.log(row('Interception rate', box.interceptionPct + '%', '~3-5%'));
console.log(row('Touchdowns per play', box.touchdownsPerPlay + '%', TARGET.touchdownsPerPlay));
console.log(row('Gains of 3 yards or fewer', box.gainsOfThreeOrFewer + '%', TARGET.gainsOfThreeOrFewer));
console.log(row('Time to throw', box.timeToThrow + 's', TARGET.timeToThrow));
/* WHAT THE QUARTERBACK DID WITH HIS FEET, and the one thing he must never do.
   A3 kills the down if the passer crosses the line, so a scramble that ever
   causes one is a bug in the scramble, not a rules event worth having. */
const scr = all.filter(r => r.scrambled).length;
const scrOf = all.filter(r => r.isPass).length;
console.log(row('Pockets broken (scramble)',
  scr + ' of ' + scrOf + ' pass plays (' + (100 * scr / Math.max(1, scrOf)).toFixed(0) + '%)', ''));
const fl = all.filter(r => r.flicked);
/* COUNT THE PITCHES, NOT THE PLAYS. A boolean "did this flick?" reported a
   contented 1 while the ball was ping-ponging between the quarterback and the
   back 343 times in a single down, because the play still ended the right way. */
console.log(row('Flea flickers flicked',
  fl.length + ' plays, max ' + Math.max(0, ...fl.map(r => r.flicked)) + ' pitches in one', 'max must be 1'));
console.log(row('Passer past the line', String(all.filter(r => r.pastLine).length), 'must be 0'));
console.log(row('Points per game (both)', avg(finals.map(f => f.home + f.away)), TARGET.pointsPerGame));
console.log(row('Touchdowns per game (both)', avg(all.filter(r => r.td).map(() => 1)) === 0 ? '0'
  : (all.filter(r => r.td).length / GAMES).toFixed(1), TARGET.touchdownsPerGame));
console.log(row('Plays per game', box.playsPerGame, TARGET.playsPerGame));
console.log(row('  of which regulation', box.regulationPlaysPerGame, '45-60'));
console.log(row('  overtime plays (total)', box.overtimePlays, ''));
const patGood = pats.filter(p => p.good).length;
const patTwo = pats.filter(p => p.points === 2).length;
console.log(row('  conversion attempts',
  pats.length + (pats.length ? '  ' + (100 * patGood / pats.length).toFixed(0) + '% good, '
    + (100 * patTwo / pats.length).toFixed(0) + '% went for 2' : ''), '~60-75%? unsourced'));
if (process.argv.includes('--pats')) {
  const by = {};
  for (const p of pats) { by[p.play] = by[p.play] || { n: 0, g: 0, type: p.type }; by[p.play].n++; if (p.good) by[p.play].g++; }
  console.log('\n  what the CPU calls from the 5, and whether it works:');
  Object.entries(by).sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) =>
    console.log('    ' + k.padEnd(18) + String(v.n).padStart(3) + ' calls  ' +
      (100 * v.g / v.n).toFixed(0).padStart(3) + '% good   ' + v.type));
}
console.log(row('Avg play length', box.avgPlayLength + 's', ''));
if (box.playsThatNeverResolved) console.log(row('NEVER RESOLVED', box.playsThatNeverResolved, '<- bug'));
console.log('');
