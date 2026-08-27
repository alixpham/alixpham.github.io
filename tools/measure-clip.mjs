#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — CLIP MEASURER

   Reads the built flagster/lib/flagplayer.glb, runs forward kinematics over a
   baked clip, and prints the joint angles a biomechanist would actually put a
   number on. Authoring animation by staring at euler triples is how a throw
   ends up with the elbow leading the hand; this reads the pose back out in
   anatomical terms so a clip can be checked against published kinematics
   instead of against a memory of what it looked like.

       node tools/measure-clip.mjs Throw
       node tools/measure-clip.mjs Throw --at 0.374     # one instant
       node tools/measure-clip.mjs Run --fps 30

   Angles follow the clinical conventions used in the throwing literature, all
   expressed in the TRUNK's own frame so trunk rotation doesn't leak into the
   shoulder numbers:

     elevation   humerus away from "straight down the trunk"; 90 = out level
                 with the shoulder, 112 is the measured QB value at cocking
     horizontal  0 = straight out to the side, + = brought across the chest
                 (horizontal adduction), - = behind the frontal plane
     ER          humeral axial rotation with the forearm as the pointer:
                 +90 = forearm straight up (max external rotation),
                 0 = forearm pointing forward, -90 = forearm down
     elbow       0 = straight, 90 = square
     trunk yaw   + = rotated toward the player's LEFT (open, for a righty)
     pelvis yaw  same sign convention; trunk - pelvis is the separation
     lean        forward flexion of the trunk, + = toward the target
     tilt        lateral trunk tilt, + = leaning AWAY from the throwing arm
     knee        flexion, 0 = straight
   ============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOLE, HEEL_Z, MTP_Z, TOE_DROP, TOE_LEN, SKULL, SKULL_R } from './rig-def.mjs';
import { readGLB, nodeIndex, loadClip as loadClipOf, sampleTrack, quatSlerp } from './glb-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB = path.resolve(HERE, '..', 'flagster', 'lib', 'flagplayer.glb');

/* --------------------------------------------------------------- math bits */
const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; }
};
const DEG = 180 / Math.PI;

/* 4x4, column-major like glTF/three. */
function matFromTR(t, q) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    t[0], t[1], t[2], 1
  ];
}
function matMul(a, b) {                       // a * b
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
const matPos = m => [m[12], m[13], m[14]];
const matAxis = (m, i) => V.norm([m[i * 4], m[i * 4 + 1], m[i * 4 + 2]]);

/* ------------------------------------------------------------------- rig */
const g = readGLB(GLB);
const { nodes, parent, byName } = nodeIndex(g);

const sample = sampleTrack;
const loadClip = name => loadClipOf(g, name);

/* Full-body world transforms at time t. */
function pose(clip, t) {
  const local = nodes.map(n => ({
    t: (n.translation || [0, 0, 0]).slice(),
    q: (n.rotation || [0, 0, 0, 1]).slice()
  }));
  for (const tr of clip.tracks) {
    const v = sample(tr.times, tr.values, t, tr.path === 'rotation');
    if (tr.path === 'rotation') local[tr.node].q = v; else local[tr.node].t = v;
  }
  const world = new Array(nodes.length).fill(null);
  const solve = i => {
    if (world[i]) return world[i];
    const m = matFromTR(local[i].t, local[i].q);
    world[i] = parent[i] >= 0 ? matMul(solve(parent[i]), m) : m;
    return world[i];
  };
  for (let i = 0; i < nodes.length; i++) solve(i);
  const out = {};
  for (const n in byName) out[n] = world[byName[n]];
  return out;
}

/* ------------------------------------------------------- angle extraction */
function measure(W) {
  const P = n => matPos(W[n]);
  // Trunk frame: the chest bone's own axes. +Y up the spine, +Z anterior,
  // +X toward the player's LEFT, so the RIGHT-hand side is -X.
  const chest = W.Chest;
  const up = matAxis(chest, 1), fwd = matAxis(chest, 2), left = matAxis(chest, 0);
  const right = left.map(v => -v);

  function arm(side) {
    const sh = P('UpperArm_' + side), el = P('LowerArm_' + side), wr = P('Hand_' + side);
    const h = V.norm(V.sub(el, sh));                 // humerus, distal
    const f = V.norm(V.sub(wr, el));                 // forearm, distal
    const lateral = side === 'R' ? right : left;
    const elevation = Math.acos(Math.max(-1, Math.min(1, V.dot(h, up.map(v => -v))))) * DEG;
    // Horizontal plane component, relative to straight-out-to-the-side.
    const hp = V.norm(V.sub(h, up.map(v => v * V.dot(h, up))));
    const horiz = Math.atan2(V.dot(hp, fwd), V.dot(hp, lateral)) * DEG;
    /* Axial rotation, read off where the forearm points around the humerus.
       u0 is trunk-up with the humeral component removed (where a maximally
       externally rotated forearm points); r0 is anterior, and has to flip with
       the side or the two arms would report opposite senses of the same pose. */
    const u0 = V.norm(V.sub(up, h.map(v => v * V.dot(h, up))));
    const r0 = V.norm(V.cross(up, h)).map(v => (side === 'R' ? v : -v));
    const er = Math.atan2(V.dot(f, u0), V.dot(f, r0)) * DEG;
    const elbow = Math.acos(Math.max(-1, Math.min(1, V.dot(h, f)))) * DEG;
    return { elevation, horiz, er, elbow, hand: P('Socket_Hand_' + side), wrist: wr, shoulder: sh, elbowP: el };
  }

  const yawOf = m => {
    const f = matAxis(m, 2);
    return Math.atan2(f[0], f[2]) * DEG;             // + = toward the player's LEFT
  };
  const knee = side => {
    const hip = P('UpperLeg_' + side), kn = P('LowerLeg_' + side), an = P('Foot_' + side);
    const a = V.norm(V.sub(kn, hip)), b = V.norm(V.sub(an, kn));
    return Math.acos(Math.max(-1, Math.min(1, V.dot(a, b)))) * DEG;
  };
  /* Trunk lean and side-bend are the trunk ON THE PELVIS, not on the world —
     with the hips yawed 40 degrees a world-frame reading swaps one for the
     other, and "23 degrees of lumbar extension" is a spine measurement. */
  const spineUp = matAxis(W.Chest, 1);
  const px = matAxis(W.Hips, 0), py = matAxis(W.Hips, 1), pz = matAxis(W.Hips, 2);
  const lean = Math.atan2(V.dot(spineUp, pz), V.dot(spineUp, py)) * DEG;   // + = toward the target
  const tilt = Math.atan2(V.dot(spineUp, px), V.dot(spineUp, py)) * DEG;   // + = away from a right arm

  /* Ground contact is the SOLE, not a joint — and the sole is TWO segments, not
     one. The foot carries the heel and the ball; the toe tip hangs off the Toe
     joint and moves with it, so once the gait clips started extending the MTP
     at toe-off (which is the whole point of having a Toe bone) a rigid
     heel-to-tip model reported a phantom point 26mm under the turf while the
     real shoe was flat on it. The three offsets are imported from rig-def.mjs, which is
     where the builder's solePoints reads them too. */
  const xform = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
  const sole = s => {
    const f = W['Foot_' + s], t = W['Toe_' + s];
    const pts = [
      xform(f, [0, -SOLE, HEEL_Z]),           // heel
      xform(f, [0, -SOLE, MTP_Z]),            // ball, under the MTP joint
      xform(t, [0, -TOE_DROP, TOE_LEN])       // toe tip, on the toe segment
    ];
    let lo = pts[0];
    for (const p of pts) if (p[1] < lo[1]) lo = p;
    return lo;
  };
  const soleL = sole('L'), soleR = sole('R');
  // Drift is measured at the ANKLE, not at the sole: the lowest point of a shoe
  // hops from heel to toe as the foot rolls, and reading that as travel reports
  // a quarter of a shoe-length of "skating" every time somebody rocks forward.
  return {
    R: arm('R'), L: arm('L'),
    trunk: yawOf(W.Chest), pelvis: yawOf(W.Hips),
    lean, tilt,
    kneeL: knee('L'), kneeR: knee('R'),
    hipsY: matPos(W.Hips)[1],
    hipsP: matPos(W.Hips),
    pelvisFwd: matAxis(W.Hips, 2),
    // Where each foot IS, for the skate check: a planted foot must not travel.
    footY: { L: soleL[1], R: soleR[1] },
    footP: { L: matPos(W.Foot_L), R: matPos(W.Foot_R) },
    soleP: { L: soleL, R: soleR },
    // Skull centre, for the limb-through-the-head check below.
    skull: xform(W.Head, SKULL)
  };
}

// A local point through a 4x4 (column-major, as glTF stores them).
function xform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
}

// Closest distance from point c to the segment a-b.
function segDist(c, a, b) {
  const ab = V.sub(b, a), ac = V.sub(c, a);
  const L2 = V.dot(ab, ab) || 1e-9;
  const u = Math.max(0, Math.min(1, V.dot(ac, ab) / L2));
  return V.len(V.sub(c, [a[0] + ab[0] * u, a[1] + ab[1] * u, a[2] + ab[2] * u]));
}

/* ------------------------------------------------------------------- main */
const name = process.argv[2] || 'Throw';
const argAt = process.argv.indexOf('--at');
const argFps = process.argv.indexOf('--fps');
const fps = argFps > 0 ? Number(process.argv[argFps + 1]) : 40;
const clip = loadClip(name);

const rows = [];
/* Rounded to an EVEN number of samples so that half a cycle is a whole number
   of them. The symmetry check below compares the left sole against the right
   shifted by exactly N/2; when N is odd that shift falls between samples, and
   interpolating a curved trace across the gap invents millimetres of
   asymmetry — up to 34mm on Sprint, which is how a clip that is symmetric by
   construction got reported as limping. */
const N = 2 * Math.max(1, Math.round(clip.dur * fps / 2));
for (let i = 0; i <= N; i++) {
  const t = (i / N) * clip.dur;
  rows.push({ t, m: measure(pose(clip, t)) });
}
// Hand speed, from the sampled path (metres/second).
for (let i = 0; i < rows.length; i++) {
  const a = rows[Math.max(0, i - 1)], b = rows[Math.min(rows.length - 1, i + 1)];
  rows[i].speed = V.len(V.sub(b.m.R.hand, a.m.R.hand)) / Math.max(1e-6, b.t - a.t);
}

const f = (v, w = 6, d = 1) => v.toFixed(d).padStart(w);
console.log(`clip ${clip.name}   ${clip.dur.toFixed(2)}s   ${rows.length} samples`);
console.log('   t     elev  horiz     ER  elbow | trunk pelvis   sep   lean   tilt |'
  + ' kneeL kneeR |  handY  handZ  speed |  Lsole      z  Rsole      z');
for (const r of rows) {
  const m = r.m;
  console.log(
    `${f(r.t, 5, 3)} ${f(m.R.elevation)} ${f(m.R.horiz)} ${f(m.R.er)} ${f(m.R.elbow)} |`
    + ` ${f(m.trunk)} ${f(m.pelvis)} ${f(m.trunk - m.pelvis)} ${f(m.lean)} ${f(m.tilt)} |`
    + ` ${f(m.kneeL)} ${f(m.kneeR)} |`
    + ` ${f(m.R.hand[1], 6, 2)} ${f(m.R.hand[2], 6, 2)} ${f(r.speed, 6, 2)} |`
    + ` ${f(m.footY.L, 6, 3)} ${f(m.soleP.L[2], 6, 2)} ${f(m.footY.R, 6, 3)} ${f(m.soleP.R[2], 6, 2)}`);
}

/* Ground check: nothing should be driven through the turf. */
let sink = 0, sinkT = 0;
for (const r of rows) {
  const low = Math.min(r.m.footY.L, r.m.footY.R);
  if (low < sink) { sink = low; sinkT = r.t; }
}
const peak = rows.reduce((a, b) => (b.speed > a.speed ? b : a));

/* AN ARM THROUGH THE OWN HEAD, which nothing was looking for.

   Everything else here asks about the ground. FlagPulled shipped with the
   forearm driven straight through the skull — 75 degrees of shoulder elevation
   with 58 of horizontal ADDUCTION on a nearly straight elbow — and every check
   in this file passed it, because both feet were fine. It was found by a
   player watching the menu.

   The skull is a sphere (rig-def: SKULL, SKULL_R). Measure the closest approach
   of the upper arm and forearm SEGMENTS to its centre, not just the hand: a
   forearm can pass through a head with both of its ends outside it. Clearance
   is that distance minus the skull radius, so it goes negative exactly when a
   limb is inside the head. A little under zero is a limb brushing the surface,
   which a head-scratch or a helmet-adjust legitimately does; well under is the
   arm inside the skull. */
let clip4 = { d: Infinity, t: 0, side: '' };
for (const r of rows) {
  for (const side of ['L', 'R']) {
    const a = r.m[side];
    const d = Math.min(segDist(r.m.skull, a.shoulder, a.elbowP),
                       segDist(r.m.skull, a.elbowP, a.wrist)) - SKULL_R;
    if (d < clip4.d) clip4 = { d, t: r.t, side };
  }
}

console.log('');
console.log(`peak hand speed   ${peak.speed.toFixed(2)} m/s at t=${peak.t.toFixed(3)}`);
console.log(`arm vs own skull  ${clip4.d >= 0 ? '+' : ''}${clip4.d.toFixed(3)} m clearance` +
  ` (${clip4.side} arm, t=${clip4.t.toFixed(3)})` +
  (clip4.d < -0.03 ? '   <-- ARM THROUGH THE HEAD' : ''));
console.log(`lowest foot point ${sink.toFixed(3)} m at t=${sinkT.toFixed(3)}` +
  (sink < -0.02 ? '   <-- THROUGH THE GROUND' : ''));

/* THE OTHER GROUND ERROR, AND THE ONE NOTHING WAS LOOKING FOR.

   Everything above asks whether a foot went THROUGH the turf. A pose can fail
   the opposite way and no check saw it: groundedHips hangs the pelvis off
   whichever sole is lowest, so if the two legs cannot both reach the ground in
   the pose as authored, the other foot simply hovers — and the solver reports
   a perfect zero the whole time, because it is measuring the foot that IS down.

   That is not a hypothetical. It is what a symmetric fore/aft stagger does: two
   legs at the same knee flexion with the ankles 0.3m apart in z do not have
   their soles at the same height, because the back shank is raked and the front
   one is not. Flex and Spike were both authored that way and both stood with
   the front foot four centimetres in the air for their whole duration.

   So: over the WHOLE clip, does each foot ever touch? A gait passes trivially
   (every foot lands once a cycle) and so does any dance that shifts its weight;
   what fails is a pose that never had both feet on the ground to begin with. */
for (const side of ['L', 'R']) {
  const low = rows.reduce((a, r) => Math.min(a, r.m.footY[side]), Infinity);
  console.log(`foot ${side} closest approach ${low.toFixed(3)} m` +
    (low > 0.02 ? '   <-- NEVER LANDS' : ''));
}

/* SKATE CHECK. A foot within a centimetre of the turf is bearing weight, and a
   foot bearing weight must not travel — that is the difference between a man
   standing on a field and a man sliding across one. A GAIT clip is the honest
   exception: its planted foot is supposed to sweep backward under the root at
   exactly ground speed, which is what stride matching in field3d.js is for. */
const GAIT = clip.extras.gait ? { [clip.name]: 1 } : {};
for (const side of ['L', 'R']) {
  let worst = 0, at = 0;
  const down = i => i >= 0 && i < rows.length && rows[i].m.footY[side] < 0.012;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].m, b = rows[i].m;
    // Settled, not landing or leaving: a foot is only held to the no-travel
    // rule once it has been down on both sides of the interval.
    if (!down(i - 2) || !down(i - 1) || !down(i) || !down(i + 1)) continue;
    const d = Math.hypot(b.footP[side][0] - a.footP[side][0], b.footP[side][2] - a.footP[side][2]);
    const rate = d / Math.max(1e-6, rows[i].t - rows[i - 1].t);
    if (rate > worst) { worst = rate; at = rows[i].t; }
  }
  console.log(`planted ${side} foot   drifts up to ${worst.toFixed(2)} m/s at t=${at.toFixed(3)}` +
    (GAIT[clip.name] ? '   (gait: the sweep IS the stride)' : worst > 0.9 ? '   <-- SKATING' : ''));
}

/* ---- GAIT COUPLING -------------------------------------------------------
   THE ARMS HAVE TO BE IN THE RIGHT PLACE, NOT MERELY MOVING.

   Every check above this one is about a single instant: is this foot through
   the turf, is this planted foot travelling. None of them can see the error
   that made the run read as a wind-up toy, because it is an error of TIMING
   and every individual frame of it is a perfectly good pose.

   A human runs contralaterally. At the instant the left foot lands, the RIGHT
   hand is at the front of its swing and the LEFT hand is behind the hip — that
   is what cancels the angular momentum the legs put into the trunk, and it is
   the single most recognisable thing about a running human. Swing the arm on
   the same side as the leg and you get a toy soldier; swing it a quarter of a
   cycle out and you get something that is not obviously wrong in any frame and
   is unmistakably wrong in motion.

   So: find each foot's contact phase, find each hand's rearmost phase, and
   report the gap. Zero is a runner. Anything past about 8% of a cycle is worth
   looking at; 50% is a toy soldier.

   A RETARGETED CLIP IS HELD TO A DIFFERENT STANDARD on both of these. An
   authored gait is built by mirroring one leg table, so its two sides agree to
   the micron and its arms are placed against the legs on purpose: any
   asymmetry there is a bug. A capture is one person taking two different
   steps. Real walkers carry 30-40mm of left/right difference and swing their
   arms a tenth of a cycle away from the textbook, and calling that a limp
   trains you to ignore the warning that matters. The numbers still print; only
   the verdict changes, and only for clips that came out of tools/mocap/.

   Fore/aft is measured in the PELVIS frame — the clip has no root motion, but
   the hips yaw through the cycle, and a world-frame reading folds that yaw into
   the arm swing it is trying to measure. */
if (clip.extras.gait) {
  const N2 = rows.length - 1;                        // last row repeats the first
  const at = i => rows[((i % N2) + N2) % N2];
  const phaseOf = i => (((i % N2) + N2) % N2) / N2;

  // Fore/aft of a point in the pelvis's own frame, at row i.
  const fore = (i, p) => {
    const m = at(i).m, W = m.hipsP;
    return (p[0] - W[0]) * m.pelvisFwd[0] + (p[2] - W[2]) * m.pelvisFwd[2];
  };

  const report = [];
  for (const side of ['L', 'R']) {
    /* Contact = the start of the LONGEST grounded run, not the first grounded
       sample found scanning from zero.

       The old version reported a limp in Walk and Jog that does not exist. Two
       bugs, both of them here. Scanning from index 0 with the foot already
       planted returns index 0, so the left foot always "contacts" at 0% — it
       reports the frame the scan began on. And a fixed 12mm threshold is
       meaningless during a flight phase: with both feet airborne the lower
       one's height is the pelvis-lift envelope, which crosses 12mm on the way
       up and again on the way down, so the right foot "contacted" wherever
       that envelope happened to dip. The two artifacts together read as 40%
       and 38% against an expected 50%, and the clips are in fact exactly
       symmetric — see the symmetry check below, which is the honest test. */
    const isDown = i => at(i).m.footY[side] < 0.012;
    let contact = null, bestLen = 0;
    for (let i = 0; i < N2; i++) {
      if (!isDown(i) || isDown(i - 1)) continue;        // not the start of a run
      let len = 0;
      while (len < N2 && isDown(i + len)) len++;
      if (len > bestLen) { bestLen = len; contact = i; }
    }
    // Rearmost hand. The hand swings once per cycle, so the minimum is unique.
    let back = 0, bv = Infinity, front = 0, fv = -Infinity;
    for (let i = 0; i < N2; i++) {
      const v = fore(i, at(i).m[side].hand);
      if (v < bv) { bv = v; back = i; }
      if (v > fv) { fv = v; front = i; }
    }
    let err = contact == null ? null : phaseOf(back) - phaseOf(contact);
    if (err != null) { while (err > 0.5) err -= 1; while (err < -0.5) err += 1; }
    report.push({ side, contact, back, front, err, reach: fv - bv });
  }

  console.log('');
  console.log('gait coupling');
  for (const r of report) {
    console.log(`  ${r.side}  contact ${r.contact == null ? ' n/a ' : (phaseOf(r.contact) * 100).toFixed(0).padStart(4) + '%'}` +
      `   hand back ${(phaseOf(r.back) * 100).toFixed(0).padStart(4)}%` +
      `   forward ${(phaseOf(r.front) * 100).toFixed(0).padStart(4)}%` +
      `   swing ${r.reach.toFixed(2)}m` +
      (r.err == null ? '' : `   arm/leg error ${(r.err * 100).toFixed(0).padStart(4)}%` +
        (Math.abs(r.err) <= 0.08 ? ''
          : clip.extras.mocap ? '   (captured, not authored — a real runner is not exact)'
            : '   <-- NOT CONTRALATERAL')));
  }
  const cL = report[0].contact, cR = report[1].contact;
  if (cL != null && cR != null) {
    let gap = phaseOf(cR) - phaseOf(cL);
    if (gap < 0) gap += 1;
    console.log(`  step contact    right ${(gap * 100).toFixed(0)}% after left`);
  }
  /* THE ACTUAL LIMP TEST. Compare the whole left sole trace against the right
     one shifted half a cycle. A gait built by rotating one leg's curve is
     symmetric by construction and this reads zero; anything that limps cannot
     hide from it, and unlike a single contact instant it does not depend on
     picking a threshold. This is the check that should have been here. */
  {
    /* Half a cycle is N2/2 samples, which is not an integer when N2 is odd, so
       the shifted sample is interpolated rather than rounded to a neighbour.
       Rounding it is wrong by up to half a frame and reports tens of
       millimetres of phantom asymmetry on exactly the clips whose sample count
       happens to be odd — which is how the first version of this check
       "confirmed" the limp it was written to disprove. */
    const soleAt = (x, side) => {
      const f = ((x % N2) + N2) % N2, i0 = Math.floor(f), u = f - i0;
      const a = at(i0).m.footY[side], b = at(i0 + 1).m.footY[side];
      return a + (b - a) * u;
    };
    let worst = 0, worstAt = 0;
    for (let i = 0; i < N2; i++) {
      const d = Math.abs(soleAt(i, 'L') - soleAt(i + N2 / 2, 'R'));
      if (d > worst) { worst = d; worstAt = i; }
    }
    console.log(`  step symmetry   left vs right shifted half a cycle: ` +
      `${(worst * 1000).toFixed(2)}mm worst, at ${(phaseOf(worstAt) * 100).toFixed(0)}%` +
      (worst <= 0.004 ? '   (symmetric)'
        : clip.extras.mocap ? '   (captured, not authored — nobody is symmetric)'
          : '   <-- LIMPING'));
  }
  const e = clip.extras;
  console.log(`  extras          ${e.groundSpeed.toFixed(2)} m/s, stride ${(e.groundSpeed * e.cycle).toFixed(2)}m,` +
    ` cadence ${(120 / e.cycle).toFixed(0)} steps/min, stance ${(e.stance * 100).toFixed(0)}%, flight ${(e.flight * 100).toFixed(0)}%`);
  if (e.steady != null) {
    // The mean is what the renderer divides by; the median is what the eye
    // sees for most of the stance. They have to agree, or the support foot is
    // sliding for part of every step and making it up at toe-off.
    const skewPct = 100 * (e.steady - e.groundSpeed) / e.groundSpeed;
    console.log(`  stance sweep    median ${e.steady.toFixed(2)} m/s (${skewPct.toFixed(0)}% off the mean),` +
      ` spread ${(e.even * 100).toFixed(0)}% of it` +
      (Math.abs(skewPct) > 8 || e.even > 0.35 ? '   <-- UNEVEN STANCE' : ''));
  }
}

if (argAt > 0) {
  const t = Number(process.argv[argAt + 1]);
  const m = measure(pose(clip, t));
  console.log('');
  console.log(`--- at t=${t} ---`);
  console.log(`  shoulder  elevation ${m.R.elevation.toFixed(0)}  horizontal ${m.R.horiz.toFixed(0)}  ER ${m.R.er.toFixed(0)}`);
  console.log(`  elbow     ${m.R.elbow.toFixed(0)}`);
  console.log(`  trunk     yaw ${m.trunk.toFixed(0)}  pelvis ${m.pelvis.toFixed(0)}  separation ${(m.trunk - m.pelvis).toFixed(0)}`);
  console.log(`  lean ${m.lean.toFixed(0)}  lateral tilt ${m.tilt.toFixed(0)}`);
  console.log(`  knees     lead(L) ${m.kneeL.toFixed(0)}  back(R) ${m.kneeR.toFixed(0)}`);
  console.log(`  hand      x ${m.R.hand[0].toFixed(2)}  y ${m.R.hand[1].toFixed(2)}  z ${m.R.hand[2].toFixed(2)}  (metres)`);
}
