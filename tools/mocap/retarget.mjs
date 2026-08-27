#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — MOCAP RETARGETER  (CMU ASF/AMC -> this project's rig)

       node tools/mocap/retarget.mjs 09_01 --name RunMocap --cyclic
       node tools/mocap/retarget.mjs 79_91 --name Throw2 --from 420 --to 560
       node tools/mocap/retarget.mjs 09_01 --cyclic --report      (measure only)

   Writes tools/motion/<Name>.json — per-key quaternions on OUR bones plus a
   pelvis track — which the builder bakes into flagplayer.glb exactly the way it
   bakes a hand-authored clip. The .amc never enters the build; the committed
   JSON is the record, so a rebuild in a fresh container needs no network.

   ---------------------------------------------------------------- THE MATH

   Both rigs have a rest pose that carries NO rotations (see the note in
   asf.mjs for why that is true of ASF, and rig-def.mjs for why it is true
   here). So a bone's world rotation, in either rig, is already "how far this
   bone has turned away from its own rest direction". Retargeting is then one
   fixed quaternion per bone:

       G_ours = G_theirs . delta        delta = minArc(ourRest, theirRest)

   which is chosen so that our bone ends up POINTING WHERE THEIRS POINTS —
   `delta` is exactly the rotation that carries our rest direction onto theirs,
   so it cancels out of the product and what survives is the subject's real
   segment orientation. Local rotations then fall out of our own hierarchy,
   which means our chain can be shorter than theirs (it is: they have three
   spine bones and two neck bones) with the intermediate rotation absorbed
   rather than lost.

   THE EXCEPTIONS ARE WHERE "REST DIRECTION" MEANS DIFFERENT THINGS in the two
   rigs, and there are exactly three:

     Hips        their root is not a bone and has no direction at all; the
                 pelvis rotation transfers as-is.
     Foot, Toe   the anatomical feature that matters is the SOLE, not the
                 metatarsal line, and the two rigs draw the foot bone at
                 different pitches (ours 26 degrees below horizontal, the
                 subject's 12). Both rests stand flat, so aligning the bones
                 would tilt our sole 13 degrees toe-down and drive the toe
                 through the turf on every flat-footed frame. Aligning the
                 rests instead — delta = identity — keeps flat flat.
     Shoulder_*  a clavicle really does run up and out, and theirs is authored
                 that way while ours is drawn horizontal because that is where
                 the mesh is bound. Honouring their rest direction would lift
                 our shoulder joint 56mm at rest and tear the deltoid off the
                 arm. The clavicle's deviation is transferred and its rest is
                 left alone.

   ------------------------------------------------------------- THE PELVIS

   Height is the subject's, rescaled by the ratio of leg lengths and then
   dropped so the deepest sole point of the cycle sits exactly on the turf.
   That preserves flight — a pelvis that is airborne must NOT be re-planted,
   which is what a naive "hang the hips off the lowest foot" solve does to
   every running clip. What it cannot preserve is contact on every other frame,
   because our shank is 25mm longer than the subject's, so a smoothed per-key
   lift takes out the residual penetration. It only ever pushes UP.

   Horizontal travel is thrown away, deliberately. Flagster's clips carry no
   root motion: the engine moves the player and the renderer picks a playback
   rate from the clip's measured ground speed. Which is measured HERE, off our
   own rig with our own leg lengths, by the same rule the builder uses.
   ============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFBX, indexScene } from '../fbx-read.mjs';
import { readRig, readClips, poseFK } from '../fbx-pose.mjs';
import { readSkeleton, readMotion, forward, qMul, qConj, qAxis, qRot, qSlerp, qNorm, minArc } from './asf.mjs';
import { skeletonText, motionText, subjectOf } from './fetch.mjs';
import { BONES, BONE_MAP, THIGH, SHIN, SOLE } from '../rig-def.mjs';
import { fk, lowestSole, metrics } from '../rig-fk.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(HERE, '..', 'motion');
const STEPS = 32;                                  // same key count the builder uses

/* ------------------------------------------------------------ bone mapping
   Ours <- theirs. Anything absent (the sockets, the flags) simply keeps an
   unrotated local and rides its parent. */
const MAP = {
  Hips: 'root',
  Spine: 'upperback', Chest: 'thorax', Neck: 'upperneck', Head: 'head',
  Shoulder_L: 'lclavicle', UpperArm_L: 'lhumerus', LowerArm_L: 'lradius', Hand_L: 'lhand',
  Shoulder_R: 'rclavicle', UpperArm_R: 'rhumerus', LowerArm_R: 'rradius', Hand_R: 'rhand',
  UpperLeg_L: 'lfemur', LowerLeg_L: 'ltibia', Foot_L: 'lfoot', Toe_L: 'ltoes',
  UpperLeg_R: 'rfemur', LowerLeg_R: 'rtibia', Foot_R: 'rfoot', Toe_R: 'rtoes'
};
// Bones whose delta is identity, for the reasons set out in the header.
const REST_ALIGNED = new Set(['Hips', 'Foot_L', 'Foot_R', 'Toe_L', 'Toe_R', 'Shoulder_L', 'Shoulder_R']);

/* Our rest direction for a bone = the offset to the child that continues it. */
const CONTINUES = {
  Hips: 'Spine', Spine: 'Chest', Chest: 'Neck', Neck: 'Head',
  Shoulder_L: 'UpperArm_L', UpperArm_L: 'LowerArm_L', LowerArm_L: 'Hand_L', Hand_L: 'Socket_Hand_L',
  Shoulder_R: 'UpperArm_R', UpperArm_R: 'LowerArm_R', LowerArm_R: 'Hand_R', Hand_R: 'Socket_Hand_R',
  UpperLeg_L: 'LowerLeg_L', LowerLeg_L: 'Foot_L', Foot_L: 'Toe_L',
  UpperLeg_R: 'LowerLeg_R', LowerLeg_R: 'Foot_R', Foot_R: 'Toe_R'
};
const TERMINAL_DIR = { Head: [0, 1, 0], Toe_L: [0, 0, 1], Toe_R: [0, 0, 1] };

function restDir(bone) {
  if (TERMINAL_DIR[bone]) return TERMINAL_DIR[bone];
  const child = CONTINUES[bone];
  const o = BONE_MAP[child].offset;
  const n = Math.hypot(...o);
  return [o[0] / n, o[1] / n, o[2] / n];
}

function deltas(skel) {
  const d = {};
  for (const ours in MAP) {
    const theirs = skel.bones[MAP[ours]];
    if (!theirs) continue;
    d[ours] = REST_ALIGNED.has(ours) ? [0, 0, 0, 1] : minArc(restDir(ours), theirs.dir);
  }
  return d;
}

/* -------------------------------------------------------------- resampling */
const wrap = (a, i) => a[((i % a.length) + a.length) % a.length];

// Cubic-Hermite in TIME is what the builder uses between authored rows; here
// the source is already dense at 120Hz, so a linear read between neighbouring
// captured frames is below the noise floor of the capture itself.
function sampleQ(list, x) {
  const i = Math.floor(x), u = x - i;
  return u < 1e-9 ? wrap(list, i) : qSlerp(wrap(list, i), wrap(list, i + 1), u);
}
function sampleV(list, x) {
  const i = Math.floor(x), u = x - i;
  const a = wrap(list, i), b = wrap(list, i + 1);
  return a.map((v, k) => v + (b[k] - v) * u);
}

/* ------------------------------------------------------------------- main */
const argv = process.argv.slice(2);
const trial = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : null;
if (!trial && !argv.includes('--src-fbx')) {
  console.error('usage: retarget.mjs <trial e.g. 09_01> [--name Clip] [--from f] [--to f] [--cyclic] [--report]');
  process.exit(2);
}
const opt = (k, def) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const flag = k => argv.includes('--' + k);
const NAME = opt('name', trial);
const CYCLIC = flag('cyclic');
/* CMU's own index lists every trial as 120Hz and it is not always true — the
   subject-141 runs come out at 2.9 strides a second and 7 m/s if you believe
   it, which is a stride rate no human has ever produced. The check that
   catches it is printed below rather than guessed at here: stride LENGTH is
   independent of the frame rate (it is pure geometry), so a clip whose length
   is sane while its rate is not has been read at the wrong speed. */
let FPS = Number(opt('fps', 120));

/* ------------------------------------------------------- an FBX source ----
   CMU is not the only free library, and the best of them ship FBX: Rokoko's
   packs are a direct public download and include TREADMILL runs, which are in
   place by construction and are the one rung CMU cannot provide at all — its
   capture volume is 3m x 8m, so nobody sprints in it and Sprint has been hand
   authored ever since.

   Rather than fork this file, an FBX source is presented UNDER CMU'S BONE
   NAMES. Everything below — the delta solve, the contact search, the planting,
   the ground-speed measurement — then runs unchanged on either. fbx-pose.mjs
   returns the same { q, p } pair asf.mjs's forward() does, which is what makes
   the disguise cheap. */
const SRC_FBX = opt('src-fbx', null);
const ALIAS_ROKOKO = {
  root: 'Hips', lowerback: 'Spine1', upperback: 'Spine2', thorax: 'Spine3',
  lowerneck: 'Spine4', upperneck: 'Neck', head: 'Head',
  lclavicle: 'LeftShoulder', lhumerus: 'LeftArm', lradius: 'LeftForeArm', lhand: 'LeftHand',
  rclavicle: 'RightShoulder', rhumerus: 'RightArm', rradius: 'RightForeArm', rhand: 'RightHand',
  lfemur: 'LeftThigh', ltibia: 'LeftShin', lfoot: 'LeftFoot', ltoes: 'LeftToe',
  rfemur: 'RightThigh', rtibia: 'RightShin', rfoot: 'RightFoot', rtoes: 'RightToe'
};
const ALIAS_MIXAMO = {
  root: 'mixamorig:Hips', lowerback: 'mixamorig:Spine', upperback: 'mixamorig:Spine1',
  thorax: 'mixamorig:Spine2', upperneck: 'mixamorig:Neck', head: 'mixamorig:Head',
  lclavicle: 'mixamorig:LeftShoulder', lhumerus: 'mixamorig:LeftArm',
  lradius: 'mixamorig:LeftForeArm', lhand: 'mixamorig:LeftHand',
  rclavicle: 'mixamorig:RightShoulder', rhumerus: 'mixamorig:RightArm',
  rradius: 'mixamorig:RightForeArm', rhand: 'mixamorig:RightHand',
  lfemur: 'mixamorig:LeftUpLeg', ltibia: 'mixamorig:LeftLeg',
  lfoot: 'mixamorig:LeftFoot', ltoes: 'mixamorig:LeftToeBase',
  rfemur: 'mixamorig:RightUpLeg', rtibia: 'mixamorig:RightLeg',
  rfoot: 'mixamorig:RightFoot', rtoes: 'mixamorig:RightToeBase'
};

let skel, raw, FWD;
if (SRC_FBX) {
  const sfbx = parseFBX(fs.readFileSync(SRC_FBX));
  const sscene = indexScene(sfbx.root);
  const srig = readRig(sscene, { restFrom: 'clusters' });
  const clips = readClips(sscene, srig);
  if (!clips.length) { console.error('no animation in ' + SRC_FBX); process.exit(1); }
  const want = opt('src-clip', null);
  const clip = want ? clips.find(c => c.name.includes(want)) : clips.reduce((a, b) => (b.duration > a.duration ? b : a));
  const names = new Set(srig.bones.keys());
  const score = a => Object.values(a).filter(v => names.has(v)).length;
  const alias = score(ALIAS_ROKOKO) >= score(ALIAS_MIXAMO) ? ALIAS_ROKOKO : ALIAS_MIXAMO;
  const aliasName = alias === ALIAS_ROKOKO ? 'rokoko' : 'mixamo';
  /* FBX is centimetres here; the ASF path is metres, and the ground-speed and
     planting maths downstream assume metres. */
  const SU = 0.01;
  skel = { bones: {}, fbx: true, alias: aliasName, matched: score(alias) };
  for (const cmu in alias) {
    const b = srig.bones.get(alias[cmu]);
    if (b) skel.bones[cmu] = { dir: b.dir, len: b.len * SU };
  }
  /* An FBX clip is sampled at a rate WE choose, so the frame rate every
     downstream cadence and stride figure is divided by has to be that same
     rate. Leaving FPS at CMU's 120 while sampling at 30 reported a 465
     steps-per-minute sprint, which is four times a real one — the same class of
     error the --fps check downstream is there to catch. */
  const FSRC = Number(opt('fps', 30));
  FPS = FSRC;
  const n = Math.max(2, Math.round(clip.duration * FSRC));
  raw = Array.from({ length: n }, (_, i) => clip.t0 + (clip.duration * i) / (n - 1));
  FWD = (_s, t) => {
    const fk = poseFK(srig, clip, t);
    const q = {}, p = {};
    for (const cmu in alias) {
      const nm = alias[cmu];
      if (fk.q[nm]) q[cmu] = fk.q[nm];
      if (fk.p[nm]) p[cmu] = fk.p[nm].map(v => v * SU);
    }
    return { q, p };
  };
} else {
  skel = readSkeleton(await skeletonText(subjectOf(trial)));
  raw = readMotion(await motionText(trial));
  FWD = forward;
}
const DELTA = deltas(skel);

/* Their pose -> our locals, for one captured frame. */
function convert(fr) {
  const src = FWD(skel, fr);
  const G = {};
  for (const ours in MAP) {
    const s = src.q[MAP[ours]];
    if (s) G[ours] = qMul(s, DELTA[ours]);
  }
  // Unmapped bones ride their parent: their world rotation IS the parent's.
  for (const [name, parent] of BONES) if (!G[name]) G[name] = parent ? G[parent] : [0, 0, 0, 1];
  const local = {};
  for (const [name, parent] of BONES) local[name] = parent ? qNorm(qMul(qConj(G[parent]), G[name])) : qNorm(G[name]);
  /* THE SUBJECT'S OWN FOOT HEIGHTS, kept so the target can be planted on the
     frames the SUBJECT was planted on. Reading stance off the retargeted rig
     instead would be circular: our shank is 25mm longer than theirs, so which
     of our frames happen to reach the turf is exactly the thing being fixed. */
  const foot = s => Math.min(src.p['%sfoot'.replace('%s', s)][1], src.p['%stoes'.replace('%s', s)][1]);
  return { local, root: src.p.root, hipY: src.p.root[1], srcFoot: { L: foot('l'), R: foot('r') } };
}

const poses = raw.map(convert);

/* ---- which frames, and which way is downfield ---------------------------
   The subject ran across the capture volume in whatever direction the room
   happened to be; the clip has to run along +Z, because that is the direction
   this rig faces and the axis the ground-speed measurement reads. */
let from = Number(opt('from', 0));
let to = Number(opt('to', raw.length - 1));

/* A LEFT FOOT CONTACT IS PHASE ZERO — every gait in this project starts there,
   so a blend of two of them has both clips landing on the same foot at the
   same instant. Find contacts by taking the frames where the left sole is
   within a centimetre of its own minimum and the trend turns. */
function contacts(a, b) {
  /* Read off the SUBJECT, not off the retargeted rig. Our shank is longer than
     theirs, so which of our frames happen to touch the turf is downstream of
     the very planting solve this window feeds — measuring it there would be
     circular, and it is what first cut a stride seven frames short. */
  const y = [];
  for (let i = a; i <= b; i++) y.push(poses[i].srcFoot.L);
  const lo = Math.min(...y);
  const gate = lo + 0.015;                        // 15mm above the subject's own floor
  const out = [];
  let armed = true;
  for (let i = 1; i < y.length; i++) {
    if (armed && y[i] <= gate) { out.push(a + i); armed = false; }
    if (!armed && y[i] > lo + 0.06) armed = true;
  }
  return out;
}

if (CYCLIC && !argv.includes('--from')) {
  const c = contacts(0, raw.length - 1);
  if (c.length < 2) { console.error('no repeating left-foot contact found — pass --from/--to'); process.exit(1); }
  /* The MIDDLE stride, not the first: a capture starts with the subject
     accelerating out of a standstill and the first cycle is never the one you
     want to loop. */
  const mid = Math.floor((c.length - 1) / 2);
  from = c[mid]; to = c[mid + 1];
}

const span = to - from;
const duration = span / FPS;

/* Travel direction over the window, from the pelvis — and when there is no
   travel, from where the pelvis is POINTING.

   A treadmill capture is the case that breaks the travel test: the subject runs
   for fifteen seconds and goes nowhere, so `dx, dz` stay under the threshold,
   yaw falls back to zero, and the clip keeps whichever way the room happened to
   face. Rokoko's treadmill run faces -Z, which came out as a ground speed of
   -0.52 m/s: a sprint, backwards.

   A rig's facing is well defined without travel. The pelvis's own forward axis
   is measured over the window and averaged — averaged because it yaws through
   every stride, and one frame of it is a lean rather than a heading. */
const dx = poses[to].root[0] - poses[from].root[0];
const dz = poses[to].root[2] - poses[from].root[2];
let yaw;
if (Math.hypot(dx, dz) > 0.15) {
  yaw = Math.atan2(dx, dz);
} else {
  let sx = 0, sz = 0;
  for (let i = from; i <= to; i++) {
    const f = qRot(poses[i].local.Hips, [0, 0, 1]);
    sx += f[0]; sz += f[2];
  }
  yaw = (Math.hypot(sx, sz) > 1e-6) ? Math.atan2(sx, sz) : 0;
}
const align = qAxis([0, 1, 0], -yaw);

/* ---- sample the window ------------------------------------------------- */
const keys = [];
for (let i = 0; i <= STEPS; i++) {
  const x = from + (span * i) / STEPS;
  const local = {};
  for (const [name] of BONES) local[name] = sampleQ(poses.map(p => p.local[name]), x);
  // The pelvis carries the world yaw; align it and everything below follows.
  local.Hips = qNorm(qMul(align, local.Hips));
  const root = sampleV(poses.map(p => p.root), x);
  keys.push({ local, root: qRot(align, root) });
}

/* ---- close the loop -----------------------------------------------------
   A captured stride is never exactly periodic, so key[STEPS] and key[0] differ
   by a few degrees at every joint — a visible tick once a second at a sprint.
   Distribute that error linearly across the cycle rather than snapping it out
   at the seam, which is the difference between a clip that drifts imperceptibly
   and one that jerks. */
if (CYCLIC) {
  for (const [name] of BONES) {
    const err = qMul(keys[0].local[name], qConj(keys[STEPS].local[name]));
    for (let i = 0; i <= STEPS; i++) {
      keys[i].local[name] = qNorm(qMul(qSlerp([0, 0, 0, 1], err, i / STEPS), keys[i].local[name]));
    }
  }
}

/* ---- the pelvis track ---------------------------------------------------- */
const legTheirs = skel.bones.lfemur.len + skel.bones.ltibia.len + SOLE;
const legOurs = THIGH + SHIN + SOLE;
const hipScale = legOurs / legTheirs;

const meanY = keys.reduce((s, k) => s + k.root[1], 0) / keys.length;
const meanX = keys.reduce((s, k) => s + k.root[0], 0) / keys.length;
// Forward travel is a ramp across the window; what is left after removing it is
// the fore-aft pulse of the pelvis, which is real and worth keeping.
const z0 = keys[0].root[2], zN = keys[STEPS].root[2];
const hips = keys.map((k, i) => [
  (k.root[0] - meanX) * hipScale,
  meanY * hipScale + (k.root[1] - meanY) * hipScale,
  (k.root[2] - (z0 + (zN - z0) * (i / STEPS))) * hipScale
]);
if (CYCLIC) { const m = hips[0]; hips[STEPS] = m.slice(); }

/* ---- plant it ------------------------------------------------------------
   A gait is not planted by hanging the pelvis off the lowest foot: do that and
   a running clip gets re-planted in mid-air and loses its flight entirely. It
   is planted on the frames the SUBJECT had a foot down, and left alone on the
   rest, so the ballistic arc between contacts survives the retarget.

   The correction is carried by the pelvis rather than by bending a knee. Both
   are defensible; this one leaves every joint angle exactly as captured, which
   is the whole point of going to mocap in the first place, and the amplitude
   it needs is a couple of centimetres because the two skeletons are within a
   few percent of each other everywhere that matters. */
const worldAt = i => fk(keys[i].local, hips[i]);
const srcFloor = { L: Infinity, R: Infinity };
for (let i = from; i <= to; i++) for (const s of ['L', 'R']) srcFloor[s] = Math.min(srcFloor[s], poses[i].srcFoot[s]);
const GATE = 0.035;                                // subject's foot within 35mm of their own floor
const downAt = (i, side) => {
  const x = Math.round(from + (span * i) / STEPS);
  return poses[Math.min(raw.length - 1, x)].srcFoot[side] < srcFloor[side] + GATE;
};

const corr = new Array(STEPS + 1).fill(null);
for (let i = 0; i <= STEPS; i++) {
  const W = worldAt(i);
  /* If either foot is down, hang the pelvis off whichever sole is LOWEST —
     not off the one the gate named. At the changeover the arriving foot is
     already below the leaving one, and planting the leaving foot buries the
     arriving one 11mm into the turf on the frame the eye is watching it land. */
  if (downAt(i, 'L') || downAt(i, 'R')) corr[i] = -Math.min(lowestSole(W, 'L')[1], lowestSole(W, 'R')[1]);
}
if (corr.every(c => c === null)) {
  // Nothing was ever down (a dive, a throw from a standstill mid-air is not a
  // thing) — fall back to planting the single deepest frame.
  let deep = Infinity;
  for (let i = 0; i <= STEPS; i++) for (const s of ['L', 'R']) deep = Math.min(deep, lowestSole(worldAt(i), s)[1]);
  corr.fill(-deep);
}
/* Across flight, the correction is INTERPOLATED between the contacts either
   side of it rather than held or zeroed: a step change in it lands as a kick
   in the pelvis on the frame the foot leaves the ground. */
const near = (i, dir) => {
  for (let d = 1; d <= STEPS; d++) {
    const j = CYCLIC ? ((i + dir * d + STEPS * 2) % STEPS) : i + dir * d;
    if (j < 0 || j > STEPS) break;
    if (corr[j] !== null) return { j, d };
  }
  return null;
};
const filled = corr.map((c, i) => {
  if (c !== null) return c;
  const a = near(i, -1), b = near(i, 1);
  if (!a) return corr[b.j];
  if (!b) return corr[a.j];
  const t = a.d / (a.d + b.d);
  return corr[a.j] + (corr[b.j] - corr[a.j]) * (t * t * (3 - 2 * t));
});
for (let i = 0; i <= STEPS; i++) hips[i][1] += filled[i];
if (CYCLIC) hips[STEPS] = hips[0].slice();

let deepest = Infinity, hover = 0;
for (let i = 0; i <= STEPS; i++) {
  const W = worldAt(i);
  for (const s of ['L', 'R']) deepest = Math.min(deepest, lowestSole(W, s)[1]);
}
for (const s of ['L', 'R']) {
  let closest = Infinity;
  for (let i = 0; i <= STEPS; i++) closest = Math.min(closest, lowestSole(worldAt(i), s)[1]);
  hover = Math.max(hover, closest);
}

/* ---- LEFT FOOT CONTACT IS PHASE ZERO -------------------------------------
   Every gait in this project starts on the left foot's landing, so that a
   blend of two rungs has both clips planting the same foot on the same frame
   rather than one landing while the other is airborne. The window above was
   cut at a contact detected on the SUBJECT — their foot joint reaching its
   lowest — and that instant is not ours: their foot joint bottoms out at
   mid-stance, while our sole touches at heel strike, an eighth of a cycle
   earlier. Left uncorrected the whole clip is a phase out, which reads on the
   measurer as arms that are not contralateral when the arms are in fact fine.

   The clip is periodic, so this is a rotation of the key arrays and nothing
   else — no resampling, no error. */
if (CYCLIC) {
  const floorNow = (() => {
    let f = Infinity;
    for (let i = 0; i < STEPS; i++) for (const s of ['L', 'R']) f = Math.min(f, lowestSole(worldAt(i), s)[1]);
    return f;
  })();
  const down = [];
  /* 12mm, which is measure-clip's threshold rather than the builder's 4mm.
     A sole comes down slowly enough in a walk that the two disagree by two
     keys, and the number that matters is the one the verifier reports. */
  for (let i = 0; i < STEPS; i++) down.push(lowestSole(worldAt(i), 'L')[1] <= floorNow + 0.012);
  /* The start of the LONGEST run of contact, not the first one found. A walk
     spends an eighth of its cycle in double support and the sole can dip back
     inside the tolerance for a key or two as the foot rolls, so "first key that
     is down after a key that was not" happily anchors the whole clip to a
     three-key blip in the middle of stance. */
  let start = -1, best = 0;
  for (let i = 0; i < STEPS; i++) {
    if (!down[i] || down[(i - 1 + STEPS) % STEPS]) continue;
    let run = 0;
    while (run < STEPS && down[(i + run) % STEPS]) run++;
    if (run > best) { best = run; start = i; }
  }
  if (start > 0) {
    const roll = a => { const b = a.slice(0, STEPS); const r = b.slice(start).concat(b.slice(0, start)); r.push(r[0]); return r; };
    const k = roll(keys), h = roll(hips);
    keys.length = 0; keys.push(...k);
    hips.length = 0; hips.push(...h.map(v => v.slice()));
    console.log(`  phase        rolled ${start}/${STEPS} keys so the left foot lands at 0`);
  }
}

/* --debug prints the series rather than its summary, which is the only way to
   see WHICH key is fighting the solve — the builder's GAIT_DEBUG, same idea. */
if (flag('debug')) {
  console.log('   key  down   Lsole      z   Rsole      z    corr    hipY');
  for (let i = 0; i <= STEPS; i++) {
    const W = worldAt(i);
    const L = lowestSole(W, 'L'), R = lowestSole(W, 'R');
    const d = (downAt(i, 'L') ? 'L' : '-') + (downAt(i, 'R') ? 'R' : '-');
    const f = (v, w = 7, k = 3) => v.toFixed(k).padStart(w);
    console.log(`  ${String(i).padStart(4)}   ${d} ${f(L[1])}${f(L[2])}${f(R[1])}${f(R[2])}${f(filled[i])}${f(hips[i][1])}`);
  }
}

/* ---- measure, on our rig, the way the builder does ---------------------- */
const frames = [];
for (let i = 0; i < STEPS; i++) frames.push(worldAt(i));
const ext = metrics(frames, duration);

const clip = {
  name: NAME,
  duration: Number(duration.toFixed(4)),
  cyclic: CYCLIC,
  source: { db: 'CMU Graphics Lab Motion Capture Database', trial, from, to, fps: FPS },
  extras: CYCLIC ? { ...ext, mocap: 1 } : { mocap: 1 },
  hips: hips.map(h => h.map(v => Number(v.toFixed(5)))),
  bones: {}
};
for (const [name] of BONES) {
  const track = keys.map(k => k.local[name].map(v => Number(v.toFixed(5))));
  // A bone that never moves is not worth a track; the builder skips it and the
  // .glb stays the size it was.
  const still = track.every(q => Math.abs(q[0]) < 1e-4 && Math.abs(q[1]) < 1e-4 && Math.abs(q[2]) < 1e-4);
  if (!still) clip.bones[name] = track;
}

const line = (l, v) => console.log('  ' + l.padEnd(14) + v);
console.log(`${NAME}  <-  ${trial} frames ${from}..${to}  (${duration.toFixed(3)}s, ${Object.keys(clip.bones).length} tracks)`);
if (CYCLIC) {
  line('ground speed', `${ext.groundSpeed.toFixed(2)} m/s   median ${ext.steady.toFixed(2)}   spread ${(ext.even * 100).toFixed(0)}%`);
  line('stance', `${(ext.stance * 100).toFixed(0)}%   flight ${(ext.flight * 100).toFixed(0)}%   cadence ${(120 / duration).toFixed(0)} steps/min`);
  const stride = ext.groundSpeed * duration;
  const rate = 1 / duration;
  line('stride', `${stride.toFixed(2)} m at ${rate.toFixed(2)} Hz` +
    (rate > 2.0 ? '   *** IMPLAUSIBLE: no one strides twice a second; re-read with --fps 60' : ''));
}
line('contact', `worst penetration ${deepest.toFixed(3)} m, worst hover ${hover.toFixed(3)} m`);
line('hips', `${Math.min(...hips.map(h => h[1])).toFixed(3)} .. ${Math.max(...hips.map(h => h[1])).toFixed(3)} m`);

if (!flag('report')) {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const file = path.join(OUTDIR, NAME + '.json');
  fs.writeFileSync(file, JSON.stringify(clip));
  console.log('  wrote        ' + path.relative(process.cwd(), file) + '  ' + (fs.statSync(file).size / 1024).toFixed(0) + 'kB');
}
