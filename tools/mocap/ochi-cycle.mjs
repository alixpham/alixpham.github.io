#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — ONE CYCLE OUT OF A BOUGHT PERFORMANCE

     node tools/fbx-to-glb.mjs "…Man A_ANIM.fbx" -o /tmp/ochi.glb
     node tools/mocap/ochi-cycle.mjs /tmp/ochi.glb "American Football Run Fast" \
          --as Sprint --ref tools/motion-ochi/Sprint.json --out tools/motion-ochi/Sprint.json

   Studio Ochi's six clips are already on this character's own metarig, so
   unlike the CMU material they need no retargeting at all — but they are
   PERFORMANCES, not cycles. "Run Fast" is 4.125 seconds and about eight and a
   half strides, and `playermodel.js` needs exactly one, because a gait rung is
   blended against three others by phase. Hand a rung a clip with eight strides
   in it and `glb-gait.mjs` measures nothing, `playermodel` silently drops the
   rung, and a player with no rungs never takes a step.

   THE CLIP IS ALREADY IN PLACE, which is the part that makes this possible at
   all: the pelvis wanders 2.8cm in x, 4.6 in y and 2.9 in z across the whole
   four seconds, so this is a treadmill run and there is no root motion to
   strip. A travelling clip would need its translation removed first and its
   stride length measured out of the travel, which is a different tool.

   TWO THINGS HAVE TO BE FOUND, and neither is written down anywhere:

   1. THE PERIOD, by autocorrelation over the whole pose — every bone's
      quaternion concatenated into one vector, and the lag that minimises the
      mean distance between frames that far apart. No forward kinematics, so no
      opinion about rest rotations, which this metarig has on all 58 bones.
      Harmonics are the trap: 3x the true period scores marginally BETTER here
      (0.356 against 0.366) because a longer lag averages over fewer, more
      similar pairs. So the smallest lag inside a tolerance of the best one
      wins, not the best one.

   2. THE PHASE, and it cannot be guessed. Every rung of the ladder must put the
      LEFT foot's contact at phase 0 or a blend has one clip landing while the
      other is airborne. Finding contact would need FK and a sole; what this
      does instead is match against the clip it REPLACES — the retargeted Sprint
      is already correct by construction, so the offset is whichever frame of
      the performance is closest to that clip's own frame 0. Same rig, same
      bones, so it is a plain distance in quaternion space, and it aligns the
      new clip to the ladder rather than to an assumption about it.

   Output is a tools/motion-ochi/*.json exactly like the retargeted ones, so
   nothing downstream needs to know where it came from: the swap mechanism in
   fbx-to-glb picks it up by name, glb-ground puts its feet on the turf and
   glb-gait measures its ground speed, all unchanged.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB } from '../glb-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SRC = argv[0], CLIP = argv[1];
const AS = opt('as', null);
const REF = opt('ref', null);
const OUT = opt('out', null);
const STEPS = Number(opt('steps', 48));

if (!SRC || !CLIP || !AS) {
  console.error('usage: node tools/mocap/ochi-cycle.mjs <in.glb> "<FBX clip>" --as <GameName> [--ref motion-ochi/X.json] [--out file.json] [--steps 48]');
  process.exit(2);
}

const g = readGLB(SRC);
const j = g.json;
const anim = (j.animations || []).find(a => a.name === CLIP);
if (!anim) {
  console.error(`no clip ${JSON.stringify(CLIP)} in ${SRC} — have: ${(j.animations || []).map(a => a.name).join(', ')}`);
  process.exit(1);
}

/* Accessor -> plain arrays. Animation accessors carry no min/max, so nothing
   here can lean on them. */
function acc(i) {
  const A = j.accessors[i], bv = j.bufferViews[A.bufferView];
  const off = (bv.byteOffset || 0) + (A.byteOffset || 0);
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[A.type];
  const out = [];
  for (let k = 0; k < A.count; k++) {
    const r = [];
    for (let c = 0; c < n; c++) r.push(g.bin.readFloatLE(off + (k * n + c) * 4));
    out.push(n === 1 ? r[0] : r);
  }
  return out;
}

/* Rotation tracks, by bone. A two-key track is a constant the exporter wrote
   out anyway; it carries no timing and only dilutes the distance metric. */
const tracks = new Map();
for (const c of anim.channels) {
  if (c.target.path !== 'rotation') continue;
  const s = anim.samplers[c.sampler];
  const t = acc(s.input), v = acc(s.output);
  if (t.length < 20) continue;
  tracks.set(j.nodes[c.target.node].name, { t, v });
}
if (!tracks.size) { console.error('clip has no animated rotation tracks'); process.exit(1); }
const DUR = Math.max(...[...tracks.values()].map(c => c.t[c.t.length - 1]));

/* Nearest-key sampling with a slerp-free lerp: the keys are dense (24fps) and
   the vectors are only ever compared against each other, never rendered. */
function at(c, t) {
  const ts = c.t;
  let i = 0;
  while (i < ts.length - 2 && ts[i + 1] < t) i++;
  const span = ts[i + 1] - ts[i];
  const u = span > 0 ? Math.max(0, Math.min(1, (t - ts[i]) / span)) : 0;
  const A = c.v[i], B = c.v[Math.min(i + 1, c.v.length - 1)];
  const q = A.map((x, k) => x + (B[k] - x) * u);
  const L = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return q.map(x => x / L);
}
const BONES = [...tracks.keys()].sort();
const poseAt = t => { const p = []; for (const b of BONES) p.push(...at(tracks.get(b), t)); return p; };
const dist = (A, B) => { let s = 0; for (let i = 0; i < A.length; i++) { const d = A[i] - B[i]; s += d * d; } return Math.sqrt(s); };

/* ---- 1. the period ------------------------------------------------------- */
const N = 400, dt = DUR / N;
const poses = []; for (let f = 0; f < N; f++) poses.push(poseAt(f * dt));
const score = [];
for (let lag = Math.round(0.15 / dt); lag < N / 2; lag++) {
  let s = 0, n = 0;
  for (let i = 0; i + lag < N; i++) { s += dist(poses[i], poses[i + lag]); n++; }
  score.push({ lag, d: s / n });
}
score.sort((a, b) => a.d - b.d);
/* HARMONICS BEAT THE FUNDAMENTAL on this metric — a lag of three strides
   averages over fewer and more similar pairs than a lag of one. Take the
   SHORTEST lag that is within 15% of the best score, which is the fundamental
   whenever the multiples are also good. */
const bestD = score[0].d;
const period = score.filter(s => s.d <= bestD * 1.15).sort((a, b) => a.lag - b.lag)[0];
const P = period.lag * dt;

/* ---- 2. the phase -------------------------------------------------------- */
let start = 0, why = 'clip start (no --ref given)';
if (REF) {
  const ref = JSON.parse(fs.readFileSync(path.resolve(ROOT, REF), 'utf8'));
  /* Only the legs decide contact. Arms are contralateral and the trunk sways,
     but neither says where the foot is, and including them lets an arm swing
     outvote the thing actually being aligned. */
  const LEG = BONES.filter(b => /^(thigh|shin|foot|toe)\./.test(b));
  if (!LEG.length) { console.error('no leg bones matched — is this the Rigify metarig?'); process.exit(1); }
  const refQ = [];
  for (const b of LEG) { const tr = ref.tracks[b]; if (tr && tr[0]) refQ.push(...tr[0]); }
  if (!refQ.length) { console.error(`--ref ${REF} carries none of the leg bones`); process.exit(1); }
  const legAt = t => { const p = []; for (const b of LEG) { const tr = ref.tracks[b]; if (tr && tr[0]) p.push(...at(tracks.get(b), t)); } return p; };
  let bd = Infinity;
  for (let f = 0; f < N; f++) {
    const t = f * dt;
    if (t + P > DUR) break;                 // a whole cycle has to fit after it
    const d = dist(legAt(t), refQ);
    if (d < bd) { bd = d; start = t; }
  }
  why = `matched ${path.basename(REF)} frame 0 on ${LEG.length} leg bones (distance ${bd.toFixed(4)})`;
}

/* ---- 3. resample one cycle ---------------------------------------------- */
const out = { clip: AS, trial: null, fps: Math.round(STEPS / P), cyclic: true, steps: STEPS,
  duration: +P.toFixed(6), source: `Studio Ochi (${CLIP})`, tracks: {}, root: [] };
for (const b of BONES) {
  const rows = [];
  for (let i = 0; i < STEPS; i++) rows.push(at(tracks.get(b), start + (P * i) / STEPS).map(v => +v.toFixed(5)));
  out.tracks[b] = rows;
}
/* The pelvis height, in the same place the retargeted clips put it: the JSON's
   `root` carries [x, y, z] and only [1] is read downstream, as the spine's own
   height. FBX is Z-up, so that is the translation's z. */
const spineCh = anim.channels.find(c => c.target.path === 'translation' && j.nodes[c.target.node].name === 'spine');
if (spineCh) {
  const s = anim.samplers[spineCh.cyclic ? 0 : spineCh.sampler];
  const st = acc(s.input), sv = acc(s.output);
  const lin = t => { let i = 0; while (i < st.length - 2 && st[i + 1] < t) i++;
    const span = st[i + 1] - st[i], u = span > 0 ? Math.max(0, Math.min(1, (t - st[i]) / span)) : 0;
    const A = sv[i], B = sv[Math.min(i + 1, sv.length - 1)];
    return A.map((x, k) => x + (B[k] - x) * u); };
  for (let i = 0; i < STEPS; i++) {
    const v = lin(start + (P * i) / STEPS);
    out.root.push([0, +v[2].toFixed(5), 0]);
  }
} else {
  for (let i = 0; i < STEPS; i++) out.root.push([0, 0, 0]);
}

console.log(`${CLIP}  ->  ${AS}`);
console.log(`  source        ${path.basename(SRC)}, ${DUR.toFixed(3)}s, ${tracks.size} animated bones`);
console.log(`  period        ${P.toFixed(4)}s  (${(DUR / P).toFixed(1)} cycles in the clip; best lag scored ${bestD.toFixed(4)}, taken ${period.d.toFixed(4)})`);
console.log(`  phase 0 at    ${start.toFixed(4)}s — ${why}`);
console.log(`  resampled     ${STEPS} steps, cyclic`);
const closure = dist(poseAt(start), poseAt(start + P));
console.log(`  loop closure  ${closure.toFixed(4)} in quaternion space (0 is a perfect repeat)`);

if (OUT) {
  const p = path.resolve(ROOT, OUT);
  fs.writeFileSync(p, JSON.stringify(out));
  console.log(`  wrote         ${path.relative(ROOT, p)}  (${(fs.statSync(p).size / 1024).toFixed(0)} KB)`);
} else {
  console.log('  (no --out given; nothing written)');
}
