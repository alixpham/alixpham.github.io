#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — FLAG-PULL PROBE

   simstats says how a game ENDS UP; this says why. It runs the same headless
   CPU-vs-CPU engine and instruments the one mechanic the box score keeps
   blaming — the contested flag pull — reporting the numbers a player actually
   feels:

     * time from a defender first getting a hand on the carrier to the flag
       coming off (the "takes too long" number),
     * how many separate engagements it takes, because a pull that needs four
       is four times as long as its fill rate says,
     * where the meter GOES: filled, drained by losing contact, wiped by a juke,
     * how often a defender is close enough to be in the play but outside grab
       range, which is contact the player sees and the engine does not.

     node tools/pullstats.mjs [--games 8] [--difficulty pro] [--seed 1] [--json]
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
/* --user drops demo mode so the difficulty knobs become side-aware, and splits
   every pull by WHICH side made it. Demo games have no user side, so the
   CPU-vs-CPU numbers above cannot see whether "Rookie" is easy in both
   directions or only while you have the ball. s.userControlled is left unset,
   so the ordinary defensive AI drives all ten players and the only thing that
   differs between the sides is the difficulty column they read. */
const USER = process.argv.includes('--user');
const USER_SIDE = 'home';
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

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ---- per-play observations ---------------------------------------------- */
const plays = [];        // one row per live play that had a ball carrier
const pulls = [];        // time-to-pull, in seconds from first contact
const userPulls = [];    // ...by the user's own defence (--user only)
const cpuPulls = [];     // ...by the CPU's

function playGame(gameIdx) {
  let jukes = 0;
  const e = new F.Engine(canvas, { onEvent(x) { if (x.type === 'juke') jukes++; } });
  let pulled = false;
  const realPull = e._flagPull.bind(e);
  let pullSide = null;
  e._flagPull = function (d, c) { pulled = true; pullSide = d.team; return realPull(d, c); };
  /* A juke wipes the meter and clears s.grabbedBy in the SAME frame, so by the
     time the sampler looks the engagement is already gone and the drop reads
     as ordinary decay. Measure it at the source instead. */
  let jukeWipe = 0;
  const realJuke = e.juke.bind(e);
  e.juke = function () {
    const c = e.state && e.state.carrier;
    const before = c ? (c.grabT || 0) : 0;
    const r = realJuke();
    if (c) jukeWipe += Math.max(0, before - (c.grabT || 0));
    return r;
  };

  const home = D.NATIONS[gameIdx % D.NATIONS.length];
  const away = D.NATIONS[(gameIdx + 3) % D.NATIONS.length];
  e.newGame({
    home, away,
    homeJersey: D.jerseysFor(home.id)[0], awayJersey: D.jerseysFor(away.id)[1],
    userSide: USER_SIDE, demo: !USER, difficulty: DIFFICULTY
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

    // --- one live play, sampled every frame ---
    pulled = false; pullSide = null; jukes = 0; jukeWipe = 0;
    let f = 0;
    let firstContactF = -1, contactF = 0, engagements = 0, breaks = 0;
    let wasGrabbed = false, pullF = -1;
    let nearF = 0, carrierF = 0;           // frames a defender was within 2yd
    let filled = 0, drained = 0, juked = 0; // meter accounting, in meter-units
    let prevT = 0;

    while (s.phase === 'live' && f < MAX_PLAY_FRAMES) {
      e._update(DT); f++;
      const c = s.carrier;
      if (!c) { prevT = 0; continue; }
      carrierF++;

      // nearest live defender, regardless of grab range
      const defTeam = e.defenseTeam();
      let nd = 1e9;
      for (const p of s.players) {
        if (p.team !== defTeam || p.flagPulled) continue;
        const dd = dist(p, c);
        if (dd < nd) nd = dd;
      }
      if (nd < 2.0) nearF++;

      const grabbed = !!s.grabbedBy;
      if (grabbed) {
        contactF++;
        if (firstContactF < 0) firstContactF = f;
        if (!wasGrabbed) engagements++;
      } else if (wasGrabbed && !pulled) breaks++;
      wasGrabbed = grabbed;

      // where did the meter go this frame?
      const t = c.grabT || 0;
      const d = t - prevT;
      if (d > 0) filled += d;
      else if (d < 0) drained += -d;      // jukes are subtracted out below
      prevT = pulled ? 0 : t;

      if (pulled && pullF < 0) pullF = f;
      if (pulled) break;
    }

    if (carrierF > 0) {
      plays.push({
        pulled, pullSide, jukes,
        engagements, breaks,
        contactS: contactF * DT,
        nearS: nearF * DT,
        carrierS: carrierF * DT,
        filled, drained: Math.max(0, drained - jukeWipe), juked: jukeWipe,
        toPullS: (pulled && firstContactF >= 0) ? (pullF - firstContactF) * DT : null
      });
      if (pulled && firstContactF >= 0) {
        const t = (pullF - firstContactF) * DT;
        pulls.push(t);
        (pullSide === USER_SIDE ? userPulls : cpuPulls).push(t);
      }
    }
    if (s.phase === 'live') break;
  }
}

for (let g = 0; g < GAMES; g++) playGame(g);

/* ---- summarise ----------------------------------------------------------- */
const num = a => a.filter(x => x != null && isFinite(x));
const avg = a => (a = num(a)).length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const q = (a, p) => {
  a = num(a).slice().sort((x, y) => x - y);
  return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
};
const f1 = x => (+x).toFixed(1);
const f2 = x => (+x).toFixed(2);
const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;

const engaged = plays.filter(p => p.engagements > 0);
const pulledPlays = plays.filter(p => p.pulled);
const meterTotal = plays.reduce((a, p) => a + p.filled, 0);
const meterDrain = plays.reduce((a, p) => a + p.drained, 0);
const meterJuke = plays.reduce((a, p) => a + p.juked, 0);

const out = {
  difficulty: DIFFICULTY,
  pullTime: F.Engine.prototype.constructor ? null : null,
  plays: plays.length,
  playsWithContact: engaged.length,
  playsEndingInPull: pulledPlays.length,
  pullRateGivenContact: pct(pulledPlays.length, engaged.length),
  timeToPullMedian: +f2(q(pulls, 0.5)),
  timeToPullP90: +f2(q(pulls, 0.9)),
  timeToPullMean: +f2(avg(pulls)),
  engagementsPerPull: +f2(avg(pulledPlays.map(p => p.engagements))),
  breaksPerContactPlay: +f2(avg(engaged.map(p => p.breaks))),
  contactSecondsPerPull: +f2(avg(pulledPlays.map(p => p.contactS))),
  jukesPerContactPlay: +f2(avg(engaged.map(p => p.jukes))),
  // of every unit of meter the defence filled, how much survived?
  meterLostToDecay: pct(meterDrain, meterTotal),
  meterLostToJukes: pct(meterJuke, meterTotal),
  // in-the-play-but-out-of-reach: seconds a defender spent inside 2yd but not grabbing
  secondsWithin2yd: +f2(avg(plays.map(p => p.nearS))),
  secondsGrabbing: +f2(avg(plays.map(p => p.contactS))),
  grabbedShareOfNear: pct(plays.reduce((a, p) => a + p.contactS, 0), plays.reduce((a, p) => a + p.nearS, 0))
};

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const row = (label, value, target) =>
  `  ${label.padEnd(34)} ${String(value).padStart(8)}   ${target || ''}`;
console.log(`\nFLAGSTER flag-pull probe — ${GAMES} games, ${DIFFICULTY}, seed ${SEED}, ${plays.length} plays${USER ? ', user on ' + USER_SIDE : ', CPU vs CPU'}\n`);
console.log(row('Plays where a defender got a hand on', engaged.length, ''));
console.log(row('  ...that ended in a flag pull', out.pullRateGivenContact + '%', '~75-90%'));
console.log(row('Time to pull, median', out.timeToPullMedian + 's', '~0.6-1.0s'));
console.log(row('  p90', out.timeToPullP90 + 's', '~1.5s'));
console.log(row('  mean', out.timeToPullMean + 's', ''));
console.log(row('Engagements needed per pull', out.engagementsPerPull, '~1-2'));
console.log(row('Lost contacts per contact play', out.breaksPerContactPlay, ''));
console.log(row('Jukes per contact play', out.jukesPerContactPlay, ''));
console.log('');
console.log(row('Meter filled then lost to decay', out.meterLostToDecay + '%', ''));
console.log(row('Meter filled then wiped by juke', out.meterLostToJukes + '%', ''));
console.log('');
if (USER) {
  console.log(row('Time to pull — YOUR defence', +f2(q(userPulls, 0.5)) + 's', `median of ${userPulls.length}`));
  console.log(row('Time to pull — CPU defence', +f2(q(cpuPulls, 0.5)) + 's', `median of ${cpuPulls.length}`));
  console.log('');
}
console.log(row('Seconds/play a defender within 2yd', out.secondsWithin2yd + 's', ''));
console.log(row('  of which actually grabbing', out.grabbedShareOfNear + '%', ''));
console.log('');
