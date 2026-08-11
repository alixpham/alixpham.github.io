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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLB = path.resolve(HERE, '..', 'flagster', 'lib', 'flagplayer.glb');

/* ------------------------------------------------------------------ glb IO */
function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glb');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8'));
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  return { json, bin };
}

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM_COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(g, bin, i) {
  const a = g.json.accessors[i];
  const bv = g.json.bufferViews[a.bufferView];
  const n = NUM_COMP[a.type], sz = COMP_SIZE[a.componentType];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = [];
  for (let k = 0; k < a.count * n; k++) {
    const at = base + k * sz;
    out.push(a.componentType === 5126 ? bin.readFloatLE(at)
      : a.componentType === 5125 ? bin.readUInt32LE(at)
        : a.componentType === 5123 ? bin.readUInt16LE(at) : bin.readUInt8(at));
  }
  if (n === 1) return out;
  const rows = [];
  for (let k = 0; k < a.count; k++) rows.push(out.slice(k * n, k * n + n));
  return rows;
}

/* --------------------------------------------------------------- math bits */
const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: a => Math.hypot(a[0], a[1], a[2]),
  norm: a => { const L = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / L, a[1] / L, a[2] / L]; }
};
const DEG = 180 / Math.PI;

function quatSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { bb = b.map(v => -v); d = -d; }
  if (d > 0.9995) {
    const o = a.map((v, i) => v + (bb[i] - v) * t);
    const L = Math.hypot(...o) || 1;
    return o.map(v => v / L);
  }
  const th0 = Math.acos(d), th = th0 * t;
  const s0 = Math.sin(th0), s1 = Math.sin(th0 - th) / s0, s2 = Math.sin(th) / s0;
  return a.map((v, i) => v * s1 + bb[i] * s2);
}

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
const g = readGlb(GLB);
const bin = g.bin;
const nodes = g.json.nodes;
const byName = {};
nodes.forEach((n, i) => { if (n.name) byName[n.name] = i; });
const parent = new Array(nodes.length).fill(-1);
nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));

function sample(times, values, t, slerp) {
  if (t <= times[0]) return values[0];
  const last = times.length - 1;
  if (t >= times[last]) return values[last];
  let i = 0;
  while (i < last - 1 && times[i + 1] < t) i++;
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  if (slerp) return quatSlerp(values[i], values[i + 1], u);
  return values[i].map((v, k) => v + (values[i + 1][k] - v) * u);
}

function loadClip(name) {
  const anim = (g.json.animations || []).find(a => a.name === name);
  if (!anim) throw new Error('no clip named ' + name + ' (have: ' +
    (g.json.animations || []).map(a => a.name).join(', ') + ')');
  const tracks = [];
  let dur = 0;
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const times = readAccessor(g, bin, s.input);
    const values = readAccessor(g, bin, s.output);
    dur = Math.max(dur, times[times.length - 1]);
    tracks.push({ node: ch.target.node, path: ch.target.path, times, values });
  }
  return { name, dur, tracks };
}

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

  /* Ground contact is the SOLE, not a joint: the ankle rides 0.090 above it and
     the shoe runs from 0.075 behind the ankle to 0.175 in front (the same three
     numbers the pelvis solver in the builder uses). Take whichever end is
     lower — that is the bit of the player touching the field. */
  const xform = (m, p) => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]
  ];
  const sole = s => {
    const m = W['Foot_' + s];
    const a = xform(m, [0, -0.090, -0.075]), b = xform(m, [0, -0.090, 0.175]);
    return a[1] <= b[1] ? a : b;
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
    // Where each foot IS, for the skate check: a planted foot must not travel.
    footY: { L: soleL[1], R: soleR[1] },
    footP: { L: matPos(W.Foot_L), R: matPos(W.Foot_R) },
    soleP: { L: soleL, R: soleR }
  };
}

/* ------------------------------------------------------------------- main */
const name = process.argv[2] || 'Throw';
const argAt = process.argv.indexOf('--at');
const argFps = process.argv.indexOf('--fps');
const fps = argFps > 0 ? Number(process.argv[argFps + 1]) : 40;
const clip = loadClip(name);

const rows = [];
const N = Math.round(clip.dur * fps);
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
console.log('');
console.log(`peak hand speed   ${peak.speed.toFixed(2)} m/s at t=${peak.t.toFixed(3)}`);
console.log(`lowest foot point ${sink.toFixed(3)} m at t=${sinkT.toFixed(3)}` +
  (sink < -0.02 ? '   <-- THROUGH THE GROUND' : ''));

/* SKATE CHECK. A foot within a centimetre of the turf is bearing weight, and a
   foot bearing weight must not travel — that is the difference between a man
   standing on a field and a man sliding across one. A GAIT clip is the honest
   exception: its planted foot is supposed to sweep backward under the root at
   exactly ground speed, which is what stride matching in field3d.js is for. */
const GAIT = { Run: 1, Walk: 1, Backpedal: 1 };
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
