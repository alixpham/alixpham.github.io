#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — flagplayer.glb GENERATOR

   Hand-authors a glTF 2.0 binary (.glb) containing a properly SKINNED
   flag-football player: one skin, 27 joints, per-region mesh primitives so the
   game can tint jersey/trim per team, four non-deforming attachment sockets,
   and ten baked, in-place animation clips.

   No Blender, no npm dependencies — the whole asset is generated from the
   parametric description below, so tweaking a radius or a keyframe is a
   one-line edit plus a re-run.

       node tools/build-player-glb.mjs
       -> flagster/lib/flagplayer.glb

   CONVENTIONS (must stay in sync with flagster/js/playermodel.js)
     * Y up, metres. Feet on y = 0, top of head at y = 1.850.
     * The rig FACES +Z. The character's LEFT is +X (face +Z toward the camera
       and their left hand is on the viewer's right). Same as player3d.js.
     * Every joint's rest rotation is IDENTITY and limbs hang along -Y, so a
       positive X rotation swings a limb BACKWARD (-Z) and a positive Z
       rotation abducts the LEFT limb outward. Animation eulers are therefore
       directly comparable to the hand-authored clips in player3d.js.
     * Bind pose == rest pose, so every inverse bind matrix is a pure
       translation by -worldPosition.
   ============================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'flagster', 'lib', 'flagplayer.glb');

const TAU = Math.PI * 2;
const HEIGHT_M = 1.850;                 // documented author height

/* ============================================================ 1. ARMATURE */
/* [name, parent, localTranslation]. Order defines the joint index. */
const BONES = [
  ['Hips',            null,             [0, 1.000, 0]],
  ['Spine',           'Hips',           [0, 0.125, 0]],
  ['Chest',           'Spine',          [0, 0.175, 0]],
  ['Neck',            'Chest',          [0, 0.250, 0]],
  ['Head',            'Neck',           [0, 0.080, 0]],

  ['Shoulder_L',      'Chest',          [ 0.050, 0.200, 0]],
  ['UpperArm_L',      'Shoulder_L',     [ 0.150, 0.000, 0]],
  ['LowerArm_L',      'UpperArm_L',     [0, -0.335, 0]],
  ['Hand_L',          'LowerArm_L',     [0, -0.270, 0]],
  ['Socket_Hand_L',   'Hand_L',         [0, -0.090, 0.035]],

  ['Shoulder_R',      'Chest',          [-0.050, 0.200, 0]],
  ['UpperArm_R',      'Shoulder_R',     [-0.150, 0.000, 0]],
  ['LowerArm_R',      'UpperArm_R',     [0, -0.335, 0]],
  ['Hand_R',          'LowerArm_R',     [0, -0.270, 0]],
  ['Socket_Hand_R',   'Hand_R',         [0, -0.090, 0.035]],

  ['UpperLeg_L',      'Hips',           [ 0.098, -0.040, 0]],
  ['LowerLeg_L',      'UpperLeg_L',     [0, -0.460, 0]],
  ['Foot_L',          'LowerLeg_L',     [0, -0.410, 0]],
  ['Toe_L',           'Foot_L',         [0, -0.055, 0.115]],

  ['UpperLeg_R',      'Hips',           [-0.098, -0.040, 0]],
  ['LowerLeg_R',      'UpperLeg_R',     [0, -0.460, 0]],
  ['Foot_R',          'LowerLeg_R',     [0, -0.410, 0]],
  ['Toe_R',           'Foot_R',         [0, -0.055, 0.115]],

  ['Socket_Flag_L',   'Hips',           [ 0.222, 0.015, -0.045]],
  ['Flag_L',          'Socket_Flag_L',  [0, 0, 0]],
  ['Socket_Flag_R',   'Hips',           [-0.222, 0.015, -0.045]],
  ['Flag_R',          'Socket_Flag_R',  [0, 0, 0]]
];

const BI = {};                                   // name -> joint index
const BWORLD = {};                               // name -> world rest position
BONES.forEach(([n, p, t], i) => {
  BI[n] = i;
  const par = p ? BWORLD[p] : [0, 0, 0];
  BWORLD[n] = [par[0] + t[0], par[1] + t[1], par[2] + t[2]];
});

/* ======================================================= 2. MESH PLUMBING */

class Region {
  constructor(name, material) {
    this.name = name; this.material = material;
    this.P = []; this.U = []; this.J = []; this.W = []; this.I = [];
  }
  vert(pos, uv, w) {
    const i = this.P.length / 3;
    this.P.push(pos[0], pos[1], pos[2]);
    this.U.push(uv[0], uv[1]);
    const j = [0, 0, 0, 0], wt = [0, 0, 0, 0];
    const list = w.slice(0, 4);
    let sum = 0;
    for (const [a, b] of list) sum += b;
    if (sum <= 0) throw new Error('zero weight in ' + this.name);
    list.forEach(([a, b], k) => { j[k] = a; wt[k] = b / sum; });
    this.J.push(...j); this.W.push(...wt);
    return i;
  }
  quad(a, b, c, d) { this.I.push(a, b, c, a, c, d); }
  tri(a, b, c) { this.I.push(a, b, c); }
  get triCount() { return this.I.length / 3; }
}

/* Superellipse unit point. p = 1 -> circle, p < 1 -> boxier. */
function se(t, p) {
  const c = Math.cos(t), s = Math.sin(t);
  const f = v => (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), p);
  return [f(c), f(s)];
}

/* Weight helpers. Values are [jointIndex, weight] pairs. */
const w1 = n => [[BI[n], 1]];
const wmix = (a, b, t) => (t <= 0 ? w1(a) : t >= 1 ? w1(b) : [[BI[a], 1 - t], [BI[b], t]]);
const wraw = (...pairs) => pairs.map(([n, v]) => [BI[n], v]);
const lerp = (a, b, t) => a + (b - a) * t;
/* Piecewise-linear ramp: at(y) over sorted [y, value] stops. */
function ramp(stops, y) {
  if (y <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (y <= stops[i][0]) {
      const t = (y - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return lerp(stops[i - 1][1], stops[i][1], t);
    }
  }
  return stops[stops.length - 1][1];
}

/* --- Loft a tube through a list of rings.
   Each ring: { c:[x,y,z], u:[..], v:[..], w:[[j,w]..], p? }
   Rings must advance along a direction `dir` with dir . (u x v) < 0 so the
   quad(A, B, B', A') winding faces outward. For the vertical tubes used here
   u = +X and v = +Z, which satisfies that for dir = +Y.
   opts: { seg, p, capStart, capEnd, poleEnd, poleStart, uv0, uv1 }            */
function loft(R, rings, opts = {}) {
  const seg = opts.seg || 12;
  const P = opts.p == null ? 1 : opts.p;
  const uv0 = opts.uv0 == null ? 0 : opts.uv0;
  const uv1 = opts.uv1 == null ? 1 : opts.uv1;
  const idx = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const row = [];
    const vv = lerp(uv0, uv1, rings.length === 1 ? 0 : r / (rings.length - 1));
    for (let k = 0; k < seg; k++) {
      const t = (k / seg) * TAU;
      const [a, b] = se(t, ring.p == null ? P : ring.p);
      row.push(R.vert([
        ring.c[0] + ring.u[0] * a + ring.v[0] * b,
        ring.c[1] + ring.u[1] * a + ring.v[1] * b,
        ring.c[2] + ring.u[2] * a + ring.v[2] * b
      ], [k / seg, vv], ring.w));
    }
    idx.push(row);
  }
  for (let r = 0; r < rings.length - 1; r++) {
    const A = idx[r], B = idx[r + 1];
    for (let k = 0; k < seg; k++) {
      const k2 = (k + 1) % seg;
      R.quad(A[k], B[k], B[k2], A[k2]);
    }
  }
  const last = rings[rings.length - 1], first = rings[0];
  // advance direction, from the last two ring centres
  const dirOf = (a, b) => {
    const d = [b.c[0] - a.c[0], b.c[1] - a.c[1], b.c[2] - a.c[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    return [d[0] / L, d[1] / L, d[2] / L];
  };
  const dEnd = rings.length > 1 ? dirOf(rings[rings.length - 2], last) : [0, 1, 0];
  const dStart = rings.length > 1 ? dirOf(rings[1], first) : [0, -1, 0];

  if (opts.poleEnd != null) {
    const c = R.vert([last.c[0] + dEnd[0] * opts.poleEnd, last.c[1] + dEnd[1] * opts.poleEnd, last.c[2] + dEnd[2] * opts.poleEnd], [0.5, uv1], last.w);
    const B = idx[idx.length - 1];
    for (let k = 0; k < seg; k++) R.tri(c, B[(k + 1) % seg], B[k]);
  } else if (opts.capEnd) {
    // duplicated rim so the cap shades flat
    const rim = [];
    for (let k = 0; k < seg; k++) {
      const t = (k / seg) * TAU, [a, b] = se(t, last.p == null ? P : last.p);
      rim.push(R.vert([last.c[0] + last.u[0] * a + last.v[0] * b, last.c[1] + last.u[1] * a + last.v[1] * b, last.c[2] + last.u[2] * a + last.v[2] * b], [k / seg, uv1], last.w));
    }
    const c = R.vert(last.c.slice(), [0.5, uv1], last.w);
    for (let k = 0; k < seg; k++) R.tri(c, rim[(k + 1) % seg], rim[k]);
  }
  if (opts.poleStart != null) {
    const c = R.vert([first.c[0] + dStart[0] * opts.poleStart, first.c[1] + dStart[1] * opts.poleStart, first.c[2] + dStart[2] * opts.poleStart], [0.5, uv0], first.w);
    const A = idx[0];
    for (let k = 0; k < seg; k++) R.tri(c, A[k], A[(k + 1) % seg]);
  } else if (opts.capStart) {
    const rim = [];
    for (let k = 0; k < seg; k++) {
      const t = (k / seg) * TAU, [a, b] = se(t, first.p == null ? P : first.p);
      rim.push(R.vert([first.c[0] + first.u[0] * a + first.v[0] * b, first.c[1] + first.u[1] * a + first.v[1] * b, first.c[2] + first.u[2] * a + first.v[2] * b], [k / seg, uv0], first.w));
    }
    const c = R.vert(first.c.slice(), [0.5, uv0], first.w);
    for (let k = 0; k < seg; k++) R.tri(c, rim[k], rim[(k + 1) % seg]);
  }
  return idx;
}

/* Vertical ring shorthand: ringY(y, rx, rz, weights, cx, cz, p) */
const ringY = (y, rx, rz, w, cx = 0, cz = 0, p) => ({ c: [cx, y, cz], u: [rx, 0, 0], v: [0, 0, rz], w, p });
/* Ring in the XY plane advancing along +Z (used for the shoe): u=+Y, v=+X. */
const ringZ = (z, hy, hx, w, cx = 0, cy = 0, p) => ({ c: [cx, cy, z], u: [0, hy, 0], v: [hx, 0, 0], w, p });

/* Ellipsoid built as stacked vertical rings between yFrom and yTo. */
function ellipsoidRings(cy, rx, ry, rz, ys, w, cx = 0, cz = 0) {
  return ys.map(y => {
    const d = (y - cy) / ry;
    const s = Math.sqrt(Math.max(0, 1 - d * d));
    return ringY(y, rx * s, rz * s, typeof w === 'function' ? w(y) : w, cx, cz);
  });
}

/* ==================================================== 3. BUILD THE FIGURE */

const REGIONS = [];
const R = (name, material) => { const r = new Region(name, material); REGIONS.push(r); return r; };

const jersey = R('jersey', 'jersey');
const trim   = R('trim', 'trim');
const skin   = R('skin', 'skin');
const hair   = R('hair', 'hair');
const shorts = R('shorts', 'shorts');
const socks  = R('socks', 'socks');
const shoes  = R('shoes', 'shoes');
const belt   = R('belt', 'belt');
const flag   = R('flag', 'flag');

const SEG_BODY = 14, SEG_LIMB = 10, SEG_FOOT = 10, SEG_FLAG = 8;

/* ---- torso weighting: hips -> spine -> chest by height ---- */
function torsoW(y) {
  if (y <= 0.990) return w1('Hips');
  if (y < 1.130) return wmix('Hips', 'Spine', (y - 0.990) / 0.140);
  if (y < 1.275) return wmix('Spine', 'Chest', (y - 1.130) / 0.145);
  return w1('Chest');
}

/* ---- JERSEY: torso ---- */
{
  const prof = [
    [0.925, 0.150, 0.104], [1.000, 0.150, 0.104], [1.070, 0.161, 0.112],
    [1.150, 0.179, 0.124], [1.230, 0.196, 0.133], [1.310, 0.206, 0.137],
    [1.380, 0.210, 0.133], [1.450, 0.207, 0.124], [1.490, 0.201, 0.116],
    [1.520, 0.186, 0.105], [1.545, 0.150, 0.089], [1.560, 0.110, 0.076]
  ];
  loft(jersey, prof.map(([y, rx, rz]) => ringY(y, rx, rz, torsoW(y), 0, 0, 0.86)),
    { seg: SEG_BODY, capEnd: true, capStart: true });
}

/* ---- JERSEY: shoulder caps / short sleeves ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R';
  const cx = side * 0.200;
  const rings = [
    [1.318, 0.064], [1.370, 0.073], [1.425, 0.083],
    [1.465, 0.080], [1.495, 0.060], [1.512, 0.033]
  ].map(([y, r]) => {
    const t = y >= 1.500 ? 0.45 : y >= 1.460 ? 0.70 : 1.0;   // shoulder vs upperarm
    const w = t >= 1 ? w1('UpperArm_' + S) : wraw(['Shoulder_' + S, 1 - t], ['UpperArm_' + S, t]);
    return ringY(y, r, r * 1.03, w, cx, 0, 0.95);
  });
  loft(jersey, rings, { seg: SEG_LIMB, capStart: true, poleEnd: 0.010 });
}

/* ---- TRIM: collar ---- */
loft(trim, [
  ringY(1.512, 0.116, 0.096, wraw(['Chest', 0.75], ['Neck', 0.25]), 0, 0, 0.9),
  ringY(1.552, 0.101, 0.085, wraw(['Chest', 0.55], ['Neck', 0.45]), 0, 0, 0.9),
  ringY(1.576, 0.093, 0.079, wraw(['Chest', 0.4], ['Neck', 0.6]), 0, 0, 0.9)
], { seg: SEG_BODY });

/* ---- TRIM: sleeve cuffs ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.200;
  loft(trim, [
    ringY(1.294, 0.0665, 0.0685, w1('UpperArm_' + S), cx),
    ringY(1.332, 0.0685, 0.0705, w1('UpperArm_' + S), cx)
  ], { seg: SEG_LIMB });
}

/* ---- TRIM: jersey side stripes (thin vertical bands, team colour) ---- */
for (const side of [1, -1]) {
  const prof = [
    [0.960, 0.150, 0.104], [1.060, 0.159, 0.111], [1.160, 0.181, 0.126],
    [1.260, 0.199, 0.135], [1.350, 0.208, 0.136], [1.440, 0.208, 0.126]
  ];
  const half = 0.105;                              // angular half-width (radians)
  const base = side > 0 ? 0 : Math.PI;             // +X / -X flank
  const cols = 3;
  const rows = prof.map(([y, rx, rz]) =>
    Array.from({ length: cols }, (_, k) => {
      const t = base + (-half + (2 * half) * (k / (cols - 1)));
      const [a, b] = se(t, 0.86);
      return trim.vert([rx * a * 1.008, y, rz * b * 1.008], [k / (cols - 1), y], torsoW(y));
    })
  );
  // Same winding on both flanks: k advances in the +X -> +Z rotational sense on
  // each side, so quad(A,B,B',A') faces outward for both (flipping one side
  // back-faces it and the stripe silently disappears).
  for (let r = 0; r < rows.length - 1; r++) {
    for (let k = 0; k < cols - 1; k++) {
      const A = rows[r], B = rows[r + 1];
      trim.quad(A[k], B[k], B[k + 1], A[k + 1]);
    }
  }
}

/* ---- SKIN: neck ---- */
loft(skin, [
  ringY(1.480, 0.066, 0.062, wraw(['Chest', 0.65], ['Neck', 0.35])),
  ringY(1.545, 0.059, 0.055, w1('Neck')),
  ringY(1.610, 0.057, 0.053, wraw(['Neck', 0.55], ['Head', 0.45]))
], { seg: SEG_LIMB });

/* ---- SKIN + HAIR: head ---- */
{
  const HC = 1.735, HRX = 0.094, HRY = 0.115, HRZ = 0.101, HCZ = 0.008;
  // Skin covers the face up to mid-headband; hair takes the crown above it, so
  // the material seam is hidden under the band.
  const skinYs = [1.632, 1.660, 1.688, 1.714, 1.740, 1.766, 1.795];
  const hairYs = [1.795, 1.815, 1.833];
  loft(skin, ellipsoidRings(HC, HRX, HRY, HRZ, skinYs, w1('Head'), 0, HCZ),
    { seg: SEG_BODY, capStart: true });
  loft(hair, ellipsoidRings(HC, HRX * 1.02, HRY * 1.02, HRZ * 1.02, hairYs, w1('Head'), 0, HCZ),
    { seg: SEG_BODY, poleEnd: 0.017 });

  // hair at the nape / back of the skull, so it doesn't read as a bald head
  loft(hair, ellipsoidRings(1.716, 0.084, 0.078, 0.062,
    [1.660, 1.688, 1.716, 1.744, 1.772], w1('Head'), 0, -0.052),
    { seg: 10, capStart: true, capEnd: true });

  // nose — the forward marker, keeps the facing readable at game distance
  loft(skin, ellipsoidRings(1.716, 0.017, 0.026, 0.026,
    [1.694, 1.705, 1.716, 1.727, 1.736], w1('Head'), 0, 0.097),
    { seg: 8, capStart: true, capEnd: true });

  // eyes + brows + mouth (dark, share the hair material)
  for (const side of [1, -1]) {
    loft(hair, ellipsoidRings(1.752, 0.021, 0.015, 0.012,
      [1.739, 1.746, 1.752, 1.759, 1.766], w1('Head'), side * 0.037, 0.090),
      { seg: 8, capStart: true, capEnd: true });
    loft(hair, ellipsoidRings(1.772, 0.027, 0.008, 0.011,
      [1.765, 1.769, 1.772, 1.776, 1.779], w1('Head'), side * 0.039, 0.086),
      { seg: 8, capStart: true, capEnd: true });
  }
  loft(hair, ellipsoidRings(1.678, 0.026, 0.007, 0.012,
    [1.672, 1.675, 1.678, 1.682, 1.685], w1('Head'), 0, 0.083),
    { seg: 8, capStart: true, capEnd: true });

  // ears — set back on the skull so they read as ears, not lumps
  for (const side of [1, -1]) {
    loft(skin, ellipsoidRings(1.734, 0.012, 0.025, 0.017,
      [1.712, 1.723, 1.734, 1.745, 1.754], w1('Head'), side * 0.091, -0.014),
      { seg: 8, capStart: true, capEnd: true });
  }

  // ---- TRIM: headband, sitting across the forehead on the hair/skin seam ----
  loft(trim, [
    ringY(1.782, 0.0910, 0.0975, w1('Head'), 0, HCZ, 0.95),
    ringY(1.798, 0.0895, 0.0960, w1('Head'), 0, HCZ, 0.95),
    ringY(1.814, 0.0800, 0.0860, w1('Head'), 0, HCZ, 0.95)
  ], { seg: SEG_BODY });
}

/* ---- SKIN: arms (upper arm under the sleeve -> forearm -> hand) ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.200;
  // elbow y = 1.165, wrist y = 0.895, fingertips ≈ 0.782 (mid-thigh)
  const armW = y => {
    if (y >= 1.225) return w1('UpperArm_' + S);
    if (y >= 1.115) return wmix('UpperArm_' + S, 'LowerArm_' + S, (1.225 - y) / 0.110);
    if (y >= 0.945) return w1('LowerArm_' + S);
    if (y >= 0.890) return wmix('LowerArm_' + S, 'Hand_' + S, (0.945 - y) / 0.055);
    return w1('Hand_' + S);
  };
  const arm = [
    [1.350, 0.0600, 0.0600], [1.300, 0.0575, 0.0575], [1.250, 0.0545, 0.0545],
    [1.200, 0.0510, 0.0510], [1.165, 0.0490, 0.0490], [1.120, 0.0520, 0.0510],
    [1.060, 0.0495, 0.0480], [1.000, 0.0445, 0.0410], [0.945, 0.0385, 0.0330],
    [0.900, 0.0350, 0.0285], [0.878, 0.0380, 0.0260], [0.845, 0.0405, 0.0245],
    [0.800, 0.0330, 0.0205]
  ].map(([y, rx, rz]) => ringY(y, rx, rz, armW(y), cx, 0, y < 0.900 ? 0.8 : 1));
  arm.reverse();                                   // advance along +Y for winding
  loft(skin, arm, { seg: SEG_LIMB, capEnd: true, poleStart: 0.018 });
}

/* ---- SHORTS: hips block ---- */
{
  const hipW = y => (y >= 1.045 ? wraw(['Hips', 0.75], ['Spine', 0.25]) : w1('Hips'));
  loft(shorts, [
    [0.888, 0.189, 0.129], [0.940, 0.187, 0.127], [1.000, 0.175, 0.119], [1.062, 0.163, 0.111]
  ].map(([y, rx, rz]) => ringY(y, rx, rz, hipW(y), 0, 0, 0.86)),
    { seg: SEG_BODY, capStart: true, capEnd: true });
}

/* ---- SHORTS: short legs ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.098;
  const legW = y => (y >= 0.895 ? wraw(['Hips', 0.45], ['UpperLeg_' + S, 0.55])
    : y >= 0.830 ? wmix('Hips', 'UpperLeg_' + S, Math.min(1, 0.45 + (0.895 - y) / 0.065 * 0.55))
      : w1('UpperLeg_' + S));
  const rings = [
    [0.640, 0.088, 0.092], [0.700, 0.094, 0.098], [0.800, 0.100, 0.104], [0.905, 0.103, 0.108]
  ].map(([y, rx, rz]) => ringY(y, rx, rz, legW(y), cx, 0, 0.92));
  loft(shorts, rings, { seg: SEG_LIMB, capStart: true, capEnd: true });
}

/* ---- SKIN: thighs / knees between the shorts hem and the sock top ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.098;
  const kW = y => (y >= 0.580 ? w1('UpperLeg_' + S)
    : y >= 0.455 ? wmix('UpperLeg_' + S, 'LowerLeg_' + S, (0.580 - y) / 0.125)
      : w1('LowerLeg_' + S));
  const rings = [
    [0.420, 0.0600, 0.0620], [0.470, 0.0625, 0.0645], [0.510, 0.0665, 0.0690],
    [0.560, 0.0715, 0.0745], [0.620, 0.0785, 0.0815], [0.665, 0.0830, 0.0865]
  ].map(([y, rx, rz]) => ringY(y, rx, rz, kW(y), cx));
  loft(skin, rings, { seg: SEG_LIMB, capStart: true, capEnd: true });
}

/* ---- SOCKS ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.098;
  const sW = y => (y <= 0.120 ? wmix('LowerLeg_' + S, 'Foot_' + S, (0.120 - y) / 0.060 * 0.5) : w1('LowerLeg_' + S));
  const rings = [
    [0.098, 0.0400, 0.0400], [0.170, 0.0460, 0.0465], [0.260, 0.0545, 0.0560],
    [0.360, 0.0605, 0.0625], [0.440, 0.0650, 0.0670]
  ].map(([y, rx, rz]) => ringY(y, rx, rz, sW(y), cx));
  loft(socks, rings, { seg: SEG_LIMB, capEnd: true });
  // sock trim stripe at the top
  loft(trim, [
    ringY(0.402, 0.0635, 0.0655, w1('LowerLeg_' + S), cx),
    ringY(0.436, 0.0662, 0.0682, w1('LowerLeg_' + S), cx)
  ], { seg: SEG_LIMB });
}

/* ---- SHOES / CLEATS ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.098;
  const fW = z => (z <= 0.060 ? w1('Foot_' + S)
    : z <= 0.120 ? wmix('Foot_' + S, 'Toe_' + S, (z - 0.060) / 0.060)
      : wraw(['Foot_' + S, 0.15], ['Toe_' + S, 0.85]));
  const rings = [
    [-0.078, 0.048, 0.036, 0.052], [-0.030, 0.052, 0.044, 0.056],
    [0.030, 0.048, 0.047, 0.052], [0.090, 0.040, 0.045, 0.044],
    [0.140, 0.031, 0.038, 0.036], [0.180, 0.023, 0.026, 0.028]
  ].map(([z, hy, hx, cy]) => ringZ(z, hy, hx, fW(z), cx, cy, 0.62));
  loft(shoes, rings, { seg: SEG_FOOT, capStart: true, capEnd: true });
}

/* ---- BELT ---- */
loft(belt, [
  ringY(0.982, 0.1955, 0.1355, w1('Hips'), 0, 0, 0.86),
  ringY(1.012, 0.1905, 0.1315, w1('Hips'), 0, 0, 0.86),
  ringY(1.048, 0.1810, 0.1250, w1('Hips'), 0, 0, 0.86)
], { seg: SEG_BODY, capStart: true, capEnd: true });

/* ---- FLAGS: two ribbons hanging off the belt ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R';
  const bw = BWORLD['Flag_' + S];
  // Turned 45 deg outward so the ribbon reads as a flag from the front AND
  // from the touchline camera instead of vanishing edge-on in one of them.
  const A = side * Math.PI / 4, ca = Math.cos(A), sa = Math.sin(A);
  const rings = [
    [0.652, 0.019, 0.006], [0.696, 0.023, 0.007], [0.790, 0.026, 0.008],
    [0.890, 0.027, 0.008], [0.970, 0.027, 0.008], [1.016, 0.026, 0.008]
  ].map(([y, rx, rz]) => ({
    c: [bw[0], y, bw[2]],
    u: [rx * ca, 0, -rx * sa],
    v: [rz * sa, 0, rz * ca],
    w: w1('Flag_' + S), p: 0.35
  }));
  loft(flag, rings, { seg: SEG_FLAG, capStart: true, capEnd: true });
}

/* =============================================== 4. NORMALS (accumulated) */
function computeNormals(r) {
  const N = new Float32Array(r.P.length);
  for (let i = 0; i < r.I.length; i += 3) {
    const a = r.I[i] * 3, b = r.I[i + 1] * 3, c = r.I[i + 2] * 3;
    const e1 = [r.P[b] - r.P[a], r.P[b + 1] - r.P[a + 1], r.P[b + 2] - r.P[a + 2]];
    const e2 = [r.P[c] - r.P[a], r.P[c + 1] - r.P[a + 1], r.P[c + 2] - r.P[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const o of [a, b, c]) { N[o] += n[0]; N[o + 1] += n[1]; N[o + 2] += n[2]; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const L = Math.hypot(N[i], N[i + 1], N[i + 2]);
    if (L > 1e-9) { N[i] /= L; N[i + 1] /= L; N[i + 2] /= L; }
    else { N[i] = 0; N[i + 1] = 1; N[i + 2] = 0; }
  }
  return N;
}

/* ================================================== 5. ANIMATION AUTHORING */
/* Euler XYZ -> quaternion, matching THREE.Euler's default order. */
function euler(x, y, z) {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3
  ];
}
const rot = (node, times, eulers) => ({ node, path: 'rotation', times, values: eulers.map(e => euler(e[0], e[1], e[2])) });
const pos = (node, times, vecs) => ({ node, path: 'translation', times, values: vecs });
/* Hips translation shorthand — only Y ever moves, so clips stay in place. */
const hipY = (times, ys) => pos('Hips', times, ys.map(y => [0, y, 0]));

const CLIPS = [];
const clip = (name, duration, tracks) => CLIPS.push({ name, duration, tracks });

/* ------------------------------------------------------------------ Idle */
clip('Idle', 2.4, [
  hipY([0, 1.2, 2.4], [0.998, 1.010, 0.998]),
  rot('Spine', [0, 1.2, 2.4], [[0.10, 0, 0], [0.13, 0.02, 0], [0.10, 0, 0]]),
  rot('Chest', [0, 1.2, 2.4], [[0.05, 0, 0], [0.02, -0.03, 0], [0.05, 0, 0]]),
  rot('Head', [0, 1.2, 2.4], [[-0.05, 0, 0], [-0.03, 0.06, 0], [-0.05, 0, 0]]),
  rot('UpperArm_L', [0, 1.2, 2.4], [[0.10, 0, 0.17], [0.14, 0, 0.20], [0.10, 0, 0.17]]),
  rot('LowerArm_L', [0, 1.2, 2.4], [[0.42, 0, 0.05], [0.47, 0, 0.05], [0.42, 0, 0.05]]),
  rot('UpperArm_R', [0, 1.2, 2.4], [[0.10, 0, -0.17], [0.14, 0, -0.20], [0.10, 0, -0.17]]),
  rot('LowerArm_R', [0, 1.2, 2.4], [[0.42, 0, -0.05], [0.47, 0, -0.05], [0.42, 0, -0.05]]),
  rot('UpperLeg_L', [0, 2.4], [[0.10, 0, 0.03], [0.10, 0, 0.03]]),
  rot('LowerLeg_L', [0, 2.4], [[-0.18, 0, 0], [-0.18, 0, 0]]),
  rot('Foot_L', [0, 2.4], [[0.08, 0, 0], [0.08, 0, 0]]),
  rot('UpperLeg_R', [0, 2.4], [[0.10, 0, -0.03], [0.10, 0, -0.03]]),
  rot('LowerLeg_R', [0, 2.4], [[-0.18, 0, 0], [-0.18, 0, 0]]),
  rot('Foot_R', [0, 2.4], [[0.08, 0, 0], [0.08, 0, 0]]),
  rot('Flag_L', [0, 1.2, 2.4], [[0.02, 0, 0.04], [-0.03, 0, 0.02], [0.02, 0, 0.04]]),
  rot('Flag_R', [0, 1.2, 2.4], [[-0.02, 0, -0.02], [0.03, 0, -0.04], [-0.02, 0, -0.02]])
]);

/* ------------------------------------------------------------------- Run */
{
  const T = [0, 0.155, 0.31, 0.465, 0.62];
  // left leg cycle: contact -> midstance -> toe-off -> mid-swing -> contact
  const thighL = [-0.48, -0.05, 0.42, -0.28, -0.48];
  const shinL = [-0.22, -0.14, -0.58, -1.55, -0.22];
  const footL = [0.22, 0.05, 0.38, -0.18, 0.22];
  const shift = a => [a[2], a[3], a[0], a[1], a[2]];
  clip('Run', 0.62, [
    hipY(T, [1.030, 1.004, 1.030, 1.004, 1.030]),
    rot('Spine', [0, 0.62], [[0.26, 0, 0], [0.26, 0, 0]]),
    rot('Chest', T, [[0.06, 0.13, 0], [0.06, 0.05, 0], [0.06, -0.13, 0], [0.06, -0.05, 0], [0.06, 0.13, 0]]),
    rot('Head', [0, 0.62], [[-0.22, 0, 0], [-0.22, 0, 0]]),
    rot('UpperLeg_L', T, thighL.map(v => [v, 0, 0.02])),
    rot('LowerLeg_L', T, shinL.map(v => [v, 0, 0])),
    rot('Foot_L', T, footL.map(v => [v, 0, 0])),
    rot('UpperLeg_R', T, shift(thighL).map(v => [v, 0, -0.02])),
    rot('LowerLeg_R', T, shift(shinL).map(v => [v, 0, 0])),
    rot('Foot_R', T, shift(footL).map(v => [v, 0, 0])),
    rot('UpperArm_L', [0, 0.31, 0.62], [[0.62, 0, 0.22], [-0.78, 0, 0.22], [0.62, 0, 0.22]]),
    rot('LowerArm_L', [0, 0.31, 0.62], [[1.05, 0, 0.08], [1.38, 0, 0.08], [1.05, 0, 0.08]]),
    rot('UpperArm_R', [0, 0.31, 0.62], [[-0.78, 0, -0.22], [0.62, 0, -0.22], [-0.78, 0, -0.22]]),
    rot('LowerArm_R', [0, 0.31, 0.62], [[1.38, 0, -0.08], [1.05, 0, -0.08], [1.38, 0, -0.08]]),
    rot('Flag_L', T, [[-0.30, 0, 0.06], [0.18, 0, 0.06], [-0.30, 0, 0.06], [0.18, 0, 0.06], [-0.30, 0, 0.06]]),
    rot('Flag_R', T, [[0.18, 0, -0.06], [-0.30, 0, -0.06], [0.18, 0, -0.06], [-0.30, 0, -0.06], [0.18, 0, -0.06]])
  ]);
}

/* ------------------------------------------------------------------ Walk */
{
  const T = [0, 0.25, 0.5, 0.75, 1.0];
  const thighL = [-0.34, -0.06, 0.30, -0.16, -0.34];
  const shinL = [-0.12, -0.08, -0.36, -0.78, -0.12];
  const footL = [0.12, 0.02, 0.26, -0.10, 0.12];
  const shift = a => [a[2], a[3], a[0], a[1], a[2]];
  clip('Walk', 1.0, [
    hipY(T, [1.006, 0.996, 1.006, 0.996, 1.006]),
    rot('Spine', [0, 1.0], [[0.10, 0, 0], [0.10, 0, 0]]),
    rot('Chest', T, [[0.02, 0.07, 0], [0.02, 0.02, 0], [0.02, -0.07, 0], [0.02, -0.02, 0], [0.02, 0.07, 0]]),
    rot('UpperLeg_L', T, thighL.map(v => [v, 0, 0.02])),
    rot('LowerLeg_L', T, shinL.map(v => [v, 0, 0])),
    rot('Foot_L', T, footL.map(v => [v, 0, 0])),
    rot('UpperLeg_R', T, shift(thighL).map(v => [v, 0, -0.02])),
    rot('LowerLeg_R', T, shift(shinL).map(v => [v, 0, 0])),
    rot('Foot_R', T, shift(footL).map(v => [v, 0, 0])),
    rot('UpperArm_L', [0, 0.5, 1.0], [[0.32, 0, 0.16], [-0.34, 0, 0.16], [0.32, 0, 0.16]]),
    rot('LowerArm_L', [0, 0.5, 1.0], [[0.44, 0, 0.05], [0.62, 0, 0.05], [0.44, 0, 0.05]]),
    rot('UpperArm_R', [0, 0.5, 1.0], [[-0.34, 0, -0.16], [0.32, 0, -0.16], [-0.34, 0, -0.16]]),
    rot('LowerArm_R', [0, 0.5, 1.0], [[0.62, 0, -0.05], [0.44, 0, -0.05], [0.62, 0, -0.05]]),
    rot('Flag_L', [0, 0.5, 1.0], [[-0.12, 0, 0.04], [0.08, 0, 0.04], [-0.12, 0, 0.04]]),
    rot('Flag_R', [0, 0.5, 1.0], [[0.08, 0, -0.04], [-0.12, 0, -0.04], [0.08, 0, -0.04]])
  ]);
}

/* ------------------------------------------------------------- Backpedal */
{
  const T = [0, 0.25, 0.5];
  clip('Backpedal', 0.5, [
    hipY(T, [0.960, 0.978, 0.960]),
    rot('Spine', [0, 0.5], [[-0.10, 0, 0], [-0.10, 0, 0]]),
    rot('Chest', [0, 0.5], [[0.14, 0, 0], [0.14, 0, 0]]),
    rot('Head', [0, 0.5], [[0.06, 0, 0], [0.06, 0, 0]]),
    rot('UpperLeg_L', T, [[-0.42, 0, 0.05], [0.18, 0, 0.05], [-0.42, 0, 0.05]]),
    rot('LowerLeg_L', T, [[-0.95, 0, 0], [-0.45, 0, 0], [-0.95, 0, 0]]),
    rot('Foot_L', T, [[0.30, 0, 0], [0.20, 0, 0], [0.30, 0, 0]]),
    rot('UpperLeg_R', T, [[0.18, 0, -0.05], [-0.42, 0, -0.05], [0.18, 0, -0.05]]),
    rot('LowerLeg_R', T, [[-0.45, 0, 0], [-0.95, 0, 0], [-0.45, 0, 0]]),
    rot('Foot_R', T, [[0.20, 0, 0], [0.30, 0, 0], [0.20, 0, 0]]),
    rot('UpperArm_L', T, [[-0.18, 0, 0.34], [0.02, 0, 0.34], [-0.18, 0, 0.34]]),
    rot('LowerArm_L', [0, 0.5], [[1.20, 0, 0.12], [1.20, 0, 0.12]]),
    rot('UpperArm_R', T, [[0.02, 0, -0.34], [-0.18, 0, -0.34], [0.02, 0, -0.34]]),
    rot('LowerArm_R', [0, 0.5], [[1.20, 0, -0.12], [1.20, 0, -0.12]])
  ]);
}

/* ----------------------------------------------------------------- Throw */
/* A right-handed quarterback: torso coils away, the upper arm abducts to
   shoulder height with the forearm cocked back, then the elbow drives forward
   and the forearm whips through a high three-quarter release. Note the arm is
   posed with Z abduction + X elevation rather than a big X backswing — with a
   fully abducted arm an X rotation only twists it (gimbal), so the drive has to
   come from decreasing abduction while X sweeps forward. */
clip('Throw', 1.10, [
  hipY([0, 0.42, 0.66, 1.1], [0.995, 0.986, 0.998, 0.998]),
  rot('Hips', [0, 0.42, 0.66, 1.1], [[0, -0.22, 0], [0, -0.36, 0], [0, 0.20, 0], [0, 0.06, 0]]),
  rot('Spine', [0, 0.42, 0.66, 1.1], [[0.08, -0.30, 0], [0.06, -0.44, 0], [0.14, 0.36, 0], [0.10, 0.12, 0]]),
  rot('Chest', [0, 0.42, 0.66, 1.1], [[0.02, -0.26, 0], [0.02, -0.42, 0], [0.06, 0.36, 0], [0.03, 0.10, 0]]),
  rot('Head', [0, 0.42, 0.66, 1.1], [[-0.05, 0.26, 0], [-0.05, 0.38, 0], [-0.05, -0.16, 0], [-0.05, 0, 0]]),
  rot('UpperArm_R', [0, 0.34, 0.52, 0.66, 0.78, 0.92, 1.10],
    [[0.12, 0, -0.20], [-0.20, -0.35, -1.20], [-0.05, -0.55, -1.55],
     [-1.20, -0.15, -1.15], [-2.10, 0.30, -0.75], [-1.30, 0.35, -0.45], [0.12, 0, -0.18]]),
  rot('LowerArm_R', [0, 0.34, 0.52, 0.66, 0.78, 0.92, 1.10],
    [[1.10, 0, 0], [1.60, 0, 0], [1.95, 0, 0], [1.60, 0, 0], [0.45, 0, 0], [0.75, 0, 0], [1.10, 0, 0]]),
  // left arm points at the target then tucks
  rot('UpperArm_L', [0, 0.45, 0.70, 1.10], [[0.10, 0, 0.18], [-1.15, 0.30, 0.35], [-0.55, 0.20, 0.30], [0.12, 0, 0.18]]),
  rot('LowerArm_L', [0, 0.45, 0.70, 1.10], [[1.00, 0, 0], [0.35, 0, 0], [0.90, 0, 0], [1.05, 0, 0]]),
  rot('UpperLeg_L', [0, 0.42, 0.66, 1.10], [[0.06, 0, 0.03], [-0.30, 0, 0.05], [-0.45, 0, 0.05], [-0.12, 0, 0.03]]),
  rot('LowerLeg_L', [0, 0.42, 0.66, 1.10], [[-0.24, 0, 0], [-0.30, 0, 0], [-0.18, 0, 0], [-0.22, 0, 0]]),
  rot('UpperLeg_R', [0, 0.42, 0.66, 1.10], [[0.06, 0, -0.03], [0.22, 0, -0.06], [0.34, 0, -0.06], [0.10, 0, -0.03]]),
  rot('LowerLeg_R', [0, 0.42, 0.66, 1.10], [[-0.24, 0, 0], [-0.42, 0, 0], [-0.55, 0, 0], [-0.26, 0, 0]]),
  rot('Foot_R', [0, 0.66, 1.10], [[0.08, 0, 0], [0.28, 0, 0], [0.10, 0, 0]])
]);

/* ----------------------------------------------------------------- Catch */
clip('Catch', 0.90, [
  hipY([0, 0.35, 0.9], [1.000, 1.020, 0.996]),
  rot('Spine', [0, 0.35, 0.9], [[0.10, 0, 0], [-0.10, 0, 0], [0.14, 0, 0]]),
  rot('Chest', [0, 0.35, 0.9], [[0.04, 0, 0], [-0.06, 0, 0], [0.06, 0, 0]]),
  rot('Head', [0, 0.35, 0.9], [[-0.05, 0, 0], [-0.30, 0, 0], [-0.02, 0, 0]]),
  rot('UpperArm_L', [0, 0.35, 0.60, 0.90], [[0.12, 0, 0.18], [-2.30, 0, 0.22], [-1.60, 0, 0.30], [0.20, 0, 0.20]]),
  rot('LowerArm_L', [0, 0.35, 0.60, 0.90], [[1.05, 0, 0], [0.22, 0, 0], [1.10, 0, 0], [1.35, 0, 0]]),
  rot('UpperArm_R', [0, 0.35, 0.60, 0.90], [[0.12, 0, -0.18], [-2.30, 0, -0.22], [-1.60, 0, -0.30], [0.20, 0, -0.20]]),
  rot('LowerArm_R', [0, 0.35, 0.60, 0.90], [[1.05, 0, 0], [0.22, 0, 0], [1.10, 0, 0], [1.35, 0, 0]]),
  rot('UpperLeg_L', [0, 0.35, 0.9], [[-0.10, 0, 0.03], [-0.05, 0, 0.03], [-0.18, 0, 0.03]]),
  rot('LowerLeg_L', [0, 0.9], [[-0.22, 0, 0], [-0.30, 0, 0]]),
  rot('UpperLeg_R', [0, 0.35, 0.9], [[0.14, 0, -0.03], [-0.05, 0, -0.03], [0.18, 0, -0.03]]),
  rot('LowerLeg_R', [0, 0.9], [[-0.22, 0, 0], [-0.30, 0, 0]])
]);

/* ------------------------------------------------------------------ Dive */
clip('Dive', 1.20, [
  hipY([0, 0.35, 0.70, 1.20], [0.960, 1.140, 0.760, 0.520]),
  rot('Hips', [0, 0.35, 0.70, 1.20], [[0, 0, 0], [-0.55, 0, 0], [-1.05, 0, 0], [-1.35, 0, 0]]),
  rot('Spine', [0, 0.35, 1.20], [[0.20, 0, 0], [-0.10, 0, 0], [-0.16, 0, 0]]),
  rot('Head', [0, 0.35, 1.20], [[-0.10, 0, 0], [0.45, 0, 0], [0.55, 0, 0]]),
  rot('UpperArm_L', [0, 0.40, 1.20], [[0.12, 0, 0.18], [-2.55, 0, 0.18], [-2.35, 0, 0.16]]),
  rot('LowerArm_L', [0, 0.40, 1.20], [[0.90, 0, 0], [0.30, 0, 0], [0.15, 0, 0]]),
  rot('UpperArm_R', [0, 0.40, 1.20], [[0.12, 0, -0.18], [-2.55, 0, -0.18], [-2.35, 0, -0.16]]),
  rot('LowerArm_R', [0, 0.40, 1.20], [[0.90, 0, 0], [0.30, 0, 0], [0.15, 0, 0]]),
  rot('UpperLeg_L', [0, 0.35, 0.70, 1.20], [[-0.30, 0, 0.04], [0.55, 0, 0.06], [0.70, 0, 0.06], [0.55, 0, 0.05]]),
  rot('LowerLeg_L', [0, 0.35, 1.20], [[-0.55, 0, 0], [-0.35, 0, 0], [-0.85, 0, 0]]),
  rot('UpperLeg_R', [0, 0.35, 0.70, 1.20], [[-0.30, 0, -0.04], [0.55, 0, -0.06], [0.70, 0, -0.06], [0.55, 0, -0.05]]),
  rot('LowerLeg_R', [0, 0.35, 1.20], [[-0.55, 0, 0], [-0.35, 0, 0], [-0.85, 0, 0]])
]);

/* ------------------------------------------------------------ FlagPulled */
/* Reaction of the ball carrier: jerked to a stop, hands up, body slumps. */
clip('FlagPulled', 1.10, [
  hipY([0, 0.18, 0.45, 1.10], [1.000, 1.020, 0.930, 0.952]),
  rot('Hips', [0, 0.18, 0.45, 1.10], [[0, 0, 0], [-0.10, 0.10, 0], [0.16, 0.22, 0], [0.10, 0.16, 0]]),
  rot('Spine', [0, 0.18, 0.45, 1.10], [[0.10, 0, 0], [-0.22, -0.12, 0], [0.34, -0.20, 0], [0.26, -0.14, 0]]),
  rot('Chest', [0, 0.18, 0.45, 1.10], [[0.04, 0, 0], [-0.14, 0, 0], [0.18, 0, 0], [0.14, 0, 0]]),
  rot('Head', [0, 0.18, 0.45, 1.10], [[-0.05, 0, 0], [-0.28, 0, 0], [0.30, 0, 0], [0.22, 0, 0]]),
  rot('UpperArm_L', [0, 0.18, 0.45, 1.10], [[0.10, 0, 0.18], [-1.30, 0, 0.55], [-0.55, 0, 0.45], [-0.20, 0, 0.35]]),
  rot('LowerArm_L', [0, 0.18, 0.45, 1.10], [[1.00, 0, 0], [0.55, 0, 0], [1.10, 0, 0], [1.25, 0, 0]]),
  rot('UpperArm_R', [0, 0.18, 0.45, 1.10], [[0.10, 0, -0.18], [-1.30, 0, -0.55], [-0.55, 0, -0.45], [-0.20, 0, -0.35]]),
  rot('LowerArm_R', [0, 0.18, 0.45, 1.10], [[1.00, 0, 0], [0.55, 0, 0], [1.10, 0, 0], [1.25, 0, 0]]),
  rot('UpperLeg_L', [0, 0.18, 0.45, 1.10], [[-0.35, 0, 0.04], [-0.60, 0, 0.06], [-0.25, 0, 0.05], [-0.20, 0, 0.04]]),
  rot('LowerLeg_L', [0, 0.18, 0.45, 1.10], [[-0.30, 0, 0], [-0.20, 0, 0], [-0.55, 0, 0], [-0.45, 0, 0]]),
  rot('UpperLeg_R', [0, 0.18, 0.45, 1.10], [[0.30, 0, -0.04], [0.45, 0, -0.06], [0.10, 0, -0.05], [0.05, 0, -0.04]]),
  rot('LowerLeg_R', [0, 0.18, 0.45, 1.10], [[-0.55, 0, 0], [-0.70, 0, 0], [-0.40, 0, 0], [-0.35, 0, 0]]),
  // the flag rips away and flies
  rot('Flag_L', [0, 0.18, 0.45, 1.10], [[0, 0, 0.05], [-0.9, 0.4, 0.5], [-1.6, 0.9, 0.9], [-1.9, 1.2, 1.1]]),
  rot('Flag_R', [0, 1.10], [[0, 0, -0.05], [0.25, 0, -0.10]])
]);

/* ------------------------------------------------------------- Celebrate */
clip('Celebrate', 1.00, [
  hipY([0, 0.25, 0.5, 0.75, 1.0], [1.000, 1.090, 1.000, 1.090, 1.000]),
  rot('Spine', [0, 0.5, 1.0], [[0.02, 0.16, 0], [0.02, -0.16, 0], [0.02, 0.16, 0]]),
  rot('Head', [0, 0.5, 1.0], [[-0.18, 0.10, 0], [-0.18, -0.10, 0], [-0.18, 0.10, 0]]),
  rot('UpperArm_L', [0, 0.5, 1.0], [[-2.75, 0, 0.30], [-2.55, 0, 0.55], [-2.75, 0, 0.30]]),
  rot('LowerArm_L', [0, 0.5, 1.0], [[0.35, 0, 0], [0.10, 0, 0], [0.35, 0, 0]]),
  rot('UpperArm_R', [0, 0.5, 1.0], [[-2.75, 0, -0.30], [-2.55, 0, -0.55], [-2.75, 0, -0.30]]),
  rot('LowerArm_R', [0, 0.5, 1.0], [[0.35, 0, 0], [0.10, 0, 0], [0.35, 0, 0]]),
  rot('UpperLeg_L', [0, 0.25, 0.5, 0.75, 1.0], [[0.05, 0, 0.03], [-0.35, 0, 0.05], [0.05, 0, 0.03], [-0.35, 0, 0.05], [0.05, 0, 0.03]]),
  rot('LowerLeg_L', [0, 0.25, 0.5, 0.75, 1.0], [[-0.22, 0, 0], [-0.75, 0, 0], [-0.22, 0, 0], [-0.75, 0, 0], [-0.22, 0, 0]]),
  rot('UpperLeg_R', [0, 0.25, 0.5, 0.75, 1.0], [[0.05, 0, -0.03], [-0.35, 0, -0.05], [0.05, 0, -0.03], [-0.35, 0, -0.05], [0.05, 0, -0.03]]),
  rot('LowerLeg_R', [0, 0.25, 0.5, 0.75, 1.0], [[-0.22, 0, 0], [-0.75, 0, 0], [-0.22, 0, 0], [-0.75, 0, 0], [-0.22, 0, 0]]),
  rot('Foot_L', [0, 0.25, 0.5, 0.75, 1.0], [[0.10, 0, 0], [0.40, 0, 0], [0.10, 0, 0], [0.40, 0, 0], [0.10, 0, 0]]),
  rot('Foot_R', [0, 0.25, 0.5, 0.75, 1.0], [[0.10, 0, 0], [0.40, 0, 0], [0.10, 0, 0], [0.40, 0, 0], [0.10, 0, 0]]),
  rot('Flag_L', [0, 0.25, 0.5, 0.75, 1.0], [[0.25, 0, 0.08], [-0.30, 0, 0.08], [0.25, 0, 0.08], [-0.30, 0, 0.08], [0.25, 0, 0.08]]),
  rot('Flag_R', [0, 0.25, 0.5, 0.75, 1.0], [[0.25, 0, -0.08], [-0.30, 0, -0.08], [0.25, 0, -0.08], [-0.30, 0, -0.08], [0.25, 0, -0.08]])
]);

/* ------------------------------------------------------------------ Juke */
clip('Juke', 0.80, [
  hipY([0, 0.20, 0.45, 0.80], [1.000, 0.940, 0.975, 1.010]),
  rot('Hips', [0, 0.20, 0.45, 0.80], [[0, 0, 0.20], [0, 0.25, 0.40], [0, -0.30, -0.35], [0, 0, -0.12]]),
  rot('Spine', [0, 0.20, 0.45, 0.80], [[0.12, 0, -0.18], [0.30, -0.20, -0.34], [0.24, 0.25, 0.30], [0.14, 0, 0.10]]),
  rot('Head', [0, 0.20, 0.45, 0.80], [[-0.08, 0.20, 0], [-0.08, 0.35, 0], [-0.08, -0.30, 0], [-0.08, 0, 0]]),
  rot('UpperArm_L', [0, 0.20, 0.45, 0.80], [[-0.35, 0, 0.55], [-0.75, 0, 0.85], [0.30, 0, 0.30], [-0.10, 0, 0.30]]),
  rot('LowerArm_L', [0, 0.80], [[1.25, 0, 0], [1.15, 0, 0]]),
  rot('UpperArm_R', [0, 0.20, 0.45, 0.80], [[0.30, 0, -0.30], [0.55, 0, -0.30], [-0.75, 0, -0.85], [-0.10, 0, -0.30]]),
  rot('LowerArm_R', [0, 0.80], [[1.15, 0, 0], [1.25, 0, 0]]),
  rot('UpperLeg_L', [0, 0.20, 0.45, 0.80], [[-0.45, 0, 0.10], [0.20, 0, 0.35], [-0.55, 0, 0.06], [-0.30, 0, 0.04]]),
  rot('LowerLeg_L', [0, 0.20, 0.45, 0.80], [[-0.35, 0, 0], [-0.30, 0, 0], [-0.90, 0, 0], [-0.35, 0, 0]]),
  rot('UpperLeg_R', [0, 0.20, 0.45, 0.80], [[0.30, 0, -0.06], [-0.50, 0, -0.10], [0.35, 0, -0.35], [-0.15, 0, -0.04]]),
  rot('LowerLeg_R', [0, 0.20, 0.45, 0.80], [[-0.60, 0, 0], [-0.95, 0, 0], [-0.35, 0, 0], [-0.40, 0, 0]]),
  rot('Flag_L', [0, 0.20, 0.45, 0.80], [[0.15, 0, 0.05], [-0.35, 0.3, 0.30], [0.35, -0.3, -0.10], [0.05, 0, 0.05]]),
  rot('Flag_R', [0, 0.20, 0.45, 0.80], [[0.15, 0, -0.05], [-0.35, 0.3, 0.10], [0.35, -0.3, -0.30], [0.05, 0, -0.05]])
]);

/* ==================================================== 6. glTF ASSEMBLY */

class BinWriter {
  constructor() { this.parts = []; this.len = 0; }
  pad(n = 4) { const r = this.len % n; if (r) { const b = Buffer.alloc(n - r); this.parts.push(b); this.len += b.length; } }
  write(typed) {
    this.pad(4);
    const off = this.len;
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    this.parts.push(buf); this.len += buf.length;
    return off;
  }
  concat() { return Buffer.concat(this.parts, this.len); }
}

const gltf = {
  asset: { version: '2.0', generator: 'flagster/tools/build-player-glb.mjs' },
  scene: 0, scenes: [{ name: 'Flagster_Player', nodes: [] }],
  nodes: [], meshes: [], materials: [], skins: [],
  accessors: [], bufferViews: [], buffers: [], animations: []
};
const bin = new BinWriter();

const COMP = { f32: 5126, u32: 5125, u16: 5123, u8: 5121 };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessor(typed, type, componentType, target, opts = {}) {
  const off = bin.write(typed);
  const bvIndex = gltf.bufferViews.length;
  const bv = { buffer: 0, byteOffset: off, byteLength: typed.byteLength };
  if (target) bv.target = target;
  gltf.bufferViews.push(bv);
  const n = NCOMP[type];
  const count = typed.length / n;
  const acc = { bufferView: bvIndex, componentType, count, type };
  if (opts.normalized) acc.normalized = true;
  if (opts.minmax) {
    const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
    for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) {
      const v = typed[i * n + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    acc.min = min; acc.max = max;
  }
  gltf.accessors.push(acc);
  return gltf.accessors.length - 1;
}

/* ---- materials ---- */
const MATDEF = [
  ['jersey', [0.17, 0.36, 1.00], 0.72, 0.02],
  ['trim',   [1.00, 1.00, 1.00], 0.60, 0.02],
  ['skin',   [0.91, 0.72, 0.56], 0.78, 0.00],
  ['hair',   [0.10, 0.075, 0.055], 0.85, 0.00],
  ['shorts', [0.125, 0.19, 0.29], 0.85, 0.00],
  ['socks',  [0.95, 0.95, 0.95], 0.88, 0.00],
  ['shoes',  [0.06, 0.06, 0.07], 0.45, 0.05],
  ['belt',   [0.09, 0.09, 0.11], 0.65, 0.05],
  ['flag',   [1.00, 0.82, 0.25], 0.80, 0.00]
];
const MI = {};
MATDEF.forEach(([name, c, rough, metal]) => {
  MI[name] = gltf.materials.length;
  gltf.materials.push({
    name,
    pbrMetallicRoughness: { baseColorFactor: [c[0], c[1], c[2], 1], metallicFactor: metal, roughnessFactor: rough },
    doubleSided: name === 'flag'
  });
});

/* ---- skin (inverse bind matrices = translate by -worldRest) ---- */
const ibm = new Float32Array(BONES.length * 16);
BONES.forEach(([name], i) => {
  const p = BWORLD[name];
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1];   // column-major
  ibm.set(m, i * 16);
});

/* ---- bone nodes (indices 0..N-1 so joint index === node index) ---- */
BONES.forEach(([name, parent, t]) => {
  gltf.nodes.push({ name, translation: [t[0], t[1], t[2]], children: [] });
});
BONES.forEach(([name, parent], i) => { if (parent) gltf.nodes[BI[parent]].children.push(i); });
gltf.nodes.forEach(n => { if (!n.children.length) delete n.children; });

const skinIndex = 0;
gltf.skins.push({
  name: 'FlagPlayerRig',
  inverseBindMatrices: accessor(ibm, 'MAT4', COMP.f32),
  skeleton: BI.Hips,
  joints: BONES.map((_, i) => i)
});

/* ---- mesh nodes, one per region so THREE names each SkinnedMesh ---- */
gltf.scenes[0].nodes.push(BI.Hips);
let totalTris = 0, totalVerts = 0;
for (const r of REGIONS) {
  if (!r.I.length) continue;
  const N = computeNormals(r);
  const prim = {
    attributes: {
      POSITION: accessor(new Float32Array(r.P), 'VEC3', COMP.f32, 34962, { minmax: true }),
      NORMAL: accessor(N, 'VEC3', COMP.f32, 34962),
      TEXCOORD_0: accessor(new Float32Array(r.U), 'VEC2', COMP.f32, 34962),
      JOINTS_0: accessor(new Uint8Array(r.J), 'VEC4', COMP.u8, 34962),
      WEIGHTS_0: accessor(new Float32Array(r.W), 'VEC4', COMP.f32, 34962)
    },
    indices: accessor(new Uint16Array(r.I), 'SCALAR', COMP.u16, 34963),
    material: MI[r.material],
    mode: 4
  };
  const meshIndex = gltf.meshes.length;
  gltf.meshes.push({ name: r.name, primitives: [prim] });
  const nodeIndex = gltf.nodes.length;
  gltf.nodes.push({ name: r.name, mesh: meshIndex, skin: skinIndex });
  gltf.scenes[0].nodes.push(nodeIndex);
  totalTris += r.triCount; totalVerts += r.P.length / 3;
}

/* ---- animations ---- */
for (const c of CLIPS) {
  const samplers = [], channels = [];
  for (const tr of c.tracks) {
    if (BI[tr.node] == null) throw new Error('unknown animated node ' + tr.node);
    const times = new Float32Array(tr.times);
    let flat;
    if (tr.path === 'rotation') {
      // keep consecutive quaternions in the same hemisphere so LINEAR slerp
      // always takes the short way round
      const q = tr.values.map(v => v.slice());
      for (let i = 1; i < q.length; i++) {
        const d = q[i][0] * q[i - 1][0] + q[i][1] * q[i - 1][1] + q[i][2] * q[i - 1][2] + q[i][3] * q[i - 1][3];
        if (d < 0) for (let k = 0; k < 4; k++) q[i][k] = -q[i][k];
      }
      flat = new Float32Array(q.flat());
    } else {
      flat = new Float32Array(tr.values.flat());
    }
    if (times.length !== flat.length / (tr.path === 'rotation' ? 4 : 3)) {
      throw new Error(`${c.name}: ${tr.node}.${tr.path} key count mismatch`);
    }
    const input = accessor(times, 'SCALAR', COMP.f32, null, { minmax: true });
    const output = accessor(flat, tr.path === 'rotation' ? 'VEC4' : 'VEC3', COMP.f32);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: BI[tr.node], path: tr.path } });
  }
  gltf.animations.push({ name: c.name, samplers, channels });
}

/* ---- pack the GLB ---- */
const binBuf = bin.concat();
gltf.buffers.push({ byteLength: binBuf.length });

let jsonStr = JSON.stringify(gltf);
while (jsonStr.length % 4) jsonStr += ' ';
const jsonBuf = Buffer.from(jsonStr, 'utf8');
const binPad = (4 - (binBuf.length % 4)) % 4;
const binChunk = binPad ? Buffer.concat([binBuf, Buffer.alloc(binPad)]) : binBuf;

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);                                   // 'glTF'
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binChunk.length, 8);

const jsonHead = Buffer.alloc(8);
jsonHead.writeUInt32LE(jsonBuf.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);  // 'JSON'
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(binChunk.length, 0); binHead.writeUInt32LE(0x004e4942, 4);   // 'BIN'

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, jsonHead, jsonBuf, binHead, binChunk]));

/* ---- report ---- */
const size = fs.statSync(OUT).size;
console.log('wrote ' + OUT);
console.log('  height        ' + HEIGHT_M.toFixed(3) + ' m (author units: metres)');
console.log('  joints        ' + BONES.length);
console.log('  regions       ' + REGIONS.filter(r => r.I.length).map(r => r.name).join(', '));
console.log('  vertices      ' + totalVerts);
console.log('  triangles     ' + totalTris);
console.log('  clips         ' + CLIPS.map(c => c.name).join(', '));
console.log('  file size     ' + (size / 1024).toFixed(1) + ' KB');
