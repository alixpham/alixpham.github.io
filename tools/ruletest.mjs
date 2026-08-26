#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — RULES REGRESSION SUITE

   Drives the real engine.js against the same stubbed DOM tools/simstats.mjs
   uses, and asserts the penalty rules behave. simstats measures the shape of a
   season; this asserts the rules themselves, which averages cannot see — a
   rule that never fires and a rule that fires on the wrong player both leave
   the box score looking fine.

     node tools/ruletest.mjs [--verbose]

   Both fouls modelled here were found broken by measurement rather than by
   reading: the illegal rush fired on 3.9% of plays and every single one was a
   linebacker in coverage, and flag guarding had been shipped in v2.17.0 with
   no call sites at all. Hence this file.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.TREE ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');
const DT = 1 / 60;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- the DOM the engine needs (see simstats.mjs for why this is enough) --- */
const timers = [];
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
  clearTimeout() {}, performance: { now: () => 0 }
};
win.window = win; win.globalThis = win;
function load(rel) {
  new Function('window', 'globalThis', 'document', 'self', 'setTimeout', 'clearTimeout',
    fs.readFileSync(path.join(ROOT, rel), 'utf8'))(
    win, win, undefined, win, win.setTimeout, win.clearTimeout);
}
load('flagster/js/data.js');
load('flagster/js/engine.js');
const F = win.FLAGSTER, D = F.data;

const drain = () => { let n = 0; while (timers.length && n++ < 64) { try { timers.shift()(); } catch (e) {} } };

/* A game parked at a live snap, with the events it emitted. */
function kickoff(defCall = 'man', tweak, seed = 3) {
  Math.random = mulberry32(seed);
  timers.length = 0;
  const ev = [];
  const e = new F.Engine(canvas, { onEvent: x => ev.push(x) });
  const h = D.NATIONS[0], a = D.NATIONS[4];
  e.newGame({
    home: h, away: a,
    homeJersey: D.jerseysFor(h.id)[0], awayJersey: D.jerseysFor(a.id)[1],
    userSide: 'home', demo: true, difficulty: 'pro'
  });
  while (e.state.phase !== 'playcall') drain();
  e.autoCall();
  e.state.defPlay = D.DEF_PLAYS.find(p => p.id === defCall);
  const med = D.PLAYS.find(p => p.type === 'pass-med');
  if (med) e.state.offPlay = med;
  if (tweak) tweak(e.state);
  e.setupFormation();
  return { e, ev, s: e.state };
}

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

/* Drive `p` straight at the passer at 8yd/s, by hand. */
function charge(e, p) {
  const q = e.state.passer;
  const dx = q.x - p.x, dy = q.y - p.y, m = Math.hypot(dx, dy) || 1;
  p.vx = dx / m * 8; p.vy = dy / m * 8;
  p.x += p.vx * DT; p.y += p.vy * DT;
}

/* ========================== A2 — ILLEGAL RUSH ============================= */

{ // eligibility is stamped from the alignment, not from the play call
  const { e, s } = kickoff('man');
  const cb = s.players.find(p => p.slot === 'CB');
  cb.x = s.losX + 3;                                  // three yards off: too close
  e.snap();
  check('a defender inside the rush line is ineligible', cb.rushLegal === false,
    'rushLegal=' + cb.rushLegal);
}

{ // ...and the man ON the line is eligible even when the call did not send him
  const { e, ev, s } = kickoff('man');                // 'man' has blitz:0
  const r = s.players.find(p => p.slot === 'RUSH');
  e.snap();
  check('the rusher on the line is eligible uncalled', r.rushLegal === true,
    'rushLegal=' + r.rushLegal + ' blitz=' + r.blitz + ' offLOS=' + (r.x - s.losX).toFixed(2));
  for (let f = 0; f < 90 && s.phase === 'live'; f++) { charge(e, r); e._update(DT); }
  check('no flag on an eligible rusher', !ev.some(x => x.type === 'flag'), '');
}

{ // a call cannot put an ineligible rusher on the field
  const { e, s } = kickoff('blitz');
  const mlb = s.players.find(p => p.slot === 'MLB');
  const off = +(mlb.x - s.losX).toFixed(2);
  e.snap();
  check('a called blitzer is aligned at the rush line', off >= 7 && mlb.rushLegal === true,
    'offLOS=' + off + ' rushLegal=' + mlb.rushLegal);
}

{ // THE PHANTOM: coverage following a man into the backfield is not a rush
  const { e, ev, s } = kickoff('man');
  const mlb = s.players.find(p => p.slot === 'MLB');
  const rb = s.players.find(p => p.slot === 'RB');
  e.snap();
  mlb.cover = rb;
  for (let f = 0; f < 90 && s.phase === 'live'; f++) {
    rb.x = s.losX - 4; rb.y = 6;                      // a swing route, behind the line
    const dx = rb.x + 0.6 - mlb.x, dy = rb.y - mlb.y, m = Math.hypot(dx, dy) || 1;
    mlb.vx = dx / m * 7; mlb.vy = dy / m * 7;
    mlb.x += mlb.vx * DT; mlb.y += mlb.vy * DT;
    e._update(DT);
  }
  check('covering a back in the backfield is not a rush',
    !ev.some(x => x.type === 'flag') && mlb.x < s.losX - 0.5,
    (s.losX - mlb.x).toFixed(1) + 'yd past the line, 0 flags');
}

{ // the real thing: flag thrown, play continues, 5 yards and an automatic first
  const { e, ev, s } = kickoff('man');
  const cb = s.players.find(p => p.slot === 'CB');
  cb.x = s.losX + 3;
  s.down = 3;                                         // so a first down is visible
  e.snap();
  const los = s.losX, ytg = s.yardsToGoal;
  let after = 0, at = -1;
  for (let f = 0; f < 120 && s.phase === 'live'; f++) {
    if (!s.flag) { cb.cover = null; charge(e, cb); }
    e._update(DT);
    if (s.flag) { if (at < 0) at = f; after++; }
  }
  check('a real illegal rush draws a flag', ev.some(x => x.type === 'flag' && x.kind === 'illegal-rush'), '');
  check('the flag does not blow the whistle', after > 5 && s.phase === 'live',
    'flag at frame ' + at + ', still live ' + after + ' frames later');
  if (s.phase === 'live') e._endPlay(los + 2, false);  // a 2-yard gain: worse than the marker
  drain(); drain();
  const pen = ev.find(x => x.type === 'penalty');
  check('the penalty resolves after the play', !!pen && pen.accepted === true,
    pen ? 'accepted=' + pen.accepted : 'no penalty event');
  check('illegal rush is 5 yards from the previous spot', Math.abs((ytg - s.yardsToGoal) - 5) < 0.01,
    'moved ' + (ytg - s.yardsToGoal).toFixed(2) + 'yd');
  check('illegal rush is an automatic first down', s.down === 1, 'down=' + s.down + ' (was 3)');
}

{ // a play that already beat the marker declines it
  const { e, ev, s } = kickoff('man', st => { st.crossedMid = false; st.yardsToGoal = 30; st.down = 2; });
  const cb = s.players.find(p => p.slot === 'CB');
  cb.x = s.losX + 3;
  e.snap();
  const los = s.losX;
  for (let f = 0; f < 600 && s.phase === 'live' && !s.flag; f++) { cb.cover = null; charge(e, cb); e._update(DT); }
  const got = !!s.flag;
  if (s.phase === 'live') e._endPlay(los + 14, false); // 14 yards, past midfield
  drain(); drain();
  const pen = ev.find(x => x.type === 'penalty');
  check('a play that beat the marker declines it',
    got && !!pen && pen.accepted === false && s.down === 1,
    'accepted=' + (pen ? pen.accepted : 'none') + ' down=' + s.down + ' crossedMid=' + s.crossedMid);
}

/* ========================== A7 — FLAG GUARDING ============================ */

/* Put `d` in a grip on the carrier and hand back a juke-er. */
function gripped(e) {
  const s = e.state;
  const c = s.carrier;
  const d = s.players.find(p => p.team !== c.team && !p.flagPulled);
  d.x = c.x + 0.3; d.y = c.y;
  s.grabbedBy = d; d.grabbing = true; c.grabT = 0.2;
  return d;
}

{ // one break of a grip is a cut, and cuts are legal
  const { e, ev, s } = kickoff('man');
  e.snap();
  const d = gripped(e);
  e.juke();
  check('breaking a grip once is legal', !ev.some(x => x.type === 'flag'),
    'flags=' + ev.filter(x => x.type === 'flag').length);

  // ...the second break of the SAME man's grip is a swat
  s.grabbedBy = d; d.grabbing = true; s.carrier.jukeCd = 0;
  e.juke();
  check('breaking the same grip twice is flag guarding',
    ev.some(x => x.type === 'flag' && x.kind === 'flag-guard'),
    JSON.stringify(ev.filter(x => x.type === 'flag').map(x => x.kind)));
}

{ // breaking two DIFFERENT defenders is not guarding
  const { e, ev, s } = kickoff('man');
  e.snap();
  const c = s.carrier;
  const ds = s.players.filter(p => p.team !== c.team && !p.flagPulled).slice(0, 2);
  for (const d of ds) {
    d.x = c.x + 0.3; d.y = c.y;
    s.grabbedBy = d; d.grabbing = true; c.grabT = 0.2; c.jukeCd = 0;
    e.juke();
  }
  check('breaking two different grips is not guarding', !ev.some(x => x.type === 'flag'),
    'flags=' + ev.filter(x => x.type === 'flag').length);
}

{ // enforcement: 10 yards from the SPOT OF THE FOUL, and a loss of down
  const { e, ev, s } = kickoff('man', st => { st.down = 2; });
  e.snap();
  const c = s.carrier;
  c.x = s.losX + 12;                                  // guard it twelve yards downfield
  const foulSpot = c.x;
  const d = gripped(e);
  e.juke();
  s.grabbedBy = d; d.grabbing = true; c.jukeCd = 0;
  e.juke();
  check('the flag guard does not blow the whistle', s.phase === 'live', 'phase=' + s.phase);
  if (s.phase === 'live') e._endPlay(foulSpot + 3, false);
  drain(); drain();
  const pen = ev.find(x => x.type === 'penalty' && x.kind === 'flag-guard');
  const spot = 60 - s.yardsToGoal;
  check('flag guarding is 10 yards from the spot of the foul',
    !!pen && pen.accepted === true && Math.abs(spot - (foulSpot - 10)) < 0.05,
    'ball on ' + spot.toFixed(1) + ', foul at ' + foulSpot.toFixed(1) + ', want ' + (foulSpot - 10).toFixed(1));
  check('flag guarding is a loss of down', s.down === 3, 'down=' + s.down + ' (was 2)');
}

{ // you cannot guard your way into the end zone
  const { e, ev, s } = kickoff('man');
  e.snap();
  s.handoffDone = true;        // a runner, not the passer: A3 is a different rule
  const c = s.carrier;
  c.x = 50;
  const d = gripped(e);
  e.juke();
  s.grabbedBy = d; d.grabbing = true; c.jukeCd = 0;
  e.juke();                                            // the foul
  const before = s.score.home + s.score.away;
  for (let f = 0; f < 240 && s.phase === 'live'; f++) {
    c.x = Math.min(c.x + 20 * DT, 61); c.vx = 20; c.vy = 0;
    e._update(DT);
  }
  drain(); drain();
  const scored = (s.score.home + s.score.away) - before;
  const pen = ev.find(x => x.type === 'penalty' && x.kind === 'flag-guard');
  check('a guarded touchdown does not count',
    scored === 0 && !!pen && pen.accepted === true && !ev.some(x => x.type === 'touchdown'),
    'points=' + scored + ' accepted=' + (pen ? pen.accepted : 'none'));
}

{ /* Difficulty is a statement about the CPU, not about the mechanic. pullTime
     and jukeCd used to be read straight off the preset for BOTH sides, so on
     Rookie your own defenders needed the same slow 1.05 the CPU's did — the
     setting that makes the game easy while you carry the ball made it hard the
     moment you didn't, and your defence measured 2.65s to a pull against the
     CPU's 1.37s. */
  const e = new F.Engine(canvas, { onEvent() {} });
  const h = D.NATIONS[0], a = D.NATIONS[4];
  e.newGame({
    home: h, away: a,
    homeJersey: D.jerseysFor(h.id)[0], awayJersey: D.jerseysFor(a.id)[1],
    userSide: 'home', demo: false, difficulty: 'rookie'
  });
  const mine = e.knob('pullTime', 'home'), theirs = e.knob('pullTime', 'away');
  check('Rookie pulls faster for you than for the CPU', mine < theirs,
    'yours=' + mine + ' cpu=' + theirs);
  check('Rookie gives the CPU carrier the long juke cooldown',
    e.knob('jukeCd', 'away') < e.knob('jukeCd', 'home'),
    'cpu=' + e.knob('jukeCd', 'away') + ' yours=' + e.knob('jukeCd', 'home'));

  e.difficulty = { key: 'allpro', name: 'All-Pro', defSpeed: 1, pullTime: 0.5, catchBonus: 0, intScale: 1, jukeCd: 2.0 };
  check('All-Pro pulls faster for the CPU than for you',
    e.knob('pullTime', 'away') < e.knob('pullTime', 'home'),
    'cpu=' + e.knob('pullTime', 'away') + ' yours=' + e.knob('pullTime', 'home'));

  e.demo = true;
  check('a demo game reads one column for both sides',
    e.knob('pullTime', 'home') === e.knob('pullTime', 'away'),
    'home=' + e.knob('pullTime', 'home') + ' away=' + e.knob('pullTime', 'away'));
}

{ /* A juke ends the engagement; it does not rewind it. The first juke of a play
     used to zero the meter outright, and since a carrier in trouble always has
     one available every engagement got erased once for free — 41% of everything
     the defence ever filled. */
  const { e, s } = kickoff('man');
  e.snap();
  const d = gripped(e);
  s.carrier.grabT = 0.5;
  e.juke();
  check('a juke knocks the meter back rather than to zero',
    s.carrier.grabT > 0.05 && s.carrier.grabT < 0.5,
    'grabT=' + s.carrier.grabT.toFixed(3) + ' (was 0.5)');
  check('a juke still ends the engagement', s.grabbedBy === null && d.stun > 0,
    'grabbedBy=' + s.grabbedBy + ' stun=' + d.stun.toFixed(2));
}

{ /* Losing contact drains the meter, it does not reset it: a defender who loses
     his grip for a moment and regains it is closer to the flag than one
     starting fresh. */
  const { e, s } = kickoff('man');
  e.snap();
  const c = s.carrier;
  const d = s.players.find(p => p.team !== c.team && !p.flagPulled);
  d.x = c.x + 40; d.y = c.y + 40;            // nobody anywhere near
  s.players.forEach(p => { if (p.team !== c.team) { p.x = c.x + 40; p.y = c.y + 40; } });
  const need = e.knob('pullTime', d.team);
  c.grabT = need;                             // a full meter, one frame from the pull
  e._dt = 1 / 60;
  const def = s.players.filter(p => p.team !== c.team);
  for (let f = 0; f < 18; f++) e._checkFlagPull(def);   // 0.3s of daylight
  /* At the old flat 2.2/s a full meter was gone in under half a second, so
     0.3s of separation left 8% of it. Proportional to the difficulty now. */
  check('0.3s of separation does not erase a full meter',
    c.grabT > need * 0.5, 'retained ' + (100 * c.grabT / need).toFixed(0) + '%, want >50%');
}

{ /* A9 — ONE FORWARD PASS PER DOWN. No state anywhere recorded that a forward
     pass had happened, so nothing could prevent a second. The only guard was
     positional (you cannot throw from past the line), which happens to cover a
     receiver who catches it DOWNFIELD and hid the hole completely — catch it
     behind the line, as a screen or checkdown routinely does, and the receiver
     could throw forward again for a second completion and no penalty. */
  let found = null;
  for (let seed = 1; seed <= 40 && !found; seed++) {
    const { e, s } = kickoff('zone', null, seed);
    e.snap();
    const qb = s.carrier;
    e.throwTo('WR1');
    let caught = null;
    for (let f = 0; f < 500; f++) {
      e._update(DT);
      if (s.carrier && s.carrier !== qb) { caught = s.carrier; break; }
      if (s.phase !== 'live') break;
    }
    if (!caught || caught.team !== qb.team) continue;    // incompletion or a pick
    found = { e, s, caught };
  }
  if (!found) {
    check('A9 setup found a completed pass to throw from', false, 'no seed completed one');
  } else {
    const { e, s, caught } = found;
    caught.x = s.losX - 3;                               // a screen: caught BEHIND the line
    s.pendingThrow = null; s.ball.inAir = false;
    e.throwTo('WR2');
    check('a second forward pass is not allowed', !s.pendingThrow,
      'pendingThrow=' + !!s.pendingThrow + ' msg=' + JSON.stringify(s.message));

    // ...but a LATERAL after a forward pass is legal, and always has been.
    const mate = s.players.find(p => p.team === caught.team && p !== caught && !p.flagPulled);
    mate.x = caught.x - 4; mate.y = caught.y;
    s.pendingThrow = null; s.ball.inAir = false;
    check('a lateral after a forward pass is still legal', e.pitch() === true,
      'msg=' + JSON.stringify(s.message));
  }
}

{ /* The passer has to be behind the line, and the message has to say which of
     the two things is past it. "No forward pass past the line!" reads as though
     the PASS may not travel past the line — the opposite of the rule. */
  const { e, s } = kickoff('man');
  e.snap();
  const qb = s.carrier;
  qb.x = s.losX + 5;                                     // passer downfield
  s.autoHandoff = false;
  e.throwTo('WR1');
  check('a forward pass from past the line is refused', !s.pendingThrow,
    'pendingThrow=' + !!s.pendingThrow);
  check('...and the message names the PASSER, not the pass',
    /passer/i.test(s.message || '') && !/^No forward pass past the line/.test(s.message || ''),
    'msg=' + JSON.stringify(s.message));
}

{ /* A handoff is not a pass, so the trick plays keep their one legal throw:
     RB Option Pass hands off and the RB then throws forward. A9 must not eat
     it — _doHandoff transfers possession directly and never reaches
     _releaseThrow, which is what keeps passThrown false. */
  const { e, s } = kickoff('man', st => {
    st.offPlay = D.PLAYS.find(p => p.trick === 'rbpass');
  });
  e.snap();
  for (let f = 0; f < 120 && !s.handoffDone; f++) e._update(DT);
  check('a handoff does not count as the down\'s forward pass',
    s.handoffDone === true && s.passThrown === false,
    'handoffDone=' + s.handoffDone + ' passThrown=' + s.passThrown);
  const rb = s.carrier;
  if (rb) rb.x = s.losX - 2;                             // behind the line, as the play intends
  s.pendingThrow = null;
  e.throwTo('WR1');
  check('the RB Option Pass can still throw its one forward pass', !!s.pendingThrow,
    'carrier=' + (rb && rb.slot) + ' msg=' + JSON.stringify(s.message));
}

{ /* A10 — TAKING OVER PAST MIDFIELD IS A FRESH SET TO SCORE.

     Both turnover paths set crossedMid = false unconditionally, so a team
     handed the ball in the opponent's half chased a line to gain that was
     BEHIND it. _advanceDown tests `spotX >= MIDFIELD`, which they already
     satisfy, so the next snap awarded a first down however it went. */
  const MID_YTG = F.Engine.FIELD.GOAL_R - F.Engine.FIELD.MID;   // 25

  // (i) turnover on downs from deep in your own half
  {
    const { e, s } = kickoff('man');
    s.yardsToGoal = 42; s.crossedMid = false; s.down = 4;       // own 8
    e._turnoverOnDowns(); drain(); drain(); drain();
    check('taking over past midfield sets the chains to the goal line',
      s.yardsToGoal < MID_YTG && s.crossedMid === true,
      'ytg=' + s.yardsToGoal + ' crossedMid=' + s.crossedMid);

    // and the very next play must NOT hand out a first down for nothing
    const spotX = F.Engine.FIELD.GOAL_R - s.yardsToGoal;
    e._endPlay(spotX - 1, false); drain(); drain(); drain();
    check('a one-yard loss past midfield is not a first down',
      s.down === 2, 'down=' + s.down + ' msg=' + JSON.stringify(s.message));
  }

  // (ii) the interception path takes the same route
  {
    const { e, s } = kickoff('man');
    s.yardsToGoal = 42; s.crossedMid = false;
    e._turnover(null, 'interception'); drain(); drain(); drain();
    check('an interception past midfield sets the chains too',
      s.yardsToGoal < MID_YTG && s.crossedMid === true,
      'ytg=' + s.yardsToGoal + ' crossedMid=' + s.crossedMid);
  }

  // (iii) the ordinary case is untouched: take over in your OWN half and the
  //       line to gain is still midfield, with four downs to reach it.
  {
    const { e, s } = kickoff('man');
    s.yardsToGoal = 12; s.crossedMid = true; s.down = 3;        // opponent 12
    e._turnoverOnDowns(); drain(); drain(); drain();
    check('taking over in your own half still has to reach midfield',
      s.yardsToGoal > MID_YTG && s.crossedMid === false,
      'ytg=' + s.yardsToGoal + ' crossedMid=' + s.crossedMid);
  }

  // (iv) exactly ON midfield counts as crossed, matching _endPlay's
  //      `spotX >= MIDFIELD`.
  {
    const { e, s } = kickoff('man');
    s.yardsToGoal = MID_YTG; s.crossedMid = false; s.down = 4;
    e._turnoverOnDowns(); drain(); drain(); drain();
    check('taking over exactly on midfield counts as crossed',
      s.yardsToGoal === MID_YTG && s.crossedMid === true,
      'ytg=' + s.yardsToGoal + ' crossedMid=' + s.crossedMid);
  }
}

/* ------------------------------- report ---------------------------------- */
let bad = 0;
for (const r of results) {
  if (!r.pass) bad++;
  if (!r.pass || VERBOSE) {
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : ''));
  }
}
console.log(bad ? `\n${bad} of ${results.length} FAILED` : `\nall ${results.length} rule assertions pass`);
process.exit(bad ? 1 : 0);
