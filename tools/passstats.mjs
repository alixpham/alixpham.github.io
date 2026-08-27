#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — THE PASS, IN THE AIR

   The box score says how many passes were completed. It cannot say whether you
   ever SAW one, and that is the complaint this exists for: *"on low / short
   passes, we don't always see the ball move."*

   So every pass is timed from release to arrival and classified by how long it
   is actually on screen:

     * HANG      — the flight time the ballistic solve produced, in seconds.
     * FRAMES    — the same number at 60fps, which is how many times the
                   renderer gets to draw the ball between the hand and the
                   hands. Under about six and a pass reads as a teleport
                   however correct the physics is.
     * ARC       — how far the ball rises above the higher of its two ends. A
                   short pass is thrown DOWNWARD (it leaves at the ear and is
                   caught at the chest), so its arc is legitimately zero; that
                   is not a bug, but combined with a short hang it is why
                   nothing appears to happen.
     * REACH     — how far it actually travelled, against how far it was aimed.

     node tools/passstats.mjs [--games 8] [--difficulty pro] [--seed 1] [--json]

   Distances are bucketed, because the complaint is specifically about the
   short ones and an average over every throw hides them.
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
const FPS = 60;
const THIN = 6;              // frames: below this a pass reads as a teleport

/* Deterministic, so a change is attributable. */
let seed = SEED >>> 0 || 1;
Math.random = function () {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 4294967296;
};

const timers = [];
const drainTimers = () => { while (timers.length) { const fn = timers.shift(); try { fn(); } catch (e) { } } };
const noopCtx = new Proxy({}, { get: () => () => { } });
const canvas = {
  width: 800, height: 450, style: {},
  addEventListener() { }, removeEventListener() { },
  getContext: () => noopCtx,
  getBoundingClientRect: () => ({ width: 800, height: 450, left: 0, top: 0, right: 800, bottom: 450 })
};
const win = {
  devicePixelRatio: 1,
  addEventListener() { }, removeEventListener() { },
  requestAnimationFrame() { return 0; }, cancelAnimationFrame() { },
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout() { },
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

const passes = [];

function playGame(gameIdx) {
  const e = new F.Engine(canvas, { onEvent() { } });
  const home = D.NATIONS[gameIdx % D.NATIONS.length];
  const away = D.NATIONS[(gameIdx + 3) % D.NATIONS.length];
  e.newGame({
    home, away,
    homeJersey: D.jerseysFor(home.id)[0], awayJersey: D.jerseysFor(away.id)[1],
    userSide: 'home', demo: true, difficulty: DIFFICULTY
  });

  let guard = 0, watching = null;
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

    for (let f = 0; f < MAX_PLAY_FRAMES && s.phase === 'live'; f++) {
      const b = s.ball;
      /* Catch the frame the ball becomes airborne: everything the flight is
         made of is on the ball object and nowhere else. */
      if (b && b.inAir && !watching) {
        const d = Math.hypot(b.to.x - b.from.x, b.to.y - b.from.y);
        const z0 = b.z0, z1 = b.z1;
        /* Peak of the parabola, if it happens during the flight at all. */
        const tPeak = b.vz > 0 ? b.vz / 10.73 : 0;
        const zPeak = z0 + b.vz * tPeak - 0.5 * 10.73 * tPeak * tPeak;
        watching = {
          aimed: d, hang: b.dur, frames: b.dur * FPS,
          arc: Math.max(0, zPeak - Math.max(z0, z1)),
          angle: Math.atan2(b.vz, b.hv) * 180 / Math.PI,
          reach: b.hv * b.dur, z0, z1, drawn: 0
        };
      }
      if (b && b.inAir && watching) watching.drawn++;
      if (watching && !(b && b.inAir)) { passes.push(watching); watching = null; }
      e._update(DT);
    }
    if (watching) { passes.push(watching); watching = null; }

  }
}

for (let g = 0; g < GAMES; g++) playGame(g);

/* ------------------------------------------------------------------ report */
const BUCKETS = [[0, 3], [3, 6], [6, 10], [10, 15], [15, 25], [25, 99]];
const rows = BUCKETS.map(([lo, hi]) => {
  const set = passes.filter(p => p.aimed >= lo && p.aimed < hi);
  const mean = k => (set.length ? set.reduce((a, p) => a + p[k], 0) / set.length : 0);
  return {
    label: (hi > 90 ? lo + '+' : lo + '-' + hi) + ' yd',
    n: set.length,
    hang: mean('hang'), frames: mean('frames'), drawn: mean('drawn'),
    arc: mean('arc'), angle: mean('angle'),
    thin: set.filter(p => p.frames < THIN).length
  };
});

if (AS_JSON) {
  console.log(JSON.stringify({ passes: passes.length, rows }, null, 2));
} else {
  const thin = passes.filter(p => p.frames < THIN).length;
  console.log(`\nFLAGSTER pass flight — ${GAMES} games, ${DIFFICULTY}, seed ${SEED}, ${passes.length} passes\n`);
  console.log(`  ${'aimed'.padEnd(9)} ${'n'.padStart(4)} ${'hang s'.padStart(7)} ${'frames'.padStart(7)} ${'arc yd'.padStart(7)} ${'angle'.padStart(7)}  under ${THIN} frames`);
  console.log('  ' + '-'.repeat(64));
  for (const r of rows) {
    if (!r.n) continue;
    console.log(`  ${r.label.padEnd(9)} ${String(r.n).padStart(4)} ${r.hang.toFixed(3).padStart(7)} ${r.frames.toFixed(1).padStart(7)} ` +
      `${r.arc.toFixed(2).padStart(7)} ${(r.angle.toFixed(1) + '°').padStart(7)}  ${String(r.thin).padStart(4)}` +
      (r.thin ? `  (${(100 * r.thin / r.n).toFixed(0)}%)` : ''));
  }
  console.log(`\n  ${thin} of ${passes.length} passes (${(100 * thin / passes.length).toFixed(1)}%) are on screen for fewer than ${THIN} frames at ${FPS}fps`);
  const shortest = passes.slice().sort((a, b) => a.frames - b.frames)[0];
  if (shortest) {
    console.log(`  shortest: ${shortest.aimed.toFixed(1)} yd in ${(shortest.hang * 1000).toFixed(0)} ms ` +
      `= ${shortest.frames.toFixed(1)} frames, arc ${shortest.arc.toFixed(2)} yd, launched ${shortest.angle.toFixed(1)}°`);
  }
  console.log('');
}
