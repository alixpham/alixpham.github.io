#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — REBUILD A SKINNED GLB ONTO THIS GAME'S RIG CONVENTIONS

     node tools/glb-rerig.mjs ochi.glb player.glb --preset ochi
     node tools/glb-rerig.mjs ochi.glb --report

   WHAT THE GAME ASSUMES, and no bought character honours.

   `rig-def.mjs` says it in one line — "no bone carries a rest ROTATION" — and
   the whole renderer is built on it. `playermodel.js` hangs the chest number
   off the Chest bone at "plain metres relative to the chest joint";
   `field3d.js` puts the ball in `Socket_Hand_R` at a fixed offset and poses a
   carrying arm by writing euler triples straight onto `UpperArm_*`. Every one
   of those is only meaningful because a Flagster bone's rest frame is the
   WORLD frame.

   A Rigify armature is the opposite: 58 bones, every one carrying a real rest
   rotation, each pointing down its own +Y. Hang the number decal off Ochi's
   spine.002 and it lies at whatever angle the spine happens to lean.

   So this does not adapt the game to the character. It rebuilds the character
   onto the game's conventions:

     * EVERY bone's rest rotation becomes identity, at the position it already
       occupied. Rest frames are world-aligned, so an offset in metres means
       what it says everywhere the game already assumes it does.
     * The mesh is baked into that world space — Y-up, metres, feet on zero —
       and the FBX unit wrapper goes away with it.
     * Every animation is rewritten into the new hierarchy. Nothing is
       resampled and nothing is approximated: a pose's WORLD rotations are
       invariant, so the conversion is exact.
     * Bones are renamed to the vocabulary the game reaches for by name, and
       the four sockets it attaches to are added.

   THE CONVERSION, once. Write R_j for joint j's rest world rotation in the
   source rig, and W_old(j) for its world rotation in some pose. Define

       W_new(j) = W_old(j) * conj(R_j)

   which is identity at rest, as the new hierarchy requires. It is also the
   RIGHT answer rather than merely a convenient one: a child's world offset is
   W(parent) * offset(parent frame), the new rest offset is the old one taken
   into world (R_parent * offset_old), and

       W_new(parent) * offset_new = W_old(parent) * conj(R_p) * R_p * offset_old
                                  = W_old(parent) * offset_old

   so every joint lands exactly where it did. Local, for glTF, is then
   conj(W_new(parent)) * W_new(j).

   SOCKETS ARE MEASURED, NOT COPIED. `rig-def.mjs` puts the hand socket 9 cm
   "down" the hand, which is only down because the game's rig rests with its
   arms at its sides. Ochi rests in an A-pose with the arms out at 28 degrees,
   so the same triple would hang the ball in mid-air beside the hip. The palm
   is found instead from the MESH — the centroid of the vertices this hand
   actually owns — which needs no convention at all.

   WHAT CANNOT BE FIXED HERE is that a rest DIRECTION is still the source's.
   The game's upper arm rests pointing down and Ochi's rests pointing out and
   down, so a hand-authored euler triple meant for one does not mean the same
   on the other. The rotation that carries one rest direction onto the other is
   a per-bone constant, so it is measured here and written to the scene's
   `extras.restAlign`; `playermodel.js` hands it to the renderer, which
   composes it onto any pose it authors itself. It is identity for every bone
   of the game's own player, which is why nothing changes there.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB, accessor, nodeIndex, NCOMP, CTYPE } from './glb-read.mjs';
import { BONE_MAP, CONTINUES, TIP_DIR, HEIGHT_M } from './rig-def.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------- args */
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && opt(argv[i - 1].slice(2)) === a));
const SRC = positional[0];
const REPORT = has('report');
const OUT = REPORT ? null : positional[1];
if (!SRC || (!REPORT && !OUT)) {
  console.error('usage: node tools/glb-rerig.mjs <in.glb> <out.glb> [--preset ochi]');
  console.error('       node tools/glb-rerig.mjs <in.glb> --report');
  process.exit(2);
}

/* Studio Ochi's Rigify metarig -> the vocabulary the game calls bones by.
   Only the bones the game or the renderer names need to appear; the other 40
   keep their own names, because nothing looks them up and a rename that means
   nothing is a rename that misleads. Rigify's spine.003 and spine.004 have no
   counterpart in a five-bone spine and keep theirs for the same reason. */
const PRESETS = {
  ochi: {
    spine: 'Hips', 'spine.001': 'Spine', 'spine.002': 'Chest',
    'spine.005': 'Neck', 'spine.006': 'Head',
    'shoulder.L': 'Shoulder_L', 'upper_arm.L': 'UpperArm_L', 'forearm.L': 'LowerArm_L', 'hand.L': 'Hand_L',
    'shoulder.R': 'Shoulder_R', 'upper_arm.R': 'UpperArm_R', 'forearm.R': 'LowerArm_R', 'hand.R': 'Hand_R',
    'thigh.L': 'UpperLeg_L', 'shin.L': 'LowerLeg_L', 'foot.L': 'Foot_L', 'toe.L': 'Toe_L',
    'thigh.R': 'UpperLeg_R', 'shin.R': 'LowerLeg_R', 'foot.R': 'Foot_R', 'toe.R': 'Toe_R'
  }
};
const RENAME = PRESETS[opt('preset', 'ochi')] || {};

/* ------------------------------------------------------------------- math */
const mul4 = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
};
const trsMat = n => {
  const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [X, Y, Z, W] = r, x2 = X + X, y2 = Y + Y, z2 = Z + Z;
  return [
    (1 - (Y * y2 + Z * z2)) * s[0], (X * y2 + W * z2) * s[0], (X * z2 - W * y2) * s[0], 0,
    (X * y2 - W * z2) * s[1], (1 - (X * x2 + Z * z2)) * s[1], (Y * z2 + W * x2) * s[1], 0,
    (X * z2 + W * y2) * s[2], (Y * z2 - W * x2) * s[2], (1 - (X * x2 + Y * y2)) * s[2], 0,
    t[0], t[1], t[2], 1];
};
const IDENT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const xform = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const xformDir = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const qConj = q => [-q[0], -q[1], -q[2], q[3]];
const qNorm = q => { const L = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / L, q[1] / L, q[2] / L, q[3] / L]; };
const qRot = (q, v) => {
  const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
  return [v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1],
    v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2],
    v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0]];
};
/* The shortest rotation carrying a onto b. The antiparallel case has no
   shortest arc at all — any axis perpendicular to a does it — so one is
   chosen rather than divided by zero. */
function minArc(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {
    let ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const c = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]];
    const L = Math.hypot(...c) || 1;
    return [c[0] / L, c[1] / L, c[2] / L, 0];
  }
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return qNorm([c[0], c[1], c[2], 1 + d]);
}
function quatOfMat(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  const tr = r[0] + r[4] + r[8];
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; return qNorm([(r[5] - r[7]) / S, (r[6] - r[2]) / S, (r[1] - r[3]) / S, 0.25 * S]); }
  if (r[0] > r[4] && r[0] > r[8]) { const S = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; return qNorm([0.25 * S, (r[3] + r[1]) / S, (r[6] + r[2]) / S, (r[5] - r[7]) / S]); }
  if (r[4] > r[8]) { const S = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; return qNorm([(r[3] + r[1]) / S, 0.25 * S, (r[7] + r[5]) / S, (r[6] - r[2]) / S]); }
  const S = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2;
  return qNorm([(r[6] + r[2]) / S, (r[7] + r[5]) / S, 0.25 * S, (r[1] - r[3]) / S]);
}

/* ==================================================================== read */
const g = readGLB(SRC);
const J = g.json;
const { nodes, parent, byName } = nodeIndex(g);
if (!J.skins || !J.skins.length) { console.error('not a skinned model'); process.exit(1); }
const skin = J.skins[0];
const joints = skin.joints;
const jointOf = new Map(joints.map((n, i) => [n, i]));

const worldCache = new Map();
function worldOf(i) {
  if (worldCache.has(i)) return worldCache.get(i);
  const m = parent[i] >= 0 ? mul4(worldOf(parent[i]), trsMat(nodes[i])) : trsMat(nodes[i]);
  worldCache.set(i, m);
  return m;
}

const IBM = accessor(g, skin.inverseBindMatrices);
const ibmOf = j => Array.from(IBM.subarray(j * 16, j * 16 + 16));

/* SKIN SPACE IS NOT MESH SPACE, and only the MESH needs moving. glTF says a
   skinned mesh node's own transform is ignored; where a vertex actually lands
   is jointWorld * IBM applied through its weights. At the bind pose that
   product is one fixed matrix for every joint — here, the Z-up-to-Y-up turn
   the FBX conversion folded into the inverse binds — so it is exactly the
   matrix that carries the stored vertices into the space the JOINTS ALREADY
   LIVE IN. The joints need nothing: their world transforms are already Y-up
   metres, the unit wrapper's 1/100 having cancelled the armature's 100.
   Applying this to them as well shrank the player to ten centimetres and put
   every rest direction 80 degrees out, which is what the report said before
   anything was rendered. */
const bindWorld = joints.map(n => worldOf(n));
const bakeM = mul4(bindWorld[0], ibmOf(0));

/* ------------------------------------------------------------------- mesh */
const meshNodes = nodes.map((n, i) => ({ n, i })).filter(x => x.n.mesh != null && x.n.skin != null);
if (!meshNodes.length) { console.error('no skinned mesh node'); process.exit(1); }

/* ---------------------------------------------------------- the new rig */
/* Every joint keeps its position and loses its rest rotation. */
const restPos = bindWorld.map(m => [m[12], m[13], m[14]]);
const restRot = bindWorld.map(m => quatOfMat(m));

/* Parent, in joint indices. A joint's parent is its nearest ancestor that is
   also a joint; anything between is scene furniture (the armature, the unit
   wrapper) and is about to disappear. */
const jparent = joints.map(n => {
  for (let x = parent[n]; x >= 0; x = parent[x]) if (jointOf.has(x)) return jointOf.get(x);
  return -1;
});

const nameOfJoint = joints.map(n => nodes[n].name || 'bone');
const newName = nameOfJoint.map(nm => RENAME[nm] || nm);

/* WHERE A BONE POINTS AT REST, asked the same way on both rigs: from this
   bone to the child that CONTINUES it, per rig-def's table. "The longest
   child" is the tempting rule and it is wrong at the pelvis, whose longest
   child is a thigh pointing at the floor while the game's is the spine
   pointing at the ceiling — which reported the hips 90 degrees out from
   themselves before this used the table. */
const jointByNewName = {};
newName.forEach((nm, j) => { if (jointByNewName[nm] === undefined) jointByNewName[nm] = j; });

function restDirOf(name) {
  const j = jointByNewName[name];
  if (j === undefined) return null;
  const c = jointByNewName[CONTINUES[name]];
  if (c === undefined) return TIP_DIR[name] || null;
  const v = [restPos[c][0] - restPos[j][0], restPos[c][1] - restPos[j][1], restPos[c][2] - restPos[j][2]];
  const L = Math.hypot(...v);
  return L > 1e-6 ? [v[0] / L, v[1] / L, v[2] / L] : null;
}
/* The game's own, out of the bone table: a child's offset IS the direction. */
function gameDirOf(name) {
  const c = CONTINUES[name];
  const off = c && BONE_MAP[c] ? BONE_MAP[c].offset : null;
  if (!off) return TIP_DIR[name] || null;
  const L = Math.hypot(...off);
  return L > 1e-6 ? off.map(v => v / L) : null;
}

/* restAlign: the constant that carries OUR rest direction onto the game's, so
   a triple authored against the game's rig means the same thing here. */
const restAlign = {};
for (let j = 0; j < joints.length; j++) {
  const nm = newName[j];
  if (!BONE_MAP[nm] || !CONTINUES[nm]) continue;
  const a = restDirOf(nm), b = gameDirOf(nm);
  if (!a || !b) continue;
  const q = minArc(a, b);
  const deg = 2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180 / Math.PI;
  if (deg > 0.5) restAlign[nm] = q.map(v => +v.toFixed(6));
}

/* --------------------------------------------------------------- sockets */
/* Measured off the mesh: a socket goes where the flesh is, not where another
   rig's rest pose happened to put it. */
function palmOf(handJoint) {
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const { n: mn } of meshNodes) {
    for (const prim of J.meshes[mn.mesh].primitives) {
      if (prim.attributes.JOINTS_0 == null) continue;
      const P = accessor(g, prim.attributes.POSITION);
      const JO = accessor(g, prim.attributes.JOINTS_0);
      const WE = accessor(g, prim.attributes.WEIGHTS_0);
      const sc = WE instanceof Float32Array ? 1 : 1 / (WE instanceof Uint8Array ? 255 : 65535);
      for (let i = 0; i < P.length / 3; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (JO[i * 4 + k] === handJoint) w += WE[i * 4 + k] * sc;
        if (w < 0.5) continue;
        const p = xform(bakeM, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
        sx += p[0]; sy += p[1]; sz += p[2]; n++;
      }
    }
  }
  return n ? [sx / n, sy / n, sz / n] : null;
}

const extraBones = [];                        // {name, parentJoint, offset}
for (const side of ['L', 'R']) {
  const hj = newName.indexOf('Hand_' + side);
  if (hj >= 0) {
    const palm = palmOf(hj) || restPos[hj];
    extraBones.push({ name: 'Socket_Hand_' + side, parentJoint: hj, offset: [palm[0] - restPos[hj][0], palm[1] - restPos[hj][1], palm[2] - restPos[hj][2]] });
  }
}
/* The flags hang off the hips. Their offsets are the game's, scaled by how
   much narrower this pelvis is — the one number that makes ±22 cm mean "at the
   side of THIS player" rather than "at the side of the other one". */
{
  const hip = newName.indexOf('Hips');
  const upL = newName.indexOf('UpperLeg_L');
  if (hip >= 0 && upL >= 0) {
    const halfOurs = Math.abs(restPos[upL][0] - restPos[hip][0]) || 1;
    const k = halfOurs / Math.abs(BONE_MAP.UpperLeg_L.offset[0]);
    for (const side of ['L', 'R']) {
      const o = BONE_MAP['Socket_Flag_' + side].offset;
      extraBones.push({ name: 'Socket_Flag_' + side, parentJoint: hip, offset: [o[0] * k, o[1] * k, o[2] * k] });
    }
  }
}

/* ------------------------------------------------------------- animations */
/* W_new(j) = W_old(j) * conj(R_j), then local against the new parent. */
const skippedScale = [];
function convertAnimations() {
  const out = [];
  for (const anim of J.animations || []) {
    /* Sample every joint's old local rotation on the union of the clip's own
       key times — no resampling, because those are the only times anything
       changes and LINEAR between them is what the file already means. */
    const rotTracks = new Map();   // node -> {times, values}
    const posTracks = new Map();
    let times = [];
    /* A SCALE TRACK CANNOT COME THROUGH THIS. The conversion is rotation and
       translation only — a per-bone scale changes both the bone's own size and
       where its children sit, and there is no rest scale to divide out of it.
       Studio Ochi's six bundled clips carry one on all 43 bones, and ignoring
       them threw a vertex 14 metres. The game does not use those clips, so the
       honest answer is to say so and drop them rather than emit a wreck. */
    if (anim.channels.some(ch => ch.target.path === 'scale')) {
      skippedScale.push(anim.name);
      continue;
    }
    for (const ch of anim.channels) {
      const s = anim.samplers[ch.sampler];
      const t = Array.from(accessor(g, s.input));
      const vflat = accessor(g, s.output);
      const n = ch.target.path === 'rotation' ? 4 : 3;
      const v = [];
      for (let i = 0; i < t.length; i++) v.push(Array.from(vflat.subarray(i * n, i * n + n)));
      (ch.target.path === 'rotation' ? rotTracks : posTracks).set(ch.target.node, { times: t, values: v });
      times = times.concat(t);
    }
    times = [...new Set(times.map(v => +v.toFixed(6)))].sort((a, b) => a - b);
    if (!times.length) continue;

    const pick = (tr, t, slerp) => {
      if (!tr) return null;
      const T = tr.times, V = tr.values;
      if (t <= T[0]) return V[0];
      if (t >= T[T.length - 1]) return V[V.length - 1];
      let i = 0;
      while (i < T.length - 2 && T[i + 1] < t) i++;
      const u = (t - T[i]) / (T[i + 1] - T[i]);
      if (!slerp) return V[i].map((x, k) => x + (V[i + 1][k] - x) * u);
      let d = V[i][0] * V[i + 1][0] + V[i][1] * V[i + 1][1] + V[i][2] * V[i + 1][2] + V[i][3] * V[i + 1][3];
      let b = V[i + 1];
      if (d < 0) { b = b.map(x => -x); d = -d; }
      return qNorm(V[i].map((x, k) => x + (b[k] - x) * u));
    };

    const newRot = joints.map(() => []);
    const newPos = joints.map(() => []);
    for (const t of times) {
      /* Old world rotation AND position, down the joint tree. Position matters
         because a clip may translate a bone, and a translation is expressed in
         its parent's frame — a frame this rerig is about to change. */
      const Wold = new Array(joints.length), Pold = new Array(joints.length);
      const solve = j => {
        if (Wold[j]) return j;
        const nodeI = joints[j];
        const lq = pick(rotTracks.get(nodeI), t, true) || nodes[nodeI].rotation || [0, 0, 0, 1];
        const lt = pick(posTracks.get(nodeI), t, false) || nodes[nodeI].translation || [0, 0, 0];
            const p = jparent[j];
        if (p >= 0) {
          solve(p);
          Wold[j] = qNorm(qMul(Wold[p], lq));
          const d = qRot(Wold[p], lt);
          Pold[j] = [Pold[p][0] + d[0], Pold[p][1] + d[1], Pold[p][2] + d[2]];
        } else {
          /* Above the root joint sits scene furniture — the armature and the
             unit wrapper — which never animates, so its bind transform is the
             frame this bone's own local is expressed in. */
          const above = parent[nodeI] >= 0 ? worldOf(parent[nodeI]) : IDENT4;
          Wold[j] = qNorm(qMul(quatOfMat(above), lq));
          Pold[j] = xform(above, lt);
        }
        return j;
      };
      for (let j = 0; j < joints.length; j++) solve(j);

      const Wnew = Wold.map((w, j) => qNorm(qMul(w, qConj(restRot[j]))));
      for (let j = 0; j < joints.length; j++) {
        const p = jparent[j];
        newRot[j].push((p >= 0 ? qNorm(qMul(qConj(Wnew[p]), Wnew[j])) : Wnew[j]).map(v => +v.toFixed(6)));
        /* The new local translation is the world offset from the new parent,
           taken back into the new parent's frame. At rest it reproduces the
           bind offset exactly; under a clip that moves a bone it follows. */
        const d = p >= 0
          ? qRot(qConj(Wnew[p]), [Pold[j][0] - Pold[p][0], Pold[j][1] - Pold[p][1], Pold[j][2] - Pold[p][2]])
          : Pold[j];
        newPos[j].push(d.map(v => +v.toFixed(6)));
        if (p >= 0) {
          const r = jparent[j] >= 0 ? [restPos[j][0] - restPos[p][0], restPos[j][1] - restPos[p][1], restPos[j][2] - restPos[p][2]] : restPos[j];
          if (Math.hypot(d[0] - r[0], d[1] - r[1], d[2] - r[2]) > 1e-5) movesBesidesRoot = true;
        }
      }
    }
    out.push({ name: anim.name, extras: anim.extras, times, newRot, newPos });
  }
  return out;
}

/* ==================================================================== emit */
const anims = convertAnimations();

if (REPORT) {
  console.log(`\n${path.basename(SRC)}`);
  console.log(`  joints        ${joints.length}, renamed ${Object.keys(RENAME).filter(k => nameOfJoint.includes(k)).length}`);
  console.log(`  height        ${Math.max(...restPos.map(p => p[1])).toFixed(3)} m at the topmost joint (game rig: ${HEIGHT_M})`);
  console.log(`  sockets       ${extraBones.map(b => b.name).join(', ') || '(none)'}`);
  console.log(`  animations    ${anims.length}`);
  console.log('  restAlign     how far each rest direction sits from the game\'s:');
  for (const k in restAlign) {
    const deg = 2 * Math.acos(Math.min(1, Math.abs(restAlign[k][3]))) * 180 / Math.PI;
    console.log(`      ${k.padEnd(14)} ${deg.toFixed(1)} deg`);
  }
  if (!Object.keys(restAlign).length) console.log('      (none — every rest direction already matches)');
  console.log('');
  process.exit(0);
}

/* ------------------------------------------------------------ new document */
const bin = [];
let binLen = 0;
const out = {
  asset: { version: '2.0', generator: 'flagster glb-rerig' },
  scenes: [{ nodes: [] }], scene: 0, nodes: [], meshes: [], accessors: [], bufferViews: [],
  materials: JSON.parse(JSON.stringify(J.materials || [])), skins: [], animations: []
};
if (J.textures) out.textures = JSON.parse(JSON.stringify(J.textures));
if (J.samplers) out.samplers = JSON.parse(JSON.stringify(J.samplers));
if (J.images) out.images = JSON.parse(JSON.stringify(J.images));

function pushView(bytes, target) {
  while (binLen % 4) { bin.push(Buffer.alloc(1)); binLen++; }
  const v = { buffer: 0, byteOffset: binLen, byteLength: bytes.length };
  if (target) v.target = target;
  out.bufferViews.push(v);
  bin.push(bytes); binLen += bytes.length;
  return out.bufferViews.length - 1;
}
function pushAccessor(arr, type, componentType, target, minmax) {
  const view = pushView(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), target);
  const n = NCOMP[type];
  const a = { bufferView: view, componentType, count: arr.length / n, type };
  if (minmax) {
    const mn = new Array(n).fill(Infinity), mx = new Array(n).fill(-Infinity);
    for (let i = 0; i < arr.length; i++) { const k = i % n; mn[k] = Math.min(mn[k], arr[i]); mx[k] = Math.max(mx[k], arr[i]); }
    a.min = mn; a.max = mx;
  }
  out.accessors.push(a);
  return out.accessors.length - 1;
}

/* --- the skeleton --- */
const nodeFor = new Array(joints.length);
for (let j = 0; j < joints.length; j++) {
  const p = jparent[j];
  const off = p >= 0
    ? [restPos[j][0] - restPos[p][0], restPos[j][1] - restPos[p][1], restPos[j][2] - restPos[p][2]]
    : restPos[j].slice();
  out.nodes.push({ name: newName[j], translation: off.map(v => +v.toFixed(6)) });
  nodeFor[j] = out.nodes.length - 1;
}
for (let j = 0; j < joints.length; j++) {
  const p = jparent[j];
  if (p < 0) continue;
  (out.nodes[nodeFor[p]].children ||= []).push(nodeFor[j]);
}
/* A SOCKET HAS TO BE A JOINT. GLTFLoader only builds a THREE.Bone for a node
   some skin lists, and `playermodel.js` collects sockets with `if (o.isBone)`
   — so a socket added as a plain node is invisible to the game and the ball
   attaches to nothing. Nothing is weighted to them; they ride the hand and the
   hips purely as attachment points, exactly as they do on the game's own rig. */
const socketNode = [];
for (const b of extraBones) {
  out.nodes.push({ name: b.name, translation: b.offset.map(v => +v.toFixed(6)) });
  socketNode.push(out.nodes.length - 1);
  (out.nodes[nodeFor[b.parentJoint]].children ||= []).push(out.nodes.length - 1);
}

/* --- inverse binds: translation only, since the rest carries no rotation --- */
const socketWorld = extraBones.map(b => [
  restPos[b.parentJoint][0] + b.offset[0], restPos[b.parentJoint][1] + b.offset[1], restPos[b.parentJoint][2] + b.offset[2]]);
const allRest = restPos.concat(socketWorld);
const ibmNew = new Float32Array(allRest.length * 16);
for (let j = 0; j < allRest.length; j++) {
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -allRest[j][0], -allRest[j][1], -allRest[j][2], 1];
  ibmNew.set(m, j * 16);
}
out.skins.push({
  inverseBindMatrices: pushAccessor(ibmNew, 'MAT4', 5126, null),
  joints: joints.map((_, j) => nodeFor[j]).concat(socketNode),
  skeleton: nodeFor[joints.findIndex((_, j) => jparent[j] < 0)]
});

/* --- the mesh, baked into world space --- */
/* PRIMITIVES SHARE ACCESSORS, AND MUST GO ON SHARING THEM. glb-repaint splits
   the mesh into one primitive per paint region precisely so that all of them
   keep pointing at the SAME position, normal, joint and weight data — only the
   index buffer differs. Rebuilding each primitive's attributes independently
   copied that data nine times and took an 833 KB player to 2.4 MB. Keyed by
   the source accessor, so the sharing survives. */
const attrCache = new Map();
for (const { n: mn } of meshNodes) {
  const src = J.meshes[mn.mesh];
  const prims = [];
  for (const prim of src.primitives) {
    const P = accessor(g, prim.attributes.POSITION);
    const pos = new Float32Array(P.length);
    for (let i = 0; i < P.length; i += 3) {
      const w = xform(bakeM, [P[i], P[i + 1], P[i + 2]]);
      pos[i] = w[0]; pos[i + 1] = w[1]; pos[i + 2] = w[2];
    }
    const share = (srcIdx, make) => {
      if (attrCache.has(srcIdx)) return attrCache.get(srcIdx);
      const v = make();
      attrCache.set(srcIdx, v);
      return v;
    };
    const attributes = { POSITION: share(prim.attributes.POSITION, () => pushAccessor(pos, 'VEC3', 5126, 34962, true)) };
    if (prim.attributes.NORMAL != null) {
      attributes.NORMAL = share(prim.attributes.NORMAL, () => {
        const N = accessor(g, prim.attributes.NORMAL);
        const nrm = new Float32Array(N.length);
        for (let i = 0; i < N.length; i += 3) {
          const d = xformDir(bakeM, [N[i], N[i + 1], N[i + 2]]);
          const L = Math.hypot(...d) || 1;
          nrm[i] = d[0] / L; nrm[i + 1] = d[1] / L; nrm[i + 2] = d[2] / L;
        }
        return pushAccessor(nrm, 'VEC3', 5126, 34962);
      });
    }
    for (const key of ['TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0', 'COLOR_0']) {
      if (prim.attributes[key] == null) continue;
      const a = J.accessors[prim.attributes[key]];
      attributes[key] = share(prim.attributes[key], () => pushAccessor(accessor(g, prim.attributes[key]), a.type, a.componentType, 34962));
    }
    const idx = accessor(g, prim.indices);
    const p = { attributes, indices: pushAccessor(idx instanceof Uint32Array ? idx : new Uint32Array(idx), 'SCALAR', 5125, 34963, true) };
    if (prim.material != null) p.material = prim.material;
    prims.push(p);
  }
  out.meshes.push({ name: src.name, primitives: prims });
  out.nodes.push({ name: mn.name || 'mesh', mesh: out.meshes.length - 1, skin: 0 });
  out.scenes[0].nodes.push(out.nodes.length - 1);
}
out.scenes[0].nodes.push(nodeFor[joints.findIndex((_, j) => jparent[j] < 0)]);

/* --- animations --- */
let constantTracks = 0;
for (const a of anims) {
  const times = new Float32Array(a.times);
  const tAcc = pushAccessor(times, 'SCALAR', 5126, null, true);
  const channels = [], samplers = [];
  /* A TRACK THAT NEVER LEAVES REST IS NOT A TRACK. This rig carries 58 bones
     where the game's own carries 27 — fingers, thumbs, breasts, heel helpers —
     and the clips retargeted onto it move 21 of them. Writing the other 37 as
     several hundred identical quaternions apiece tripled the file for no
     motion at all. The rest pose is already in the node, so a bone that stays
     there needs nothing. */
  for (let j = 0; j < joints.length; j++) {
    const q0 = a.newRot[j][0];
    const still = a.newRot[j].every(q => Math.abs(q[0] - q0[0]) < 2e-5 && Math.abs(q[1] - q0[1]) < 2e-5 &&
      Math.abs(q[2] - q0[2]) < 2e-5 && Math.abs(q[3] - q0[3]) < 2e-5);
    if (still && Math.abs(q0[0]) < 2e-5 && Math.abs(q0[1]) < 2e-5 && Math.abs(q0[2]) < 2e-5 && Math.abs(Math.abs(q0[3]) - 1) < 2e-5) {
      constantTracks++;
      continue;
    }
    const R = new Float32Array(a.times.length * 4);
    a.newRot[j].forEach((q, i) => { R[i * 4] = q[0]; R[i * 4 + 1] = q[1]; R[i * 4 + 2] = q[2]; R[i * 4 + 3] = q[3]; });
    samplers.push({ input: tAcc, output: pushAccessor(R, 'VEC4', 5126, null), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: nodeFor[j], path: 'rotation' } });
  }
  /* A translation track per joint that actually moves. The root always does —
     that is the pelvis height — and on a clip that moves nothing else, writing
     43 constant tracks would triple the file for no motion at all. */
  for (let j = 0; j < joints.length; j++) {
    const rest = jparent[j] >= 0
      ? [restPos[j][0] - restPos[jparent[j]][0], restPos[j][1] - restPos[jparent[j]][1], restPos[j][2] - restPos[jparent[j]][2]]
      : restPos[j];
    const moves = jparent[j] < 0 || a.newPos[j].some(p => Math.hypot(p[0] - rest[0], p[1] - rest[1], p[2] - rest[2]) > 1e-5);
    if (!moves) continue;
    const T = new Float32Array(a.times.length * 3);
    a.newPos[j].forEach((p, i) => { T[i * 3] = p[0]; T[i * 3 + 1] = p[1]; T[i * 3 + 2] = p[2]; });
    samplers.push({ input: tAcc, output: pushAccessor(T, 'VEC3', 5126, null), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: nodeFor[j], path: 'translation' } });
  }
  const anim = { name: a.name, channels, samplers };
  if (a.extras) anim.extras = a.extras;
  out.animations.push(anim);
}

/* What the runtime needs to know about this character that it cannot see:
   how tall it is (so two characters end up the same size on the field) and the
   per-bone rest correction (so a pose the renderer authors by hand means the
   same thing here as on the rig it was authored against). Both ride on the
   scene, which is what GLTFLoader hands back as `scene.userData`. */
{
  let top = -Infinity;
  for (const m of out.meshes) for (const p of m.primitives) {
    const mx = out.accessors[p.attributes.POSITION].max;
    if (mx) top = Math.max(top, mx[1]);
  }
  const extras = {};
  if (Number.isFinite(top)) extras.authorHeight = +top.toFixed(4);
  if (Object.keys(restAlign).length) extras.restAlign = restAlign;
  if (Object.keys(extras).length) out.scenes[0].extras = extras;
}

/* ------------------------------------------------------------------ write */
const binBuf = Buffer.concat(bin);
out.buffers = [{ byteLength: binBuf.length }];
const jsonBuf = Buffer.from(JSON.stringify(out), 'utf8');
const jPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
const bPad = Buffer.alloc((4 - (binBuf.length % 4)) % 4, 0);
const jc = Buffer.concat([jsonBuf, jPad]), bc = Buffer.concat([binBuf, bPad]);
const head = Buffer.alloc(12);
head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jc.length + 8 + bc.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jc.length, 0); jh.write('JSON', 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bc.length, 0); bh.write('BIN\0', 4);
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([head, jh, jc, bh, bc]));

/* ---------------------------------------------------------------- verify */
/* THE ONLY CLAIM THAT MATTERS is that nothing moved. Skin a sample of vertices
   through BOTH files at the same times of the same clips and compare where
   they land. An exact conversion reads as micrometres of float noise; a rest
   rotation left in, an inverse bind built from the wrong matrix, or a track
   converted against the wrong parent all read as centimetres, and every one of
   those has happened in this repo already. */
function skinner(doc) {
  const idx = nodeIndex(doc);
  const sk = doc.json.skins[0];
  const ibm = accessor(doc, sk.inverseBindMatrices);
  const mnode = idx.nodes.findIndex(n => n.mesh != null && n.skin != null);
  const prim = doc.json.meshes[idx.nodes[mnode].mesh].primitives[0];
  const P = accessor(doc, prim.attributes.POSITION);
  const JO = accessor(doc, prim.attributes.JOINTS_0);
  const WE = accessor(doc, prim.attributes.WEIGHTS_0);
  const wsc = WE instanceof Float32Array ? 1 : 1 / (WE instanceof Uint8Array ? 255 : 65535);
  const tracks = new Map();
  return {
    count: P.length / 3,
    at(clipName, t, verts) {
      const anim = (doc.json.animations || []).find(a => a.name === clipName);
      const key = clipName;
      if (!tracks.has(key)) {
        const m = new Map();
        for (const ch of anim.channels) {
          const sm = anim.samplers[ch.sampler];
          const T = Array.from(accessor(doc, sm.input));
          const flat = accessor(doc, sm.output);
          const n = ch.target.path === 'rotation' ? 4 : 3;
          const V = [];
          for (let i = 0; i < T.length; i++) V.push(Array.from(flat.subarray(i * n, i * n + n)));
          m.set(ch.target.path + ':' + ch.target.node, { T, V, slerp: n === 4 });
        }
        tracks.set(key, m);
      }
      const m = tracks.get(key);
      const pick = tr => {
        if (!tr) return null;
        const { T, V, slerp } = tr;
        if (t <= T[0]) return V[0];
        if (t >= T[T.length - 1]) return V[V.length - 1];
        let i = 0; while (i < T.length - 2 && T[i + 1] < t) i++;
        const u = (t - T[i]) / (T[i + 1] - T[i]);
        if (!slerp) return V[i].map((x, k) => x + (V[i + 1][k] - x) * u);
        let b = V[i + 1];
        let d = V[i][0] * b[0] + V[i][1] * b[1] + V[i][2] * b[2] + V[i][3] * b[3];
        if (d < 0) b = b.map(x => -x);
        return qNorm(V[i].map((x, k) => x + (b[k] - x) * u));
      };
      const local = idx.nodes.map((n, i) => ({
        t: pick(m.get('translation:' + i)) || n.translation || [0, 0, 0],
        q: pick(m.get('rotation:' + i)) || n.rotation || [0, 0, 0, 1],
        s: n.scale || [1, 1, 1]
      }));
      const W = new Array(idx.nodes.length).fill(null);
      const solve = i => {
        if (W[i]) return W[i];
        const l = trsMat({ translation: local[i].t, rotation: local[i].q, scale: local[i].s });
        W[i] = idx.parent[i] >= 0 ? mul4(solve(idx.parent[i]), l) : l;
        return W[i];
      };
      const JM = sk.joints.map((n, j) => mul4(solve(n), Array.from(ibm.subarray(j * 16, j * 16 + 16))));
      return verts.map(v => {
        const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
        const o = [0, 0, 0];
        for (let k = 0; k < 4; k++) {
          const w = WE[v * 4 + k] * wsc;
          if (!w) continue;
          const q = xform(JM[JO[v * 4 + k]], p);
          o[0] += w * q[0]; o[1] += w * q[1]; o[2] += w * q[2];
        }
        return o;
      });
    }
  };
}
let worst = 0, worstAt = '';
try {
  const A = skinner(g), B = skinner(readGLB(OUT));
  const verts = [];
  for (let i = 0; i < 240; i++) verts.push(Math.floor((i * A.count) / 240));
  for (const anim of out.animations) {
    const T = anims.find(x => x.name === anim.name).times;
    for (const frac of [0, 0.17, 0.33, 0.5, 0.71, 0.93]) {
      const t = T[Math.min(T.length - 1, Math.floor(frac * T.length))];
      const a = A.at(anim.name, t, verts), b = B.at(anim.name, t, verts);
      for (let i = 0; i < verts.length; i++) {
        const d = Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2]);
        if (d > worst) { worst = d; worstAt = `${anim.name} @ ${t.toFixed(3)}s`; }
      }
    }
  }
} catch (e) { worstAt = 'CHECK FAILED: ' + e.message; worst = Infinity; }

console.log(`\n  ${OUT}`);
console.log(`  joints        ${joints.length} (+${extraBones.length} sockets), every rest rotation identity`);
console.log(`  renamed       ${joints.filter((_, j) => newName[j] !== nameOfJoint[j]).length} bones to the game's vocabulary`);
console.log(`  height        ${Math.max(...restPos.map(p => p[1])).toFixed(3)} m at the topmost joint`);
console.log(`  animations    ${out.animations.length}, ${constantTracks} constant rotation tracks dropped`);
console.log(`  restAlign     ${Object.keys(restAlign).length ? Object.keys(restAlign).join(', ') : '(none)'}`);
console.log(`  file size     ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
/* 0.1 mm. The conversion itself is exact; what is left is the six decimal
   places every quaternion and offset is rounded to on the way out, accumulated
   down a five-joint chain. A real mistake here is not subtle — the bundled
   clips' dropped scale tracks read as fourteen METRES. */
console.log(`  skin unchanged  worst vertex moved ${(worst * 1000).toFixed(4)} mm across every clip` +
  (worst > 1e-4 ? `   <-- NOT a lossless rerig (${worstAt})` : `  (worst at ${worstAt})`));
if (skippedScale.length) console.log(`  DROPPED       ${skippedScale.length} clip(s) carrying scale tracks: ${skippedScale.join(', ')}`);
console.log('');
if (worst > 1e-4) process.exit(1);
