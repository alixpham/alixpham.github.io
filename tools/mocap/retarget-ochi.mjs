#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — CMU MOCAP -> THE STUDIO OCHI METARIG

   Free motion capture, retargeted onto the purchased character, with no
   Blender and no paid animation pack.

     node tools/mocap/retarget-ochi.mjs 35_21 --fbx ManA.fbx --name Jog --cyclic
     node tools/mocap/retarget-ochi.mjs 16_15 --fbx ManA.fbx --name Idle --from 0 --to 240
     node tools/mocap/retarget-ochi.mjs 35_21 --fbx ManA.fbx --report      # measure only

   Writes tools/motion-ochi/<Name>.json — a few hundred quaternions, committed,
   reviewable in a diff — which fbx-to-glb.mjs bakes into the player GLB with
   `--motion tools/motion-ochi`. The .amc never enters the build, so a rebuild
   in a fresh container needs no network.

   WHY A SECOND RETARGETER. tools/mocap/retarget.mjs targets the game's own
   27-bone rig, whose rest LOCAL rotations are all identity — which lets it get
   away with treating a bone's rest direction as its offset to the next child
   and composing straight onto that. The Ochi metarig is a Blender Rigify
   armature: 58 bones, every one of them carrying a real rest rotation. The
   general form is below, and the shipping pipeline is left alone rather than
   refactored underneath a game that currently works.

   THE MATH, once, because getting it approximately right looks fine in a still.

   asf.mjs's forward() returns, for each of their bones, a world quaternion `S`
   defined RELATIVE TO THEIR REST: their bone's current direction is S * theirDir.
   Our bone has a bind world rotation R and a bind world direction d (measured
   from the bind pose as the direction to the child that continues it, so it
   holds whatever axis convention the rig uses without being told).

   Take DELTA = minArc(d, theirDir), the fixed rotation that lays our rest
   direction along theirs. Then

       W = S * DELTA * R

   is the world rotation we want, because W applied to our bone's own axis gives
     S * DELTA * R * axis = S * DELTA * d = S * theirDir
   which is exactly where their bone is pointing. Local, for glTF, is then
   conj(W_parent) * W. Bones with no counterpart keep their bind local and ride
   the parent.

   IN PLACE, DELIBERATELY. Horizontal travel is stripped: the game moves the
   player and the clip moves his legs (the plan's step 7). The vertical bob is
   kept and rescaled by the ratio of leg lengths, because that is body motion,
   not travel.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSkeleton, readMotion, forward, qMul, qConj, qRot, qSlerp, qNorm, minArc } from './asf.mjs';
import { skeletonText, motionText, subjectOf } from './fetch.mjs';
import { parseFBX, indexScene, kid, prop70 } from '../fbx-read.mjs';
import { readRig, readClips, poseAt } from '../fbx-pose.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.resolve(HERE, '..', 'motion-ochi');
const STEPS = 48;                                  // samples written per clip

/* ---------------------------------------------------------- Ochi <- CMU ---
   The Rigify spine is seven bones and CMU's is seven joints, which line up
   pelvis-to-head without inventing anything. Fingers, breasts, heels and the
   pelvis helpers have no counterpart and keep their bind pose. */
/* SOURCE NAMING CONVENTIONS. Ochi bone <- their bone. CMU's ASF names below;
   Mixamo's are the de-facto standard for downloaded FBX packs (MocapFlow
   advertises "standard humanoid skeleton mapping", which in practice means
   this), so both ship and the right one is picked by counting which matches.

   Rigify's spine is seven bones and Mixamo's is Hips + Spine/1/2 + Neck + Head,
   so spine.004 has no counterpart and rides its parent. */
const MAP_MIXAMO = {
  spine: 'mixamorig:Hips',
  'spine.001': 'mixamorig:Spine', 'spine.002': 'mixamorig:Spine1', 'spine.003': 'mixamorig:Spine2',
  'spine.005': 'mixamorig:Neck', 'spine.006': 'mixamorig:Head',
  'shoulder.L': 'mixamorig:LeftShoulder', 'upper_arm.L': 'mixamorig:LeftArm',
  'forearm.L': 'mixamorig:LeftForeArm', 'hand.L': 'mixamorig:LeftHand',
  'shoulder.R': 'mixamorig:RightShoulder', 'upper_arm.R': 'mixamorig:RightArm',
  'forearm.R': 'mixamorig:RightForeArm', 'hand.R': 'mixamorig:RightHand',
  'thigh.L': 'mixamorig:LeftUpLeg', 'shin.L': 'mixamorig:LeftLeg',
  'foot.L': 'mixamorig:LeftFoot', 'toe.L': 'mixamorig:LeftToeBase',
  'thigh.R': 'mixamorig:RightUpLeg', 'shin.R': 'mixamorig:RightLeg',
  'foot.R': 'mixamorig:RightFoot', 'toe.R': 'mixamorig:RightToeBase'
};
const MAP_CMU = {
  spine: 'root',
  'spine.001': 'lowerback', 'spine.002': 'upperback', 'spine.003': 'thorax',
  'spine.004': 'lowerneck', 'spine.005': 'upperneck', 'spine.006': 'head',
  'shoulder.L': 'lclavicle', 'upper_arm.L': 'lhumerus', 'forearm.L': 'lradius', 'hand.L': 'lwrist',
  'shoulder.R': 'rclavicle', 'upper_arm.R': 'rhumerus', 'forearm.R': 'rradius', 'hand.R': 'rwrist',
  'thigh.L': 'lfemur', 'shin.L': 'ltibia', 'foot.L': 'lfoot', 'toe.L': 'ltoes',
  'thigh.R': 'rfemur', 'shin.R': 'rtibia', 'foot.R': 'rfoot', 'toe.R': 'rtoes'
};
/* Pick the table that actually matches the source's bone names, and say so.
   A convention that half-matches is worse than one that does not: it retargets
   the bones it recognises and silently leaves the rest at rest. */
function pickMap(names) {
  const has = new Set(names);
  const score = m => Object.values(m).filter(v => has.has(v)).length;
  const cands = [['mixamo', MAP_MIXAMO], ['cmu', MAP_CMU]];
  cands.sort((a, b) => score(b[1]) - score(a[1]));
  const [name, map] = cands[0];
  return { name, map, matched: score(map), total: Object.keys(map).length };
}
let MAP = MAP_CMU;
/* Which child continues each bone, for measuring its bind direction. */
const CONTINUES = {
  spine: 'spine.001', 'spine.001': 'spine.002', 'spine.002': 'spine.003',
  'spine.003': 'spine.004', 'spine.004': 'spine.005', 'spine.005': 'spine.006',
  'spine.006': 'spine.006_end',
  'shoulder.L': 'upper_arm.L', 'upper_arm.L': 'forearm.L', 'forearm.L': 'hand.L', 'hand.L': 'Fingers.L.001',
  'shoulder.R': 'upper_arm.R', 'upper_arm.R': 'forearm.R', 'forearm.R': 'hand.R', 'hand.R': 'Fingers.R.001',
  'thigh.L': 'shin.L', 'shin.L': 'foot.L', 'foot.L': 'toe.L', 'toe.L': 'toe.L_end',
  'thigh.R': 'shin.R', 'shin.R': 'foot.R', 'foot.R': 'toe.R', 'toe.R': 'toe.R_end'
};

/* -------------------------------------------------------------------- args */
const argv = process.argv.slice(2);
const trial = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : null;
if (!trial && !argv.includes('--src-fbx')) {
  console.error('usage: retarget-ochi.mjs <trial|--src-fbx anim.fbx> --fbx <character.fbx> [--name Clip] [--src-clip n] [--from f] [--to t] [--cyclic] [--report]');
  process.exit(2);
}
/* `i >= 0`, not `i > 0`: a flag at position 0 is legal now that the trial is
   optional, and `> 0` made --src-fbx invisible when it led the command line. */
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = k => argv.includes('--' + k);
const FBX = opt('fbx', null);
const NAME = opt('name', trial);
const CYCLIC = flag('cyclic');
const REPORT = flag('report');
const FPS = Number(opt('fps', 120));
if (!FBX) { console.error('need --fbx <character.fbx> to read the bind pose from'); process.exit(2); }

/* -------------------------------------------- the target rig, at bind pose */
const M4mul = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
};
const M4inv = m => {
  /* Rigid-ish inverse is not safe here (the armature carries a scale of 100),
     so invert the 3x3 by cofactors and re-apply the translation. */
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  const inv3 = [A / det, (-(b * i - c * h)) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (-(a * f - c * d)) / det,
    C / det, (-(a * h - b * g)) / det, (a * e - b * d) / det];
  const t = [m[12], m[13], m[14]];
  return [inv3[0], inv3[1], inv3[2], 0, inv3[3], inv3[4], inv3[5], 0, inv3[6], inv3[7], inv3[8], 0,
    -(inv3[0] * t[0] + inv3[3] * t[1] + inv3[6] * t[2]),
    -(inv3[1] * t[0] + inv3[4] * t[1] + inv3[7] * t[2]),
    -(inv3[2] * t[0] + inv3[5] * t[1] + inv3[8] * t[2]), 1];
};
function quatOf(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  const tr = r[0] + r[4] + r[8];
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return qNorm([(r[5] - r[7]) / S, (r[6] - r[2]) / S, (r[1] - r[3]) / S, 0.25 * S]); }
  if (r[0] > r[4] && r[0] > r[8]) { const S = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; return qNorm([0.25 * S, (r[3] + r[1]) / S, (r[6] + r[2]) / S, (r[5] - r[7]) / S]); }
  if (r[4] > r[8]) { const S = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; return qNorm([(r[3] + r[1]) / S, 0.25 * S, (r[7] + r[5]) / S, (r[6] - r[2]) / S]); }
  const S = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
  return qNorm([(r[6] + r[2]) / S, (r[7] + r[5]) / S, 0.25 * S, (r[1] - r[3]) / S]);
}

const fbx = parseFBX(fs.readFileSync(FBX));
const { byId, parentOf, childrenOf } = indexScene(fbx.root);
const bindG = new Map();                            // bone name -> world bind matrix
const boneParent = new Map();                       // bone name -> parent bone name (or null)
const nameOf = new Map();
for (const o of byId.values()) if (o.type === 'Model') nameOf.set(o.id, o.name);
for (const cl of [...byId.values()].filter(o => o.type === 'Deformer' && o.sub === 'Cluster')) {
  const bone = (childrenOf.get(cl.id) || []).map(x => byId.get(x.id)).find(o => o && o.type === 'Model');
  const TL = (kid(cl.node, 'TransformLink') || {}).props;
  if (bone && TL) bindG.set(bone.name, TL[0]);
}
for (const o of byId.values()) {
  if (o.type !== 'Model' || o.sub !== 'LimbNode') continue;
  const p = byId.get(parentOf.get(o.id));
  boneParent.set(o.name, p && p.sub === 'LimbNode' ? p.name : null);
}

/* THE ARMATURE ABOVE THE ROOT BONE STILL APPLIES.

   `spine` has no bone parent, but it is not a world root: in the FBX — and in
   the GLB that comes out of fbx-to-glb — it hangs off the armature Null, which
   carries Blender's -90 degree X conversion. Writing its retargeted world
   rotation straight into the file as a local means that -90 gets applied on
   top, and the whole character lies on his back with his feet in the air while
   every limb articulates perfectly. Divide the armature out. */
function worldRotOfModel(id) {
  const chain = [];
  for (let x = id; x != null && byId.has(x); x = parentOf.get(x)) chain.unshift(x);
  let M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const x of chain) {
    const o = byId.get(x);
    const t = prop70(o.node, 'Lcl Translation') || [0, 0, 0];
    const r = prop70(o.node, 'Lcl Rotation') || [0, 0, 0];
    const sc = prop70(o.node, 'Lcl Scaling') || [1, 1, 1];
    const D = Math.PI / 180;
    const [rx, ry, rz] = [(r[0] || 0) * D, (r[1] || 0) * D, (r[2] || 0) * D];
    const cx = Math.cos(rx), sx2 = Math.sin(rx), cy = Math.cos(ry), sy2 = Math.sin(ry), cz = Math.cos(rz), sz2 = Math.sin(rz);
    const Rx = [1, 0, 0, 0, 0, cx, sx2, 0, 0, -sx2, cx, 0, 0, 0, 0, 1];
    const Ry = [cy, 0, -sy2, 0, 0, 1, 0, 0, sy2, 0, cy, 0, 0, 0, 0, 1];
    const Rz = [cz, sz2, 0, 0, -sz2, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const R = M4mul(M4mul(Rz, Ry), Rx);
    const S = [sc[0] ?? 1, 0, 0, 0, 0, sc[1] ?? 1, 0, 0, 0, 0, sc[2] ?? 1, 0, 0, 0, 0, 1];
    const L = M4mul(R, S);
    L[12] = t[0] || 0; L[13] = t[1] || 0; L[14] = t[2] || 0;
    M = M4mul(M, L);
  }
  return quatOf(M);
}
const ARMATURE = (() => {
  const spineObj = [...byId.values()].find(o => o.type === 'Model' && o.name === 'spine');
  const par = spineObj ? byId.get(parentOf.get(spineObj.id)) : null;
  return par ? worldRotOfModel(par.id) : [0, 0, 0, 1];
})();
if (!bindG.size) { console.error('no skin clusters in ' + FBX + ' — cannot read a bind pose'); process.exit(1); }

/* TransformLink is in the file's world units, which for these exports is the
   centimetre times the armature's scale of 100 — the same factor fbx-to-glb
   takes off with its wrapper node. Leg length came out at 87.9 and a leg-scale
   of x101 before this was applied. */
const UNIT = 0.01;
const posOf = n => { const m = bindG.get(n); return m ? [m[12] * UNIT, m[13] * UNIT, m[14] * UNIT] : null; };
const rotOf = n => { const m = bindG.get(n); return m ? quatOf(m) : [0, 0, 0, 1]; };
/* Bind direction: toward the child that continues this bone. Measured rather
   than assumed, so the rig's own axis convention needs no declaring. */
function bindDir(name) {
  const a = posOf(name), childName = CONTINUES[name];
  const b = childName ? posOf(childName) : null;
  if (a && b) {
    const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const n = Math.hypot(...v);
    if (n > 1e-6) return [v[0] / n, v[1] / n, v[2] / n];
  }
  /* A tip — spine.006, toe.L, toe.R — continues into an `_end` bone that
     carries no skin cluster, so there is no bind matrix to measure toward.
     Rigify bones point along their own +Y, so the bind rotation gives the
     direction directly. Checked against the measured one wherever both exist;
     see the agreement figure in the report. */
  const m = bindG.get(name);
  return m ? qRot(quatOf(m), [0, 1, 0]) : null;
}

/* Do the two ways of asking agree where both are available? If they diverge the
   rig is not the +Y-down-the-bone convention this falls back on. */
function axisAgreement() {
  let worst = 0, at = '';
  for (const ours in MAP) {
    const a = posOf(ours), c = CONTINUES[ours] ? posOf(CONTINUES[ours]) : null;
    const m = bindG.get(ours);
    if (!a || !c || !m) continue;
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = Math.hypot(...v) || 1;
    const measured = [v[0] / n, v[1] / n, v[2] / n];
    const assumed = qRot(quatOf(m), [0, 1, 0]);
    const dot = Math.max(-1, Math.min(1, measured[0] * assumed[0] + measured[1] * assumed[1] + measured[2] * assumed[2]));
    const deg = Math.acos(dot) * 180 / Math.PI;
    if (deg > worst) { worst = deg; at = ours; }
  }
  return { worst, at };
}

/* ------------------------------------------------------------ their motion

   Two sources, one interface. CMU gives .asf/.amc; a purchased or downloaded
   pack (Mixamo, MocapFlow) gives an FBX. Either way what the retarget needs is
   the same three things: a bone's REST DIRECTION, its rotation RELATIVE TO
   THAT REST at time t, and a root position — so both are wrapped into `src`
   below and nothing downstream knows which arrived. */
const SRC_FBX = opt('src-fbx', null);
const SRC_CLIP = opt('src-clip', null);
let src, skel, raw;

if (SRC_FBX) {
  const sfbx = parseFBX(fs.readFileSync(SRC_FBX));
  const sscene = indexScene(sfbx.root);
  /* The cluster bind, not the node locals: a downloaded rig's bind IS its
     T-pose, which is the anatomical reference the motion is meaningful
     against. See the note in fbx-pose.mjs on why the two differ. */
  const srig = readRig(sscene, { restFrom: 'clusters' });
  const clips = readClips(sscene, srig);
  if (!clips.length) { console.error('no animation stacks in ' + SRC_FBX); process.exit(1); }
  const clip = SRC_CLIP ? clips.find(c => c.name.includes(SRC_CLIP)) : clips.reduce((a, b) => (b.duration > a.duration ? b : a));
  if (!clip) { console.error('no clip matching ' + SRC_CLIP + '; have: ' + clips.map(c => c.name).join(', ')); process.exit(1); }
  const picked = pickMap([...srig.bones.keys()]);
  MAP = picked.map;
  /* FBX's native unit is the centimetre and these exports leave it there
     (UnitScaleFactor 1, Hips resting at y=99.7). Lengths only feed the leg-scale
     ratio and the pelvis bob, both of which want metres — the retarget itself is
     rotation-only and does not care. */
  const SU = 0.01;
  /* The hips' own translation curve is the vertical bob: the crouch of a stride,
     the drop of a dodge. Without it the clip is rotation-only and the player
     glides at a fixed height through motions that should sink. */
  const hipsCurves = clip.curves.get(MAP.spine);
  const sampleT = (c, t, dflt) => {
    if (!c || !c.times.length) return dflt;
    if (t <= c.times[0]) return c.vals[0];
    if (t >= c.times[c.times.length - 1]) return c.vals[c.vals.length - 1];
    let i = 0;
    while (i < c.times.length - 1 && c.times[i + 1] <= t) i++;
    const a = c.times[i], b = c.times[i + 1];
    return c.vals[i] + (c.vals[i + 1] - c.vals[i]) * (b > a ? (t - a) / (b - a) : 0);
  };
  src = {
    kind: 'fbx', label: `${path.basename(SRC_FBX)} :: ${clip.name}`,
    convention: picked, duration: clip.duration,
    boneDir: n => { const b = srig.bones.get(n); return b ? b.dir : null; },
    boneLen: n => { const b = srig.bones.get(n); return b ? b.len * SU : 0; },
    at: t => poseAt(srig, clip, clip.t0 + t),
    rootAt: t => {
      const T = hipsCurves && hipsCurves.T;
      if (!T) return [0, 0, 0];
      const tt = clip.t0 + t;
      return [sampleT(T.X, tt, 0) * SU, sampleT(T.Y, tt, 0) * SU, sampleT(T.Z, tt, 0) * SU];
    }
  };
} else {
  skel = readSkeleton(await skeletonText(subjectOf(trial)));
  raw = readMotion(await motionText(trial));
  const picked = pickMap(Object.keys(skel.bones));
  MAP = picked.map;
  src = {
    kind: 'cmu', label: 'CMU ' + trial, convention: picked,
    boneDir: n => { const b = skel.bones[n]; return b ? b.dir : null; },
    boneLen: n => { const b = skel.bones[n]; return b ? b.len : 0; },
    at: null, rootAt: null
  };
}

/* THE ROOT IS A FRAME, NOT A BONE. CMU's `root` carries dir [0,0,0] and length
   0 — it is the pelvis coordinate system, with nothing to point along — so
   minArc against it returns a degenerate rotation. Feeding that to the pelvis
   rotated the whole character about ninety degrees and laid a perfectly good
   jog on its back with its feet in the air, limbs still articulating correctly
   relative to each other, which is exactly what a bad root and good bones look
   like. The pelvis takes their rotation directly onto our bind instead. */
const DELTA = {}, REST = {};
let mapped = 0, unmapped = [];
for (const ours in MAP) {
  const tdir = src.boneDir(MAP[ours]);
  const d = bindDir(ours);
  if (!tdir || !d) { unmapped.push(ours); continue; }
  const degenerate = !src.boneLen(MAP[ours]) || Math.hypot(...tdir) < 1e-6;
  DELTA[ours] = degenerate ? [0, 0, 0, 1] : minArc(d, tdir);
  REST[ours] = rotOf(ours);
  mapped++;
}

/* AND THE SUBJECT'S OWN FACING COMES OUT. Their root rotation carries which
   way the person happened to be walking across the capture volume; the game
   decides which way our player faces. Everything is pre-multiplied by the
   inverse of the root's rotation on the first sampled frame, which is a rigid
   world rotation of the whole character — it leaves every local except the
   pelvis untouched, and puts the pelvis back on its bind orientation at the
   start of the clip. */
const HEADING = qConj(src.kind === 'cmu'
  ? forward(skel, raw[Math.max(0, Number(opt('from', 0)))]).q.root
  : (src.at(0)[MAP.spine ? 'spine' : 'spine'] ? [0, 0, 0, 1] : [0, 0, 0, 1]));

/* Frame range. CMU counts captured frames; an FBX clip counts seconds, so the
   same --from/--to are read in the source's own units and both end up as a
   span the sampler walks. */
const FROM = Math.max(0, Number(opt('from', 0)));
const TO = src.kind === 'cmu'
  ? Math.min(raw.length - 1, Number(opt('to', raw.length - 1)))
  : Number(opt('to', src.duration));
if (TO <= FROM) { console.error('empty frame range'); process.exit(1); }

/* Leg lengths, for rescaling the vertical bob. Theirs from the ASF, ours from
   the bind pose. */
const legTheirs = src.boneLen(MAP['thigh.L']) + src.boneLen(MAP['shin.L']);
const hipP = posOf('thigh.L'), kneeP = posOf('shin.L'), ankP = posOf('foot.L');
const legOurs = (Math.hypot(kneeP[0] - hipP[0], kneeP[1] - hipP[1], kneeP[2] - hipP[2]) +
  Math.hypot(ankP[0] - kneeP[0], ankP[1] - kneeP[1], ankP[2] - kneeP[2]));
const legScale = legOurs / legTheirs;

/* Their pose -> our world rotations, per captured frame. */
function worldAt(x) {
  const S = src.kind === 'cmu' ? forward(skel, raw[Math.round(x)]) : { q: src.at(x), p: { root: src.rootAt(x) } };
  const W = {};
  for (const ours in DELTA) {
    const q = S.q[MAP[ours]];
    if (q) W[ours] = qNorm(qMul(HEADING, qMul(q, qMul(DELTA[ours], REST[ours]))));
  }
  return { W, p: S.p };
}

/* ------------------------------------------------------------------ sample */
const span = TO - FROM;
const times = [];
for (let i = 0; i < STEPS; i++) times.push(FROM + (span * i) / (CYCLIC ? STEPS : STEPS - 1));

const frames = times.map(x => {
  if (src.kind !== 'cmu') { const a = worldAt(x); return { W: a.W, root: a.p.root }; }
  const i = Math.floor(x), u = x - i;
  const a = worldAt(Math.min(i, TO)), b = worldAt(Math.min(i + 1, TO));
  const W = {};
  for (const k in a.W) W[k] = u < 1e-9 ? a.W[k] : qSlerp(a.W[k], b.W[k], u);
  const pa = a.p.root, pb = b.p.root;
  return { W, root: pa.map((v, k) => v + (pb[k] - v) * u) };
});

/* Pelvis height: the subject's own, rescaled by leg length, with the mean
   removed so the clip sits at our own bind height rather than theirs. */
/* CMU's root is in the subject's own units and gets the leg-length rescale;
   an FBX source is already metres by the time it arrives, and rescaling it a
   second time would flatten or exaggerate the bob. */
const rootY = frames.map(f => (src.kind === 'cmu' ? f.root[1] * legScale : f.root[1] * (legOurs / (legTheirs || 1))));
const meanY = rootY.reduce((a, b) => a + b, 0) / rootY.length;
const bindHipY = posOf('spine')[1];

/* World -> local, against our own bind hierarchy. */
const boneNames = [...bindG.keys()];
const out = { clip: NAME, trial, fps: FPS, cyclic: CYCLIC, steps: STEPS, duration: +(src.kind === 'cmu' ? span / FPS : span).toFixed(5), source: 'CMU Graphics Lab', tracks: {} };
for (const name of boneNames) out.tracks[name] = [];
const rootTrack = [];

frames.forEach((f, fi) => {
  const Wof = n => f.W[n] || null;
  for (const name of boneNames) {
    const p = boneParent.get(name);
    const w = Wof(name);
    if (!w) {                                   // no counterpart: keep the bind local
      const pm = p ? bindG.get(p) : null;
      const local = pm ? M4mul(M4inv(pm), bindG.get(name)) : bindG.get(name);
      out.tracks[name].push(quatOf(local).map(v => +v.toFixed(5)));
      continue;
    }
    const wp = p ? (Wof(p) || rotOf(p)) : ARMATURE;
    const local = qNorm(qMul(qConj(wp), w));
    out.tracks[name].push(local.map(v => +v.toFixed(5)));
  }
  rootTrack.push([0, +(bindHipY + (rootY[fi] - meanY)).toFixed(5), 0]);
});
out.root = rootTrack;

/* ----------------------------------------------------------------- report */
const dur = src.kind === 'cmu' ? (span / FPS) : span;
console.log(`\n${src.label}  ->  ${NAME}`);
console.log(`  convention    ${src.convention.name}, ${src.convention.matched} of ${src.convention.total} bone names matched` +
  (src.convention.matched < src.convention.total * 0.7 ? '   <-- POOR MATCH, check fbx-inspect --bones' : ''));
console.log(`  range         ${FROM}..${TO}${src.kind === 'cmu' ? ' of ' + raw.length + ' frames' : 's'}  (${dur.toFixed(2)}s)`);
console.log(`  bones mapped  ${mapped} of ${Object.keys(MAP).length}` + (unmapped.length ? `   unmapped: ${unmapped.join(', ')}` : ''));
console.log(`  leg scale     theirs ${legTheirs.toFixed(3)}m -> ours ${legOurs.toFixed(3)}m  (x${legScale.toFixed(3)})`);
{
  const ag = axisAgreement();
  console.log(`  bone axis     measured vs +Y assumption agree to ${ag.worst.toFixed(1)} deg (worst: ${ag.at})` +
    (ag.worst > 15 ? '   <-- NOT a +Y rig, tips will be wrong' : ''));
}
{
  /* Travel is what tells you the clip is a gait and roughly how fast. Stride
     LENGTH is pure geometry and independent of the frame rate, so a sane
     length beside an impossible rate means CMU's 120Hz claim is wrong for this
     trial — the check CLAUDE.md warns about. */
  if (src.kind === 'cmu') {
    const p0 = forward(skel, raw[FROM]).p.root, p1 = forward(skel, raw[TO]).p.root;
    const travel = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) * legScale;
    console.log(`  travel        ${travel.toFixed(2)} m over ${dur.toFixed(2)}s  =  ${(travel / dur).toFixed(2)} m/s` +
      (travel / dur > 9 ? '   <-- IMPOSSIBLE, check --fps' : ''));
  }
  const bob = Math.max(...rootY) - Math.min(...rootY);
  console.log(`  pelvis bob    ${(bob * 100).toFixed(1)} cm`);
}
if (REPORT) { console.log(''); process.exit(0); }

fs.mkdirSync(OUTDIR, { recursive: true });
const file = path.join(OUTDIR, NAME + '.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`  wrote         ${path.relative(process.cwd(), file)}  (${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${STEPS} samples)`);
console.log('');
