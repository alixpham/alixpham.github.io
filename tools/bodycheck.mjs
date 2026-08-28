#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — IS THIS BODY POSSIBLE?

     node tools/bodycheck.mjs [--secs 170] [--character ochi]

   Two complaints, one run, because both are properties of the SKINNED POSE and
   the only way to see a skinned pose is to draw it.

   THE FEET.  *"Players should never move like skaters... they always must have
   one or two feet planted, and the feet never slide."*  A foot that is on the
   ground and whose world position is moving is sliding, and that is the whole
   definition — it is not the facing, not the blend weight, not the playback
   rate, it is those and the lean and the stride resolved together. `skew` in
   `debugPlayers` is a proxy for this and has been reported for a while; this
   measures the thing itself. Three numbers:

     * SLIP    — how fast a planted foot travels across the ground, in yd/s.
                 Zero is a foot that is planted. Anything approaching the
                 player's own travel speed is a skater.
     * SLIP %  — the same as a fraction of how fast the player is moving, which
                 is the honest scale: 0.2yd/s under a walk is a different thing
                 from 0.2yd/s under a sprint.
     * FLOAT   — the share of moving frames with NEITHER foot down. A run has a
                 real flight phase and a walk has none, so this is never zero;
                 what it must not be is most of the time.

   THE ARMS.  *"Their arms cannot rotate 360 degrees: they are humans and have
   limitations."*  Measured at the joint, from world positions, so it does not
   depend on how any one bone's euler triple was authored:

     * ELBOW   — flexion, the angle at the elbow between the shoulder and the
                 wrist. 0 is a straight arm. A human reaches about 145 and
                 hyperextends about 10 the other way; past that the forearm has
                 folded through the upper arm.
     * SHOULDER— elevation of the upper arm away from hanging straight down,
                 measured in the CHEST's frame so a leaning body does not read
                 as a raised arm. Straight overhead is 180; a human shoulder
                 gets there, but only forward and to the side.
     * SPIN    — how fast the upper arm sweeps, deg/s. An arm that rotates
                 through 360 shows up here long before any static limit does,
                 because to go round it has to go fast.

   PLANTED IS PER FOOT AND PER PLAYER. There is no absolute ground height to
   test against: build scale, PLAYER_LIFT and the clip mix all move a sole by
   centimetres, and a dive puts one 30cm down. So each foot's own ground is the
   tenth percentile of its own height over the run — the same lesson
   footcheck.mjs learned — and a frame counts as stance when the foot is within
   PLANT_BAND of it.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECS = Number(arg('secs', 170));
const CHAR = arg('character', '');
const AS_JSON = process.argv.includes('--json');
/* Swiftshader is fill-rate bound and the whole simulation runs at whatever
   rate it draws at, so a small window is not a smaller sample of the game —
   it is MORE frames of it. Nothing here reads a pixel. */
const VW = Number(arg('width', 360)), VH = Number(arg('height', 240));
/* SEED THE GAME, OR THIS MEASURES NOTHING.

   Three runs of one unchanged build returned a median support slip of 31%,
   42% and 57% of travel speed. That is not a noisy statistic, it is a
   different football match each time — different plays called, different men
   running different routes at different speeds. Anything smaller than a
   factor of two is invisible to it.

   The renderer cannot change what the simulation does, so seeding `Math.random`
   before the demo starts makes a before/after pair play the SAME game and the
   comparison becomes paired rather than two samples of a wide distribution. */
const SEED = Number(arg('seed', 1));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png', '.css': 'text/css' };

/* One world unit is one yard. A sole within this of its own ground is bearing
   weight; much tighter and a foot rolling heel-to-toe drops out of stance for
   the middle of it, much looser and the swing foot's low point counts. */
const PLANT_BAND = 0.05;
/* Below this the renderer plays Idle and there is no stride to disagree with. */
const MOVING = 1.0;

const server = http.createServer((q, r) => {
  let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, b) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(b);
  });
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
const chrome = process.env.FLAGSTER_CHROME || fs.globSync('/opt/pw-browsers/chromium*/chrome-linux/chrome').sort().pop();
const browser = await chromium.launch({ executablePath: chrome, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: VW, height: VH } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.addInitScript((seed) => {
  let a = seed >>> 0 || 1;
  Math.random = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}, SEED);
await page.goto(base + (CHAR ? '?character=' + CHAR : ''), { waitUntil: 'load' });
await page.waitForSelector('.menu-tiles', { timeout: 60000 });
await page.getByRole('button', { name: /Watch Demo/i }).click();
await page.waitForTimeout(5000);

/* Accumulate INSIDE the frame. Swiftshader draws about twice a second, so
   anything that polls from Node sees a handful of frames and draws a
   conclusion from the half of the stride it happened to catch. */
await page.evaluate(() => {
  const F = window.FLAGSTER, sh = F.activeShell, f3 = sh && sh.field3d;
  if (!f3 || !f3.debugLimbs) { window.__err = 'no field3d.debugLimbs'; return; }
  window.__rows = []; window.__frames = 0;
  /* `render` takes the game STATE, not a delta — the delta it uses is the
     engine's own, clamped at 50ms, which is what the poses were advanced by.
     Reading it back rather than timing the wrapper is the difference between
     differencing positions over the interval they actually moved in and
     differencing them over however long swiftshader took. */
  const orig = f3.render.bind(f3);
  f3.render = function (state) {
    const r = orig(state);
    try {
      const eng = sh.engine || (window.FLAGSTER.activeShell && window.FLAGSTER.activeShell.engine);
      let dt = (eng && eng._dt) || 0;
      if (dt > 0.05) dt = 0.05;
      if (state && dt > 0) {
        for (const p of f3.debugLimbs()) window.__rows.push({ dt, ...p });
        window.__frames++;
      }
    } catch (e) { window.__err = String(e); }
    return r;
  };
});
await page.waitForTimeout(SECS * 1000);
const out = await page.evaluate(() => ({
  frames: window.__frames, err: window.__err || null, rows: window.__rows,
  character: (window.FLAGSTER.PlayerModel.character && window.FLAGSTER.PlayerModel.character()) || '?'
}));
await browser.close(); server.close();
if (out.err) { console.error('\n  ' + out.err + '\n'); process.exit(1); }

/* ---------------------------------------------------------------- analysis */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const ang = (a, b) => {
  const m = len(a) * len(b);
  return m ? Math.acos(Math.max(-1, Math.min(1, dot(a, b) / m))) * 180 / Math.PI : 0;
};
const pctile = (a, p) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

// Group by player index; frames arrive in render order so each player's rows
// are already a time series.
const byPlayer = new Map();
for (const r of out.rows) {
  if (!byPlayer.has(r.i)) byPlayer.set(r.i, []);
  byPlayer.get(r.i).push(r);
}

/* SUPPORT SLIP is the number the complaint is about. Not "how fast is a
   planted foot moving" — a foot at touchdown and a foot at toe-off are both
   legitimately in the plant band and legitimately moving, and at a 50ms step
   they are a real share of every contact. What must be true is that on each
   frame there is AT LEAST ONE foot bearing weight that is not sliding, which
   is the minimum across whatever is down. */
const support = [], supportRel = [], supportJuke = [], supportRun = [];
const standing = [];          // the control: a player who is not moving at all
const skewOf = [], rateOf = [];
let movingFrames = 0, floatFrames = 0, twoFeet = 0;
const elbow = { L: [], R: [] }, shoulder = { L: [], R: [] }, spin = { L: [], R: [] };
let elbowBad = 0, elbowHyper = 0, shoulderBad = 0, spinBad = 0, armSamples = 0;
let spinWorst = null;

for (const [, series] of byPlayer) {
  // Each foot's own ground: the tenth percentile of its own height.
  const ground = {};
  for (const b of ['Foot_L', 'Toe_L', 'Foot_R', 'Toe_R']) {
    const ys = series.filter(r => r.j[b]).map(r => r.j[b][1]);
    if (ys.length) ground[b] = pctile(ys, 0.10);
  }
  for (let k = 1; k < series.length; k++) {
    const a = series[k - 1], c = series[k], dt = c.dt;
    if (!(dt > 0) || !c.j.Foot_L || !a.j.Foot_L) continue;
    /* NOT ACROSS A REBUILD. Every formation change disposes all ten bodies and
       builds ten new ones at new spots, and the index is reused — so this pair
       of frames would be one man's limb against a different man's limb, which
       differences out as a 3,200-degree-per-second whip on a player who is
       standing still. It was the single worst arm reading in the file and it
       was not a game bug at all. */
    if (a.gen !== c.gen) continue;
    /* HOW FAST THE PLAYER REALLY WENT, taken from the holder he is drawn on
       rather than from the engine's velocity. `gp.vx` is intent; the renderer
       itself animates from `rvx/rvy`, the actual displacement, because a
       player moved by anything other than his own steering still has to stride
       into it. Differencing the holder is that same quantity with nothing left
       to disagree with — it is the ground moving under the feet, which is
       exactly what the feet are being graded against. */
    const speed = Math.hypot(c.hx - a.hx, c.hz - a.hz) / dt;

    /* ---- feet ---- */
    // The slip of each foot that is down on BOTH frames, so the displacement
    // measured is one the foot made while in contact.
    const down = [];
    for (const side of ['L', 'R']) {
      let best = Infinity;
      for (const b of ['Foot_' + side, 'Toe_' + side]) {
        if (!c.j[b] || !a.j[b] || ground[b] == null) continue;
        if (c.j[b][1] <= ground[b] + PLANT_BAND && a.j[b][1] <= ground[b] + PLANT_BAND) {
          const d = Math.hypot(c.j[b][0] - a.j[b][0], c.j[b][2] - a.j[b][2]) / dt;
          if (d < best) best = d;
        }
      }
      if (best < Infinity) down.push(best);
    }
    const sup = down.length ? Math.min(...down) : null;

    // The control. A player standing still has no stride to disagree with, so
    // his support foot must be pinned; if it is not, the probe is wrong and
    // nothing below it means anything.
    if (speed < 0.15 && !c.oneShot && sup != null) standing.push(sup);

    if (speed >= MOVING && !c.oneShot && !c.pulled) {
      movingFrames++;
      if (down.length === 0) floatFrames++;
      if (down.length === 2) twoFeet++;
      if (sup != null) {
        support.push(sup);
        supportRel.push(sup / speed);
        (c.juke ? supportJuke : supportRun).push(sup / speed);
        // How far the facing sits off the line of travel, and what rate the
        // gait is being played at — the two things that make a stride and the
        // ground disagree.
        let sk = Math.atan2(c.vy, c.vx) - (c.yaw || 0);
        while (sk > Math.PI) sk -= Math.PI * 2;
        while (sk < -Math.PI) sk += Math.PI * 2;
        if (Math.abs(sk) > Math.PI / 2) sk = (sk > 0 ? Math.PI : -Math.PI) - sk;
        skewOf.push(Math.abs(sk) * 180 / Math.PI);
        if (c.rate) rateOf.push(c.rate);
      }
    }

    /* ---- arms ---- */
    for (const side of ['L', 'R']) {
      const sh = c.j['Shoulder_' + side], up = c.j['UpperArm_' + side];
      const lo = c.j['LowerArm_' + side], hd = c.j['Hand_' + side];
      const upA = a.j['UpperArm_' + side], loA = a.j['LowerArm_' + side];
      if (!sh || !up || !lo || !hd || !upA || !loA) continue;
      armSamples++;
      // Elbow flexion: 0 is a straight arm, 145 is the hand at the shoulder.
      const flex = 180 - ang(sub(up, lo), sub(hd, lo));
      elbow[side].push(flex);
      if (flex > 155) elbowBad++;
      if (flex < -12) elbowHyper++;
      // Shoulder elevation, in the chest's frame so a lean is not an arm raise.
      if (c.j.Chest && c.j.Hips) {
        const upAxis = sub(c.j.Chest, c.j.Hips);          // the trunk, root to chest
        const arm = sub(lo, up);                          // the upper arm, shoulder to elbow
        const elev = 180 - ang(upAxis, arm);              // 0 = hanging down the trunk
        shoulder[side].push(elev);
        if (elev > 190) shoulderBad++;
      }
      // How fast the upper arm sweeps. To go round, it has to go fast.
      const sweep = ang(sub(loA, upA), sub(lo, up)) / dt;
      spin[side].push(sweep);
      if (sweep > 1400) {
        spinBad++;
        if (!spinWorst || sweep > spinWorst.sweep) {
          spinWorst = { sweep, side, slot: c.slot, oneShot: c.oneShot,
                        pulled: c.pulled, juke: c.juke, speed: Math.hypot(c.vx, c.vy) };
        }
      }
    }
  }
}

const report = {
  frames: out.frames, character: out.character,
  slipMedian: pctile(support, 0.5), slipP90: pctile(support, 0.90),
  slipRelMedian: pctile(supportRel, 0.5), slipRelP90: pctile(supportRel, 0.90),
  slipRelRun: pctile(supportRun, 0.5), slipRelJuke: pctile(supportJuke, 0.5),
  jukeSamples: supportJuke.length,
  standingSlip: pctile(standing, 0.5), standingP90: pctile(standing, 0.90),
  standingSamples: standing.length,
  skewMedian: pctile(skewOf, 0.5), skewP90: pctile(skewOf, 0.90),
  rateMedian: pctile(rateOf, 0.5), rateP90: pctile(rateOf, 0.90),
  spinWorst,
  movingFrames, floatPct: 100 * floatFrames / (movingFrames || 1),
  twoFeetPct: 100 * twoFeet / (movingFrames || 1),
  elbowMedian: pctile([...elbow.L, ...elbow.R], 0.5),
  elbowP99: pctile([...elbow.L, ...elbow.R], 0.99),
  elbowMin: Math.min(...elbow.L, ...elbow.R),
  elbowMax: Math.max(...elbow.L, ...elbow.R),
  elbowBadPct: 100 * elbowBad / (armSamples || 1),
  elbowHyperPct: 100 * elbowHyper / (armSamples || 1),
  shoulderP99: pctile([...shoulder.L, ...shoulder.R], 0.99),
  shoulderMax: Math.max(...shoulder.L, ...shoulder.R),
  shoulderBadPct: 100 * shoulderBad / (armSamples || 1),
  spinMedian: pctile([...spin.L, ...spin.R], 0.5),
  spinP99: pctile([...spin.L, ...spin.R], 0.99),
  spinMax: Math.max(...spin.L, ...spin.R),
  spinBadPct: 100 * spinBad / (armSamples || 1),
  pageErrors: errs.length
};

if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const row = (l, v, note) => `  ${l.padEnd(34)} ${String(v).padStart(9)}   ${note || ''}`;
console.log(`\nFLAGSTER body check — ${report.character}, seed ${SEED}, ${report.frames} rendered frames (${(report.frames / SECS).toFixed(1)}/s), ${report.movingFrames} moving player-frames\n`);
console.log('  THE FEET');
console.log(row('CONTROL: standing, support slip', n(report.standingSlip, 3) + 'yd/s', `must be ~0 — ${report.standingSamples} samples`));
console.log(row('Support-foot slip, median', n(report.slipMedian) + 'yd/s', 'a planted foot is 0'));
console.log(row('  ...90th percentile', n(report.slipP90) + 'yd/s', ''));
console.log(row('Slip as a share of travel, median', n(100 * report.slipRelMedian, 1) + '%', 'lower is better'));
console.log(row('  ...90th percentile', n(100 * report.slipRelP90, 1) + '%', ''));
console.log(row('  ...running', n(100 * report.slipRelRun, 1) + '%', ''));
console.log(row('  ...while juking', n(100 * report.slipRelJuke, 1) + '%', `${report.jukeSamples} samples`));
console.log(row('Moving with NEITHER foot down', n(report.floatPct, 1) + '%', 'flight phase; not most of the time'));
console.log(row('Moving with BOTH feet down', n(report.twoFeetPct, 1) + '%', ''));
console.log(row('Facing off line of travel, median', n(report.skewMedian, 1) + 'deg', '0 = hips into the run'));
console.log(row('  ...90th percentile', n(report.skewP90, 1) + 'deg', ''));
console.log(row('Gait playback rate, median', n(report.rateMedian, 3), '1.0 = stride matches the speed'));
console.log(row('  ...90th percentile', n(report.rateP90, 3), ''));
console.log('\n  THE ARMS');
console.log(row('Elbow flexion, median', n(report.elbowMedian, 1) + 'deg', '0 = straight'));
console.log(row('  ...99th percentile', n(report.elbowP99, 1) + 'deg', 'a human folds to ~145'));
console.log(row('  ...range seen', n(report.elbowMin, 1) + ' .. ' + n(report.elbowMax, 1), ''));
console.log(row('Elbow folded past 155deg', n(report.elbowBadPct, 2) + '%', 'must be 0'));
console.log(row('Elbow hyperextended past -12deg', n(report.elbowHyperPct, 2) + '%', 'must be 0'));
console.log(row('Shoulder elevation, 99th pct', n(report.shoulderP99, 1) + 'deg', '180 = straight overhead'));
console.log(row('  ...max seen', n(report.shoulderMax, 1) + 'deg', ''));
console.log(row('Shoulder past 190deg', n(report.shoulderBadPct, 2) + '%', 'must be 0'));
console.log(row('Upper-arm sweep, median', n(report.spinMedian, 0) + 'deg/s', ''));
console.log(row('  ...99th percentile', n(report.spinP99, 0) + 'deg/s', 'a thrown arm peaks ~1500'));
console.log(row('  ...max seen', n(report.spinMax, 0) + 'deg/s', ''));
console.log(row('Sweeping past 1400deg/s', n(report.spinBadPct, 2) + '%', 'must be ~0'));
if (report.spinWorst) {
  const w = report.spinWorst;
  console.log(`  ${'  ...worst was'.padEnd(34)} ${(n(w.sweep, 0) + 'deg/s').padStart(9)}   ${w.slot} ${w.side} arm, ` +
    `${w.oneShot ? 'in a one-shot' : 'in the loop'}${w.pulled ? ', flag pulled' : ''}${w.juke ? ', juking' : ''}, ${n(w.speed, 1)}yd/s`);
}
if (errs.length) console.log(`\n  page errors: ${errs.length}`);
console.log('');
