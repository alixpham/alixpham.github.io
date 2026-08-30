#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — IS THIS POSE ONE A BODY CAN HOLD?

     node tools/posecheck.mjs [player.glb] [--clip Lasso] [--fps 120]

   `bodycheck.mjs` asks whether a joint is bent further than a joint bends, and
   the answer across every clip was yes, they are all inside a human's range.
   That is necessary and it is not sufficient: a pose can have every joint
   inside its limit and still be one nobody can hold, and an arm can travel
   through a full revolution without ever moving faster than a person moves.
   Those are the two things this catches, plus the one that decides whether a
   body stays up at all.

   BALANCE. A standing body falls over when its centre of mass leaves the patch
   of ground its feet cover. That is the whole of it: not a lean angle, not a
   style parameter — a point, a polygon, and whether one is inside the other.
   The centre of mass is built from the SEGMENTS, using Dempster's mass
   fractions (trunk 49.7% of body mass, thigh 10.0% each, upper arm 2.8% each
   and so on) each placed at its own fraction along its own bone, because
   averaging mesh vertices weights a body by how finely its artist tessellated
   the head. The base of support is the convex hull of the sole points that are
   on the ground, widened by half a boot.

   MARGIN is reported in units of the base's own size, so "outside" means
   outside whatever stance this pose is actually standing in, rather than
   outside some fixed number of centimetres. Negative is over the edge.

   WHEN LEAVING IT IS ALLOWED. Every running stride leaves it — that is what
   running is, a controlled fall caught by the next foot — and a dive is
   nothing but leaving it. So the verdict is only ever passed on frames where
   the body is NOT airborne and is not travelling: a celebration performed on
   the spot, an idle, a stance. Those have to balance, and it is those the eye
   reads as a man leaning back further than a man can.

   WINDING. A bone that turns through 360 degrees has done something no
   shoulder does, and it can do it slowly — `bodycheck` measures degrees per
   second and a lasso twirl at 400 deg/s trips no speed limit at all while
   winding a full revolution every 0.9 seconds. So the rotation is INTEGRATED,
   per bone, along its own path: the total turn, and the largest net winding
   about any single axis. A swing that goes out and comes back nets to nothing;
   one that goes round accumulates.

   Anything this flags is either the clip or the limit being wrong, and the
   report says which frame so the pose can be looked at with posesheet.mjs.
   ============================================================================ */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB, clipNames, loadClip } from './glb-read.mjs';
import { skinnedRig, mul4 } from './glb-skin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SRC = argv.find(a => !a.startsWith('--') && a.endsWith('.glb')) ||
            path.resolve(HERE, '..', 'flagster', 'lib', 'ochiplayer.glb');
const ONLY = opt('clip', null);
const FPS = Number(opt('fps', 120));
const AS_JSON = argv.includes('--json');

/* Clips that LOOP. A cycle's last sample is its first; a one-shot's is not —
   its end pose and its start pose are different poses, and differencing one
   into the other reported a 35,501 deg/s flip that no clip ever plays. */
const CYCLIC = new Set(['Idle', 'Run', 'Walk', 'Backpedal', 'Jog', 'Sprint',
  'Celebrate', 'Dance', 'Flex', 'HighStep', 'Bow', 'Lasso', 'Salute', 'Griddy']);

/* Dempster, via Winter's *Biomechanics and Motor Control of Human Movement*:
   each segment's share of body mass, and where along its own bone that share
   acts, as a fraction from the proximal joint to the distal one. */
const SEGMENTS = [
  { a: 'Hips', b: 'Chest', m: 0.497, c: 0.50 },        // trunk
  { a: 'Neck', b: 'Head', m: 0.081, c: 0.50 },         // head + neck
  { a: 'UpperArm_L', b: 'LowerArm_L', m: 0.028, c: 0.436 },
  { a: 'UpperArm_R', b: 'LowerArm_R', m: 0.028, c: 0.436 },
  { a: 'LowerArm_L', b: 'Hand_L', m: 0.016, c: 0.430 },
  { a: 'LowerArm_R', b: 'Hand_R', m: 0.016, c: 0.430 },
  { a: 'Hand_L', b: 'Hand_L', m: 0.006, c: 0 },
  { a: 'Hand_R', b: 'Hand_R', m: 0.006, c: 0 },
  { a: 'UpperLeg_L', b: 'LowerLeg_L', m: 0.100, c: 0.433 },
  { a: 'UpperLeg_R', b: 'LowerLeg_R', m: 0.100, c: 0.433 },
  { a: 'LowerLeg_L', b: 'Foot_L', m: 0.0465, c: 0.433 },
  { a: 'LowerLeg_R', b: 'Foot_R', m: 0.0465, c: 0.433 },
  { a: 'Foot_L', b: 'Toe_L', m: 0.0145, c: 0.50 },
  { a: 'Foot_R', b: 'Toe_R', m: 0.0145, c: 0.50 }
];
const ARM_BONES = ['UpperArm_L', 'LowerArm_L', 'Hand_L', 'UpperArm_R', 'LowerArm_R', 'Hand_R'];
const BOOT_HALF_WIDTH = 0.045;   // metres — a sole is a patch, not a line
/* …AND A PATCH HAS TWO AXES. Padding only in x left a stance whose feet are
   level with each other collinear in z, and `hull()` correctly drops collinear
   points, so the base of a perfectly ordinary square stance came back as a
   two-point LINE — at which point `marginInside` falls to its degenerate
   branch and answers with the distance to the nearest vertex. That reads as a
   catastrophe rather than a stance: Celebrate's centre of mass is 2.4cm behind
   the middle of its feet and was reported 17.3cm outside them, because the
   nearest hull point was a toe 13cm away across the body. Every symmetrical
   two-footed pose in the file was one contact point per foot away from the
   same reading. A contact patch is small but it is not nothing. */
const BOOT_HALF_LEN = 0.02;      // metres — and the patch has depth as well
const CONTACT = 0.06;            // metres above the clip's own floor that still bears weight
const SLACK = 0.03;              // metres of margin the model itself is worth
const STILL = 0.25;              // m/s of hip travel below which this is a stance

const g = readGLB(SRC);
const R = skinnedRig(g);
const soleOf = R.soles({ band: 0.03 });
const { byName, parent, nodes } = R;

/* World transform of one node under a set of locals, walked from the root. */
function worldOf(L, i) {
  const chain = [];
  for (let k = i; k >= 0; k = parent[k]) chain.push(k);
  let m = null;
  for (let c = chain.length - 1; c >= 0; c--) {
    const l = L[chain[c]], q = l.q, s = l.s || [1, 1, 1];
    const [X, Y, Z, W] = q, x2 = X + X, y2 = Y + Y, z2 = Z + Z;
    const mm = [
      (1 - (Y * y2 + Z * z2)) * s[0], (X * y2 + W * z2) * s[0], (X * z2 - W * y2) * s[0], 0,
      (X * y2 - W * z2) * s[1], (1 - (X * x2 + Z * z2)) * s[1], (Y * z2 + W * x2) * s[1], 0,
      (X * z2 + W * y2) * s[2], (Y * z2 - W * x2) * s[2], (1 - (X * x2 + Y * y2)) * s[2], 0,
      l.t[0], l.t[1], l.t[2], 1];
    m = m ? mul4(m, mm) : mm;
  }
  return m;
}
const posOf = m => [m[12], m[13], m[14]];
function quatOfMat(m) {
  const nx = Math.hypot(m[0], m[1], m[2]) || 1, ny = Math.hypot(m[4], m[5], m[6]) || 1, nz = Math.hypot(m[8], m[9], m[10]) || 1;
  const a = [m[0] / nx, m[1] / nx, m[2] / nx, m[4] / ny, m[5] / ny, m[6] / ny, m[8] / nz, m[9] / nz, m[10] / nz];
  const t = a[0] + a[4] + a[8];
  let x, y, z, w, s;
  if (t > 0) { s = Math.sqrt(t + 1) * 2; w = 0.25 * s; x = (a[5] - a[7]) / s; y = (a[6] - a[2]) / s; z = (a[1] - a[3]) / s; }
  else if (a[0] > a[4] && a[0] > a[8]) { s = Math.sqrt(1 + a[0] - a[4] - a[8]) * 2; w = (a[5] - a[7]) / s; x = 0.25 * s; y = (a[3] + a[1]) / s; z = (a[6] + a[2]) / s; }
  else if (a[4] > a[8]) { s = Math.sqrt(1 + a[4] - a[0] - a[8]) * 2; w = (a[6] - a[2]) / s; x = (a[3] + a[1]) / s; y = 0.25 * s; z = (a[7] + a[5]) / s; }
  else { s = Math.sqrt(1 + a[8] - a[0] - a[4]) * 2; w = (a[1] - a[3]) / s; x = (a[6] + a[2]) / s; y = (a[7] + a[5]) / s; z = 0.25 * s; }
  return [x, y, z, w];
}

/* Convex hull of the ground-plane points, and the signed distance from a point
   to its boundary — positive inside. A one-foot stance is very nearly a line
   segment, which is exactly why every point is padded by half a boot first. */
function hull(pts) {
  if (pts.length < 3) return pts;
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
function marginInside(h, pt) {
  if (h.length < 3) {
    // Degenerate: distance to the segment, made negative (never inside).
    let best = Infinity;
    for (let i = 0; i < h.length; i++) best = Math.min(best, Math.hypot(h[i][0] - pt[0], h[i][1] - pt[1]));
    return -best;
  }
  /* ORIENTATION-AGNOSTIC. Testing `cross < 0` on every edge assumes the hull
     came back counter-clockwise; hand it a clockwise one and every point in
     the world reads as outside. That is not a subtle failure — it marked 19 of
     22 clips impossible, Idle among them, and a standing idle balances by
     definition. Inside is "on the SAME side of every edge", whichever side
     that turns out to be. */
  let pos = 0, neg = 0, best = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const c = ex * (pt[1] - a[1]) - ey * (pt[0] - a[0]);
    if (c > 0) pos++; else if (c < 0) neg++;
    const L2 = ex * ex + ey * ey;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * ex + (pt[1] - a[1]) * ey) / L2)) : 0;
    best = Math.min(best, Math.hypot(pt[0] - (a[0] + ex * t), pt[1] - (a[1] + ey * t)));
  }
  return (pos === 0 || neg === 0) ? best : -best;
}
const hullSize = h => {
  if (h.length < 2) return BOOT_HALF_WIDTH * 2;
  let mx = 0;
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) mx = Math.max(mx, Math.hypot(h[i][0] - h[j][0], h[i][1] - h[j][1]));
  return Math.max(mx, BOOT_HALF_WIDTH * 2);
};

/* ------------------------------------------------------------------- run it */
const idxOf = {};
for (const s of SEGMENTS) { idxOf[s.a] = byName[s.a]; idxOf[s.b] = byName[s.b]; }
for (const b of ARM_BONES) idxOf[b] = byName[b];
const rows = [];
const names = clipNames(g).filter(n => !ONLY || n === ONLY);

for (const name of names) {
  const clip = loadClip(g, name);
  const cyclic = CYCLIC.has(name);
  const N = Math.max(24, Math.round(clip.dur * FPS));
  const dt = clip.dur / N;
  const last = cyclic ? N - 1 : N;

  const frames = [];
  for (let k = 0; k <= last; k++) {
    const L = R.localsOf(clip, (cyclic ? k % N : k) * dt);
    const W = {};
    for (const b in idxOf) if (idxOf[b] != null) W[b] = worldOf(L, idxOf[b]);
    const JM = R.jointMats(L);
    // Centre of mass, from the segments.
    let cx = 0, cy = 0, cz = 0, mass = 0;
    for (const s of SEGMENTS) {
      const A = W[s.a], B = W[s.b];
      if (!A || !B) continue;
      const a = posOf(A), b = posOf(B);
      cx += s.m * (a[0] + (b[0] - a[0]) * s.c);
      cy += s.m * (a[1] + (b[1] - a[1]) * s.c);
      cz += s.m * (a[2] + (b[2] - a[2]) * s.c);
      mass += s.m;
    }
    frames.push({
      com: [cx / mass, cy / mass, cz / mass],
      hips: posOf(W.Hips || worldOf(L, byName.Hips)),
      sole: { L: R.solePoints(JM, soleOf, 'L'), R: R.solePoints(JM, soleOf, 'R') },
      q: Object.fromEntries(ARM_BONES.filter(b => W[b]).map(b => [b, quatOfMat(W[b])]))
    });
  }

  /* WHERE THE GROUND IS: the tenth percentile of every sole point in the clip,
     the same rule the gait tools use, and a band wide enough to hold a real
     stance. Both halves of that were got wrong first, in opposite directions.

     A 2cm band collapsed a two-footed stance to a SINGLE point — the Ochi
     athlete stands with his heels 3cm apart in height, so one foot fell out of
     the band and the base of support became a dot; every pose then read as off
     balance, Idle included. Widening it to 6cm fixes that.

     Taking the lowest sole THIS FRAME instead fixes it too, and breaks
     something worse: it can never report a body as airborne, because there is
     always a lowest point. On HighStep, with both knees up, it declared the
     swing foot 58cm out in front to be the base of support and called a
     man 66cm off balance who was simply in the air. The ground does not move
     between frames; the floor is the clip's. */

  const minima = [];
  for (const f of frames) for (const s of ['L', 'R']) for (const p of f.sole[s]) minima.push(p[1]);
  minima.sort((a, b) => a - b);
  const floor = minima[Math.floor(minima.length * 0.10)];

  let worstMargin = Infinity, worstAt = 0, judged = 0, over = 0, worstOff = [0, 0];
  /* A GAIT CLIP CARRIES NO ROOT MOTION, so its hips do not translate and every
     stride frame looked like a man standing still. It is not: the ground is
     going past at `groundSpeed`, which the builder measured and baked. Without
     this, Run and Sprint were judged as stances and reported as the two most
     impossible poses in the file — a running body's centre of mass IS outside
     its base of support, which is what running is. */
  const gaitSpeed = (clip.extras && clip.extras.groundSpeed) || 0;
  for (let k = 1; k < frames.length; k++) {
    const f = frames[k];
    /* AND A HOP IS TRAVEL TOO. This measured the hips in the GROUND PLANE only,
       so a body going straight up read as perfectly still — and a celebration
       hop is exactly that. Celebrate was judged on 119 of its 120 frames, the
       airborne ones included, because the hop is 8.5cm against a 6cm contact
       band and the toe of a tilted foot never leaves it. What came back was not
       a balance reading at all: nudging the tuck by fifteen degrees swung the
       centre of mass from 2.4cm behind the base to 24.3cm in front of it, which
       is not something a body does and not something the eye would see.

       The fourth variant of one bug — a band too tight collapsed a stance to a
       point, a per-frame floor could never report anybody airborne, and now a
       planar speed cannot see a jump. A stance is settled in THREE dimensions
       or it is not settled. */
    const travel = Math.max(gaitSpeed,
      Math.hypot(f.hips[0] - frames[k - 1].hips[0],
                 f.hips[1] - frames[k - 1].hips[1],
                 f.hips[2] - frames[k - 1].hips[2]) / dt);
    /* JUDGED ONLY ON A SETTLED, TWO-FOOTED STANCE, and that one test does the
       work three different clip lists were doing badly. Locomotion is single
       support almost all of the time — a walk's double-support phase is brief
       and a run has none at all — and a dive and a jump have no support to
       speak of. So requiring BOTH feet on the ground selects exactly the poses
       that are meant to be held: an idle, a celebration performed on the spot,
       a man standing still leaning back. Everything a body is allowed to do
       outside its base of support falls out on its own, without a table of
       clip names to keep in step with the .glb. */
    const pts = [];
    let onL = 0, onR = 0;
    for (const s of ['L', 'R']) for (const p of f.sole[s]) {
      if (p[1] > floor + CONTACT) continue;
      if (s === 'L') onL++; else onR++;
      pts.push([p[0] - BOOT_HALF_WIDTH, p[2] - BOOT_HALF_LEN], [p[0] + BOOT_HALF_WIDTH, p[2] - BOOT_HALF_LEN],
               [p[0] - BOOT_HALF_WIDTH, p[2] + BOOT_HALF_LEN], [p[0] + BOOT_HALF_WIDTH, p[2] + BOOT_HALF_LEN]);
    }
    if (!onL || !onR || travel > STILL) continue;
    judged++;
    const h = hull(pts);
    const m = marginInside(h, [f.com[0], f.com[2]]);
    if (m < worstMargin) {
      worstMargin = m; worstAt = k * dt;
      /* WHICH WAY HE IS FALLING, not just how far. A margin on its own says a
         pose is impossible and leaves you to guess whether the fix is the arms,
         the lean or the stance — and guessing costs a full asset rebuild per
         attempt. The offset from the base's own centroid names the direction:
         +z is the way the rig faces, +x is its left. */
      let cx = 0, cz = 0;
      for (const q of h) { cx += q[0]; cz += q[1]; }
      worstOff = h.length ? [f.com[0] - cx / h.length, f.com[2] - cz / h.length] : [0, 0];
    }
    if (m < -SLACK) over++;
  }

  // Winding: total turn per bone, and the net rotation about a single axis.
  let wind = 0, windBone = '';
  for (const b of ARM_BONES) {
    let total = 0;
    const axis = [0, 0, 0];
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1].q[b], c = frames[k].q[b];
      if (!a || !c) continue;
      let d = 0; for (let m = 0; m < 4; m++) d += a[m] * c[m];
      const sgn = d < 0 ? -1 : 1;
      // Relative rotation c * conj(a), taking the short path.
      const ca = [-a[0], -a[1], -a[2], a[3]];
      const r = [
        sgn * (c[3] * ca[0] + c[0] * ca[3] + c[1] * ca[2] - c[2] * ca[1]),
        sgn * (c[3] * ca[1] - c[0] * ca[2] + c[1] * ca[3] + c[2] * ca[0]),
        sgn * (c[3] * ca[2] + c[0] * ca[1] - c[1] * ca[0] + c[2] * ca[3]),
        sgn * (c[3] * ca[3] - c[0] * ca[0] - c[1] * ca[1] - c[2] * ca[2])];
      const s = Math.hypot(r[0], r[1], r[2]);
      if (s < 1e-9) continue;
      const ang = 2 * Math.atan2(s, Math.abs(r[3])) * 180 / Math.PI;
      total += ang;
      axis[0] += (r[0] / s) * ang; axis[1] += (r[1] / s) * ang; axis[2] += (r[2] / s) * ang;
    }
    const net = Math.hypot(axis[0], axis[1], axis[2]);
    if (net > wind) { wind = net; windBone = b; }
    void total;
  }

  rows.push({
    name, dur: clip.dur, cyclic, judged, gait: gaitSpeed > 0, frames: frames.length,
    margin: judged ? worstMargin : NaN, marginAt: worstAt, off: worstOff,
    overPct: judged ? 100 * over / judged : 0,
    wind, windBone
  });
}

if (AS_JSON) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }

/* WHAT COUNTS AS IMPOSSIBLE. Both halves turn on the same distinction, which
   is whether the clip LOOPS.

   BALANCE. A looping clip performed on the spot has to balance, and that is
   not a judgement call: a loop plays for as long as the move lasts, and you
   cannot spend that long past the edge of your own feet — you fall over. A
   one-shot may legitimately be a controlled fall, because that is exactly what
   a dive, a cut and a jump are; they show negative here and they are meant to.

   It also needs enough of the clip to be a stance before it says anything.
   Backpedal is locomotion with no baked ground speed, so it looked on-the-spot
   — and six settled frames out of seventy is not a stance, it is the moment
   between two steps.

   WINDING. 360 degrees in a ONE-SHOT is one long sweep, and a throwing arm
   really does travel most of a revolution from the top of the windup to the
   end of the follow-through. 360 degrees in a LOOP never unwinds: it goes
   round again every cycle, for as long as the move is on screen, which is the
   arm that spins forever. */
const ENOUGH = 0.25;                 // share of the clip that must be a stance
const bad = rows.filter(r =>
  (r.cyclic && !r.gait && r.judged / (r.frames || 1) >= ENOUGH && r.margin < -SLACK) ||
  (r.cyclic && r.wind > 330));
rows.sort((a, b) => (a.margin || 9) - (b.margin || 9));
console.log(`\n${path.basename(SRC)} — can a body hold these poses?   ${FPS}fps\n`);
console.log(`  ${'clip'.padEnd(12)} ${'sec'.padStart(5)} ${'stance'.padStart(7)} ${'margin cm'.padStart(9)} ${'over'.padStart(6)} ${'winding'.padStart(8)}  bone`);
console.log('  ' + '-'.repeat(70));
for (const r of rows) {
  const m = Number.isFinite(r.margin) ? (r.margin * 100).toFixed(1).padStart(8) : '       -';
  const off = Number.isFinite(r.margin) && r.margin < -SLACK;
  const settled = r.judged / (r.frames || 1) >= ENOUGH;
  const flag = (r.cyclic && !r.gait && settled && off) ? '  <-- OFF BALANCE IN A LOOP'
             : (r.cyclic && r.wind > 330) ? '  <-- WINDS PAST 360, EVERY CYCLE'
             : off ? '  (a one-shot may be a controlled fall)' : '';
  console.log(`  ${r.name.padEnd(12)} ${r.dur.toFixed(2).padStart(5)} ${String(r.judged).padStart(7)} ${m} ` +
    `${(r.overPct.toFixed(0) + '%').padStart(6)} ${(r.wind.toFixed(0) + 'deg').padStart(8)}  ${r.windBone}${flag}`);
}
console.log(`\n  margin is the centre of mass's distance inside the base of support, in cm.`);
console.log(`  Negative is past what the feet can hold; ${(SLACK * 100).toFixed(0)}cm of slack is allowed for the`);
console.log(`  segment model itself, which is a table of averages laid over a stylised rig.`);
console.log(`  Judged only on a settled TWO-FOOTED stance — locomotion is single support`);
console.log(`  nearly all of the time and a dive has none, and both are meant to leave it.\n`);
console.log(`  ${bad.length} of ${rows.length} clips are impossible` +
  (bad.length ? ': ' + bad.map(r => r.name).join(', ') : '') + '\n');
process.exit(bad.length ? 1 : 0);
