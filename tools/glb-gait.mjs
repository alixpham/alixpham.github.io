#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — HOW FAST A BAKED GAIT COVERS THE GROUND, FROM THE MESH

     node tools/glb-gait.mjs player.glb --report
     node tools/glb-gait.mjs player.glb out.glb          # writes the extras in
     node tools/glb-gait.mjs flagster/lib/flagplayer.glb --check

   WHY THIS EXISTS. `playermodel.js` will not put a clip on the locomotion
   ladder without a measured `groundSpeed` in its animation extras — a rung
   without one is silently dropped, and a player with no rungs never plays a
   step. The game's own four are measured by `build-player-glb.mjs` through
   `rig-fk.mjs`, using the three sole points `rig-def.mjs` declares.

   A BOUGHT CHARACTER HAS NO SUCH TABLE. Its foot is whatever shape the artist
   modelled, its ankle sits at its own height, and typing three offsets for it
   would be another hand-copied constant of exactly the kind this repo has
   already watched drift twice. So the sole is taken from the MESH: the
   vertices the foot bones actually own, the lowest centimetres of them, skinned
   through the pose like everything else. No convention, nothing to keep in
   step, and it works on any rig whose feet are called Foot_* and Toe_*.

   THE RULE IS THE BUILDER'S: a sole point within 4 mm of the turf is carrying
   weight, and the ground goes by at the speed that point travels backwards
   under the player. Where the turf IS has to be answered differently here —
   see the note on the percentile floor below, which is the one place a mesh
   sole cannot follow three declared points.

   `--check` runs it against the game's own player and prints the answer beside
   the one the builder baked. They are measured by different code from different
   geometry, so agreeing to a percent or two is worth more than either number
   on its own; that is the whole reason the flag is here.

   BLEND CORRECTION. A pose halfway between a jog and a run does not cover the
   ground at the average of their speeds, so the ratio is measured at three
   mixes and baked onto the slower rung as `blendUp`, which is what
   `playermodel.js` divides by. The builder can predict that curve analytically
   because every gait joint on its rig turns about one axis; a retargeted clip
   has no such property, so here the blend is simply BUILT — slerp the two
   clips' tracks, exactly as the mixer will — and measured like any other pose.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { readGLB, clipNames, loadClip } from './glb-read.mjs';
import { skinnedRig } from './glb-skin.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && opt(argv[i - 1].slice(2)) === a));
const SRC = positional[0];
const CHECK = has('check');
const REPORT = has('report') || CHECK;
const OUT = REPORT ? null : positional[1];
const LADDER = (opt('gaits', 'Walk,Jog,Run,Sprint')).split(',').map(s => s.trim()).filter(Boolean);
const STEPS = Math.max(16, Number(opt('steps', 64)));
const CONTACT = 0.004;                 // the builder's tolerance, in metres
const BAND = Number(opt('band', 0.03));  // how much of the foot counts as sole

if (!SRC || (!REPORT && !OUT)) {
  console.error('usage: node tools/glb-gait.mjs <in.glb> <out.glb> [--gaits Walk,Jog,Run,Sprint]');
  console.error('       node tools/glb-gait.mjs <in.glb> --report | --check');
  process.exit(2);
}

/* ======================================================================= rig */
const g = readGLB(SRC);
const J = g.json;
const R = skinnedRig(g);
const soleOf = R.soles({ band: BAND });
if (!soleOf.L || !soleOf.R) { console.error('could not find Foot_L / Foot_R and their vertices'); process.exit(1); }
const jointMats = l => R.jointMats(l);
const skinPoint = (JM, v) => R.point(JM, v);
const localsOf = (c, t) => R.localsOf(c, t);
const localsMixed = (a, ta, b, tb, w) => R.localsMixed(a, ta, b, tb, w);

/* --------------------------------------------------------------- measure */
/* `poseAt(k)` gives the joint matrices for sample k of a cycle of `n`. */
function measure(poseAt, n, dur) {
  const dt = dur / n;
  const sole = [];
  for (let k = 0; k < n; k++) {
    const JM = poseAt(k);
    sole.push({ L: R.solePoints(JM, soleOf, 'L'), R: R.solePoints(JM, soleOf, 'R') });
  }
  /* THE FLOOR IS A PERCENTILE, NOT A MINIMUM.

     `rig-fk.mjs` takes the lowest the sole EVER gets, which is exact for the
     three points rig-def declares because they sit flat on the turf through a
     flat stance. A mesh sole does not: the game's own walk plants at 5 mm and
     then digs its toe 5 mm deeper at toe-off, so a floor of zero plus a 4 mm
     tolerance excluded every flat-footed frame — the walk came back with 14%
     stance and 75% flight, which is not a walk at all, and its speed was 17%
     high because only the fast frames survived.

     The tenth percentile of the per-frame, per-foot minima sits inside the
     contact cluster for every gait on the ladder: even a sprint has each foot
     down for a fifth of its cycle, which is twice what this needs. */
  const minima = [];
  for (const f of sole) for (const s of ['L', 'R']) {
    let lo = Infinity;
    for (const p of f[s]) lo = Math.min(lo, p[1]);
    minima.push(lo);
  }
  minima.sort((a, b) => a - b);
  const floor = minima[Math.floor(minima.length * 0.10)];
  const ON = CONTACT + Math.max(0, floor);

  let sum = 0, cnt = 0, stanceL = 0, anyDown = 0;
  const rates = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    let down = 0;
    for (const side of ['L', 'R']) {
      const now = sole[k][side], nxt = sole[j][side];
      let lo = 0;
      for (let m = 1; m < now.length; m++) if (now[m][1] < now[lo][1]) lo = m;
      if (now[lo][1] > ON) continue;
      down = 1;
      if (side === 'L') stanceL++;
      const r = -(nxt[lo][2] - now[lo][2]) / dt;
      sum += r; rates.push(r); cnt++;
    }
    anyDown += down;
  }
  const sorted = rates.slice().sort((a, b) => a - b);
  const at = q => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const mean = cnt ? sum / cnt : 0;
  return {
    gait: 1, groundSpeed: mean, steady: at(0.5),
    even: mean ? (at(0.75) - at(0.25)) / mean : 0,
    stance: stanceL / n, flight: 1 - anyDown / n, cycle: dur
  };
}

/* THE STANCE SWEEP, AND THE WARP THAT EVENS IT.

   `groundSpeed` is a MEAN, and the ladder matches it to within a tenth of a
   percent — so the stride is the right length and the right cadence and the
   playback rate sits at 1.000. It is the wrong PARAMETERISATION. The support
   foot creeps through early stance and whips through toe-off, so it averages
   out correct while sliding for the part of it the eye watches, which is the
   `spread` column above and is what "the players skate" actually is. Measured
   on the Ochi athlete at 60fps, with no lean, no facing and no camera in the
   way, a planted foot slid 10-35% of the player's own travel speed, worst at
   exactly the two clips whose spread is worst.

   So re-time it. `du = (v/G) dt` through stance and `du = dt` through flight
   makes the support foot's sweep CONSTANT; normalising the result back to the
   clip's own duration means stride length, cadence, ground speed and the
   contact at phase 0 are all exactly what they were, and only the
   distribution of time inside the cycle changes. `playermodel.js` reads the
   table back and writes `warp(phase) * duration` into the action instead of
   `phase * duration`.

   It is a table rather than a formula for the same reason `blendUp` is: there
   is no constant to keep in step with the clips, so re-author a stride and the
   curve is rebuilt with it. */
const WARP_STEPS = 32;
function warpOf(poseAt, n, dur) {
  const sole = [];
  for (let k = 0; k < n; k++) {
    const JM = poseAt(k);
    sole.push({ L: R.solePoints(JM, soleOf, 'L'), R: R.solePoints(JM, soleOf, 'R') });
  }
  const minima = [];
  for (const f of sole) for (const s of ['L', 'R']) {
    let lo = Infinity;
    for (const p of f[s]) lo = Math.min(lo, p[1]);
    minima.push(lo);
  }
  minima.sort((a, b) => a - b);
  const ON = CONTACT + Math.max(0, minima[Math.floor(minima.length * 0.10)]);
  const dt = dur / n;
  /* The sweep of whichever foot is carrying the load. Through double support
     there are two, and which one to believe looks like it ought to matter —
     the front foot has just struck and is nearly still, the rear is rolling
     off. It was measured all three ways (faster, slower, mean) on both
     characters at seven speeds: the resulting slip agreed to within a tenth of
     a percent everywhere except the walk, where the spread across the three
     was 1.2 points. It is not a knob. Faster, and no more thought about it. */
  const v = [];
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    let best = null;
    for (const side of ['L', 'R']) {
      let lo = 0;
      for (let m = 1; m < sole[k][side].length; m++) if (sole[k][side][m][1] < sole[k][side][lo][1]) lo = m;
      if (sole[k][side][lo][1] > ON) continue;
      const r = -(sole[j][side][lo][2] - sole[k][side][lo][2]) / dt;
      if (best == null || r > best) best = r;
    }
    v.push(best);
  }
  const on = v.filter(x => x != null && x > 0);
  if (on.length < n * 0.1) return null;            // not enough contact to time from
  const G = on.reduce((a, b) => a + b, 0) / on.length;
  const u = [0];
  for (let k = 0; k < n; k++) u.push(u[k] + ((v[k] != null && v[k] > 0) ? v[k] / G : 1) * dt);
  const k2 = dur / u[n];
  const uu = u.map(x => x * k2);
  // Invert: for each uniform phase, which source phase plays there.
  const table = [];
  for (let i = 0; i <= WARP_STEPS; i++) {
    const t = (i / WARP_STEPS) * dur;
    let lo = 0, hi = n;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (uu[mid] <= t) lo = mid; else hi = mid; }
    const span = uu[lo + 1] - uu[lo];
    const f2 = span > 1e-9 ? (t - uu[lo]) / span : 0;
    table.push(+(((lo + f2) / n)).toFixed(5));
  }
  table[0] = 0; table[WARP_STEPS] = 1;             // the loop has to close exactly
  return table;
}

const have = clipNames(g);
const rungs = [];
for (const name of LADDER) {
  if (!have.includes(name)) continue;
  const clip = loadClip(g, name);
  const m = measure(k => jointMats(localsOf(clip, (k / STEPS) * clip.dur)), STEPS, clip.dur);
  m.sweepWarp = warpOf(k => jointMats(localsOf(clip, (k / (STEPS * 3)) * clip.dur)), STEPS * 3, clip.dur);
  rungs.push({ name, clip, m, baked: clip.extras || {} });
}
if (!rungs.length) { console.error('none of ' + LADDER.join(', ') + ' is in this file'); process.exit(1); }

/* blendUp, per adjacent pair, onto the slower rung. */
for (let i = 0; i < rungs.length - 1; i++) {
  const A = rungs[i], B = rungs[i + 1];
  const curve = [1];
  for (const w of [0.25, 0.5, 0.75]) {
    const dur = A.clip.dur + (B.clip.dur - A.clip.dur) * w;
    const mm = measure(k => jointMats(localsMixed(A.clip, (k / STEPS) * A.clip.dur, B.clip, (k / STEPS) * B.clip.dur, w)), STEPS, dur);
    const linear = A.m.groundSpeed + (B.m.groundSpeed - A.m.groundSpeed) * w;
    curve.push(linear > 0 ? mm.groundSpeed / linear : 1);
  }
  curve.push(1);
  A.m.blendUp = curve.map(v => +v.toFixed(4));
}

/* ---------------------------------------------------------------- output */
const f = (v, d = 2) => v.toFixed(d).padStart(6);
console.log(`\n${path.basename(SRC)}   sole: ${soleOf.L.length}+${soleOf.R.length} points, from ${soleOf.L.reduce((a, b) => a + b.group.length, 0) + soleOf.R.reduce((a, b) => a + b.group.length, 0)} vertices`);
console.log(`  ${'clip'.padEnd(9)} ${'m/s'.padStart(6)} ${'steady'.padStart(7)} ${'spread'.padStart(7)} ${'stance'.padStart(7)} ${'flight'.padStart(7)}` + (CHECK ? '    baked   delta' : ''));
for (const r of rungs) {
  let tail = '';
  if (CHECK) {
    const b = r.baked.groundSpeed;
    tail = b ? `  ${f(b)}  ${((r.m.groundSpeed - b) / b * 100).toFixed(1).padStart(6)}%` : '       -       -';
  }
  console.log(`  ${r.name.padEnd(9)} ${f(r.m.groundSpeed)} ${f(r.m.steady)} ${(r.m.even * 100).toFixed(0).padStart(6)}% ` +
    `${(r.m.stance * 100).toFixed(0).padStart(6)}% ${(r.m.flight * 100).toFixed(0).padStart(6)}%` + tail);
}
for (const r of rungs) if (r.m.blendUp) console.log(`  blend ${r.name.padEnd(8)} ${r.m.blendUp.map(v => v.toFixed(3)).join('  ')}`);
/* How much re-timing the warp actually asks for: the largest gap between the
   phase that plays and the phase that asked for it. Zero means the clip's
   stance sweep was already even and the warp is the identity. */
for (const r of rungs) {
  if (!r.m.sweepWarp) { console.log(`  warp  ${r.name.padEnd(8)}  none — too little ground contact to time from`); continue; }
  let worst = 0;
  r.m.sweepWarp.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - i / (r.m.sweepWarp.length - 1))); });
  console.log(`  warp  ${r.name.padEnd(8)} shifts phase by at most ${(worst * 100).toFixed(1)}%`);
}

if (CHECK) {
  const withBaked = rungs.filter(r => r.baked.groundSpeed);
  const worst = Math.max(0, ...withBaked.map(r => Math.abs(r.m.groundSpeed - r.baked.groundSpeed) / r.baked.groundSpeed));
  console.log(`\n  worst disagreement with the builder: ${(worst * 100).toFixed(1)}%` +
    (worst > 0.05 ? '   <-- the two measurements do not agree; do not trust either' : '   (independent code, independent geometry)'));
  console.log('');
  process.exit(worst > 0.05 ? 1 : 0);
}
if (REPORT) { console.log(''); process.exit(0); }

/* Write the extras back in, leaving everything else alone. */
for (const r of rungs) {
  const anim = J.animations.find(a => a.name === r.name);
  const keep = anim.extras && anim.extras.mocap ? { mocap: anim.extras.mocap } : {};
  anim.extras = { ...r.m, ...keep };
  for (const k of ['groundSpeed', 'steady', 'even', 'stance', 'flight', 'cycle']) anim.extras[k] = +anim.extras[k].toFixed(6);
  if (!anim.extras.sweepWarp) delete anim.extras.sweepWarp;
}
const jsonBuf = Buffer.from(JSON.stringify(J), 'utf8');
const jPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
const bPad = Buffer.alloc((4 - (g.bin.length % 4)) % 4, 0);
const jc = Buffer.concat([jsonBuf, jPad]), bc = Buffer.concat([g.bin, bPad]);
const head = Buffer.alloc(12);
head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jc.length + 8 + bc.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jc.length, 0); jh.write('JSON', 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bc.length, 0); bh.write('BIN\0', 4);
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([head, jh, jc, bh, bc]));
console.log(`\n  wrote ${OUT}  (${rungs.length} rungs measured)\n`);
