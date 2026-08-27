#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — POSING AN FBX

   Reads a skeleton and its animation stacks out of a parsed FBX and hands back
   WORLD rotations per bone per frame — the same shape asf.mjs's forward() gives
   for CMU, so a retargeter can take either without caring which it got.

   Used by tools/mocap/retarget-ochi.mjs when the motion arrives as an FBX (a
   purchased pack, a Mixamo export, a MocapFlow bundle) rather than as CMU's
   .asf/.amc.

   THE REST POSE, WHICH IS THE WHOLE PROBLEM AGAIN. A rig's rest is what the
   animation is measured against, and FBX stores it in two different places
   depending on what the file is:

     * A file with a skinned mesh carries the true bind in each skin cluster's
       TransformLink — and its bone nodes' Lcl values are whatever POSE the file
       was saved on, which is not the rest at all. That caught fbx-to-glb out
       and tore a character into shards.
     * An animation-only file has no clusters, so the node Lcl values ARE the
       rest, and there is nothing else to use.

   So: clusters when they exist, node locals when they do not, and `restSource`
   says which was used rather than leaving it to be guessed at.
   ============================================================================ */
import { kid, kids, prop70, KTIME } from './fbx-read.mjs';

const D2R = Math.PI / 180;
const ORDER = ['XYZ', 'XZY', 'YZX', 'ZXY', 'YXZ', 'ZYX', 'XYZ'];

export const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];
export const qConj = q => [-q[0], -q[1], -q[2], q[3]];
export const qNorm = q => { const n = Math.hypot(...q) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
export function qRot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
export function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let e = b;
  if (d < 0) { e = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) return qNorm(a.map((v, i) => v + (e[i] - v) * t));
  const th = Math.acos(Math.max(-1, Math.min(1, d))), s = Math.sin(th) || 1;
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return qNorm(a.map((v, i) => v * wa + e[i] * wb));
}
export function eulerToQuat(x, y, z, order = 'XYZ') {
  const h = [x * D2R / 2, y * D2R / 2, z * D2R / 2];
  const q = { X: [Math.sin(h[0]), 0, 0, Math.cos(h[0])], Y: [0, Math.sin(h[1]), 0, Math.cos(h[1])], Z: [0, 0, Math.sin(h[2]), Math.cos(h[2])] };
  let o = [0, 0, 0, 1];
  /* Compose in REVERSE of the name. "XYZ" names the order the rotations are
     APPLIED, and quaternion multiplication applies right-to-left, so
     qZ * qY * qX is the one that turns about X first. Getting this backwards is
     invisible until a bone approaches gimbal lock and then it is catastrophic:
     Rokoko's treadmill run holds the pelvis at Y = 88 degrees, where X and Z
     trade off wildly against each other, and the wrong order put the spine
     upside down on 55 of 318 sampled frames. Right order: 0 of 318. */
  for (const a of [...order].reverse()) o = qMul(o, q[a]);
  return o;
}

const M4mul = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
};
export function quatOfMatrix(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  const tr = r[0] + r[4] + r[8];
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return qNorm([(r[5] - r[7]) / S, (r[6] - r[2]) / S, (r[1] - r[3]) / S, 0.25 * S]); }
  if (r[0] > r[4] && r[0] > r[8]) { const S = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; return qNorm([0.25 * S, (r[3] + r[1]) / S, (r[6] + r[2]) / S, (r[5] - r[7]) / S]); }
  if (r[4] > r[8]) { const S = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; return qNorm([(r[3] + r[1]) / S, 0.25 * S, (r[7] + r[5]) / S, (r[6] - r[2]) / S]); }
  const S = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
  return qNorm([(r[6] + r[2]) / S, (r[7] + r[5]) / S, 0.25 * S, (r[1] - r[3]) / S]);
}
function localMatrix(node) {
  const t = prop70(node, 'Lcl Translation') || [0, 0, 0];
  const r = prop70(node, 'Lcl Rotation') || [0, 0, 0];
  const s = prop70(node, 'Lcl Scaling') || [1, 1, 1];
  const ord = ORDER[(prop70(node, 'RotationOrder') || [0])[0]] || 'XYZ';
  const q = eulerToQuat(r[0] || 0, r[1] || 0, r[2] || 0, ord);
  const [x, y, z, w] = q;
  const sc = [s[0] == null ? 1 : s[0], s[1] == null ? 1 : s[1], s[2] == null ? 1 : s[2]];
  return [
    (1 - 2 * (y * y + z * z)) * sc[0], 2 * (x * y + z * w) * sc[0], 2 * (x * z - y * w) * sc[0], 0,
    2 * (x * y - z * w) * sc[1], (1 - 2 * (x * x + z * z)) * sc[1], 2 * (y * z + x * w) * sc[1], 0,
    2 * (x * z + y * w) * sc[2], 2 * (y * z - x * w) * sc[2], (1 - 2 * (x * x + y * y)) * sc[2], 0,
    t[0] || 0, t[1] || 0, t[2] || 0, 1
  ];
}

/* ------------------------------------------------------------------ public */
export function readRig(scene, opts = {}) {
  /* WHICH REST, AND IT DEPENDS WHAT YOU WANT IT FOR.

     A skinned file holds two different "rest" poses and they are not the same:
     the skin clusters' TransformLink (what the MESH is bound to) and the bone
     nodes' own Lcl values (what the ANIMATION CURVES continue). Measured on the
     Studio Ochi export they sit up to 163 degrees apart.

     So the answer depends on the question. For a TARGET character you want the
     cluster bind, because that is the pose the mesh deforms from — it is what
     fbx-to-glb needs and what gets the inverse binds right. For an animation
     SOURCE you want the node locals, because the curves are expressed in that
     space and a rotation is only meaningful against the rest it was measured
     from; pairing curve-composed world rotations with a cluster bind measures
     the gap between two unrelated poses and calls it motion.

     restFrom: 'clusters' | 'nodes' | 'auto' (clusters when present). */
  const restFrom = opts.restFrom || 'auto';
  const { byId, parentOf, childrenOf } = scene;
  const models = [...byId.values()].filter(o => o.type === 'Model');
  /* THE SKELETON IS NOT ONLY THE LimbNodes.

     Rokoko exports the chain `Sam[Root] > Root[Root] > Hips[LimbNode]`, and
     BOTH Root nodes carry animation curves — the character's whole world
     orientation lives up there. Keying the pose off LimbNodes alone drops it,
     which came out as a treadmill run rendered upside down with its head on the
     floor while every limb articulated correctly.

     So the skeleton is every LimbNode plus every Model ANCESTOR of one. The
     fingertip `*Tip` helpers are Roots too but they are leaves, not ancestors,
     and stay out. */
  const limbIds = new Set(models.filter(m => m.sub === 'LimbNode').map(m => m.id));
  const inRig = new Set(limbIds);
  for (const id of limbIds) {
    for (let p = parentOf.get(id); p != null && byId.has(p); p = parentOf.get(p)) {
      const o = byId.get(p);
      if (!o || o.type !== 'Model' || o.sub === 'Mesh') break;
      inRig.add(p);
    }
  }
  const limbs = models.filter(m => inRig.has(m.id));

  /* The bind, if there is one. */
  const bindG = new Map();
  for (const cl of [...byId.values()].filter(o => o.type === 'Deformer' && o.sub === 'Cluster')) {
    const bone = (childrenOf.get(cl.id) || []).map(x => byId.get(x.id)).find(o => o && o.type === 'Model');
    const TL = (kid(cl.node, 'TransformLink') || {}).props;
    if (bone && TL) bindG.set(bone.id, TL[0]);
  }
  const useClusters = restFrom === 'clusters' || (restFrom === 'auto' && bindG.size > 0);
  if (!useClusters) bindG.clear();
  const restSource = useClusters ? 'skin clusters (TransformLink)'
    : (restFrom === 'nodes' ? 'node locals (asked for: animation source)' : 'node locals (no skin in this file)');

  /* World rest matrix per model, from the bind where available and by composing
     locals where not. Parents before children. */
  const order = [];
  const seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    const p = parentOf.get(id);
    if (p != null && byId.has(p)) visit(p);
    order.push(id);
  };
  models.forEach(m => visit(m.id));
  const restWorld = new Map();
  for (const id of order) {
    const p = parentOf.get(id);
    const pg = p != null ? restWorld.get(p) : null;
    const g = bindG.get(id) || (pg ? M4mul(pg, localMatrix(byId.get(id).node)) : localMatrix(byId.get(id).node));
    restWorld.set(id, g);
  }

  const bones = new Map();
  for (const b of limbs) {
    const p = byId.get(parentOf.get(b.id));
    const g = restWorld.get(b.id);
    /* A root bone hangs off the armature (a Null carrying, for a Blender
       export, the -90 X of the Z-up conversion). The rest orientations here are
       WORLD, so composing bone locals alone would leave the pose armature-
       relative and the two would disagree by exactly that rotation. Seed the
       chain with it. */
    const isRoot = !(p && inRig.has(p.id));
    bones.set(b.name, {
      id: b.id,
      parent: isRoot ? null : p.name,
      sub: b.sub,
      parentId: p ? p.id : null,
      aboveQ: isRoot && p && restWorld.get(p.id) ? quatOfMatrix(restWorld.get(p.id)) : [0, 0, 0, 1],
      restWorldQ: quatOfMatrix(g),
      restPos: [g[12], g[13], g[14]]
    });
  }
  /* Rest DIRECTION: toward the child bone furthest away, which for a humanoid
     limb is the one that continues it. Measured, so no axis convention has to
     be declared; a tip with no children falls back to the bone's own +Y. */
  for (const [name, b] of bones) {
    let best = null, bestD = 0;
    for (const [cn, cb] of bones) {
      if (cb.parent !== name) continue;
      const d = Math.hypot(cb.restPos[0] - b.restPos[0], cb.restPos[1] - b.restPos[1], cb.restPos[2] - b.restPos[2]);
      if (d > bestD) { bestD = d; best = cb; }
    }
    if (best && bestD > 1e-6) {
      b.dir = [(best.restPos[0] - b.restPos[0]) / bestD, (best.restPos[1] - b.restPos[1]) / bestD, (best.restPos[2] - b.restPos[2]) / bestD];
    } else {
      b.dir = qRot(b.restWorldQ, [0, 1, 0]);
    }
    b.len = bestD;
  }
  return { bones, restSource, restWorld, byId, parentOf, childrenOf };
}

/* EULER CURVES HAVE TO BE UNWRAPPED BEFORE THEY CAN BE INTERPOLATED.

   An FBX rotation channel is degrees, and a bone whose angle sits near the
   +/-180 boundary crosses it constantly: consecutive keys read -177.5, then
   +178, which is a 4.5 degree move written as a 355 degree one. Interpolating
   that literally sweeps the long way round, and for the fraction of a frame in
   between the bone is pointing anywhere at all.

   Measured on Rokoko's treadmill run, whose Spine1 Z sits at -177.5: the spine
   pointed DOWN on 56 of 318 sampled frames — 18% of the clip — and the retarget
   window happened to start on one of them, so the heading correction was
   computed from a corrupt frame and the whole clip came out inverted.

   Adding or subtracting 360 so no step exceeds 180 makes the sequence
   continuous without changing any pose it passes through. Rotations only. */
function unwrapDegrees(vals) {
  if (vals.length < 2) return vals;
  const out = vals.slice();
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    while (d > 180) { out[i] -= 360; d = out[i] - out[i - 1]; }
    while (d < -180) { out[i] += 360; d = out[i] - out[i - 1]; }
  }
  return out;
}

/* Animation stacks, as sampled world rotations per bone. */
export function readClips(scene, rig) {
  const { byId, childrenOf, parentsOf } = scene;
  const stacks = [...byId.values()].filter(o => o.type === 'AnimationStack');
  const idToName = new Map([...rig.bones].map(([n, b]) => [b.id, n]));
  const out = [];
  for (const st of stacks) {
    const layers = (childrenOf.get(st.id) || []).map(c => byId.get(c.id)).filter(o => o && o.type === 'AnimationLayer');
    const curves = new Map();                      // boneName -> { R:{X,Y,Z}, T:{...} }
    for (const L of layers) {
      for (const cn of (childrenOf.get(L.id) || []).map(c => byId.get(c.id))) {
        if (!cn || cn.type !== 'AnimationCurveNode') continue;
        const target = (parentsOf.get(cn.id) || []).map(p => ({ o: byId.get(p.id), prop: p.prop }))
          .find(x => x.o && x.o.type === 'Model');
        if (!target) continue;
        const bone = idToName.get(target.o.id);
        if (!bone) continue;
        const kind = /Rotation/.test(target.prop || '') ? 'R' : /Translation/.test(target.prop || '') ? 'T' : null;
        if (!kind) continue;
        if (!curves.has(bone)) curves.set(bone, {});
        const slot = curves.get(bone);
        slot[kind] = slot[kind] || {};
        for (const cc of (childrenOf.get(cn.id) || [])) {
          const cur = byId.get(cc.id);
          if (!cur || cur.type !== 'AnimationCurve') continue;
          const axis = (cc.prop || 'd|X').slice(-1);
          const times = (kid(cur.node, 'KeyTime') || { props: [[]] }).props[0] || [];
          let vals = (kid(cur.node, 'KeyValueFloat') || { props: [[]] }).props[0] || [];
          if (kind === 'R') vals = unwrapDegrees(vals);
          slot[kind][axis] = { times: times.map(t => t / KTIME), vals };
        }
      }
    }
    if (!curves.size) continue;
    let t0 = Infinity, t1 = -Infinity;
    for (const [, s] of curves) for (const k of ['R', 'T']) for (const a of 'XYZ') {
      const c = s[k] && s[k][a];
      if (c && c.times.length) { t0 = Math.min(t0, c.times[0]); t1 = Math.max(t1, c.times[c.times.length - 1]); }
    }
    const stop = prop70(st.node, 'LocalStop');
    const duration = (t1 > t0) ? (t1 - t0) : (stop && stop[0] ? stop[0] / KTIME : 1);
    out.push({ name: st.name, curves, t0: isFinite(t0) ? t0 : 0, duration });
  }
  return out;
}

/* Full forward kinematics at time t: world rotations RELATIVE TO REST plus
   world POSITIONS, which is exactly the pair asf.mjs's forward() hands back for
   CMU. Positions are what a foot-contact test needs, and a retargeter that
   plants the target on the frames the SUBJECT was planted on needs them from
   the source rather than from its own output.

   A bone's position is its parent's plus the parent's CURRENT world rotation
   applied to the rest offset between them — the rest offset being fixed, since
   only rotation is animated below the root. */
export function poseFK(rig, clip, t) {
  const S = poseAt(rig, clip, t);
  const worldQ = new Map();
  const p = {};
  const order = [];
  const seen = new Set();
  const visit = n => {
    if (seen.has(n)) return;
    seen.add(n);
    const b = rig.bones.get(n);
    if (b && b.parent) visit(b.parent);
    order.push(n);
  };
  for (const [n] of rig.bones) visit(n);
  for (const n of order) {
    const b = rig.bones.get(n);
    /* Current world orientation = deviation-from-rest composed onto the rest. */
    const w = qNorm(qMul(S[n] || [0, 0, 0, 1], b.restWorldQ));
    worldQ.set(n, w);
    if (!b.parent) { p[n] = b.restPos.slice(); continue; }
    const pb = rig.bones.get(b.parent);
    const off = [b.restPos[0] - pb.restPos[0], b.restPos[1] - pb.restPos[1], b.restPos[2] - pb.restPos[2]];
    /* Rotate the rest offset by how far the PARENT has turned since rest. */
    const r = qRot(S[b.parent] || [0, 0, 0, 1], off);
    p[n] = [p[b.parent][0] + r[0], p[b.parent][1] + r[1], p[b.parent][2] + r[2]];
  }
  return { q: S, p };
}

/* World rotation per bone at time t, RELATIVE TO THE REST — which is what a
   retargeter wants, and what asf.mjs's forward() returns for CMU. */
export function poseAt(rig, clip, t) {
  const at = (c, dflt) => {
    if (!c || !c.times.length) return dflt;
    if (t <= c.times[0]) return c.vals[0];
    if (t >= c.times[c.times.length - 1]) return c.vals[c.vals.length - 1];
    let i = 0;
    while (i < c.times.length - 1 && c.times[i + 1] <= t) i++;
    const a = c.times[i], b = c.times[i + 1];
    const u = b > a ? (t - a) / (b - a) : 0;
    return c.vals[i] + (c.vals[i + 1] - c.vals[i]) * u;
  };
  const localQ = new Map();
  for (const [name, b] of rig.bones) {
    const s = clip.curves.get(name);
    if (s && s.R) {
      const node = rig.byId.get(b.id).node;
      const ord = ORDER[(prop70(node, 'RotationOrder') || [0])[0]] || 'XYZ';
      localQ.set(name, eulerToQuat(at(s.R.X, 0), at(s.R.Y, 0), at(s.R.Z, 0), ord));
      continue;
    }
    /* NOT ANIMATED: keep the BIND local and ride the parent. Falling back to
       the node's own Lcl rotation instead reads the frame the file was saved
       on, which for a skinned export is a pose — measured, that put `breast.L`
       and `breast.R` 163 degrees off their bind on every frame of every clip,
       because nothing animates them and nothing was putting them back. */
    const pq = b.parent ? rig.bones.get(b.parent).restWorldQ : b.aboveQ;
    localQ.set(name, qNorm(qMul(qConj(pq), b.restWorldQ)));
  }
  /* Compose to world, parents first. */
  const worldQ = new Map();
  const walk = name => {
    const b = rig.bones.get(name);
    const p = b.parent;
    const pq = p ? worldQ.get(p) : b.aboveQ;
    worldQ.set(name, qNorm(qMul(pq, localQ.get(name))));
    for (const [cn, cb] of rig.bones) if (cb.parent === name) walk(cn);
  };
  for (const [name, b] of rig.bones) if (!b.parent) walk(name);
  /* Relative to rest: S = W(t) * conj(W_rest). */
  const S = {};
  for (const [name, b] of rig.bones) {
    const w = worldQ.get(name);
    if (w) S[name] = qNorm(qMul(w, qConj(b.restWorldQ)));
  }
  return S;
}
