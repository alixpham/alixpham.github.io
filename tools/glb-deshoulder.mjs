#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — TAKE THE SHOULDER PADS OFF

     node tools/glb-deshoulder.mjs in.glb out.glb [--cut 0.75] [--keep 0.095]
     node tools/glb-deshoulder.mjs in.glb --report

   Flag football is played in a shirt. The Studio Ochi athlete is an AMERICAN
   footballer and wears the pads to match: measured in the Idle pose, the shirt
   reaches 0.332m from the midline where the shoulder joint is at 0.191 — 14cm
   of material outboard of the joint — and the cap rises to y 1.505, which is
   ten centimetres ABOVE the neck joint and level with the jaw. A shoulder does
   neither of those things.

   THE PADS ARE NOT A PART, AND THIS TIME THEY ARE NOT A BONE EITHER. The
   helmet at least hung off `Head`, which is what made `glb-graft-head.mjs`
   possible. The pads are the SHAPE of the shirt: 41 jersey vertices weighted
   to each `Shoulder_*` and 27 more to each `UpperArm_*`, in the same primitive
   as the sleeve and the chest, sharing the same accessors. There is nothing to
   delete — deleting would open a hole in a closed shirt — so the geometry is
   sculpted instead.

   IT IS THE RADIUS ABOUT THE ARM AXIS THAT COMES DOWN.

       perp = (v - A) - ((v - A).u)u            u = the upper-arm bone's axis
       r    = |perp|
       r'   = r <= keep ? r : keep + (r - keep) * (1 - cut * falloff(|v - A|))

   Three formulations, and the two that failed are why this one is written the
   way it is.

   SHRINKING TOWARD THE JOINT barely moves anything. A shell sitting at a
   roughly constant distance from the joint is precisely what a radial shrink
   cannot shift: the displacement it produces is the offset it is already at
   times a falloff that is dying at that same radius. At 0.26 it moved the
   silhouette 5mm, and the pad is 90mm thick. Widen the falloff to fix that and
   it reaches the elbow, which is 0.207 from the joint — it would pull the
   elbow toward the shoulder and SHORTEN THE ARM.

   DEFLATING ALONG THE NORMAL is what taking a shell off ought to be, and it
   turns thin features inside out. The cap's outer lip is thinner than the
   65mm being taken off it, so its underside — normal pointing down — was
   pushed UP through its own top surface, and the measured top of the shoulder
   went from 1.496 to 1.539. A deflate is only safe while it is smaller than
   the local thickness, and nothing here knows the local thickness.

   Contracting the radius ABOUT THE ARM AXIS has neither problem. It is a
   linear contraction in a plane, so it cannot invert; the component along the
   bone is untouched, so the arm keeps its length by construction however hard
   the shoulder is squeezed; and it is exactly the shape change wanted, because
   a shoulder pad is bulk around the joint. The cap on top of the shoulder
   comes down because "away from the arm axis" points up there, and the outer
   flap comes in because there it points out.

   AND ONLY THE EXCESS COMES OFF. Contracting the radius by a flat fraction
   thinned the LIMB as well — measured, the upper arm's own radius fell 40%
   along its whole length, which is a padless player with the arms of a bird.
   The pad is the part of the radius that is bigger than a shoulder, so `keep`
   is what a shoulder is and only what stands outside it is compressed. The
   sleeve at 0.06 is under `keep` and does not move at all; the cap at 0.17 is
   well over it and loses three quarters of the difference.

   AND `keep` IS NOT A TASTE SETTING: it has to be bigger than the limb's own
   radius, or the tool is sculpting the arm rather than the pad. This athlete's
   upper arm measures 0.061-0.084 about its own axis, so 0.095 clears it and
   the measured arm radius comes back bit-for-bit unchanged. Drop it to 0.070
   and the arm starts to lose 14%; to 0.055 and it loses a third. If a rig ever
   needs a smaller `keep` to shift its pads, the pads are not what is being
   measured.

   THE FRAME MATTERS AND IT MUST BE BONES. The bind pose is an A-POSE, so at
   the height of the shoulder cap the widest thing in the mesh is the SLEEVE of
   a raised arm; any rule written in world x cannot tell a pad from a sleeve.
   Two bone positions do not care what pose the mesh was authored in. The
   falloff is on distance from the JOINT, not from the axis, so the chest at
   0.307 and the neck at 0.225 are outside it and untouched while the elbow,
   whose offset is almost entirely ALONG the bone, has almost no perpendicular
   component to lose however close it is.

   NOTHING CAN TEAR, and that is not luck: `glb-repaint.mjs` built this mesh so
   that all seven parts — skin, shoes, jersey, shorts, trim, socks, hair —
   share ONE position accessor and differ only in their index buffers. Moving a
   vertex moves it for every part that uses it, so the seam between the sleeve
   and the arm cannot come apart. The tool asserts the sharing rather than
   assuming it.

   NORMALS ARE REBUILT, not transformed. A non-uniform deformation does not
   carry normals correctly under any cheap rule, and this mesh is small enough
   to just recompute them from the triangles that came out — area-weighted, so
   a long thin triangle does not shout down its neighbours.

   RUNNING IT TWICE WOULD SHRINK TWICE, so the output is stamped and a stamped
   file is refused. That is a footgun this repo has the scars to expect.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { readGLB, accessor, nodeIndex } from './glb-read.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);
const files = argv.filter(a => !a.startsWith('--') && a.endsWith('.glb'));
const SRC = files[0], OUT = files[1];
const REPORT = has('report') || !OUT;
const CUT = Number(opt('cut', 0.75));       // fraction of the EXCESS radius to remove
const KEEP = Number(opt('keep', 0.095));    // metres: must clear the LIMB's own radius
const REACH = Number(opt('reach', 0.24));   // metres from the joint the deformation dies at
/* The falloff is flat out to this fraction of `reach` before it starts to
   decay. A pad is a shell at a fairly constant distance from the joint, so a
   falloff that is already dying where the pad lives takes nothing off it. */
const PLATEAU = Number(opt('plateau', 0.62));
const STAMP = 'flagsterDeshouldered';

if (!SRC) {
  console.error('usage: node tools/glb-deshoulder.mjs <in.glb> <out.glb> [--cut 0.75] [--keep 0.095]');
  console.error('       node tools/glb-deshoulder.mjs <in.glb> --report');
  process.exit(2);
}

const g = readGLB(SRC);
const J = g.json;
if (J.asset && J.asset.extras && J.asset.extras[STAMP]) {
  console.error(`\n  ${path.basename(SRC)} has already had its pads taken off (asset.extras.${STAMP}).`);
  console.error('  Running again would shrink the shoulder a second time. Start from the un-deshouldered build.\n');
  process.exit(1);
}

/* ---- the rig, in bind pose --------------------------------------------- */
const { nodes, parent, byName } = nodeIndex(g);
function restWorld(name) {
  const i = byName[name];
  if (i == null) return null;
  let p = [0, 0, 0];
  const chain = [];
  for (let k = i; k >= 0; k = parent[k]) chain.push(k);
  for (let c = chain.length - 1; c >= 0; c--) {
    const t = nodes[chain[c]].translation || [0, 0, 0];
    p = [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
  }
  return p;
}
/* No bone in this rig carries a rest ROTATION — `glb-rerig.mjs` guarantees it
   and `rig-def.mjs` states it — which is why summing translations up the chain
   is the bind position and not an approximation. */
for (const n of nodes) {
  if (n.rotation && n.rotation.length === 4) {
    const q = n.rotation;
    if (Math.abs(Math.abs(q[3]) - 1) > 1e-4) {
      console.error(`\n  ${n.name} carries a rest rotation; this tool assumes none (see glb-rerig.mjs).\n`);
      process.exit(1);
    }
  }
}
const JOINTS = [['UpperArm_L', 'LowerArm_L'], ['UpperArm_R', 'LowerArm_R']].map(([a, b]) => {
  const A = restWorld(a), B = restWorld(b);
  if (!A || !B) return null;
  const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const L = Math.hypot(d[0], d[1], d[2]) || 1;
  return { name: a, p: A, u: [d[0] / L, d[1] / L, d[2] / L] };
});
if (JOINTS.some(j => !j)) { console.error('no UpperArm_*/LowerArm_* pair in this rig'); process.exit(1); }

/* ---- the one shared vertex array ---------------------------------------- */
const body = J.meshes.find(m => m.primitives.length > 3) || J.meshes[0];
const posAcc = body.primitives[0].attributes.POSITION;
const nrmAcc = body.primitives[0].attributes.NORMAL;
for (const p of body.primitives) {
  if (p.attributes.POSITION !== posAcc || p.attributes.NORMAL !== nrmAcc) {
    console.error('\n  the body mesh\'s parts do NOT share one position/normal accessor.');
    console.error('  Deforming would tear the seams between them. See glb-repaint.mjs.\n');
    process.exit(1);
  }
}
const P = accessor(g, posAcc);
const N = accessor(g, nrmAcc);
const nVerts = P.length / 3;

const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/* Measure before, so the change is a number rather than an opinion. */
function silhouette(pos) {
  let widest = 0, top = 0;
  for (let i = 0; i < nVerts; i++) {
    const x = Math.abs(pos[i * 3]), y = pos[i * 3 + 1];
    // Outboard material above the armpit — the pad, whatever pose it is in.
    if (x > 0.12 && y > JOINTS[0].p[1] - 0.05) { if (x > widest) widest = x; if (y > top) top = y; }
  }
  return { widest, top };
}
const before = silhouette(P);

/* ---- the shrink ---------------------------------------------------------- */
const out = Float32Array.from(P);
let moved = 0, worst = 0;
for (let i = 0; i < nVerts; i++) {
  const v = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  // Nearest shoulder wins; they are far enough apart that no vertex is really
  // shared between them, and taking the nearest keeps the two sides symmetric.
  let best = null, bestD = Infinity;
  for (const j of JOINTS) {
    const d = Math.hypot(v[0] - j.p[0], v[1] - j.p[1], v[2] - j.p[2]);
    if (d < bestD) { bestD = d; best = j; }
  }
  const u = bestD / REACH;
  const f = u <= PLATEAU ? 1 : 1 - smooth((u - PLATEAU) / (1 - PLATEAU));
  if (f <= 0) continue;
  const d = [v[0] - best.p[0], v[1] - best.p[1], v[2] - best.p[2]];
  const along = d[0] * best.u[0] + d[1] * best.u[1] + d[2] * best.u[2];
  // Only the part of the offset that is ACROSS the bone: the part along it is
  // the arm's own length and must survive untouched.
  const perp = [d[0] - along * best.u[0], d[1] - along * best.u[1], d[2] - along * best.u[2]];
  const r = Math.hypot(perp[0], perp[1], perp[2]);
  if (r <= KEEP || r < 1e-9) continue;       // already no thicker than a shoulder
  const rNew = KEEP + (r - KEEP) * (1 - CUT * f);
  const k = 1 - rNew / r;
  out[i * 3] = v[0] - perp[0] * k;
  out[i * 3 + 1] = v[1] - perp[1] * k;
  out[i * 3 + 2] = v[2] - perp[2] * k;
  const md = r - rNew;
  if (md > 1e-6) moved++;
  if (md > worst) worst = md;
}
const after = silhouette(out);

/* ---- normals, rebuilt from what came out --------------------------------- */
const nrm = new Float32Array(nVerts * 3);
for (const prim of body.primitives) {
  const idx = accessor(g, prim.indices);
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = out[b * 3] - out[a * 3], ay = out[b * 3 + 1] - out[a * 3 + 1], az = out[b * 3 + 2] - out[a * 3 + 2];
    const bx = out[c * 3] - out[a * 3], by = out[c * 3 + 1] - out[a * 3 + 1], bz = out[c * 3 + 2] - out[a * 3 + 2];
    // Un-normalised cross product: its length IS twice the area, which is the
    // weighting we want, so a sliver triangle does not shout down its neighbours.
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    for (const k of [a, b, c]) { nrm[k * 3] += nx; nrm[k * 3 + 1] += ny; nrm[k * 3 + 2] += nz; }
  }
}
let flipped = 0;
for (let i = 0; i < nVerts; i++) {
  let x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2];
  const L = Math.hypot(x, y, z);
  if (L < 1e-12) { nrm[i * 3] = N[i * 3]; nrm[i * 3 + 1] = N[i * 3 + 1]; nrm[i * 3 + 2] = N[i * 3 + 2]; continue; }
  x /= L; y /= L; z /= L;
  if (x * N[i * 3] + y * N[i * 3 + 1] + z * N[i * 3 + 2] < 0) flipped++;
  nrm[i * 3] = x; nrm[i * 3 + 1] = y; nrm[i * 3 + 2] = z;
}

console.log(`\n${path.basename(SRC)} — shoulder pads`);
console.log(`  shoulder joints at  ${JOINTS.map(j => j.p.map(v => v.toFixed(3)).join(',')).join('   ')}`);
console.log(`  arm axis            ${JOINTS[0].u.map(v => v.toFixed(3)).join(',')}`);
console.log(`  cut ${CUT} of the radius over ${(KEEP * 100).toFixed(1)}cm   reach ${REACH}m   plateau ${PLATEAU}`);
console.log(`  vertices moved      ${moved} of ${nVerts}   worst ${(worst * 100).toFixed(1)}cm`);
console.log(`  outboard half-width ${before.widest.toFixed(3)} -> ${after.widest.toFixed(3)} m`);
console.log(`  top of the cap      ${before.top.toFixed(3)} -> ${after.top.toFixed(3)} m`);
console.log(`  normals rebuilt, ${flipped} disagreed with the originals by more than 90deg`);
if (flipped > nVerts * 0.02) console.log('  <-- that is a lot; the winding or the deform is wrong');

if (REPORT) { console.log('\n  (report only, nothing written)\n'); process.exit(0); }

/* ---- write it back ------------------------------------------------------- */
function replaceAccessor(accIdx, data) {
  const acc = J.accessors[accIdx];
  const bv = J.bufferViews[acc.bufferView];
  const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(g.bin, off);
}
replaceAccessor(posAcc, out);
replaceAccessor(nrmAcc, nrm);
// Keep the accessor bounds honest; three.js builds bounding volumes from them.
const pa = J.accessors[posAcc];
const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < nVerts; i++) for (let k = 0; k < 3; k++) {
  const v = out[i * 3 + k];
  if (v < mn[k]) mn[k] = v;
  if (v > mx[k]) mx[k] = v;
}
pa.min = mn; pa.max = mx;
J.asset = J.asset || {};
J.asset.extras = { ...(J.asset.extras || {}), [STAMP]: { cut: CUT, keep: KEEP, reach: REACH, plateau: PLATEAU } };

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
console.log(`\n  wrote ${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)\n`);
