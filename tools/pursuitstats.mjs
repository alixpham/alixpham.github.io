#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — PURSUIT PROBE

   pullstats measures the flag pull once a defender has arrived. This measures
   whether he arrives at all, and it exists because of one complaint the box
   score cannot see: "defenders often just back up in front of a ball carrier."

   Every frame with a live carrier, every defender inside 15 yards is classified
   by where he is and which way he is going:

     * GOAL-SIDE   — between the carrier and the end zone (d.x > c.x). This is
                     the defender the carrier is running at.
     * BACKPEDAL   — goal-side, and moving downfield (+x) while the carrier
                     comes at him. That is retreating in front of the ball,
                     which is the thing being complained about.
     * CLOSING     — the range to the carrier is shrinking.

   It also reports what the defender was actually being told to do that frame
   (pursue / cover / zone / spy / blitz / break-on-ball), because the fix is
   almost always "he was never in pursuit mode at all".

     node tools/pursuitstats.mjs [--games 6] [--difficulty pro] [--seed 1] [--json]
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const GAMES = parseInt(arg('games', '6'), 10);
const DIFFICULTY = arg('difficulty', 'pro');
const SEED = parseInt(arg('seed', '1'), 10);
const AS_JSON = process.argv.includes('--json');
const DT = 1 / 60;
const MAX_PLAY_FRAMES = 60 * 30;
const NEAR = 15;             // yards: "in the play"

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
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* Which branch of _aiDefender ran this frame. Read off the same state the AI
   reads, one frame BEFORE it runs, so it matches what the AI decided. */
function modeOf(e, d) {
  const s = e.state;
  if (d.stun > 0) return 'stun';
  if (d.blitz && (!s.carrier || s.carrier.slot === 'QB' || s.ball.inAir === false)) return 'blitz';
  if (s.ball && s.ball.inAir) return 'ball';
  if (e._isRunner(s.carrier)) return 'pursue';
  if (d.cover) return 'cover';
  if (d.zone) return 'zone';
  return 'spy';
}

const tally = {};
function bump(k, n) { tally[k] = (tally[k] || 0) + (n == null ? 1 : n); }
const byMode = {};
function bumpMode(m, k) {
  const t = byMode[m] || (byMode[m] = { frames: 0, goalSide: 0, backpedal: 0, closing: 0, gapRate: 0 });
  if (k) t[k]++; else t.frames++;
  return t;
}

function playGame(gameIdx) {
  const e = new F.Engine(canvas, { onEvent() {} });
  const home = D.NATIONS[gameIdx % D.NATIONS.length];
  const away = D.NATIONS[(gameIdx + 3) % D.NATIONS.length];
  e.newGame({
    home, away,
    homeJersey: D.jerseysFor(home.id)[0], awayJersey: D.jerseysFor(away.id)[1],
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
      const was = s.phase;
      e._nextSnap();
      if (s.phase === was) break;
      continue;
    }

    let f = 0;
    const prevGap = new Map();
    while (s.phase === 'live' && f < MAX_PLAY_FRAMES) {
      const c = s.carrier;
      /* Only frames with a genuine RUNNER count. A quarterback standing in the
         pocket is a ball carrier too, and coverage dropping away from him is
         coverage doing its job — counting those frames buries the thing being
         looked for under normal football. */
      const runner = c && !(c === s.passer && !s.handoffDone);
      const modes = new Map();
      if (runner) for (const p of s.players) {
        if (p.team === c.team || p.flagPulled) continue;
        modes.set(p, modeOf(e, p));
      }
      const gapBefore = new Map();
      if (runner) for (const p of modes.keys()) gapBefore.set(p, dist(p, c));

      e._update(DT); f++;

      const c2 = s.carrier;
      if (!c2 || c2 !== c || !runner) { prevGap.clear(); continue; }
      const carrierRunning = (c2.vx || 0) > 0.5;        // actually going somewhere
      for (const [p, m] of modes) {
        if (p.flagPulled) continue;
        const gap = dist(p, c2);
        if (gap > NEAR) continue;
        const t = bumpMode(m);
        bump('frames');
        const goalSide = (p.x - c2.x) > 0.5;
        const closing = gap < (gapBefore.get(p) || gap);
        if (closing) { t.closing++; bump('closing'); }
        if (goalSide) {
          t.goalSide++; bump('goalSide');
          // retreating: moving downfield, with the carrier coming at him
          if (carrierRunning && (p.vx || 0) > 0.5) { t.backpedal++; bump('backpedal'); }
        }
        t.gapRate += (gap - (gapBefore.get(p) || gap)) / DT;
      }
      if (s.phase !== 'live') break;
    }
    if (s.phase === 'live') break;
  }
}

for (let g = 0; g < GAMES; g++) playGame(g);

const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
const modes = Object.keys(byMode).sort((a, b) => byMode[b].frames - byMode[a].frames);
const out = {
  difficulty: DIFFICULTY, games: GAMES,
  defenderFramesNearCarrier: tally.frames || 0,
  goalSideShare: pct(tally.goalSide, tally.frames),
  backpedalShareOfGoalSide: pct(tally.backpedal, tally.goalSide),
  closingShare: pct(tally.closing, tally.frames),
  byMode: modes.map(m => ({
    mode: m,
    frames: byMode[m].frames,
    shareOfAll: pct(byMode[m].frames, tally.frames),
    goalSide: pct(byMode[m].goalSide, byMode[m].frames),
    backpedalOfGoalSide: pct(byMode[m].backpedal, byMode[m].goalSide),
    closing: pct(byMode[m].closing, byMode[m].frames),
    meanGapRate: +(byMode[m].gapRate / Math.max(1, byMode[m].frames)).toFixed(2)
  }))
};

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`\nFLAGSTER pursuit probe — ${GAMES} games, ${DIFFICULTY}, seed ${SEED}\n`);
console.log(`  defender-frames within ${NEAR}yd of a carrier   ${out.defenderFramesNearCarrier}`);
console.log(`  ...goal-side of him                        ${out.goalSideShare}%`);
console.log(`  ...of those, BACKPEDALLING away            ${out.backpedalShareOfGoalSide}%`);
console.log(`  ...closing the range                       ${out.closingShare}%\n`);
console.log('  mode        share   goal-side  backpedal   closing   gap yd/s');
for (const r of out.byMode) {
  console.log('  ' + r.mode.padEnd(10) +
    String(r.shareOfAll + '%').padStart(6) +
    String(r.goalSide + '%').padStart(11) +
    String(r.backpedalOfGoalSide + '%').padStart(11) +
    String(r.closing + '%').padStart(10) +
    String(r.meanGapRate).padStart(11));
}
console.log('');
