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
    [0.925, 0.148, 0.103], [1.000, 0.148, 0.103], [1.070, 0.157, 0.110],
    [1.150, 0.178, 0.124], [1.230, 0.200, 0.136], [1.310, 0.216, 0.142],
    [1.380, 0.228, 0.140], [1.450, 0.228, 0.132], [1.490, 0.219, 0.122],
    [1.520, 0.198, 0.109], [1.545, 0.156, 0.091], [1.560, 0.112, 0.077]
  ];
  loft(jersey, prof.map(([y, rx, rz]) => ringY(y, rx, rz, torsoW(y), 0, 0, 0.86)),
    { seg: SEG_BODY, capEnd: true, capStart: true });
}

/* ---- JERSEY: shoulder caps / short sleeves ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R';
  const cx = side * 0.200;
  const rings = [
    [1.318, 0.074], [1.370, 0.084], [1.425, 0.094],
    [1.465, 0.091], [1.495, 0.068], [1.512, 0.037]
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
    ringY(1.294, 0.0775, 0.0795, w1('UpperArm_' + S), cx),
    ringY(1.332, 0.0795, 0.0815, w1('UpperArm_' + S), cx)
  ], { seg: SEG_LIMB });
}

/* ---- TRIM: jersey side stripes (thin vertical bands, team colour) ---- */
for (const side of [1, -1]) {
  const prof = [
    [0.960, 0.148, 0.103], [1.060, 0.155, 0.109], [1.160, 0.180, 0.125],
    [1.260, 0.205, 0.138], [1.350, 0.222, 0.141], [1.440, 0.228, 0.131]
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
  ringY(1.480, 0.079, 0.074, wraw(['Chest', 0.65], ['Neck', 0.35])),
  ringY(1.545, 0.070, 0.065, w1('Neck')),
  ringY(1.610, 0.066, 0.061, wraw(['Neck', 0.55], ['Head', 0.45]))
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
    [1.350, 0.0710, 0.0710], [1.300, 0.0690, 0.0685], [1.250, 0.0645, 0.0640],
    [1.200, 0.0580, 0.0575], [1.165, 0.0545, 0.0540], [1.120, 0.0600, 0.0585],
    [1.060, 0.0570, 0.0550], [1.000, 0.0500, 0.0460], [0.945, 0.0420, 0.0360],
    [0.900, 0.0375, 0.0305], [0.878, 0.0405, 0.0278], [0.845, 0.0430, 0.0262],
    [0.800, 0.0350, 0.0220]
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
    [0.640, 0.095, 0.099], [0.700, 0.102, 0.106], [0.800, 0.108, 0.112], [0.905, 0.111, 0.116]
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
    [0.420, 0.0620, 0.0640], [0.470, 0.0655, 0.0675], [0.510, 0.0705, 0.0730],
    [0.560, 0.0770, 0.0800], [0.620, 0.0855, 0.0885], [0.665, 0.0905, 0.0940]
  ].map(([y, rx, rz]) => ringY(y, rx, rz, kW(y), cx));
  loft(skin, rings, { seg: SEG_LIMB, capStart: true, capEnd: true });
}

/* ---- SOCKS ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.098;
  const sW = y => (y <= 0.120 ? wmix('LowerLeg_' + S, 'Foot_' + S, (0.120 - y) / 0.060 * 0.5) : w1('LowerLeg_' + S));
  const rings = [
    [0.098, 0.0420, 0.0420], [0.170, 0.0520, 0.0530], [0.260, 0.0645, 0.0665],
    [0.330, 0.0660, 0.0685], [0.440, 0.0645, 0.0665]
  ].map(([y, rx, rz]) => ringY(y, rx, rz, sW(y), cx));
  loft(socks, rings, { seg: SEG_LIMB, capEnd: true });
  // sock trim stripe at the top
  loft(trim, [
    ringY(0.402, 0.0672, 0.0692, w1('LowerLeg_' + S), cx),
    ringY(0.436, 0.0668, 0.0688, w1('LowerLeg_' + S), cx)
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
/* Same track, but keyed with quaternions that were solved rather than typed —
   see armQ below. */
const rotq = (node, times, quats) => ({ node, path: 'rotation', times, values: quats });
const pos = (node, times, vecs) => ({ node, path: 'translation', times, values: vecs });
/* Hips translation shorthand — only Y ever moves, so clips stay in place. */
const hipY = (times, ys) => pos('Hips', times, ys.map(y => [0, y, 0]));

const CLIPS = [];
const clip = (name, duration, tracks) => CLIPS.push({ name, duration, tracks });

/* --- Sagittal-plane sign convention ---------------------------------------
   The rig faces +Z and every limb hangs along -Y, so a POSITIVE rotation about
   X swings a limb's far end toward -Z (backwards) and a negative one swings it
   toward +Z (forwards). Authoring raw X values against that rule is how the
   first pass shipped knees and elbows that bent the wrong way — a knee folding
   FORWARD also carries the whole foot around behind the shin, which is why the
   run read as a bird's gait with reversed feet. Sagittal joints are therefore
   authored in DEGREES of the motion they anatomically perform, and converted
   here exactly once:

     hip(a)       a > 0  thigh swings forward (flexion)
     knee(a)      a > 0  heel folds up behind the thigh — a human knee is
                         never negative here
     ankle(a)     a > 0  toes pull up toward the shin (dorsiflexion)
                  a < 0  toes point away from the shin (plantarflexion)
     toe(a)       a > 0  the metatarsophalangeal joint EXTENDS — the toes bend
                         up relative to the rest of the foot. At toe-off this
                         is what lets the ankle plantarflex 30 degrees while
                         the forefoot stays flat on the turf; it is never
                         meaningfully negative.
     shoulder(a)  a > 0  arm swings forward
     elbow(a)     a > 0  hand comes up toward the shoulder — never negative

   Spine/Chest/Head point +Y rather than -Y, so their raw X sign already means
   "positive leans forward"; those stay in radians.                          */
const D = Math.PI / 180;
const hip = a => -a * D;
const knee = a => a * D;
const ankle = a => -a * D;
const toe = a => -a * D;
const shoulder = a => -a * D;
const elbow = a => -a * D;

/* --- Gait plumbing --------------------------------------------------------
   A walk/run cycle is one description of ONE leg; the other leg is the same
   curve half a cycle later. Authoring at named gait phases and resampling onto
   a uniform grid is what makes that shift a plain array rotation, so the two
   legs can never drift out of agreement.                                    */
const STEPS = 32;

/* Resample an authored phase table onto the uniform STEPS grid.

   This used to interpolate LINEARLY between the rows, and that single decision
   is most of the reason a set of perfectly reasonable poses walked like a
   marionette. Between two rows every joint turns at a CONSTANT rate, and at the
   row itself the rate changes within one frame — so the whole body moves as a
   staircase of angular velocities with a visible corner at every phase
   boundary. Sixteen samples per cycle then quantised the rows onto a grid they
   don't sit on, which clipped the extremes flat as well: the run's 124-degree
   heel-to-glute measured back out of the built file as 115, and held there for
   two frames, because the peak fell between two samples.

   What replaces it is a cyclic cubic Hermite through the same rows, with
   tangents taken from the neighbouring rows at their ACTUAL phase spacing — the
   rows are deliberately not evenly spaced (a run spends 30% of the cycle in
   stance and needs most of its detail there), so uniform Catmull-Rom would be
   the wrong curve. It passes through every authored pose exactly, has
   continuous velocity everywhere including across the wrap from 1.0 back to
   0.0, and at 32 samples the peaks survive to within a degree.

   rows: [phase, ...columns] with phase 0..1 ascending, row 0 at phase 0, and a
   closing row at phase 1 that repeats row 0 (it is dropped — the wrap is what
   makes the cycle continuous). Missing columns read as 0.                    */
function sampleGait(rows, col) {
  const K = rows[rows.length - 1][0] >= 1 ? rows.slice(0, -1) : rows.slice();
  const n = K.length;
  const X = K.map(r => r[0]);
  const V = K.map(r => (r[col + 1] == null ? 0 : r[col + 1]));
  // Knot i, wrapped: phase runs on past 1.0 (and below 0.0) so the tangent at
  // the seam is computed on real spacing rather than on a fold.
  const at = i => {
    const w = ((i % n) + n) % n;
    return { x: X[w] + Math.floor(i / n), v: V[w] };
  };
  const out = [];
  for (let s = 0; s < STEPS; s++) {
    const p = s / STEPS;
    let k = n - 1;
    for (let j = 0; j < n; j++) if (X[j] <= p) k = j;
    const P0 = at(k - 1), P1 = at(k), P2 = at(k + 1), P3 = at(k + 2);
    const h = P2.x - P1.x, u = (p - P1.x) / h;
    const m1 = (P2.v - P0.v) / (P2.x - P0.x);
    const m2 = (P3.v - P1.v) / (P3.x - P1.x);
    const u2 = u * u, u3 = u2 * u;
    out.push((2 * u3 - 3 * u2 + 1) * P1.v + (u3 - 2 * u2 + u) * h * m1
      + (-2 * u3 + 3 * u2) * P2.v + (u3 - u2) * h * m2);
  }
  return out;
}
const cycleTimes = dur => Array.from({ length: STEPS + 1 }, (_, i) => (i / STEPS) * dur);
const closeLoop = a => a.concat([a[0]]);
const halfCycle = a => a.slice(STEPS / 2).concat(a.slice(0, STEPS / 2));
/* Smooth 0..1 ramp — used to turn "how far off the turf is this foot" into the
   weight behind everything the pelvis and shoulders do in the frontal plane. A
   bare clamp has corners at both ends and those corners are visible in a hip. */
const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/* The first harmonic of a cyclic signal, rescaled so it peaks at +/-1. Used to
   turn a near-square footfall indicator into the smooth, correctly-phased sine
   that the pelvis and the shoulder girdle actually ride on. Returns all zeros
   for a signal with no fundamental (a stationary pose), which is the right
   answer: nothing to list toward. */
function fundamental(sig) {
  const n = sig.length;
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const th = 2 * Math.PI * i / n;
    a += sig[i] * Math.cos(th); b += sig[i] * Math.sin(th);
  }
  const amp = Math.hypot(a, b);
  if (amp < 1e-9) return sig.map(() => 0);
  return sig.map((_, i) => {
    const th = 2 * Math.PI * i / n;
    return (a * Math.cos(th) + b * Math.sin(th)) / amp;
  });
}

/* --- Pelvis height, solved rather than guessed -----------------------------
   Hand-keyed hip bob is how a cycle ends up skating 15cm above the turf. The
   legs only rotate about X, so the whole thing is 2D forward kinematics in the
   (forward, up) plane: walk the chain down each leg, find the lowest point of
   either sole, and drop the pelvis by exactly that much. The support foot then
   plants itself, and the natural rise and fall of the gait — down at
   mid-stance, up over a near-straight leg — comes out of the pose for free.

   `lift` adds a small cosine bump at the two mid-flight phases, which is the
   one part a runner's pelvis does that the kinematics can't know about: for a
   moment nothing is holding the body up at all. A walk never leaves the
   ground, so it passes lift = 0. */
const THIGH = 0.460, SHIN = 0.410;
const HIP_Y = 1.000 - 0.040;                       // UpperLeg height at rest
const SOLE = 0.090;                                // ankle joint above the sole
const HEEL_Z = -0.075;                             // back of the heel, in the foot frame
const MTP_Z = 0.115;                               // ball of the foot == the Toe joint
const MTP_DROP = 0.055;                            // Toe joint above the sole under it
const TOE_DROP = 0.035, TOE_LEN = 0.068;           // sole under, and length past, that joint

/* THE FOOT IS TWO SEGMENTS, NOT A PADDLE.

   The rig has always had Toe_L / Toe_R and no clip had ever touched them, so
   every foot in the game was one rigid plank from heel to toe. That is the
   single loudest thing in the old walk: a real foot lands on its heel, rolls
   flat, and then leaves the ground by rotating the whole leg up over toes that
   stay put. A plank can do none of that — it lands flat, it leaves flat, and
   between those it hangs off the end of the shin at whatever angle the ankle
   was keyed to. It reads as a boot on a stick.

   So the sole is modelled the way it is shaped: heel and ball on the FOOT
   segment, tip on the TOE segment, with the toe's own rotation folded in. Every
   ground solve below takes the lowest of the three, which is what lets the
   ankle plantarflex through toe-off while the forefoot stays flat on the turf.

   `tilt` is the accumulated forward tilt of a segment (its direction is
   (0, -cos, +sin)), and a local point (0, ly, lz) on it lands at
       y = ly*cos + lz*sin ,  z = -ly*sin + lz*cos
   relative to the segment's own joint.                                       */
function xf(ly, lz, tilt, oy, oz) {
  const c = Math.cos(tilt), s = Math.sin(tilt);
  return { y: oy + ly * c + lz * s, z: oz - ly * s + lz * c };
}

/* The three sole contact points of one leg, relative to a pelvis at HIP_Y.
   Index 0 = heel, 1 = ball, 2 = toe tip. */
function solePoints(hipDeg, kneeDeg, ankleDeg, toeDeg) {
  const t = hipDeg * D;                            // forward tilt of the thigh
  const s = t - kneeDeg * D;                       // knee folds the shin back
  const f = s + ankleDeg * D;                      // dorsiflexion lifts the toes
  const g = f + (toeDeg || 0) * D;                 // MTP extension lifts the foot off them
  const kneeY = HIP_Y - THIGH * Math.cos(t), kneeZ = THIGH * Math.sin(t);
  const ankY = kneeY - SHIN * Math.cos(s), ankZ = kneeZ + SHIN * Math.sin(s);
  const mtp = xf(-MTP_DROP, MTP_Z, f, ankY, ankZ);
  return [
    xf(-SOLE, HEEL_Z, f, ankY, ankZ),
    xf(-SOLE, MTP_Z, f, ankY, ankZ),
    xf(-TOE_DROP, TOE_LEN, g, mtp.y, mtp.z)
  ];
}

/* Lowest sole point of one leg, relative to a pelvis sitting at HIP_Y. */
function soleHeight(hipDeg, kneeDeg, ankleDeg, toeDeg) {
  const p = solePoints(hipDeg, kneeDeg, ankleDeg, toeDeg);
  return Math.min(p[0].y, p[1].y, p[2].y);
}

/* --- The shoulder, authored the way a throwing study reports it -------------
   Everything above is sagittal, where one euler angle IS the joint angle. A
   throw is not: the humerus elevates, sweeps across the chest AND spins about
   its own long axis, and those three do not decompose into an XYZ euler in any
   order you can hold in your head. Typing euler triples at it is exactly how
   the first throw ended up releasing the ball while the hand was still behind
   the ear — the numbers looked like a wind-up and the geometry wasn't one.

   So the arm is authored in the three angles the literature actually measures,
   and the rotation is SOLVED. All three are relative to the trunk, which is
   what makes them comparable to published values even while the torso rotates
   sixty degrees underneath them (UpperArm's parent chain up to Chest carries
   no rest rotation, so its local rotation IS its rotation in the chest frame):

     elev    humeral elevation away from hanging straight down the trunk.
             90 = level with the shoulder; collegiate QBs cock at ~112.
     horiz   where that elevation points, around the trunk. 0 = straight out
             to the side, + = swept across the chest (horizontal adduction),
             - = held behind the frontal plane.
     er      axial rotation of the humerus, read off the forearm as a pointer:
             0 = forearm anterior, +90 = forearm at the sky, -90 = forearm
             down. Max external rotation in a football throw is ~134.

   The forearm is still a plain hinge — `elbow(deg)` on LowerArm — and the
   solve accounts for it: the elbow folds about the humerus's own local X, so
   fixing where that axis ends up is what fixes ER.                          */
function armQ(side, elevDeg, horizDeg, erDeg) {
  const lat = side === 'R' ? -1 : 1;                 // the arm's outward side, in chest space
  const e = elevDeg * D, hz = horizDeg * D, er = erDeg * D;
  // Humerus, pointing from shoulder to elbow.
  const h = [lat * Math.sin(e) * Math.cos(hz), -Math.cos(e), Math.sin(e) * Math.sin(hz)];
  // Reference frame perpendicular to the humerus: u0 is "up the trunk", which
  // is where a fully externally-rotated forearm points; r0 is anterior, ER = 0.
  const du = h[1];                                   // dot(h, trunk up)
  let u0 = [-h[0] * du, 1 - h[1] * du, -h[2] * du];
  const uL = Math.hypot(u0[0], u0[1], u0[2]);
  if (uL < 1e-4) throw new Error('armQ: humerus is parallel to the trunk axis');
  u0 = u0.map(v => v / uL);
  const cr = [h[2], 0, -h[0]];                       // cross(trunk up, h)
  const cL = Math.hypot(cr[0], cr[1], cr[2]) || 1;
  const r0 = cr.map(v => (-lat * v) / cL);
  // The bone's own axes: -Y down the humerus, +Z the direction the forearm
  // folds toward, +X completing a right-handed frame.
  const Y = [-h[0], -h[1], -h[2]];
  const Z = [
    Math.cos(er) * r0[0] + Math.sin(er) * u0[0],
    Math.cos(er) * r0[1] + Math.sin(er) * u0[1],
    Math.cos(er) * r0[2] + Math.sin(er) * u0[2]
  ];
  const X = [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]];
  return quatFromAxes(X, Y, Z);
}

/* Orthonormal basis (as columns) -> quaternion. */
function quatFromAxes(X, Y, Z) {
  const m00 = X[0], m10 = X[1], m20 = X[2];
  const m01 = Y[0], m11 = Y[1], m21 = Y[2];
  const m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let S;
  if (tr > 0) {
    S = Math.sqrt(tr + 1) * 2;
    return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S];
  }
  if (m00 > m11 && m00 > m22) {
    S = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S];
  }
  if (m11 > m22) {
    S = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S];
  }
  S = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
}

/* --- A planted foot, solved rather than keyed -------------------------------
   A stride is authored as "the front foot is HERE and the knee is bent THIS
   much", because that is the part a viewer reads: the foot must stay where it
   landed while the hips rotate over it. Keying hip flexion directly and then
   flexing the knee under it drags the plant backwards through the turf, which
   is the skate this repo has spent its whole life removing from the run.
   Fore/aft of the ankle, measured from the hip joint, is
       z = THIGH*sin(hip) + SHIN*sin(hip - knee)
   which is monotonic in hip over the range a leg can reach, so bisect it.    */
function plantHip(zTarget, kneeDeg) {
  const at = t => THIGH * Math.sin(t) + SHIN * Math.sin(t - kneeDeg * D);
  let lo = -1.3, hi = 1.4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < zTarget) lo = mid; else hi = mid;
  }
  return ((lo + hi) / 2) / D;
}

/* Pelvis height for a NON-cyclic pose: drop it until the lower of the two
   soles is exactly on the turf. Same solve as solveHipY, without the cycle. */
function standHipY(legL, legR) {
  return 1.000 - Math.min(soleHeight(...legL), soleHeight(...legR));
}

/* Solving pelvis height AT the keys is not the same as it being right BETWEEN
   them: leg angle interpolates linearly and leg LENGTH does not, so a long,
   lazy segment sags a couple of centimetres through the turf in the middle.
   Sample the leg angles on a fine grid, solve there, and hand back a hips track
   dense enough that the error is under a millimetre. (Legs rotate about one
   axis, and slerp between two rotations about a shared axis is exactly the
   angle-interpolated one, so linear interpolation of the angles here is not an
   approximation of the playback — it is the playback.)

   `lift` is optional and is the one thing this cannot know: how far off the
   ground the whole body is. A celebration hop leaves the turf, and the
   kinematics of a tucked leg can't tell you that — so it is added ON TOP of
   the solved height rather than replacing it, which keeps the feet exactly on
   the ground at the bottom of every hop.

   `roll` is the pelvis's own Z rotation at each key, if the clip has one. It
   belongs here because tilting the pelvis raises one hip joint and lowers the
   other by 0.098*sin(theta): the Juke rolls 23 degrees at the plant, which is
   38mm — twice the tolerance this holds ground contact to, and enough on its
   own to put the inside foot through the turf while every leg angle is right. */
const HIP_HALF = 0.098;                            // UpperLeg offset from the spine
function groundedHips(times, legL, legR, lift, roll, step = 0.02) {
  const lerpLeg = (A, B, u) => A.map((v, i) => v + (B[i] - v) * u);
  const up = k => (lift ? lift[k] : 0);
  const rz = k => (roll ? roll[k] : 0);
  // Lowest sole of either leg with the pelvis tilted by `th`, whose two hip
  // joints therefore sit +/- HIP_HALF*sin(th) either side of the pelvis.
  const low = (L, R, th) => {
    const dy = HIP_HALF * Math.sin(th);            // + raises the LEFT hip joint
    return Math.min(soleHeight(...L) + dy, soleHeight(...R) - dy);
  };
  const T = [], Y = [];
  for (let k = 0; k < times.length - 1; k++) {
    const span = times[k + 1] - times[k];
    const n = Math.max(1, Math.round(span / step));
    for (let i = 0; i < n; i++) {
      const u = i / n;
      T.push(times[k] + span * u);
      Y.push(1.000 - low(lerpLeg(legL[k], legL[k + 1], u), lerpLeg(legR[k], legR[k + 1], u),
        rz(k) + (rz(k + 1) - rz(k)) * u)
        + up(k) + (up(k + 1) - up(k)) * u);
    }
  }
  const last = times.length - 1;
  T.push(times[last]);
  Y.push(1.000 - low(legL[legL.length - 1], legR[legR.length - 1], rz(last)) + up(last));
  return pos('Hips', T, Y.map(y => [0, y, 0]));
}

/* ============================ ONE CYCLIC GAIT, END TO END ==================

   Everything a walk, a run or a backpedal needs, built from two authored phase
   tables (one leg, one arm) plus a handful of amplitudes. It exists as one
   function because the parts are not independent: the pelvis has to know where
   the feet are to sit at the right height, the frontal plane has to know which
   foot is carrying the weight, and the trunk and the head have to counter what
   the pelvis does. Scattering those across four helpers is how the old cycle
   ended up with a pelvis that bobbed and a body above it that did nothing.

   WHAT THE OLD ONE WAS MISSING, and why it read as a novelty walk:

     * The frontal plane was FROZEN. Pelvis translation was Y only, pelvis
       rotation was yaw only, and the chest had no side-bend at all. A real
       walker's pelvis drops four or five degrees toward the leg that is in the
       air, shifts two or three centimetres over the leg that is not, and the
       shoulders tilt back against both. With none of that, ten players ran
       about with a spirit level for a pelvis.
     * Nothing counter-rotated above the hips except a token seven degrees of
       chest yaw, and the head was keyed to a constant — so the eyeline swung
       with the shoulders instead of staying on where the player was going.
     * The toes never moved (see solePoints above).

   The frontal-plane terms are all driven off ONE derived quantity: how far each
   foot is off the turf, smoothed to 0..1. That is not a stylistic choice, it is
   the actual mechanism — the pelvis drops toward the unsupported side because
   there is nothing under it — and deriving it means the sway can never drift
   out of phase with the footfalls the way a hand-keyed sine would.

   cfg:
     leg     [phase, hip, knee, ankle, toe]  — ONE leg; the other is +0.5
     arm     [phase, shoulder, elbow, abduct] — ditto, in degrees
     lift    extra pelvis rise at mid-flight, metres (0 for a walk: a walk never
             leaves the ground, and the kinematics already know that)
     lean    trunk flexion, radians, split across Spine and Chest
     yaw     pelvis rotation amplitude, radians
     obliq   pelvic drop toward the swing leg, radians
     sway    pelvis shift toward the stance leg, metres
     tilt    shoulder counter-tilt against the pelvic drop, radians
     splay   constant hip abduction, radians
     head    head pitch, radians                                              */
function cyclicGait(name, dur, cfg) {
  const T = cycleTimes(dur);
  const col = c => sampleGait(cfg.leg, c);
  const H = col(0), K = col(1).map(v => Math.max(0, v)), A = col(2), O = col(3).map(v => Math.max(0, v));
  const Hr = halfCycle(H), Kr = halfCycle(K), Ar = halfCycle(A), Or = halfCycle(O);
  const legAt = (i, right) => (right ? [Hr[i], Kr[i], Ar[i], Or[i]] : [H[i], K[i], A[i], O[i]]);

  /* --- pelvis height, and which foot is carrying ------------------------- */
  const stanceEnd = cfg.stanceEnd == null ? 0.5 : cfg.stanceEnd;
  const span = 0.5 - stanceEnd;                    // half-cycle spent airborne
  const raw = [];
  for (let i = 0; i < STEPS; i++) {
    // + = the weight is on the LEFT foot (which sits at +X), - = on the right.
    raw.push(soleHeight(...legAt(i, true)) - soleHeight(...legAt(i, false)));
  }
  /* Take the FUNDAMENTAL of that rather than the raw signal. The difference in
     sole heights is a very nearly square wave — a swinging foot is 40cm up for
     most of its swing, so any normalisation of it saturates and the pelvis
     snaps from one obliquity to the other inside two frames. A pelvis does not
     do that. Its lateral list is dominated by the first harmonic of the stride,
     which is exactly what this extracts: same phase as the real footfalls
     (which is the whole reason for deriving it rather than keying a sine by
     hand and hoping), and smooth by construction. */
  const load = fundamental(raw);
  const hipsX = load.map(l => (cfg.sway || 0) * l);

  /* Now the pelvis height, WITH the obliquity folded in. Tilting the pelvis
     raises one hip joint and lowers the other by 0.098*sin(theta) — nine
     millimetres at the amplitudes here, which is three times the tolerance this
     project holds ground contact to, so leaving it out puts a foot through the
     turf on the very frames the tilt is deepest. */
  const HIP_X = 0.098;                             // UpperLeg offset from the spine
  const hipsY = [], hipRise = [];
  for (let i = 0; i < STEPS; i++) {
    const th = (cfg.obliq || 0) * load[i];
    const dy = HIP_X * Math.sin(th);               // + raises the LEFT hip joint
    hipRise.push(dy);
    const lowL = soleHeight(...legAt(i, false)) + dy;
    const lowR = soleHeight(...legAt(i, true)) - dy;
    const q = (i / STEPS) % 0.5;
    const air = span > 0 && q > stanceEnd ? Math.sin(Math.PI * (q - stanceEnd) / span) : 0;
    hipsY.push(1.000 - Math.min(lowL, lowR) + (cfg.lift || 0) * air);
  }

  /* --- pelvis and trunk rotation ----------------------------------------- */
  const yawOf = i => (cfg.yaw || 0) * Math.sin(2 * Math.PI * (i / STEPS - (cfg.yawPhase || 0)));
  const pelvis = [], spine = [], chest = [], head = [];
  const leanS = (cfg.lean || 0) * 0.55, leanC = (cfg.lean || 0) * 0.45;
  for (let i = 0; i < STEPS; i++) {
    const y = yawOf(i), l = load[i];
    // Obliquity: the pelvis drops toward the leg that is in the air. Positive Z
    // raises the character's LEFT, and `l` is negative when the left foot is
    // the one off the turf, so this falls out with no sign to remember.
    pelvis.push([0, y, (cfg.obliq || 0) * l]);
    // The shoulder girdle unwinds the pelvis and tilts back against its drop —
    // split across the two spine joints so neither has to bend further than a
    // spine bends.
    spine.push([leanS, -y * 0.55, -(cfg.tilt || 0) * l * 0.55]);
    chest.push([leanC, -y * 0.75, -(cfg.tilt || 0) * l * 0.45]);
    // EYES DOWNFIELD. The head is a child of the chest and inherits every
    // degree of the above; give most of it back so the player looks where they
    // are running rather than swinging their face side to side.
    const carried = y + (-y * 0.55) + (-y * 0.75);
    head.push([(cfg.head == null ? -0.13 : cfg.head), -carried * 0.85, 0]);
  }

  /* --- arms --------------------------------------------------------------
     Authored as a table like the legs so the swing gets the same spline, and
     so the elbow's peaks can be placed a beat LATER than the shoulder's. That
     lag is the whole difference between an arm and a lever: the forearm is
     dragged round by the upper arm and arrives after it. */
  const S = sampleGait(cfg.arm, 0), E = sampleGait(cfg.arm, 1).map(v => Math.max(0, v));
  const B = sampleGait(cfg.arm, 2);
  const Sr = halfCycle(S), Er = halfCycle(E), Br = halfCycle(B);

  const key = (node, vals) => rot(node, T, closeLoop(vals));
  const splay = cfg.splay == null ? 0.02 : cfg.splay;
  const tracks = [
    pos('Hips', T, closeLoop(hipsY.map((y, i) => [hipsX[i], y, 0]))),
    key('Hips', pelvis), key('Spine', spine), key('Chest', chest), key('Head', head),
    key('UpperLeg_L', H.map(v => [hip(v), 0, splay])),
    key('LowerLeg_L', K.map(v => [knee(v), 0, 0])),
    key('Foot_L', A.map(v => [ankle(v), 0, 0])),
    key('Toe_L', O.map(v => [toe(v), 0, 0])),
    key('UpperLeg_R', Hr.map(v => [hip(v), 0, -splay])),
    key('LowerLeg_R', Kr.map(v => [knee(v), 0, 0])),
    key('Foot_R', Ar.map(v => [ankle(v), 0, 0])),
    key('Toe_R', Or.map(v => [toe(v), 0, 0])),
    key('UpperArm_L', S.map((v, i) => [shoulder(v), 0, B[i] * D])),
    key('LowerArm_L', E.map(v => [elbow(v), 0, 0.05])),
    key('UpperArm_R', Sr.map((v, i) => [shoulder(v), 0, -Br[i] * D])),
    key('LowerArm_R', Er.map(v => [elbow(v), 0, -0.05])),
    key('Flag_L', H.map(v => [-0.004 * v, 0, 0.06])),
    key('Flag_R', Hr.map(v => [-0.004 * v, 0, -0.06]))
  ];

  // Where the turf sits relative to the pelvis at each sample: the solve above
  // dropped the pelvis to `hipsY`, so a sole point's height above the field is
  // its height in the HIP_Y frame plus (hipsY - 1.000).
  const rise = (i, right) => hipsY[i] - 1.000 + (right ? -hipRise[i] : hipRise[i]);
  CLIPS.push({ name, duration: dur, tracks, extras: gaitMetrics(dur, legAt, rise) });
}

/* HOW FAST THE GROUND GOES BY, measured rather than asserted.

   A clip with no root motion only looks planted if the support foot sweeps
   backward at exactly the speed the ground moves under it, and the renderer has
   to know that speed to pick a playback rate. It has always been a pair of
   constants hand-copied into field3d.js with a comment begging whoever edits
   these tables to keep them in step — which is a promise no comment can keep,
   and one that was already broken once (the rig's stride grew 32% and the
   divisor didn't, so every stride slid forward).

   So it is computed here, from the same kinematics the clip is built from, and
   baked into the glTF as animation extras. field3d reads it off the clip.

   The measurement: at every sample where a foot's lowest sole point is on the
   turf, take the fore/aft velocity of THAT MATERIAL POINT — the same corner of
   the same shoe one sample later, not whichever point happens to be lowest then
   — and average over the whole cycle. Both feet count when both are down, which
   is what makes a walk's double-support come out right.                      */
function gaitMetrics(dur, legAt, riseAt) {
  const dt = dur / STEPS;
  const ON = 0.004;                                // within 4mm of the turf
  let sum = 0, n = 0, stanceL = 0, anyDown = 0;
  for (let i = 0; i < STEPS; i++) {
    const j = (i + 1) % STEPS;
    let down = 0;
    for (const right of [false, true]) {
      const now = solePoints(...legAt(i, right)), nxt = solePoints(...legAt(j, right));
      let k = 0;
      for (let m = 1; m < 3; m++) if (now[m].y < now[k].y) k = m;
      // Height above the FIELD, which during flight is not the lowest sole:
      // the pelvis has been lifted off the kinematic solution by `lift`.
      if (now[k].y + riseAt(i, right) > ON) continue;
      down = 1;
      if (!right) stanceL++;
      sum += -(nxt[k].z - now[k].z) / dt;          // ground travels backward under it
      n++;
    }
    anyDown += down;
  }
  return {
    gait: 1,
    groundSpeed: n ? sum / n : 0,   // metres/sec at the model's authored scale
    stance: stanceL / STEPS,        // fraction of the cycle one given foot is down
    flight: 1 - anyDown / STEPS,    // fraction with neither foot down
    cycle: dur
  };
}

/* ------------------------------------------------------------------ Idle */
const IDLE_DROP = soleHeight(16, 28, 11);
clip('Idle', 2.4, [
  hipY([0, 1.2, 2.4], [0.998 - IDLE_DROP, 1.010 - IDLE_DROP, 0.998 - IDLE_DROP]),
  rot('Spine', [0, 1.2, 2.4], [[0.20, 0, 0], [0.23, 0.02, 0], [0.20, 0, 0]]),
  rot('Chest', [0, 1.2, 2.4], [[0.05, 0, 0], [0.02, -0.03, 0], [0.05, 0, 0]]),
  rot('Head', [0, 1.2, 2.4], [[-0.16, 0, 0], [-0.14, 0.06, 0], [-0.16, 0, 0]]),
  rot('UpperArm_L', [0, 1.2, 2.4], [[shoulder(6), 0, 0.19], [shoulder(3), 0, 0.22], [shoulder(6), 0, 0.19]]),
  rot('LowerArm_L', [0, 1.2, 2.4], [[elbow(48), 0, 0.05], [elbow(53), 0, 0.05], [elbow(48), 0, 0.05]]),
  rot('UpperArm_R', [0, 1.2, 2.4], [[shoulder(6), 0, -0.19], [shoulder(3), 0, -0.22], [shoulder(6), 0, -0.19]]),
  rot('LowerArm_R', [0, 1.2, 2.4], [[elbow(48), 0, -0.05], [elbow(53), 0, -0.05], [elbow(48), 0, -0.05]]),
  // Athletic ready stance: weight forward over slightly bent knees.
  rot('UpperLeg_L', [0, 2.4], [[hip(16), 0, 0.03], [hip(16), 0, 0.03]]),
  rot('LowerLeg_L', [0, 2.4], [[knee(28), 0, 0], [knee(28), 0, 0]]),
  rot('Foot_L', [0, 2.4], [[ankle(11), 0, 0], [ankle(11), 0, 0]]),
  rot('UpperLeg_R', [0, 2.4], [[hip(16), 0, -0.03], [hip(16), 0, -0.03]]),
  rot('LowerLeg_R', [0, 2.4], [[knee(28), 0, 0], [knee(28), 0, 0]]),
  rot('Foot_R', [0, 2.4], [[ankle(11), 0, 0], [ankle(11), 0, 0]]),
  rot('Flag_L', [0, 1.2, 2.4], [[0.02, 0, 0.04], [-0.03, 0, 0.02], [0.02, 0, 0.04]]),
  rot('Flag_R', [0, 1.2, 2.4], [[-0.02, 0, -0.02], [0.03, 0, -0.04], [-0.02, 0, -0.02]])
]);

/* ------------------------------------------------------------------- Run */
/* THE RUNNING GAIT, one leg, as fractions of a stride. Stance runs 0.00 ->
   ~0.30 and swing fills the rest; because the other leg is half a cycle behind,
   both feet are off the ground between one leg's toe-off and the other's
   contact — the flight phase falls out of the timing rather than being posed.

   Two things changed here besides the interpolation. Stance is broken into four
   rows rather than two, because that is where a run is READ — the eye watches
   the leg that is carrying the weight, and giving the whole support phase two
   keys 20% of a cycle apart is what made the old one look like it was being
   winched along. And the toe column exists at all, so the foot rolls: contact
   just ahead of the hips on a flat-ish forefoot, the ankle collapsing into
   dorsiflexion to absorb, and then a toe-off where the ankle plantarflexes 30
   degrees over an MTP joint that extends 48 and keeps the shoe on the turf. */
cyclicGait('Run', 0.62, {
  leg: [
    //  phase  hip  knee  ankle  toe
    [0.00, 34, 20, -4, 6],     // 1. initial contact, midfoot, just ahead of the hips
    [0.06, 22, 30, 4, 2],      // 2. loading — the ankle collapses under the weight
    [0.13, 5, 39, 11, 0],      // 3. mid-stance — knee deepest, hips lowest
    [0.21, -14, 27, 3, 14],    // 4. the heel comes up, the MTP starts to extend
    [0.30, -38, 11, -30, 48],  // 5. toe-off — everything extends over a flat forefoot
    [0.38, -19, 79, -13, 22],  // 6. early flight, the trailing knee folds
    [0.48, 11, 123, 5, 4],     // 7. recovery — heel snaps up under the glute
    [0.62, 61, 96, 14, 0],     // 8. knee drive — hip flexors carry the knee through
    [0.78, 61, 55, 10, 0],
    [0.90, 50, 30, 2, 2],      // 9. reach — the shin unfolds toward the next contact
    [1.00, 34, 20, -4, 6]
  ],
  /* The left knee drives at 0.62, so the left ARM is furthest BACK there and
     furthest forward half a cycle away — contralateral, which is what cancels
     the rotation the hips put into the trunk. Both extremes of the elbow are
     placed a beat AFTER the shoulder's: the forearm is dragged round by the
     upper arm and arrives late, and that lag is most of what separates an arm
     from a lever. Hand travels roughly sternum-to-hip-pocket. */
  arm: [
    //  phase  shoulder  elbow  abduct
    [0.00, 20, 94, 9],
    [0.12, 30, 104, 8],        // shoulder furthest forward
    [0.20, 24, 110, 8],        // ...elbow peaks here, a beat later
    [0.34, 2, 94, 10],
    [0.50, -34, 74, 13],
    [0.62, -52, 68, 14],       // shoulder furthest back, hand past the hip
    [0.72, -43, 66, 13],       // ...elbow bottoms out here
    [0.86, -8, 80, 11],
    [1.00, 20, 94, 9]
  ],
  lift: 0.030, stanceEnd: 0.30,
  lean: 0.22, head: -0.13,
  yaw: 0.10, yawPhase: 0.25,
  obliq: 0.075, sway: 0.016, tilt: 0.055, splay: 0.02
});

/* ------------------------------------------------------------------ Walk */
/* A walk heel-strikes, keeps a much straighter stance leg, and never leaves
   the ground — the two legs overlap in double support instead of flying. The
   roll-off is the whole character of it: heel down with the toes held up, the
   forefoot slapping flat under load, the shin rolling forward over a nearly
   straight leg, and then a push where the heel lifts off toes that stay put. */
cyclicGait('Walk', 1.0, {
  leg: [
    //  phase  hip  knee  ankle  toe
    [0.00, 28, 4, 5, 0],       // heel strike — toes held up, knee almost straight
    [0.08, 21, 17, -7, 0],     // loading response — the forefoot slaps flat
    [0.20, 9, 17, -1, 0],      // the shin begins to roll forward over the foot
    [0.32, -6, 5, 9, 3],       // mid-stance — tallest point, leg nearly straight
    [0.46, -21, 7, 12, 24],    // terminal stance — heel off, MTP extending
    [0.58, -15, 36, -16, 48],  // toe-off — ankle plantarflexes over a flat forefoot
    [0.70, 6, 68, -2, 14],     // early swing — the knee folds
    [0.82, 24, 45, 10, 2],     // mid-swing — toes up to clear the turf
    [0.93, 32, 14, 7, 0],      // terminal swing — the shin reaches out
    [1.00, 28, 4, 5, 0]
  ],
  /* Left leg is furthest forward across the wrap, so the left arm is furthest
     BACK there. Same elbow lag as the run, a third of the amplitude. */
  arm: [
    [0.00, -25, 32, 9],
    [0.16, -8, 38, 9],
    [0.32, 12, 44, 8],
    [0.46, 25, 47, 8],         // shoulder furthest forward
    [0.58, 20, 50, 8],         // ...elbow peaks a beat later
    [0.76, -6, 38, 9],
    [0.90, -22, 32, 9],
    [1.00, -25, 32, 9]
  ],
  lift: 0, stanceEnd: 0.5,
  lean: 0.075, head: -0.05,
  yaw: 0.075, yawPhase: 0.25,
  obliq: 0.085, sway: 0.026, tilt: 0.06, splay: 0.02
});

/* ------------------------------------------------------------- Backpedal */
/* A defender's backpedal: hips sunk, chest kept over the toes, steps that reach
   BEHIND the body — so the thigh spends most of the cycle extended while the
   knee stays bent, and the whole thing rides on the forefoot. A backpedalling
   defender's heel never touches the ground, which is why the toe column stays
   small and the ankle stays plantarflexed.

   The reach is much longer than it was, and that is a bug fix rather than a
   restyling. The renderer picked this clip's playback rate off RUN_NATURAL —
   the run's 5.8yd/s — while the clip's own natural speed was 1.3. A defender
   backpedalling at 4yd/s therefore played it at the 0.75 floor instead of the
   3.0 the stride actually needed, and slid backwards for the whole snap. Now
   that field3d reads each clip's own measured speed off the file, the only
   thing left to fix is the stride itself: 0.44s and a 30/-34 sweep puts the
   natural speed near 3.4yd/s, which is the middle of the range a defensive
   back actually backpedals at.                                              */
cyclicGait('Backpedal', 0.44, {
  leg: [
    //  phase  hip  knee  ankle  toe
    [0.00, 30, 52, 6, 2],      // knee up in front, foot about to reach back
    [0.14, 16, 34, -6, 4],
    [0.26, -2, 22, -14, 8],    // the forefoot lands behind and drives the body back
    [0.40, -18, 24, -10, 8],
    [0.52, -34, 34, -2, 4],    // hip fully extended behind, the knee begins to fold
    [0.68, -16, 62, 6, 0],     // the knee folds and swings through under the hips
    [0.84, 12, 70, 10, 0],
    [1.00, 30, 52, 6, 2]
  ],
  arm: [
    [0.00, 8, 78, 15],
    [0.26, 12, 86, 17],
    [0.50, -10, 70, 16],
    [0.72, -20, 62, 14],
    [1.00, 8, 78, 15]
  ],
  lift: 0.012, stanceEnd: 0.42,
  lean: 0.20, head: -0.16,
  yaw: 0.05, yawPhase: 0.25,
  obliq: 0.05, sway: 0.020, tilt: 0.035, splay: 0.05
});

/* ----------------------------------------------------------------- Throw */
/* THE QUARTERBACK THROW.

   Posed against the measured kinematics of collegiate quarterbacks (Bohnert,
   "A complete kinematic, kinetic and electromyographical analysis of the
   football throw in collegiate quarterbacks"; and the IJSPT inertial
   kinematic-sequencing study of the football pass), because the previous pass
   at this clip was authored by eye and measuring it said so. At the instant
   the engine actually let go of the ball, tools/measure-clip.mjs read the old
   clip as: hand 0.41m BEHIND the chest, trunk still 67 degrees closed, elbow
   at 95 degrees and shoulder external rotation of 9. The quarterback threw the
   ball out of the back of his own shoulder while facing away from the target,
   and the arm's fastest moment arrived 0.18s after the ball had already gone.

   The events below are the standard phases of an overhead throw, and the times
   are the ones the game actually plays to: the engine releases the pass at
   RELEASE_AT (0.34) of this 1.10s clip = 0.374s, so maximum external rotation
   is placed at 0.33 and the whole arm-acceleration phase is the 44ms between
   them. That is not a rounding error, it is the real number — MER to release
   is 40-50ms in a thrower, which is why a throw reads as a whip and not a
   push. Everything downstream of the release is deceleration and recovery, and
   the last key returns to the Idle pose exactly so the crossfade out is clean.

     0.000  set          ball in the throwing hand at the near shoulder, off
                         hand on it. Matches field3d's READY grip bone-for-bone
                         so the carry pose it is blending out of doesn't fight.
     0.120  separation   off hand leaves the ball, lead leg picks up, torso
                         coils to its deepest point
     0.220  foot contact trunk 40 closed, pelvis already 28 ahead of it — the
                         separation the trunk then unwinds through
     0.330  MER          shoulder 112 elevated / 134 externally rotated, elbow
                         100, lumbar extended, lead leg braced
     0.374  RELEASE      elbow through to 31, ER down to 56, trunk just past
                         square, separation collapsed to 11, lead knee 44
     0.470  max IR       arm decelerating across the body, trunk over the front
                         leg, back leg pulled through
     0.620  follow       hand finishes past the opposite hip, trunk at its 21
                         degrees of left rotation
     0.850  recover
     1.100  set          == Idle

   The lead foot is authored by WHERE IT IS, not by hip angle, and the hip is
   solved (plantHip) so it stays planted while the hips rotate over it; pelvis
   height is solved too (groundedHips) so neither sole leaves or enters the
   turf, between the keys as well as on them.

   Check any edit with:  node tools/measure-clip.mjs Throw                  */
{
  /* Set/idle arm poses, kept as eulers because that is how their two owners —
     field3d's READY grip and the Idle clip — are written. */
  const SET_R = euler(0.34, 0.30, -0.16), SET_L = euler(0.22, -0.95, 0.10);
  const IDLE_R = euler(shoulder(6), 0, -0.19), IDLE_L = euler(shoulder(6), 0, 0.19);

  const K = [
    // t     pelvis trunk  lean tilt |    lead foot: [z, knee, ankle]  |  back leg: [hip, knee, ankle]
    // |     throwing arm: [elev, horiz, ER, elbow]   |  off arm: [elev, horiz, ER, elbow]
    { t: 0.000, pel: -14, trk: -30, lean:  6, tilt: -2, lead: [0.20, 30,  8], back: [-16, 24,   6], armq: SET_R, elb: 111.7, offq: SET_L, oelb: 117.5 },
    { t: 0.120, pel: -22, trk: -40, lean:  3, tilt:  0, lead: [0.06, 60, 16], back: [-20, 26,   2], arm: [ 64, -14,  24,  98], off: [ 58,  42,  18,  92] },
    { t: 0.220, pel: -12, trk: -40, lean:  0, tilt:  3, lead: [0.32, 30,  4], back: [-28, 22, -10], arm: [ 96, -26,  72,  98], off: [ 78,  30,  10,  55] },
    { t: 0.330, pel:   6, trk: -12, lean:-20, tilt:  7, lead: [0.32, 34,  0], back: [-26, 26, -20], arm: [112,  -8, 134, 100], off: [ 68,  16,   0,  45] },
    { t: 0.374, pel:  16, trk:   5, lean:  8, tilt:  9, lead: [0.32, 44, -4], back: [-28, 26, -30], arm: [108,  14,  56,  31], off: [ 44,   0, -20,  72] },
    { t: 0.470, pel:  18, trk:  18, lean: 21, tilt:  7, lead: [0.32, 46, -6], back: [ -6, 78, -16], arm: [ 72,  46, -42,  54], off: [ 22, -22, -40,  96] },
    { t: 0.620, pel:  14, trk:  21, lean: 18, tilt:  4, lead: [0.30, 40, -2], back: [ 14, 84,  -6], arm: [ 34,  64, -56,  76], off: [ 16, -28, -30,  88] },
    // The recovery is keyed at 0.72/0.96 as well as its endpoints. Not for the
    // pose — for the ground: pelvis height is solved AT a key and interpolated
    // between them, so a long lazy segment lets the linear middle sag a couple
    // of centimetres through the turf. Shorter segments, smaller error.
    { t: 0.720, pel:  11, trk:  17, lean: 16, tilt:  3, lead: [0.27, 38,  1], back: [ 10, 66,  -2], arm: [ 26,  46, -32,  70], off: [ 14, -18, -22,  74] },
    { t: 0.850, pel:   6, trk:  10, lean: 11, tilt:  1, lead: [0.22, 34,  4], back: [  4, 52,   6], arm: [ 18,  26, -18,  62], off: [ 12,  -6, -10,  58] },
    // The back foot lands here and the front one lifts: the gather back to a
    // balanced stance is a STEP, so that the last 140ms don't drag a planted
    // foot 18cm backwards under a standing man.
    { t: 0.960, pel:   3, trk:   5, lean:  8, tilt:  0, lead: [0.13, 44, 12], back: [ 14, 30,  10], arm: [ 15,  27,   8,  54], off: [ 11,  -2,   0,  51] },
    { t: 1.100, pel:   0, trk:   0, lean:  5, tilt:  0, lead: [0.04, 28, 11], back: [ 16, 28,  11], armq: IDLE_R, elb: 48, offq: IDLE_L, oelb: 48 }
  ];

  const T = K.map(k => k.t);
  // The lead leg's hip angle falls out of where its foot has to be.
  const legL = K.map(k => [plantHip(k.lead[0], k.lead[1]), k.lead[1], k.lead[2]]);
  const legR = K.map(k => k.back);
  // Rows carry either the three solved shoulder angles or a ready-made pose.
  const shoulderQ = (k, side) => (side === 'R')
    ? (k.armq || armQ('R', k.arm[0], k.arm[1], k.arm[2]))
    : (k.offq || armQ('L', k.off[0], k.off[1], k.off[2]));
  const flexOf = k => (k.elb != null ? k.elb : k.arm[3]);
  const offFlexOf = k => (k.oelb != null ? k.oelb : k.off[3]);

  clip('Throw', 1.10, [
    groundedHips(T, legL, legR),
    rot('Hips', T, K.map(k => [0, k.pel * D, 0])),
    // Trunk rotation, flexion and side-bend split between the two spine joints
    // so neither one has to bend further than a spine bends.
    rot('Spine', T, K.map(k => [k.lean * 0.55 * D, (k.trk - k.pel) * 0.5 * D, -k.tilt * 0.55 * D])),
    rot('Chest', T, K.map(k => [k.lean * 0.45 * D, (k.trk - k.pel) * 0.5 * D, -k.tilt * 0.45 * D])),
    /* EYES STAY ON THE TARGET. The head is a child of the chest, so it
       inherits everything the trunk does — and the trunk here coils 40 degrees
       away and then arches 20 degrees backwards through maximum external
       rotation. Left alone the quarterback spends the cocking phase looking
       over his own shoulder and then straight up at the sky. The neck gives
       most of both back: yaw against the coil, pitch against the arch. */
    rot('Head', T, K.map(k => [
      -0.05 - k.lean * 0.70 * D,
      Math.max(-55, Math.min(55, -k.trk * 0.85)) * D, 0])),
    rotq('UpperArm_R', T, K.map(k => shoulderQ(k, 'R'))),
    rot('LowerArm_R', T, K.map(k => [elbow(flexOf(k)), 0, -0.05])),
    rotq('UpperArm_L', T, K.map(k => shoulderQ(k, 'L'))),
    rot('LowerArm_L', T, K.map(k => [elbow(offFlexOf(k)), 0, 0.05])),
    rot('UpperLeg_L', T, legL.map(l => [hip(l[0]), 0, 0.03])),
    rot('LowerLeg_L', T, legL.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_L', T, legL.map(l => [ankle(l[2]), 0, 0])),
    rot('UpperLeg_R', T, legR.map(l => [hip(l[0]), 0, -0.03])),
    rot('LowerLeg_R', T, legR.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_R', T, legR.map(l => [ankle(l[2]), 0, 0])),
    rot('Flag_L', T, K.map(k => [-0.004 * k.lean, 0, 0.05])),
    rot('Flag_R', T, K.map(k => [-0.004 * k.lean, 0, -0.05]))
  ]);
}

/* ----------------------------------------------------------------- Catch */
/* Pelvis height solved, not keyed. The hand-keyed track drove a heel 27mm
   through the turf on the first frame and sat the whole pose 3cm low
   throughout — invisible in a still, obvious in the measurement, and exactly
   the failure the solver exists for. The leg angles are the same ones the
   rotation tracks below carry, restated in degrees; `lift` is the part the
   kinematics cannot know, which is that he leaves the ground to catch it. */
{
  const T = [0, 0.35, 0.9];
  const legL = [[5.7, 12.6, 0], [2.9, 14.4, 0], [10.3, 17.2, 0]];
  const legR = [[-8.0, 12.6, 0], [2.9, 14.4, 0], [-10.3, 17.2, 0]];
clip('Catch', 0.90, [
  groundedHips(T, legL, legR, [0, 0.055, 0]),
  rot('Spine', [0, 0.35, 0.9], [[0.10, 0, 0], [-0.10, 0, 0], [0.14, 0, 0]]),
  rot('Chest', [0, 0.35, 0.9], [[0.04, 0, 0], [-0.06, 0, 0], [0.06, 0, 0]]),
  rot('Head', [0, 0.35, 0.9], [[-0.05, 0, 0], [-0.30, 0, 0], [-0.02, 0, 0]]),
  rot('UpperArm_L', [0, 0.35, 0.60, 0.90], [[0.12, 0, 0.18], [-2.30, 0, 0.22], [-1.60, 0, 0.30], [0.20, 0, 0.20]]),
  rot('LowerArm_L', [0, 0.35, 0.60, 0.90], [[-1.05, 0, 0], [-0.22, 0, 0], [-1.1, 0, 0], [-1.35, 0, 0]]),
  rot('UpperArm_R', [0, 0.35, 0.60, 0.90], [[0.12, 0, -0.18], [-2.30, 0, -0.22], [-1.60, 0, -0.30], [0.20, 0, -0.20]]),
  rot('LowerArm_R', [0, 0.35, 0.60, 0.90], [[-1.05, 0, 0], [-0.22, 0, 0], [-1.1, 0, 0], [-1.35, 0, 0]]),
  rot('UpperLeg_L', [0, 0.35, 0.9], [[-0.10, 0, 0.03], [-0.05, 0, 0.03], [-0.18, 0, 0.03]]),
  rot('LowerLeg_L', [0, 0.9], [[0.22, 0, 0], [0.3, 0, 0]]),
  rot('UpperLeg_R', [0, 0.35, 0.9], [[0.14, 0, -0.03], [-0.05, 0, -0.03], [0.18, 0, -0.03]]),
  rot('LowerLeg_R', [0, 0.9], [[0.22, 0, 0], [0.3, 0, 0]])
]);
}

/* ------------------------------------------------------------------ Dive */
clip('Dive', 1.20, [
  hipY([0, 0.35, 0.70, 1.20], [0.960, 1.140, 0.760, 0.520]),
  rot('Hips', [0, 0.35, 0.70, 1.20], [[0, 0, 0], [-0.55, 0, 0], [-1.05, 0, 0], [-1.35, 0, 0]]),
  rot('Spine', [0, 0.35, 1.20], [[0.20, 0, 0], [-0.10, 0, 0], [-0.16, 0, 0]]),
  rot('Head', [0, 0.35, 1.20], [[-0.10, 0, 0], [0.45, 0, 0], [0.55, 0, 0]]),
  rot('UpperArm_L', [0, 0.40, 1.20], [[0.12, 0, 0.18], [-2.55, 0, 0.18], [-2.35, 0, 0.16]]),
  rot('LowerArm_L', [0, 0.40, 1.20], [[-0.9, 0, 0], [-0.3, 0, 0], [-0.15, 0, 0]]),
  rot('UpperArm_R', [0, 0.40, 1.20], [[0.12, 0, -0.18], [-2.55, 0, -0.18], [-2.35, 0, -0.16]]),
  rot('LowerArm_R', [0, 0.40, 1.20], [[-0.9, 0, 0], [-0.3, 0, 0], [-0.15, 0, 0]]),
  rot('UpperLeg_L', [0, 0.35, 0.70, 1.20], [[-0.30, 0, 0.04], [0.55, 0, 0.06], [0.70, 0, 0.06], [0.55, 0, 0.05]]),
  rot('LowerLeg_L', [0, 0.35, 1.20], [[0.55, 0, 0], [0.35, 0, 0], [0.85, 0, 0]]),
  rot('UpperLeg_R', [0, 0.35, 0.70, 1.20], [[-0.30, 0, -0.04], [0.55, 0, -0.06], [0.70, 0, -0.06], [0.55, 0, -0.05]]),
  rot('LowerLeg_R', [0, 0.35, 1.20], [[0.55, 0, 0], [0.35, 0, 0], [0.85, 0, 0]])
]);

/* -------------------------------------------------------------- FlagGrab */
/* THE DEFENDER'S HALF OF A FLAG PULL, which the rig never had.

   FlagPulled below is the BALL CARRIER's reaction — jerked to a stop, hands
   up. There was nothing for the player who actually made the play: a defender
   ran up to a runner, the whistle went, and the flag came off by itself. In a
   sport whose entire defensive act is reaching out and taking a strip of cloth
   off somebody's hip, that is the one animation that has to exist.

   Two beats. First the REACH: hips sink, both arms drive forward and down to
   the height of the other man's waist, elbows extending so the hands arrive
   ahead of the body — 'horiz' near 80 is straight out in front, which is where
   the flag is. Then the RIP: the near hand closes and snaps up and away while
   the trunk rotates out of it, finishing with the flag held high, which is
   both what a defender does and a clear read at chase-camera distance.       */
{
  /* Both feet are authored by WHERE THEY ARE and held there — a defender
     sinking into a grab bends at the knees over two planted feet, and keying
     hip angles instead slid the back foot a third of a metre backwards through
     the turf while the man stood still. The pelvis then drops out of the knee
     flexion on its own, which is the whole point of solving it. */
  const G = [
    // t      pelvis trunk lean tilt | lead foot: [z, knee, ankle] | back foot | reaching arm (R)       | off arm (L)
    { t: 0.00, pel:  0, trk:   0, lean:  8, tilt:  0, L: [0.10, 30, 10], R: [-0.10, 30, 10], arm: [ 16,  20,  10,  55], off: [ 16,  20,  10,  55] },
    { t: 0.14, pel: -2, trk:  -4, lean: 22, tilt:  0, L: [0.10, 42, 13], R: [-0.10, 42, 12], arm: [ 48,  72,  20,  62], off: [ 44,  70,  16,  66] },
    { t: 0.28, pel: -3, trk:  -6, lean: 34, tilt:  0, L: [0.10, 50, 15], R: [-0.10, 50, 13], arm: [ 62,  80,  10,  22], off: [ 58,  78,   8,  28] },
    { t: 0.40, pel:  0, trk:   2, lean: 30, tilt: -2, L: [0.10, 46, 14], R: [-0.10, 46, 12], arm: [ 58,  62,  -6,  34], off: [ 52,  60,   0,  40] },
    { t: 0.55, pel:  8, trk:  16, lean: 12, tilt: -4, L: [0.10, 36, 12], R: [-0.10, 36, 11], arm: [118,   4, -30,  66], off: [ 30, -20, -20,  80] },
    { t: 0.72, pel:  5, trk:  10, lean:  2, tilt: -2, L: [0.10, 30, 11], R: [-0.10, 30, 11], arm: [150,  -6, -10,  42], off: [ 20,  -8,  -6,  62] },
    // Ends with the flag still held up, because what follows it is Celebrate,
    // whose arms are also up: dropping to a rest pose here would put a fast
    // arm-swing down and straight back up either side of the crossfade.
    { t: 0.90, pel:  0, trk:   0, lean:  5, tilt:  0, L: [0.10, 30, 11], R: [-0.10, 30, 11], arm: [146,  -2,  -6,  44], off: [ 18,   4,   4,  56] }
  ];
  const T = G.map(k => k.t);
  const legL = G.map(k => [plantHip(k.L[0], k.L[1]), k.L[1], k.L[2]]);
  const legR = G.map(k => [plantHip(k.R[0], k.R[1]), k.R[1], k.R[2]]);
  clip('FlagGrab', 0.90, [
    groundedHips(T, legL, legR),
    rot('Hips', T, G.map(k => [0, k.pel * D, 0])),
    rot('Spine', T, G.map(k => [k.lean * 0.55 * D, (k.trk - k.pel) * 0.5 * D, -k.tilt * 0.55 * D])),
    rot('Chest', T, G.map(k => [k.lean * 0.45 * D, (k.trk - k.pel) * 0.5 * D, -k.tilt * 0.45 * D])),
    // Eyes on the flag on the way down, then up off it.
    rot('Head', T, G.map(k => [(-0.05 - k.lean * 0.010) , -k.trk * 0.5 * D, 0])),
    rotq('UpperArm_R', T, G.map(k => armQ('R', k.arm[0], k.arm[1], k.arm[2]))),
    rot('LowerArm_R', T, G.map(k => [elbow(k.arm[3]), 0, -0.05])),
    rotq('UpperArm_L', T, G.map(k => armQ('L', k.off[0], k.off[1], k.off[2]))),
    rot('LowerArm_L', T, G.map(k => [elbow(k.off[3]), 0, 0.05])),
    rot('UpperLeg_L', T, legL.map(l => [hip(l[0]), 0, 0.03])),
    rot('LowerLeg_L', T, legL.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_L', T, legL.map(l => [ankle(l[2]), 0, 0])),
    rot('UpperLeg_R', T, legR.map(l => [hip(l[0]), 0, -0.03])),
    rot('LowerLeg_R', T, legR.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_R', T, legR.map(l => [ankle(l[2]), 0, 0])),
    rot('Flag_L', T, G.map(k => [-0.004 * k.lean, 0, 0.05])),
    rot('Flag_R', T, G.map(k => [-0.004 * k.lean, 0, -0.05]))
  ]);
}

/* ------------------------------------------------------------ FlagPulled */
/* Reaction of the ball carrier: jerked to a stop, hands up, body slumps. */
/* The pelvis height here was hand-keyed and drove the feet 8.6cm through the
   turf halfway through — which nobody ever saw, because until now `flagPulled`
   was never set and this clip never played. Legs are in the same solved form
   as Throw and FlagGrab: angles in degrees, ground worked out from them. */
{
  const T = [0, 0.18, 0.45, 1.10];
  //              hip  knee ankle
  const legL = [[ 20,  17,  2], [ 34,  12,  6], [ 14,  32, -2], [ 12,  26,  0]];
  const legR = [[-17,  32, -4], [-26,  40, -8], [ -6,  23,  2], [ -3,  20,  4]];
clip('FlagPulled', 1.10, [
  groundedHips(T, legL, legR),
  rot('Hips', [0, 0.18, 0.45, 1.10], [[0, 0, 0], [-0.10, 0.10, 0], [0.16, 0.22, 0], [0.10, 0.16, 0]]),
  rot('Spine', [0, 0.18, 0.45, 1.10], [[0.10, 0, 0], [-0.22, -0.12, 0], [0.34, -0.20, 0], [0.26, -0.14, 0]]),
  rot('Chest', [0, 0.18, 0.45, 1.10], [[0.04, 0, 0], [-0.14, 0, 0], [0.18, 0, 0], [0.14, 0, 0]]),
  rot('Head', [0, 0.18, 0.45, 1.10], [[-0.05, 0, 0], [-0.28, 0, 0], [0.30, 0, 0], [0.22, 0, 0]]),
  rot('UpperArm_L', [0, 0.18, 0.45, 1.10], [[0.10, 0, 0.18], [-1.30, 0, 0.55], [-0.55, 0, 0.45], [-0.20, 0, 0.35]]),
  rot('LowerArm_L', [0, 0.18, 0.45, 1.10], [[-1, 0, 0], [-0.55, 0, 0], [-1.1, 0, 0], [-1.25, 0, 0]]),
  rot('UpperArm_R', [0, 0.18, 0.45, 1.10], [[0.10, 0, -0.18], [-1.30, 0, -0.55], [-0.55, 0, -0.45], [-0.20, 0, -0.35]]),
  rot('LowerArm_R', [0, 0.18, 0.45, 1.10], [[-1, 0, 0], [-0.55, 0, 0], [-1.1, 0, 0], [-1.25, 0, 0]]),
  rot('UpperLeg_L', T, legL.map(l => [hip(l[0]), 0, 0.05])),
  rot('LowerLeg_L', T, legL.map(l => [knee(l[1]), 0, 0])),
  rot('Foot_L', T, legL.map(l => [ankle(l[2]), 0, 0])),
  rot('UpperLeg_R', T, legR.map(l => [hip(l[0]), 0, -0.05])),
  rot('LowerLeg_R', T, legR.map(l => [knee(l[1]), 0, 0])),
  rot('Foot_R', T, legR.map(l => [ankle(l[2]), 0, 0])),
  // the flag rips away and flies
  rot('Flag_L', [0, 0.18, 0.45, 1.10], [[0, 0, 0.05], [-0.9, 0.4, 0.5], [-1.6, 0.9, 0.9], [-1.9, 1.2, 1.1]]),
  rot('Flag_R', [0, 1.10], [[0, 0, -0.05], [0.25, 0, -0.10]])
]);
}

/* ------------------------------------------------------------- Celebrate */
/* Little hops. The pelvis height was hand-keyed and sank 4cm into the turf at
   the bottom of each one — again unseen until now, because the celebration was
   triggered off the flag pull that never fired. The landing height is solved
   from the legs and the HOP is added on top of it, which is the one part the
   kinematics cannot know: for half of this clip nothing is holding him up. */
{
  const T = [0, 0.25, 0.5, 0.75, 1.0];
  //             hip  knee ankle
  const DOWN = [-3, 13, -6], UP = [20, 43, -23];
  const leg = [DOWN, UP, DOWN, UP, DOWN];
  const HOP = [0, 0.085, 0, 0.085, 0];
clip('Celebrate', 1.00, [
  groundedHips(T, leg, leg, HOP),
  rot('Spine', [0, 0.5, 1.0], [[0.02, 0.16, 0], [0.02, -0.16, 0], [0.02, 0.16, 0]]),
  rot('Head', [0, 0.5, 1.0], [[-0.18, 0.10, 0], [-0.18, -0.10, 0], [-0.18, 0.10, 0]]),
  rot('UpperArm_L', [0, 0.5, 1.0], [[-2.75, 0, 0.30], [-2.55, 0, 0.55], [-2.75, 0, 0.30]]),
  rot('LowerArm_L', [0, 0.5, 1.0], [[-0.35, 0, 0], [-0.1, 0, 0], [-0.35, 0, 0]]),
  rot('UpperArm_R', [0, 0.5, 1.0], [[-2.75, 0, -0.30], [-2.55, 0, -0.55], [-2.75, 0, -0.30]]),
  rot('LowerArm_R', [0, 0.5, 1.0], [[-0.35, 0, 0], [-0.1, 0, 0], [-0.35, 0, 0]]),
  rot('UpperLeg_L', T, leg.map(l => [hip(l[0]), 0, 0.03])),
  rot('LowerLeg_L', T, leg.map(l => [knee(l[1]), 0, 0])),
  rot('Foot_L', T, leg.map(l => [ankle(l[2]), 0, 0])),
  rot('UpperLeg_R', T, leg.map(l => [hip(l[0]), 0, -0.03])),
  rot('LowerLeg_R', T, leg.map(l => [knee(l[1]), 0, 0])),
  rot('Foot_R', T, leg.map(l => [ankle(l[2]), 0, 0])),
  rot('Flag_L', [0, 0.25, 0.5, 0.75, 1.0], [[0.25, 0, 0.08], [-0.30, 0, 0.08], [0.25, 0, 0.08], [-0.30, 0, 0.08], [0.25, 0, 0.08]]),
  rot('Flag_R', [0, 0.25, 0.5, 0.75, 1.0], [[0.25, 0, -0.08], [-0.30, 0, -0.08], [0.25, 0, -0.08], [-0.30, 0, -0.08], [0.25, 0, -0.08]])
]);
}

/* ====================== THE END ZONE ==================================

   ONE celebration, for everybody, forever: a man hopping on the spot with both
   arms over his head. Ten of them doing it in perfect unison, because it was
   literally the same clip at the same phase. Flag football's whole culture is
   the celebration, and the game had one, and it was a pogo stick.

   What follows is four more, deliberately different in SHAPE rather than in
   detail, because at chase-camera distance that is all that reads: one is a
   whole-body slam (Spike), one is lateral (Dance), one is static and wide
   (Flex), one is vertical and fast (HighStep). Put four of those in a group and
   it looks like a team; put four variations on a hop in a group and it looks
   like a rendering bug.

   Every one of them is authored the way the throw and the flag grab are: feet
   by WHERE THEY ARE, hips solved so the soles stay on the turf, and shoulders
   through armQ rather than by typing euler triples at them.                  */

/* A POSED, NON-CYCLIC CLIP — the shape every one-shot in this file already has,
   extracted so four more of them don't mean four more copies of it.

   rows:  t     seconds
          pel   pelvis yaw, degrees        trk  trunk yaw, degrees
          lean  trunk flexion, + forward   tilt trunk side-bend
          L, R  [z, knee, ankle] — the foot's fore/aft POSITION in metres, its
                knee flexion and its ankle; the hip angle is solved from them so
                a planted foot stays where it was put
          up    how far the whole body is off the turf, metres (a hop)
          arm   [elev, horiz, er, elbow] for the RIGHT arm, through armQ
          off   ditto for the LEFT
          look  optional [pitch, yaw] for the head, radians                    */
function posedClip(name, dur, rows, opts = {}) {
  const T = rows.map(k => k.t);
  const legL = rows.map(k => [plantHip(k.L[0], k.L[1]), k.L[1], k.L[2]]);
  const legR = rows.map(k => [plantHip(k.R[0], k.R[1]), k.R[1], k.R[2]]);
  const lift = rows.map(k => k.up || 0);
  const sway = k => (k.sway || 0);
  const hips = groundedHips(T, legL, legR, lift, rows.map(k => (k.roll || 0) * D));
  // groundedHips only writes height; fold the lateral shift in on the same
  // dense grid it produced, so a dance can put its weight over one foot.
  if (rows.some(k => k.sway)) {
    const xs = hips.times.map(t => {
      let k = 0;
      while (k < rows.length - 2 && rows[k + 1].t <= t) k++;
      const u = (t - rows[k].t) / (rows[k + 1].t - rows[k].t || 1);
      return sway(rows[k]) + (sway(rows[k + 1]) - sway(rows[k])) * u;
    });
    hips.values = hips.values.map((v, i) => [xs[i], v[1], v[2]]);
  }
  clip(name, dur, [
    hips,
    rot('Hips', T, rows.map(k => [0, (k.pel || 0) * D, (k.roll || 0) * D])),
    rot('Spine', T, rows.map(k => [(k.lean || 0) * 0.55 * D, ((k.trk || 0) - (k.pel || 0)) * 0.5 * D, -(k.tilt || 0) * 0.55 * D])),
    rot('Chest', T, rows.map(k => [(k.lean || 0) * 0.45 * D, ((k.trk || 0) - (k.pel || 0)) * 0.5 * D, -(k.tilt || 0) * 0.45 * D])),
    rot('Head', T, rows.map(k => (k.look || [-0.05 - (k.lean || 0) * 0.6 * D, -(k.trk || 0) * 0.5 * D]))
      .map(h => [h[0], h[1], 0])),
    rotq('UpperArm_R', T, rows.map(k => armQ('R', k.arm[0], k.arm[1], k.arm[2]))),
    rot('LowerArm_R', T, rows.map(k => [elbow(k.arm[3]), 0, -0.05])),
    rotq('UpperArm_L', T, rows.map(k => armQ('L', k.off[0], k.off[1], k.off[2]))),
    rot('LowerArm_L', T, rows.map(k => [elbow(k.off[3]), 0, 0.05])),
    rot('UpperLeg_L', T, legL.map(l => [hip(l[0]), 0, (opts.splay == null ? 0.03 : opts.splay)])),
    rot('LowerLeg_L', T, legL.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_L', T, legL.map(l => [ankle(l[2]), 0, 0])),
    rot('Toe_L', T, rows.map(k => [toe(k.L[3] || 0), 0, 0])),
    rot('UpperLeg_R', T, legR.map(l => [hip(l[0]), 0, -(opts.splay == null ? 0.03 : opts.splay)])),
    rot('LowerLeg_R', T, legR.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_R', T, legR.map(l => [ankle(l[2]), 0, 0])),
    rot('Toe_R', T, rows.map(k => [toe(k.R[3] || 0), 0, 0])),
    rot('Flag_L', T, rows.map(k => [-0.004 * (k.lean || 0), 0, 0.05])),
    rot('Flag_R', T, rows.map(k => [-0.004 * (k.lean || 0), 0, -0.05]))
  ]);
}

/* ----------------------------------------------------------------- Spike */
/* THE BALL GOES INTO THE TURF. The one celebration everybody can name, and the
   only one here that is a one-shot: it has a beginning (the ball still in the
   hand from the run), a middle (both arms up, up on the toes, the trunk arched
   back) and an end (the slam, and the stagger out of it with the arms flung
   wide). It hands over to a looping dance afterwards, so the last key is open
   and high rather than back at a rest pose — a fast arm-swing down and straight
   up again either side of a crossfade is the one thing that reads as a glitch. */
posedClip('Spike', 1.15, [
  // t     pelvis trunk lean tilt |  lead foot        back foot      | throwing arm             off arm
  { t: 0.00, pel: 0, trk: 0, lean: 8, tilt: 0, L: [0.12, 30, 10], R: [-0.12, 30, 10], arm: [30, 30, 10, 70], off: [24, 24, 8, 62] },
  { t: 0.20, pel: 0, trk: 4, lean: -14, tilt: 0, L: [0.12, 16, -18], R: [-0.12, 16, -20], up: 0.02, arm: [162, 26, 40, 44], off: [140, 34, 30, 58] },
  // the ball is at the top and the body is stretched: heels off, back arched
  { t: 0.30, pel: 0, trk: 6, lean: -20, tilt: 0, L: [0.12, 12, -26], R: [-0.12, 12, -28], up: 0.04, arm: [172, 20, 46, 30], off: [148, 30, 26, 62] },
  // SLAM. Trunk folds, the arm whips through past the knee, the knees give.
  { t: 0.42, pel: 0, trk: -2, lean: 46, tilt: 0, L: [0.12, 54, 16], R: [-0.12, 54, 14], arm: [24, 8, -60, 16], off: [40, -10, -30, 40] },
  { t: 0.52, pel: 0, trk: -4, lean: 52, tilt: 0, L: [0.12, 62, 18], R: [-0.12, 62, 16], arm: [16, -14, -70, 22], off: [30, -22, -40, 46] },
  // up out of it, arms thrown wide, chest open, head back — the pose the crowd
  // shot is framed on.
  { t: 0.74, pel: 0, trk: 0, lean: -14, tilt: 0, L: [0.12, 26, -6], R: [-0.12, 26, -6], arm: [96, -34, 40, 26], off: [96, -34, 40, 26], look: [0.22, 0] },
  { t: 0.94, pel: 0, trk: 0, lean: -16, tilt: 0, L: [0.12, 22, -10], R: [-0.12, 22, -10], up: 0.03, arm: [118, -26, 50, 22], off: [118, -26, 50, 22], look: [0.26, 0] },
  { t: 1.15, pel: 0, trk: 0, lean: -8, tilt: 0, L: [0.12, 28, 4], R: [-0.12, 28, 4], arm: [128, -12, 46, 34], off: [128, -12, 46, 34], look: [0.14, 0] }
]);

/* ------------------------------------------------------------------ Dance */
/* A two-step shimmy, and the only celebration in here that is LATERAL — which
   is the whole reason it exists. Weight rocks from one foot to the other, the
   pelvis swings under a trunk that counters it, and the arms punch across the
   body on the off-beat. Loops on a 1.1s bar so a group of them, staggered, is
   not a chorus line. */
posedClip('Dance', 1.10, [
  { t: 0.000, pel: 22, trk: -10, lean: 6, tilt: -8, sway: 0.055, L: [0.14, 46, 12], R: [-0.14, 20, 6], arm: [92, 58, 30, 104], off: [58, -22, -10, 76] },
  { t: 0.275, pel: 0, trk: 0, lean: 10, tilt: 0, sway: 0.000, L: [0.14, 30, 10], R: [-0.14, 30, 10], arm: [74, 20, 10, 88], off: [74, 20, 10, 88] },
  { t: 0.550, pel: -22, trk: 10, lean: 6, tilt: 8, sway: -0.055, L: [0.14, 20, 6], R: [-0.14, 46, 12], arm: [58, -22, -10, 76], off: [92, 58, 30, 104] },
  { t: 0.825, pel: 0, trk: 0, lean: 10, tilt: 0, sway: 0.000, L: [0.14, 30, 10], R: [-0.14, 30, 10], arm: [74, 20, 10, 88], off: [74, 20, 10, 88] },
  { t: 1.100, pel: 22, trk: -10, lean: 6, tilt: -8, sway: 0.055, L: [0.14, 46, 12], R: [-0.14, 20, 6], arm: [92, 58, 30, 104], off: [58, -22, -10, 76] }
], { splay: 0.06 });

/* ------------------------------------------------------------------- Flex */
/* Both arms out and folded, chest up, rocking slowly on braced legs. The wide,
   STATIC one: it holds a silhouette while everything around it is moving, which
   is what stops a group celebration reading as one animation played ten times.
   'er' near 90 puts the forearms vertical, which is what makes it a flex and
   not a shrug. */
posedClip('Flex', 1.30, [
  { t: 0.000, pel: 0, trk: 0, lean: -6, tilt: 0, L: [0.16, 24, 8], R: [-0.16, 24, 8], arm: [82, 4, 88, 128], off: [82, 4, 88, 128], look: [0.06, 0] },
  { t: 0.325, pel: 6, trk: -6, lean: -10, tilt: -4, L: [0.16, 18, 4], R: [-0.16, 30, 10], arm: [88, -6, 94, 138], off: [78, 10, 82, 122], look: [0.10, -0.14] },
  { t: 0.650, pel: 0, trk: 0, lean: -6, tilt: 0, L: [0.16, 26, 9], R: [-0.16, 26, 9], arm: [80, 6, 86, 126], off: [80, 6, 86, 126], look: [0.06, 0] },
  { t: 0.975, pel: -6, trk: 6, lean: -10, tilt: 4, L: [0.16, 30, 10], R: [-0.16, 18, 4], arm: [78, 10, 82, 122], off: [88, -6, 94, 138], look: [0.10, 0.14] },
  { t: 1.300, pel: 0, trk: 0, lean: -6, tilt: 0, L: [0.16, 24, 8], R: [-0.16, 24, 8], arm: [82, 4, 88, 128], off: [82, 4, 88, 128], look: [0.06, 0] }
], { splay: 0.07 });

/* --------------------------------------------------------------- HighStep */
/* Knees to the chest, on the spot, fast. It is a gait — so it is built by the
   gait machinery, which means it gets the same foot roll and the same solved
   ground contact as the run rather than being a second, worse implementation
   of the same thing. Nothing translates a celebrating player, so a cycle with
   no root motion is exactly right. */
cyclicGait('HighStep', 0.52, {
  leg: [
    //  phase  hip  knee  ankle  toe
    [0.00, -6, 26, -22, 10],   // driving down onto the forefoot
    [0.10, -20, 20, -30, 26],  // toe-off, hard
    [0.24, -6, 96, -12, 8],
    [0.40, 46, 116, 6, 0],
    [0.52, 88, 104, 14, 0],    // knee to the chest
    [0.68, 84, 76, 10, 0],
    [0.84, 48, 46, -4, 4],     // the shin drops for the next strike
    [1.00, -6, 26, -22, 10]
  ],
  arm: [
    [0.00, -20, 96, 14],
    [0.16, 26, 118, 12],
    [0.30, 40, 128, 11],       // hand up by the shoulder
    [0.52, 10, 110, 13],
    [0.70, -34, 88, 16],
    [0.84, -28, 84, 15],
    [1.00, -20, 96, 14]
  ],
  lift: 0.040, stanceEnd: 0.22,
  lean: -0.06, head: 0.04,
  yaw: 0.10, yawPhase: 0.25,
  obliq: 0.06, sway: 0.014, tilt: 0.05, splay: 0.03
});

/* ------------------------------------------------------------------ Juke */
/* Same treatment as Catch, and it mattered more here: this is the animation a
   player watches most closely, because it is the one they asked for. The
   hand-keyed pelvis put a foot 77mm under the turf at the bottom of the plant.
   The sink the keys were reaching for is real, but it belongs to the knee
   flexion already in the pose — solve the height and it arrives for free,
   without the foot going with it. */
{
  const T = [0, 0.20, 0.45, 0.80];
  const legL = [[25.8, 20.1, 0], [-11.5, 17.2, 0], [31.5, 51.6, 0], [17.2, 20.1, 0]];
  const legR = [[-17.2, 34.4, 0], [28.6, 54.4, 0], [-20.1, 20.1, 0], [8.6, 22.9, 0]];
  const roll = [0.20, 0.40, -0.35, -0.12];         // matches the Hips track below
clip('Juke', 0.80, [
  groundedHips(T, legL, legR, null, roll),
  rot('Hips', [0, 0.20, 0.45, 0.80], [[0, 0, 0.20], [0, 0.25, 0.40], [0, -0.30, -0.35], [0, 0, -0.12]]),
  rot('Spine', [0, 0.20, 0.45, 0.80], [[0.12, 0, -0.18], [0.30, -0.20, -0.34], [0.24, 0.25, 0.30], [0.14, 0, 0.10]]),
  rot('Head', [0, 0.20, 0.45, 0.80], [[-0.08, 0.20, 0], [-0.08, 0.35, 0], [-0.08, -0.30, 0], [-0.08, 0, 0]]),
  rot('UpperArm_L', [0, 0.20, 0.45, 0.80], [[-0.35, 0, 0.55], [-0.75, 0, 0.85], [0.30, 0, 0.30], [-0.10, 0, 0.30]]),
  rot('LowerArm_L', [0, 0.80], [[-1.25, 0, 0], [-1.15, 0, 0]]),
  rot('UpperArm_R', [0, 0.20, 0.45, 0.80], [[0.30, 0, -0.30], [0.55, 0, -0.30], [-0.75, 0, -0.85], [-0.10, 0, -0.30]]),
  rot('LowerArm_R', [0, 0.80], [[-1.15, 0, 0], [-1.25, 0, 0]]),
  rot('UpperLeg_L', [0, 0.20, 0.45, 0.80], [[-0.45, 0, 0.10], [0.20, 0, 0.35], [-0.55, 0, 0.06], [-0.30, 0, 0.04]]),
  rot('LowerLeg_L', [0, 0.20, 0.45, 0.80], [[0.35, 0, 0], [0.3, 0, 0], [0.9, 0, 0], [0.35, 0, 0]]),
  rot('UpperLeg_R', [0, 0.20, 0.45, 0.80], [[0.30, 0, -0.06], [-0.50, 0, -0.10], [0.35, 0, -0.35], [-0.15, 0, -0.04]]),
  rot('LowerLeg_R', [0, 0.20, 0.45, 0.80], [[0.6, 0, 0], [0.95, 0, 0], [0.35, 0, 0], [0.4, 0, 0]]),
  rot('Flag_L', [0, 0.20, 0.45, 0.80], [[0.15, 0, 0.05], [-0.35, 0.3, 0.30], [0.35, -0.3, -0.10], [0.05, 0, 0.05]]),
  rot('Flag_R', [0, 0.20, 0.45, 0.80], [[0.15, 0, -0.05], [-0.35, 0.3, 0.10], [0.35, -0.3, -0.30], [0.05, 0, -0.05]])
]);
}

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
  const anim = { name: c.name, samplers, channels };
  // Clip metadata rides along in glTF `extras`, which GLTFLoader copies onto
  // AnimationClip.userData — so the renderer reads a gait's natural ground
  // speed off the clip instead of keeping a hand-copied constant in step with
  // these tables by force of comment.
  if (c.extras) anim.extras = c.extras;
  gltf.animations.push(anim);
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
