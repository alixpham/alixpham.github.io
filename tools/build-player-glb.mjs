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
    /* Per-vertex "do not weld" flag. The cap rims below are duplicated ON
       PURPOSE so a cap shades flat against the tube it closes; the normal
       weld must leave those alone or every cleat and cuff rounds off. */
    this.H = [];
  }
  vert(pos, uv, w, hard) {
    const i = this.P.length / 3;
    this.P.push(pos[0], pos[1], pos[2]);
    this.U.push(uv[0], uv[1]);
    const j = [0, 0, 0, 0], wt = [0, 0, 0, 0];
    const list = w.slice(0, 4);
    let sum = 0;
    for (const [a, b] of list) sum += b;
    if (sum <= 0) throw new Error('zero weight in ' + this.name);
    list.forEach(([a, b], k) => { j[k] = a; wt[k] = b / sum; });
    this.J.push(...j); this.W.push(...wt); this.H.push(hard ? 1 : 0);
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

   Each ring emits seg + 1 columns: the last DUPLICATES the first in position
   and weights but carries u = 1. Without it the closing quad runs from
   u = (seg-1)/seg straight back to u = 0 and smears the entire texture across
   one column — invisible while every material was a flat colour, and the first
   thing you would see once the head carries a face.

   opts: { seg, p, phase, capStart, capEnd, poleEnd, poleStart, uv0, uv1, uv } */
function loft(R, rings, opts = {}) {
  const seg = opts.seg || 12;
  const P = opts.p == null ? 1 : opts.p;
  const uv0 = opts.uv0 == null ? 0 : opts.uv0;
  const uv1 = opts.uv1 == null ? 1 : opts.uv1;
  const phase = opts.phase || 0;
  const idx = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const row = [];
    const vv = lerp(uv0, uv1, rings.length === 1 ? 0 : r / (rings.length - 1));
    for (let k = 0; k <= seg; k++) {
      const t = ((k % seg) / seg) * TAU + phase;
      let [a, b] = se(t, ring.p == null ? P : ring.p);
      /* Per-angle radial modulation. A ring alone can only ever be a smooth
         convex hoop, which is why the figure read as a set of tubes: an
         ellipse has no deltoid, no lat, no quadriceps sweep and no spinal
         groove. `mod` scales the radius as a function of the angle around the
         ring, so a profile can carry muscle without carrying more vertices. */
      if (ring.mod) { const m = ring.mod(t); a *= m; b *= m; }
      const pos = [
        ring.c[0] + ring.u[0] * a + ring.v[0] * b,
        ring.c[1] + ring.u[1] * a + ring.v[1] * b,
        ring.c[2] + ring.u[2] * a + ring.v[2] * b
      ];
      const uv = opts.uv
        ? opts.uv({ pos, a, b, k, seg, r, rows: rings.length, last: k === seg })
        : [k / seg, vv];
      row.push(R.vert(pos, uv, ring.w));
    }
    idx.push(row);
  }
  for (let r = 0; r < rings.length - 1; r++) {
    const A = idx[r], B = idx[r + 1];
    for (let k = 0; k < seg; k++) {
      R.quad(A[k], B[k], B[k + 1], A[k + 1]);
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

  const rimOf = (ring, vv) => {
    const rim = [];
    for (let k = 0; k <= seg; k++) {
      const t = ((k % seg) / seg) * TAU + phase, [a, b] = se(t, ring.p == null ? P : ring.p);
      rim.push(R.vert([ring.c[0] + ring.u[0] * a + ring.v[0] * b, ring.c[1] + ring.u[1] * a + ring.v[1] * b, ring.c[2] + ring.u[2] * a + ring.v[2] * b], [k / seg, vv], ring.w, true));
    }
    return rim;
  };

  if (opts.poleEnd != null) {
    const c = R.vert([last.c[0] + dEnd[0] * opts.poleEnd, last.c[1] + dEnd[1] * opts.poleEnd, last.c[2] + dEnd[2] * opts.poleEnd], [0.5, uv1], last.w);
    const B = idx[idx.length - 1];
    for (let k = 0; k < seg; k++) R.tri(c, B[k + 1], B[k]);
  } else if (opts.capEnd) {
    const rim = rimOf(last, uv1);              // duplicated rim so the cap shades flat
    const c = R.vert(last.c.slice(), [0.5, uv1], last.w, true);
    for (let k = 0; k < seg; k++) R.tri(c, rim[k + 1], rim[k]);
  }
  if (opts.poleStart != null) {
    const c = R.vert([first.c[0] + dStart[0] * opts.poleStart, first.c[1] + dStart[1] * opts.poleStart, first.c[2] + dStart[2] * opts.poleStart], [0.5, uv0], first.w);
    const A = idx[0];
    for (let k = 0; k < seg; k++) R.tri(c, A[k], A[k + 1]);
  } else if (opts.capStart) {
    const rim = rimOf(first, uv0);
    const c = R.vert(first.c.slice(), [0.5, uv0], first.w, true);
    for (let k = 0; k < seg; k++) R.tri(c, rim[k], rim[k + 1]);
  }
  return idx;
}

/* Vertical ring shorthand: ringY(y, rx, rz, weights, cx, cz, p) */
const ringY = (y, rx, rz, w, cx = 0, cz = 0, p, mod) => ({ c: [cx, y, cz], u: [rx, 0, 0], v: [0, 0, rz], w, p, mod });
/* Ring in the XY plane advancing along +Z (used for the shoe): u=+Y, v=+X. */
const ringZ = (z, hy, hx, w, cx = 0, cy = 0, p) => ({ c: [cx, cy, z], u: [0, hy, 0], v: [hx, 0, 0], w, p });

/* Post-loft displacement.

   Everything on the face that must not break the head's silhouette is a
   DISPLACEMENT of the skull surface rather than a mesh stuck on top of it.
   The old head lofted small ellipsoids for eyes, brows, nose and mouth onto
   the outside of the skin, and from three-quarter and profile views they
   protruded past the head's outline and merged into one dark smear. A surface
   that is pushed in or pulled out cannot do that.

   `grid` is the vertex index table loft() returned; `fn` takes a position and
   returns a delta. Because it is a pure function of position, the duplicated
   seam column always moves with its twin, so the seam can never open.        */
function sculpt(R, grid, fn) {
  for (const row of grid) {
    for (const vi of row) {
      const o = vi * 3;
      const d = fn(R.P[o], R.P[o + 1], R.P[o + 2]);
      if (!d) continue;
      R.P[o] += d[0]; R.P[o + 1] += d[1]; R.P[o + 2] += d[2];
    }
  }
}
/* Smooth falloff: 1 at the centre, 0 at d >= 1, flat-topped and flat-tailed. */
const fall = d => (d >= 1 ? 0 : Math.pow(Math.cos(d * Math.PI / 2), 2));
const norm = (...v) => Math.hypot(...v);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/* --- Anatomy modulation helpers -------------------------------------------
   Angles around a vertical ring: t = 0 is the character's LEFT (+X), t = pi/2
   is FRONT (+Z), t = pi is their RIGHT, t = 3pi/2 is BACK. A "lobe" is a
   raised-cosine bump centred on an angle, so muscles blend into the profile
   instead of stepping.                                                       */
const angDist = (t, c) => {
  let d = (t - c) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return Math.abs(d);
};
/* amp at `centre`, falling to 0 by `width` radians away. Negative amp digs in. */
function lobe(t, centre, width, amp) {
  const d = angDist(t, centre);
  if (d >= width) return 0;
  return amp * 0.5 * (1 + Math.cos(Math.PI * d / width));
}
/* Combine lobes into a radius multiplier. */
const mods = (...specs) => t => 1 + specs.reduce((s, [c, w, a]) => s + lobe(t, c, w, a), 0);
const FRONT = Math.PI / 2, BACK = -Math.PI / 2, LEFT = 0, RIGHT = Math.PI;

/* ==================================================== 3. BUILD THE FIGURE */

const REGIONS = [];
const R = (name, material) => { const r = new Region(name, material); REGIONS.push(r); return r; };

const jersey = R('jersey', 'jersey');
const trim   = R('trim', 'trim');
const skin   = R('skin', 'skin');
/* The head is its own region because it is the only part of the body that
   carries a texture. Neck, arms and legs all share one 0..1 UV space (loft
   writes [k/seg, v]), so a face map applied to `skin` would smear a mouth
   across somebody's forearm. */
const head   = R('head', 'head');
const shorts = R('shorts', 'shorts');
const socks  = R('socks', 'socks');
const shoes  = R('shoes', 'shoes');
const belt   = R('belt', 'belt');
const flag   = R('flag', 'flag');

/* Segment counts around each ring. These were 14/10/10/8 — enough for a smooth
   tube and nowhere near enough to carry muscle: at 14 segments the samples are
   26 degrees apart and a sternal groove 20 degrees wide falls between two. */
const SEG_BODY = 26, SEG_LIMB = 16, SEG_FOOT = 12, SEG_FLAG = 8;

/* ---- torso weighting: hips -> spine -> chest by height ---- */
function torsoW(y) {
  if (y <= 0.990) return w1('Hips');
  if (y < 1.130) return wmix('Hips', 'Spine', (y - 0.990) / 0.140);
  if (y < 1.275) return wmix('Spine', 'Chest', (y - 1.130) / 0.145);
  return w1('Chest');
}

/* ---- JERSEY: torso ----
   The profile alone gives a barrel. What makes a torso read as an athlete's is
   what happens AROUND each ring: pectorals either side of a sternal groove,
   lats flaring off the ribs into the armpit, a shallow channel down the spine,
   a linea alba down the abdomen, and a trapezius that lifts the shoulder line
   out of the neck instead of letting it slope straight off. Those are all
   `mod` lobes below; the rings themselves barely changed.                     */
{
  const prof = [
    [0.925, 0.148, 0.103], [0.965, 0.148, 0.103], [1.000, 0.148, 0.103],
    [1.035, 0.152, 0.106], [1.070, 0.157, 0.110], [1.110, 0.167, 0.117],
    [1.150, 0.178, 0.124], [1.190, 0.190, 0.131], [1.230, 0.202, 0.137],
    [1.270, 0.211, 0.141], [1.310, 0.219, 0.144], [1.345, 0.226, 0.143],
    [1.380, 0.232, 0.142], [1.415, 0.233, 0.138], [1.450, 0.232, 0.134],
    [1.472, 0.227, 0.129], [1.490, 0.221, 0.123], [1.506, 0.211, 0.117],
    [1.520, 0.199, 0.110], [1.535, 0.178, 0.100], [1.545, 0.156, 0.091],
    [1.553, 0.134, 0.084], [1.560, 0.112, 0.077]
  ];
  /* Muscle amplitude ramps in over the height of the trunk. */
  const torsoMod = y => {
    const pec = ramp([[1.240, 0], [1.330, 0.055], [1.430, 0.050], [1.480, 0]], y);
    const abs = ramp([[0.960, 0.020], [1.120, 0.026], [1.240, 0.012], [1.300, 0]], y);
    const lat = ramp([[1.130, 0], [1.260, 0.048], [1.380, 0.040], [1.460, 0]], y);
    const spine = ramp([[1.020, -0.016], [1.240, -0.026], [1.420, -0.020], [1.500, 0]], y);
    const trap = ramp([[1.430, 0], [1.500, 0.075], [1.545, 0.060]], y);
    return mods(
      [FRONT - 0.42, 0.66, pec], [FRONT + 0.42, 0.66, pec],   // pectorals
      [FRONT, 0.34, -pec * 0.55 - abs * 0.9],                 // sternum / linea alba
      [FRONT - 1.05, 0.34, abs], [FRONT + 1.05, 0.34, abs],   // oblique
      [LEFT, 0.62, lat], [RIGHT, 0.62, lat],                  // lats
      [BACK, 0.30, spine],                                    // spinal channel
      [LEFT - 0.55, 0.70, trap], [RIGHT + 0.55, 0.70, trap]   // trapezius
    );
  };
  loft(jersey, prof.map(([y, rx, rz]) => ringY(y, rx, rz, torsoW(y), 0, 0, 0.86, torsoMod(y))),
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
    /* Deltoid: the cap was a plain cone off the shoulder, which is why the
       shoulder line slid straight into the arm. Mass goes on the OUTBOARD
       face and slightly forward, the way a deltoid sits, and the inboard face
       is pulled in so the arm reads as separate from the ribs. */
    const del = ramp([[1.310, 0], [1.380, 0.10], [1.440, 0.13], [1.490, 0.05], [1.512, 0]], y);
    const out = side > 0 ? LEFT : RIGHT;
    return ringY(y, r, r * 1.03, w, cx, 0, 0.95,
      mods([out, 1.30, del], [out + side * 0.75, 0.80, del * 0.45], [out + Math.PI, 1.00, -del * 0.35]));
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

const SEG_HEAD = 24;
/* k = 0 lands at the BACK of the skull, so the UV seam — and any imprecision
   where the texture wraps — hides in the hair instead of running down a
   cheek. It also puts the face centre at exactly u = 0.5. */
const HEAD_PHASE = -Math.PI / 2;
const CHIN_Y = 1.600, CROWN_Y = 1.850;
/* The neck's top ring and the head's bottom ring are THE SAME RING — same
   radii, same centre, same superellipse, same segment count and phase, same
   skin weights. They are separate meshes only because the head carries a
   texture and the neck does not, and two surfaces that merely overlap
   interleave: the first cut of this had the jaw and the neck crossing within
   two millimetres of each other over a 2 cm band, which rendered as a ragged
   stair-stepped line under the chin. Sharing the ring means there is nothing
   to intersect — just a material seam, tucked under the jaw, between two
   surfaces tinted the same colour. */
const NECK_TOP = [1.606, 0.054, 0.050, -0.012, 0.90];
const NECK_W = wraw(['Neck', 0.5], ['Head', 0.5]);

/* ---- SKIN: neck ----
   The bottom ring flares into the trapezius instead of ending as a straight
   tube: without it the collar had nothing to sit on and read as a ring
   floating in front of a gap. The top ring is deliberately NARROWER than the
   jaw above it, so the head emerges from the neck around y = 1.61 the way a
   jaw actually does, and the neck's open top rim is hidden inside the skull
   rather than showing as a hard circle under the chin. */
loft(skin, [
  ringY(1.448, 0.100, 0.090, w1('Chest'), 0, -0.004, 0.85),
  ringY(1.490, 0.082, 0.074, wraw(['Chest', 0.70], ['Neck', 0.30]), 0, -0.006),
  ringY(1.545, 0.065, 0.060, w1('Neck'), 0, -0.008),
  ringY(1.578, 0.058, 0.054, wraw(['Neck', 0.75], ['Head', 0.25]), 0, -0.011),
  ringY(NECK_TOP[0], NECK_TOP[1], NECK_TOP[2], NECK_W, 0, NECK_TOP[3], NECK_TOP[4])
], { seg: SEG_HEAD, phase: HEAD_PHASE, capStart: true });

/* ============================================================== THE HEAD ===
   The old head was an ellipsoid: 7 rings lofted through a sphere equation, no
   jawline, no chin, no brow, no cheekbone. In profile it was an egg, and the
   features were separate blobs floating on its surface.

   This one is a PROFILE, sampled. Every horizontal slice of a skull has its
   own half-width, half-depth, forward offset and squareness, and stating all
   four as data gives cranium -> temple -> cheekbone -> jaw -> chin for free,
   in the same style as the torso and limb tables above. The superellipse
   exponent doing most of the work: squarer (p < 0.8) at the jaw where a face
   is flat and angular, round (p -> 1) over the cranium.

   Head width comes out at 0.162 m and depth 0.194 m, against 0.155/0.195 for
   an adult male — the old one was 0.188 wide, which is part of why it read as
   a ball rather than a head.                                                 */

/* [y, halfWidth, halfDepth, centreZ, superellipse p] */
const HEAD_PROF = [
  NECK_TOP,                              // shared with the neck's top ring
  [1.616, 0.055, 0.056,  0.000, 0.84],   // under the jaw
  [1.628, 0.059, 0.070,  0.012, 0.72],   // chin / jaw underside
  [1.641, 0.064, 0.074,  0.008, 0.75],   // chin front
  [1.654, 0.069, 0.077,  0.004, 0.76],   // jawline — squarest slice
  [1.667, 0.074, 0.083,  0.000, 0.78],   // mouth
  [1.680, 0.077, 0.088, -0.003, 0.78],
  [1.694, 0.080, 0.094, -0.006, 0.80],   // cheekbone
  [1.708, 0.081, 0.096, -0.006, 0.84],
  [1.722, 0.081, 0.097, -0.007, 0.88],   // eye line — widest
  [1.736, 0.080, 0.096, -0.008, 0.91],   // brow ridge
  [1.752, 0.079, 0.094, -0.009, 0.94],   // forehead
  [1.770, 0.077, 0.091, -0.010, 0.96],   // hairline
  [1.790, 0.073, 0.086, -0.011, 0.98],   // cranium
  [1.812, 0.065, 0.077, -0.011, 1.00],
  [1.832, 0.048, 0.058, -0.011, 1.00],
  [1.843, 0.030, 0.036, -0.011, 1.00],
  [1.8475, 0.017, 0.020, -0.011, 1.00]
];
const profOf = col => {
  const stops = HEAD_PROF.map(r => [r[0], r[col]]);
  return y => ramp(stops, y);
};
const hrx = profOf(1), hrz = profOf(2), hcz = profOf(3), hp = profOf(4);

/* Face UVs. u is derived from the ring's own normalised X rather than from
   the angle, so every slice maps edge-to-edge onto the same u range and a
   feature drawn at a given u stays proportionally placed as the head narrows
   toward the chin. Going around the ring from the back the path is
   back -> +X -> front -> -X -> back, and u runs 0 -> 0.25 -> 0.5 -> 0.75 -> 1
   monotonically, so the face owns the middle half of the texture and the back
   of the skull is parked in the outer quarters.

   +X is the character's LEFT, which is the viewer's RIGHT, so u increases
   toward the character's right — worth knowing before drawing anything
   deliberately asymmetric. */
function headUV(a, b, y, last) {
  const v = clamp01((y - CHIN_Y) / (CROWN_Y - CHIN_Y));
  let u;
  if (last) u = 1;
  else if (b >= 0) u = 0.5 - 0.25 * a;                 // front half
  else u = a >= 0 ? 0.25 * a : 1 + 0.25 * a;           // back half
  return [u, v];
}
const faceUV = ctx => headUV(ctx.a, ctx.b, ctx.pos[1], ctx.last);

/* Enough to clear the skin, too little to read as a step.

   It can be this small because every shell is tessellated at least as finely
   as the skull under it — same column count and phase, more rows — and of two
   polygonal surfaces inscribed in the same true surface the finer one lies
   outside the coarser one. When this was 2.6 mm the boundary of every shell
   showed as a faint ledge: a rectangle around the ear, a step around the
   goatee, a rim along the fade. */
const TH_EDGE = 0.0008;

{
  const HEAD_YS = HEAD_PROF.map(r => r[0]);
  /* Weights blend out of the neck over the bottom two rings so the shared
     ring above deforms identically on both sides of the material seam — get
     this wrong and the seam opens the moment anybody turns their head. */
  const headW = y => (y >= 1.641 ? w1('Head')
    : y <= NECK_TOP[0] ? NECK_W
      : wmix('Neck', 'Head', 0.5 + 0.5 * clamp01((y - NECK_TOP[0]) / 0.035)));
  const headGrid = loft(head,
    HEAD_YS.map(y => ringY(y, hrx(y), hrz(y), headW(y), 0, hcz(y), hp(y))),
    { seg: SEG_HEAD, phase: HEAD_PHASE, poleEnd: 0.0028, uv: faceUV });

  /* ---- FACE, sculpted into the surface -----------------------------------
     All of it scaled by how front-facing the vertex is, so nothing bleeds
     around onto the sides of the skull. */
  const nostrilW = y => ramp([[1.696, 0.028], [1.712, 0.025], [1.728, 0.016], [1.746, 0.013], [1.762, 0.012]], y);
  /* The nose is a continuation of the brow ridge — the bridge starts between
     the eyes and swells to the tip — not the detached capsule it used to be,
     which is what let it float off the face in profile. It is still the
     forward marker that keeps facing readable at game distance: the tip ends
     up 24 mm proud of the cheeks. */
  const noseOut = y => ramp([
    [1.694, 0.000], [1.702, 0.015], [1.712, 0.028], [1.722, 0.024],
    [1.734, 0.014], [1.746, 0.008], [1.760, 0.002], [1.770, 0.000]], y);

  sculpt(head, headGrid, (x, y, z) => {
    const front = clamp01((z - hcz(y)) / (hrz(y) * 0.62));
    if (front <= 0.02) return null;
    let dz = 0;

    // Eye sockets: the eyes have to sit IN the face, so the face goes in.
    for (const sx of [1, -1]) {
      dz -= 0.0085 * fall(norm((x - sx * 0.031) / 0.034, (y - 1.727) / 0.017));
    }
    // Brow ridge over them, heaviest above the inner corners.
    dz += 0.0060 * fall(clamp01((Math.abs(x) - 0.006) / 0.052)) * fall(Math.abs(y - 1.744) / 0.015);
    // Nose.
    dz += noseOut(y) * fall(Math.abs(x) / nostrilW(y));
    // Chin point, lips, and a hollow under the cheekbones.
    dz += 0.0060 * fall(norm(x / 0.030, (y - 1.633) / 0.017));
    dz += 0.0028 * fall(norm(x / 0.027, (y - 1.673) / 0.010));
    for (const sx of [1, -1]) {
      dz -= 0.0035 * fall(norm((x - sx * 0.056) / 0.028, (y - 1.686) / 0.020));
    }
    return [0, 0, dz * front];
  });

  /* ---- EARS: helix rim, concha, lobe --------------------------------------
     Built as a PATCH raised off the skull, not a tube parked against it. A
     separate tube has to end somewhere, and wherever it ends is a rim you can
     see; this one's thickness falls to nothing at the patch border, so it
     merges into the side of the head and the only edges in it are the ones an
     ear actually has — the helix standing proud, the concha hollow inside it,
     and a lobe at the bottom.

     Ears get a flat UV in the plain-skin margin of the face texture; an ear
     wants tone, not features.                                                */
  for (const side of [1, -1]) {
    /* Tessellated FINER than the skull under it, in both directions. Two
       polygonal surfaces inscribed in the same true surface: the finer one
       lies outside the coarser one everywhere, so the patch needs almost no
       lift to sit clear of the head — and it is the lift, not the shape, that
       showed as a faint rectangle around the ear when it was TH_EDGE. */
    const SEGE = 24, ROWE = 14, EAR_EDGE = 0.0004;
    const HALF = 0.062, EY0 = 1.692, EY1 = 1.752;
    const centre = side > 0 ? 0.25 : 0.75;      // frac 0.25 is +X, dead side-on
    const grid = [];
    for (let r = 0; r <= ROWE; r++) {
      const row = [];
      for (let k = 0; k <= SEGE; k++) {
        const cu = k / SEGE, s = r / ROWE;
        const px = (cu - 0.5) * 2, py = (s - 0.5) * 2;      // patch space, -1..1
        // The outline: an ellipse pulled slightly forward and down, which is
        // the difference between an ear and a disc.
        const rr = norm(px * 1.06 + py * 0.10, py);
        const helix = fall(Math.abs(rr - 0.70) / 0.30);     // the rim
        const body = fall(rr) * 0.34;
        const concha = fall(norm((px + 0.18) / 0.44, (py - 0.06) / 0.46)) * 0.42;
        const lobe = fall(norm((px + 0.10) / 0.55, (py + 0.80) / 0.34)) * 0.30;
        const th = Math.max(EAR_EDGE, 0.0128 * (helix * 0.92 + body + lobe - concha));
        const frac = centre + (side > 0 ? 1 : -1) * lerp(-HALF, HALF, cu);
        const y = lerp(EY0, EY1, s);
        const [a, b] = se(frac * TAU + HEAD_PHASE, hp(y));
        // Same mapping as the skull under it: a constant UV made the ear a
        // pale rectangle, because the face map shades toward the silhouette
        // and a flat sample does not.
        row.push(head.vert([(hrx(y) + th) * a, y, hcz(y) + (hrz(y) + th) * b],
          headUV(a, b, y, false), w1('Head')));
      }
      grid.push(row);
    }
    for (let r = 0; r < ROWE; r++) {
      for (let k = 0; k < SEGE; k++) head.quad(grid[r][k], grid[r + 1][k], grid[r + 1][k + 1], grid[r][k + 1]);
    }
  }
}

/* ================================================ HAIR, BEARDS, HEADBAND ===
   All baked, all optional, exactly one of each group shown per player.
   SkeletonUtils.clone shares geometry between instances, so the variants cost
   file size once and nothing per player, and a hidden mesh is skipped by the
   renderer — draw calls per player do not move.

   Every one of them is a SHELL OFFSET FROM THE SAME SKULL PROFILE, which is
   the fix for the old hair: that was a skullcap sitting above y = 1.795 plus
   an entirely separate ellipsoid at the nape, and the second one read from
   behind and in profile as a hard-edged dark slab hovering off the head.
   Following the skull it cannot hover, and tapering the thickness to almost
   nothing at the boundary makes a hairline a hairline instead of a rim. */

/* Angular distance from the front of the head, 0 (front) .. 0.5 (back). */
const fromFront = frac => { const d = frac - 0.5; return Math.abs(d - Math.round(d)); };

/* A cap running from a per-column hairline up over the crown. */
function hairShell(R, opts) {
  const seg = opts.seg || SEG_HEAD, rows = opts.rows || 6, top = 1.8475;
  const grid = [];
  for (let r = 0; r <= rows; r++) {
    const row = [];
    for (let k = 0; k <= seg; k++) {
      const kk = k % seg, frac = kk / seg;
      /* Rows crowd toward the crown. Spacing them evenly meant a column whose
         hairline starts low took ~2 cm steps, and a 2 cm chord across the
         crown's curvature cuts a corner deeper than the hair is thick — which
         is skin poking through the hair, in a thin bright wedge. The extra
         clearance term does the same job for what is left. */
      const s = Math.pow(r / rows, 0.8);
      const y = lerp(opts.low(frac), top, s);
      const th = Math.max(TH_EDGE, opts.thick(fromFront(frac), s, frac) + 0.0022 * s * s);
      const [a, b] = se((kk / seg) * TAU + HEAD_PHASE, hp(y));
      row.push(R.vert([(hrx(y) + th) * a, y, hcz(y) + (hrz(y) + th) * b],
        [k / seg, s], w1('Head')));
    }
    grid.push(row);
  }
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < seg; k++) R.quad(grid[r][k], grid[r + 1][k], grid[r + 1][k + 1], grid[r][k + 1]);
  }
  const apex = R.vert([0, CROWN_Y + Math.max(0.003, opts.thick(0, 1, 0.5) * 0.8), hcz(CROWN_Y)], [0.5, 1], w1('Head'));
  const B = grid[rows];
  for (let k = 0; k < seg; k++) R.tri(apex, B[k + 1], B[k]);
  return grid;
}

/* A patch bounded on all four sides — beards. Thickness falls to TH_EDGE at
   every border, so the patch welds itself onto the skin and never shows an
   open rim. */
function facePatch(R, opts) {
  const seg = opts.seg || SEG_HEAD, rows = opts.rows || 10;
  const grid = [];
  for (let r = 0; r <= rows; r++) {
    const row = [];
    for (let k = 0; k <= seg; k++) {
      const cu = k / seg, s = r / rows;
      const frac = 0.5 + lerp(-opts.half, opts.half, cu);       // 0.5 = front
      const d = fromFront(frac);
      /* The patch is a LENS, and it is a lens in the geometry rather than in
         the thickness. Tapering thickness alone only makes the shape lie flat
         against the skin — it still paints every square millimetre of itself
         beard-coloured, which is how the first cut produced a rectangular bib
         with a notch out of it. Collapsing each column's height to the
         ellipse is what actually stops the shape where it should stop. */
      const dcu = (cu - 0.5) * 2;
      const hh = Math.sqrt(Math.max(0, 1 - dcu * dcu));
      const mid = (opts.low(d) + opts.high(d)) / 2;
      const span = (opts.high(d) - opts.low(d)) / 2;
      const y = mid + (s * 2 - 1) * span * hh;
      const th = Math.max(TH_EDGE, opts.thick * fall(norm(dcu, s * 2 - 1)));
      const [a, b] = se(frac * TAU + HEAD_PHASE, hp(y));
      row.push(R.vert([(hrx(y) + th) * a, y, hcz(y) + (hrz(y) + th) * b], [cu, s], w1('Head')));
    }
    grid.push(row);
  }
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < seg; k++) R.quad(grid[r][k], grid[r + 1][k], grid[r + 1][k + 1], grid[r][k + 1]);
  }
  return grid;
}

/* Hairlines as data: how far down the hair reaches at the front, the temple,
   the side and the nape, plus how thick it is and how much it ribs. */
const HAIR_STYLES = [
  { id: 'buzz',  front: 1.772, temple: 1.744, side: 1.722, back: 1.706, th: 0.0035, rib: 0 },
  { id: 'crop',  front: 1.774, temple: 1.742, side: 1.718, back: 1.700, th: 0.0090, rib: 0 },
  { id: 'fade',  front: 1.776, temple: 1.730, side: 1.694, back: 1.684, th: 0.0110, rib: 0, taper: 1 },
  { id: 'afro',  front: 1.778, temple: 1.744, side: 1.720, back: 1.704, th: 0.0280, rib: 0.15, ribs: 9, curl: 1, seg: 36 },
  { id: 'locs',  front: 1.776, temple: 1.740, side: 1.706, back: 1.664, th: 0.0190, rib: 0.32, ribs: 9, seg: 36 },
  { id: 'long',  front: 1.780, temple: 1.732, side: 1.688, back: 1.646, th: 0.0150, rib: 0.06 }
];
for (const st of HAIR_STYLES) {
  const Rg = R('hair_' + st.id, 'hair');
  /* A hairline is FLAT across the forehead and then drops at the temples. A
     straight ramp from the centre gives a widow's peak on everybody, which is
     what the first cut of this looked like. */
  const lowOf = d => ramp([
    [0.00, st.front], [0.085, st.front], [0.16, lerp(st.front, st.temple, 0.55)],
    [0.25, st.temple], [0.35, st.side], [0.44, st.back], [0.50, st.back]], d);
  /* The hair shell is offset from the SKULL, and the ear stands up to 12 mm
     proud of it — so any hairline crossing the ear band has the ear poking
     straight through the hair. Real short cuts go around the ear rather than
     over it, so the hairline is lifted clear of it, which is both the fix and
     the correct shape.

     Plus a few millimetres of wander, because a hairline that is exactly the
     curve above is a swimming cap. Kept to low frequencies: at 24 columns
     anything faster than about 5 cycles reads as a zigzag, not as hair. */
  const earGuard = d => 1.761 - (1 - fall(Math.abs(d - 0.25) / 0.135)) * 0.16;
  const lowWander = frac => {
    const d = fromFront(frac);
    return Math.max(lowOf(d), earGuard(d))
      + 0.0022 * Math.cos(frac * TAU * 5) - 0.0014 * Math.cos(frac * TAU * 3);
  };
  hairShell(Rg, {
    seg: st.seg || SEG_HEAD, rows: st.rib ? 12 : 9,
    low: lowWander,
    /* s = 0 at the hairline, 1 at the crown. Ramping in over the first
       quarter is what turns a rim into a hairline; `taper` holds a fade short
       at the bottom all the way up its own boundary. */
    thick: (d, s, frac) => {
      let t = st.th * (0.10 + 0.90 * clamp01(s / 0.28));
      if (st.taper) t *= 0.30 + 0.70 * clamp01((s - 0.10) / 0.55);
      /* Ribbing needs columns to resolve it: at 24 the old 10-cycle ripple
         had 2.4 columns per rib and simply aliased away, which is why locs
         rendered as a smooth cap. Ribbed styles get a finer shell instead. */
      if (st.rib) t *= 1 + st.rib * Math.cos(frac * TAU * st.ribs) * (st.curl ? Math.cos(s * Math.PI * 3) : 1);
      return t;
    }
  });
}

/* A beard is more than one patch. Drawn as a single lens from the jaw to the
   nose it swallows the mouth and reads as a muzzle, so the chin and the
   moustache are separate shapes with the lip left bare between them — which
   is what both of these actually look like. */
const BEARDS = [
  { id: 'goatee', patches: [
    { half: 0.058, th: 0.011,                                  // chin
      low: d => ramp([[0.00, 1.618], [0.058, 1.646]], d),
      high: d => ramp([[0.00, 1.666], [0.058, 1.660]], d) },
    { half: 0.050, th: 0.009,                                  // moustache
      low: d => ramp([[0.00, 1.679], [0.050, 1.684]], d),
      high: d => ramp([[0.00, 1.697], [0.050, 1.694]], d) }
  ] },
  { id: 'full', patches: [
    { half: 0.170, th: 0.013,                                  // jaw + chin
      low: d => ramp([[0.00, 1.616], [0.08, 1.630], [0.13, 1.650], [0.170, 1.672]], d),
      high: d => ramp([[0.00, 1.668], [0.08, 1.690], [0.13, 1.714], [0.170, 1.740]], d) },
    { half: 0.062, th: 0.010,                                  // moustache
      low: d => ramp([[0.00, 1.678], [0.062, 1.686]], d),
      high: d => ramp([[0.00, 1.699], [0.062, 1.696]], d) }
  ] }
];
for (const bd of BEARDS) {
  const Rg = R('beard_' + bd.id, 'hair');
  for (const pt of bd.patches) {
    facePatch(Rg, { seg: SEG_HEAD, rows: 12, half: pt.half, thick: pt.th, low: pt.low, high: pt.high });
  }
}

/* ---- TRIM: headband, across the forehead on the hairline ---- */
loft(R('band', 'trim'), [
  ringY(1.770, hrx(1.770) + 0.0045, hrz(1.770) + 0.0045, w1('Head'), 0, hcz(1.770), hp(1.770)),
  ringY(1.784, hrx(1.784) + 0.0060, hrz(1.784) + 0.0060, w1('Head'), 0, hcz(1.784), hp(1.784)),
  ringY(1.797, hrx(1.797) + 0.0045, hrz(1.797) + 0.0045, w1('Head'), 0, hcz(1.797), hp(1.797))
], { seg: SEG_HEAD, phase: HEAD_PHASE });

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
    /* HAND. Was a long flat paddle running to y=0.800 — a blade on the end of
       the forearm, and unmistakable as one whenever an arm swung past the
       camera. A runner's hand is a loose fist: short, deep, with the knuckle
       line squared off and the thumb wrapped across the front. */
    [0.900, 0.0370, 0.0310], [0.884, 0.0408, 0.0355], [0.866, 0.0428, 0.0392],
    [0.846, 0.0430, 0.0398], [0.830, 0.0402, 0.0372], [0.818, 0.0330, 0.0300]
  ].map(([y, rx, rz]) => {
    /* Biceps forward, triceps behind, and the forearm's flexor bulk on the
       inboard-front third — an arm with a constant round section reads as a
       broom handle no matter how correct its taper is. */
    const bi = ramp([[1.140, 0], [1.230, 0.11], [1.300, 0.09], [1.350, 0.03]], y);
    const tri = ramp([[1.150, 0], [1.240, 0.09], [1.320, 0.10], [1.350, 0.05]], y);
    const fx = ramp([[0.930, 0], [1.020, 0.10], [1.090, 0.12], [1.150, 0.02]], y);
    const inb = side > 0 ? RIGHT : LEFT;           // toward the ribs
    const outb = side > 0 ? LEFT : RIGHT;
    // Thumb across the front of the fist, knuckles squared on the outboard face.
    const thumb = ramp([[0.900, 0], [0.878, 0.14], [0.852, 0.16], [0.830, 0.05], [0.818, 0]], y);
    const knuck = ramp([[0.888, 0], [0.866, 0.09], [0.842, 0.08], [0.822, 0]], y);
    return ringY(y, rx, rz, armW(y), cx, 0, y < 0.900 ? 0.72 : 1,
      mods([FRONT, 1.15, bi + fx * 0.7], [BACK, 1.15, tri], [inb, 1.05, fx * 0.6 + thumb],
        [outb, 0.95, knuck]));
  });
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
    [0.634, 0.0955, 0.0995], [0.660, 0.0988, 0.1028], [0.700, 0.1030, 0.1070],
    [0.760, 0.1072, 0.1112], [0.830, 0.1100, 0.1145], [0.905, 0.1110, 0.1160]
  ].map(([y, rx, rz]) => ringY(y, rx, rz, legW(y), cx, 0, 0.92,
    // The hem used to flare wider than the thigh inside it, so the leg read as
    // a skirt with a leg passing through. It now closes onto the quadriceps.
    mods([BACK, 1.20, ramp([[0.640, 0], [0.780, 0.030], [0.905, 0.045]], y)])));
  loft(shorts, rings, { seg: SEG_LIMB, capStart: true, capEnd: true });
}

/* ---- SKIN: thighs / knees between the shorts hem and the sock top ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.098;
  const kW = y => (y >= 0.580 ? w1('UpperLeg_' + S)
    : y >= 0.455 ? wmix('UpperLeg_' + S, 'LowerLeg_' + S, (0.580 - y) / 0.125)
      : w1('LowerLeg_' + S));
  const rings = [
    [0.420, 0.0620, 0.0640], [0.448, 0.0635, 0.0655], [0.470, 0.0655, 0.0675],
    [0.490, 0.0680, 0.0700], [0.510, 0.0705, 0.0730], [0.535, 0.0735, 0.0762],
    [0.560, 0.0770, 0.0800], [0.590, 0.0812, 0.0842], [0.620, 0.0855, 0.0885],
    [0.645, 0.0885, 0.0918], [0.665, 0.0905, 0.0940]
  ].map(([y, rx, rz]) => {
    const out = side > 0 ? LEFT : RIGHT;
    // Vastus lateralis sweeps to the outside, rectus femoris up the front,
    // the hamstring hangs behind, and the knee gets a patella rather than a
    // smooth waist between two cones.
    const quad = ramp([[0.560, 0], [0.620, 0.07], [0.665, 0.09]], y);
    const ham = ramp([[0.560, 0], [0.625, 0.06], [0.665, 0.07]], y);
    const cap = ramp([[0.440, 0], [0.478, 0.055], [0.512, 0.030], [0.545, 0]], y);
    return ringY(y, rx, rz, kW(y), cx, 0, undefined,
      mods([out, 1.10, quad], [FRONT, 1.00, quad * 0.8 + cap], [BACK, 1.05, ham]));
  });
  loft(skin, rings, { seg: SEG_LIMB, capStart: true, capEnd: true });
}

/* ---- SOCKS ---- */
for (const side of [1, -1]) {
  const S = side > 0 ? 'L' : 'R', cx = side * 0.098;
  const sW = y => (y <= 0.120 ? wmix('LowerLeg_' + S, 'Foot_' + S, (0.120 - y) / 0.060 * 0.5) : w1('LowerLeg_' + S));
  const rings = [
    [0.098, 0.0420, 0.0420], [0.135, 0.0468, 0.0474], [0.170, 0.0520, 0.0530],
    [0.215, 0.0588, 0.0602], [0.260, 0.0645, 0.0665], [0.295, 0.0656, 0.0678],
    [0.330, 0.0660, 0.0685], [0.385, 0.0652, 0.0675], [0.440, 0.0645, 0.0665]
  ].map(([y, rx, rz]) => {
    // Gastrocnemius: the calf belly sits high and BEHIND, and the shin in
    // front of it is nearly flat bone. A round sock has neither.
    const calf = ramp([[0.140, 0], [0.250, 0.10], [0.320, 0.07], [0.400, 0]], y);
    return ringY(y, rx, rz, sW(y), cx, 0, undefined,
      mods([BACK, 1.25, calf], [FRONT, 0.85, -calf * 0.30]));
  });
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
/* Narrower and set higher: at 66mm deep this read as a powerlifting belt
   rather than the webbing strap a flag belt actually is. */
loft(belt, [
  ringY(1.000, 0.1930, 0.1338, w1('Hips'), 0, 0, 0.86),
  ringY(1.022, 0.1893, 0.1307, w1('Hips'), 0, 0, 0.86),
  ringY(1.040, 0.1836, 0.1268, w1('Hips'), 0, 0, 0.86)
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

/* =============================================== 4. NORMALS (accumulated)
   Accumulated PER POSITION, not per vertex index. Two vertices can sit at the
   same point and still be separate — the duplicated UV seam column is exactly
   that, and so is the ring the head and the neck share. Accumulating per index
   gives each of them only the faces on its own side of the split, and the
   normals disagree: the back of the head came out with a hard vertical crease
   straight down the middle, lit as though the skull were folded.             */
function computeNormals(r) {
  const N = new Float32Array(r.P.length);
  for (let i = 0; i < r.I.length; i += 3) {
    const a = r.I[i] * 3, b = r.I[i + 1] * 3, c = r.I[i + 2] * 3;
    const e1 = [r.P[b] - r.P[a], r.P[b + 1] - r.P[a + 1], r.P[b + 2] - r.P[a + 2]];
    const e2 = [r.P[c] - r.P[a], r.P[c + 1] - r.P[a + 1], r.P[c + 2] - r.P[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    for (const o of [a, b, c]) { N[o] += n[0]; N[o + 1] += n[1]; N[o + 2] += n[2]; }
  }
  return N;
}

/* Weld across EVERY region at once (0.1 mm buckets), then normalise. Across,
   because the head and the neck deliberately share a ring over a material
   boundary — a per-region pass cannot see that pair and the seam creases. */
function normalsFor(regions) {
  const raw = new Map();
  for (const r of regions) raw.set(r, computeNormals(r));
  const bucket = new Map();
  for (const r of regions) {
    const N = raw.get(r);
    for (let v = 0; v < r.P.length / 3; v++) {
      if (r.H[v]) continue;                        // cap rim: keep it hard
      const o = v * 3;
      const k = Math.round(r.P[o] * 1e4) + ',' + Math.round(r.P[o + 1] * 1e4) + ',' + Math.round(r.P[o + 2] * 1e4);
      const list = bucket.get(k);
      if (list) list.push([N, o]); else bucket.set(k, [[N, o]]);
    }
  }
  for (const list of bucket.values()) {
    if (list.length < 2) continue;
    let sx = 0, sy = 0, sz = 0;
    for (const [N, o] of list) { sx += N[o]; sy += N[o + 1]; sz += N[o + 2]; }
    for (const [N, o] of list) { N[o] = sx; N[o + 1] = sy; N[o + 2] = sz; }
  }
  for (const r of regions) {
    const N = raw.get(r);
    for (let i = 0; i < N.length; i += 3) {
      const L = Math.hypot(N[i], N[i + 1], N[i + 2]);
      if (L > 1e-9) { N[i] /= L; N[i + 1] /= L; N[i + 2] /= L; }
      else { N[i] = 0; N[i + 1] = 1; N[i + 2] = 0; }
    }
  }
  return raw;
}

/* ============================================ 4b. BAKED AMBIENT OCCLUSION

   The single biggest reason a low-poly figure reads as injection-moulded
   plastic is that it has no shading relief. There is no texture set here and
   there is not going to be one — it would need authored binary assets and an
   asset pipeline, and the whole point of this generator is that the character
   is a text file. So the occlusion is baked per-VERTEX into COLOR_0, which
   glTF multiplies into the base colour and THREE honours automatically
   (GLTFLoader turns on material.vertexColors when the attribute is present).
   Costs 3 bytes a vertex, no textures, no extra draw calls, and it survives
   per-instance team tinting because tinting multiplies too.

   Rays are short on purpose. A long ray would bake the whole torso into the
   inner arm, and then the arm would carry that shadow around with it when it
   swings clear during a stride — baked AO cannot know the pose. At 0.22m only
   genuine creases contribute: under the jaw, the armpit, the inside of the
   knee, the eye sockets, beneath the jersey hem and the shorts.               */
const AO = {
  RAYS: 48,
  MAX_DIST: 0.22,                    // metres — creases only, not whole limbs
  FLOOR: 0.42,                       // darkest a vertex may get
  STRENGTH: 1.00,
  BIAS: 0.004,                       // lift the origin off the surface
  PROXY_GAIN: 1.35,                  // broad-scale (volume vs volume) weight
  PROXY_FALLOFF: 0.55,               // metres — how far bulk keeps shading bulk
  NEAR_MIX: 0.55                     // crease term vs broad term
};

/* Uniformly distributed hemisphere directions about +Z, cosine-weighted so the
   sample density matches the diffuse response we are approximating. */
const AO_DIRS = (() => {
  const d = [], GOLD = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < AO.RAYS; i++) {
    const t = (i + 0.5) / AO.RAYS;
    const r = Math.sqrt(t), z = Math.sqrt(Math.max(0, 1 - t));   // cosine hemisphere
    const a = i * GOLD;
    d.push([r * Math.cos(a), r * Math.sin(a), z]);
  }
  return d;
})();

function bakeAO(regions, occluders) {
  /* One triangle soup for the whole figure: the jersey has to be able to
     shadow the arm, and the head the neck, so occlusion cannot be per-region. */
  const T = [];                                    // [ax,ay,az, e1..., e2..., cx,cy,cz, radius]
  for (const r of (occluders || regions)) {
    for (let i = 0; i < r.I.length; i += 3) {
      const a = r.I[i] * 3, b = r.I[i + 1] * 3, c = r.I[i + 2] * 3;
      const A = [r.P[a], r.P[a + 1], r.P[a + 2]];
      const B = [r.P[b], r.P[b + 1], r.P[b + 2]];
      const C = [r.P[c], r.P[c + 1], r.P[c + 2]];
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const ctr = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
      const rad = Math.max(
        Math.hypot(A[0] - ctr[0], A[1] - ctr[1], A[2] - ctr[2]),
        Math.hypot(B[0] - ctr[0], B[1] - ctr[1], B[2] - ctr[2]),
        Math.hypot(C[0] - ctr[0], C[1] - ctr[1], C[2] - ctr[2]));
      T.push({ A, e1, e2, ctr, rad });
    }
  }

  /* A uniform grid over the figure. Without it this is 2.4k vertices x 48 rays
     x 3.5k triangles and takes minutes; the rays are only 0.22m long, so all
     that is ever needed is the handful of triangles near the vertex. */
  const CELL = AO.MAX_DIST;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of T) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], t.ctr[k] - t.rad);
    hi[k] = Math.max(hi[k], t.ctr[k] + t.rad);
  }
  const dim = [0, 1, 2].map(k => Math.max(1, Math.ceil((hi[k] - lo[k]) / CELL) + 1));
  const grid = new Map();
  const key = (i, j, k) => (i * dim[1] + j) * dim[2] + k;
  const cellOf = (p, k) => Math.max(0, Math.min(dim[k] - 1, Math.floor((p - lo[k]) / CELL)));
  T.forEach((t, ti) => {
    // Insert into every cell the triangle's bounding sphere touches.
    const c0 = [0, 1, 2].map(k => cellOf(t.ctr[k] - t.rad, k));
    const c1 = [0, 1, 2].map(k => cellOf(t.ctr[k] + t.rad, k));
    for (let i = c0[0]; i <= c1[0]; i++)
      for (let j = c0[1]; j <= c1[1]; j++)
        for (let k = c0[2]; k <= c1[2]; k++) {
          const kk = key(i, j, k);
          let b = grid.get(kk); if (!b) grid.set(kk, b = []);
          b.push(ti);
        }
  });

  /* Every triangle reachable from a point by a MAX_DIST ray lives in the 3x3x3
     cell block around it, because the cell size IS the ray length. */
  function candidates(p) {
    const c = [0, 1, 2].map(k => cellOf(p[k], k));
    const seen = new Set();
    for (let i = Math.max(0, c[0] - 1); i <= Math.min(dim[0] - 1, c[0] + 1); i++)
      for (let j = Math.max(0, c[1] - 1); j <= Math.min(dim[1] - 1, c[1] + 1); j++)
        for (let k = Math.max(0, c[2] - 1); k <= Math.min(dim[2] - 1, c[2] + 1); k++) {
          const b = grid.get(key(i, j, k));
          if (b) for (const ti of b) seen.add(ti);
        }
    return seen;
  }

  /* Möller–Trumbore, single-sided ignored: an unclosed shell (the sleeve, the
     flag) must occlude from both faces or it casts nothing. */
  function hits(o, d, list) {
    for (const ti of list) {
      const t = T[ti];
      const px = d[1] * t.e2[2] - d[2] * t.e2[1];
      const py = d[2] * t.e2[0] - d[0] * t.e2[2];
      const pz = d[0] * t.e2[1] - d[1] * t.e2[0];
      const det = t.e1[0] * px + t.e1[1] * py + t.e1[2] * pz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const sx = o[0] - t.A[0], sy = o[1] - t.A[1], sz = o[2] - t.A[2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * t.e1[2] - sz * t.e1[1];
      const qy = sz * t.e1[0] - sx * t.e1[2];
      const qz = sx * t.e1[1] - sy * t.e1[0];
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const dist = (t.e2[0] * qx + t.e2[1] * qy + t.e2[2] * qz) * inv;
      if (dist > AO.BIAS && dist < AO.MAX_DIST) return true;
    }
    return false;
  }

  /* ---- broad-scale occlusion, from a volumetric proxy ------------------
     The ray pass above only reaches 0.22m, and the figure is convex almost
     everywhere, so on its own it finds almost nothing — which is the real
     diagnosis, not a bug: you cannot bake occlusion into a shape that has no
     concavity. What a body actually has at the large scale is bulk blocking
     bulk: the torso shades the inside of the arm, each thigh shades the other,
     the jaw shades the throat. That is a volume relationship, so it is
     computed against a coarse set of spheres standing in for the body's
     volumes rather than against the triangles. Analytic solid angle, no rays:
     smooth by construction, where a sparse ray bake against a faceted low-poly
     surface would band.                                                      */
  const PROXY = [];
  const blob = (p, r) => PROXY.push({ p, r });
  const strand = (a, b, ra, rb, n) => {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      blob([lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)], lerp(ra, rb, t));
    }
  };
  strand([0, 0.90, 0], [0, 1.46, 0], 0.150, 0.185, 5);          // torso
  blob([0, 1.55, 0.005], 0.075);                                 // neck
  blob([0, 1.735, 0.008], 0.105);                                // head
  for (const s of [1, -1]) {
    strand([s * 0.200, 1.40, 0], [s * 0.200, 1.17, 0], 0.072, 0.056, 3);   // upper arm
    strand([s * 0.200, 1.16, 0], [s * 0.200, 0.90, 0], 0.056, 0.040, 3);   // forearm
    strand([s * 0.098, 0.95, 0], [s * 0.098, 0.50, 0], 0.115, 0.070, 4);   // thigh
    strand([s * 0.098, 0.49, 0], [s * 0.098, 0.09, 0], 0.070, 0.048, 3);   // shin
  }

  function proxyOcclusion(p, n) {
    let occ = 0;
    for (const b of PROXY) {
      const dx = b.p[0] - p[0], dy = b.p[1] - p[1], dz = b.p[2] - p[2];
      const d = Math.hypot(dx, dy, dz);
      // A vertex sitting on (or inside) a volume is not shadowed by it.
      if (d <= b.r + 0.015) continue;
      const c = (dx * n[0] + dy * n[1] + dz * n[2]) / d;         // cos to the blob
      if (c <= 0) continue;                                       // behind the surface
      const sinT = Math.min(1, b.r / d);
      const solid = 1 - Math.sqrt(Math.max(0, 1 - sinT * sinT));  // (1-cos) of the cone
      occ += solid * c * Math.exp(-d / AO.PROXY_FALLOFF);
    }
    return Math.min(1, occ * AO.PROXY_GAIN);
  }

  let darkest = 1;
  for (const r of regions) {
    if (!r.I.length) continue;
    const N = r.N;                                  // normals, computed already
    /* VEC4, not VEC3: a vertex attribute bufferView must have a stride that
       is a multiple of 4, and three bytes a vertex is not. Alpha is unused. */
    const out = new Uint8Array((r.P.length / 3) * 4);
    for (let vi = 0; vi < r.P.length / 3; vi++) {
      const p = [r.P[vi * 3], r.P[vi * 3 + 1], r.P[vi * 3 + 2]];
      const n = [N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]];
      // Orthonormal basis with +Z along the normal, so AO_DIRS lands on the
      // correct hemisphere.
      const up = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let tx = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]];
      const tl = Math.hypot(tx[0], tx[1], tx[2]) || 1;
      tx = [tx[0] / tl, tx[1] / tl, tx[2] / tl];
      const ty = [n[1] * tx[2] - n[2] * tx[1], n[2] * tx[0] - n[0] * tx[2], n[0] * tx[1] - n[1] * tx[0]];
      const o = [p[0] + n[0] * AO.BIAS, p[1] + n[1] * AO.BIAS, p[2] + n[2] * AO.BIAS];
      const list = candidates(o);
      let open = 0;
      for (const s of AO_DIRS) {
        const d = [
          tx[0] * s[0] + ty[0] * s[1] + n[0] * s[2],
          tx[1] * s[0] + ty[1] * s[1] + n[1] * s[2],
          tx[2] * s[0] + ty[2] * s[1] + n[2] * s[2]
        ];
        if (!hits(o, d, list)) open++;
      }
      /* Two scales, combined multiplicatively: creases from the real mesh,
         bulk from the proxy. Multiplying rather than averaging means a crease
         that also sits deep inside the body's shadow gets both. */
      const near = Math.pow(open / AO.RAYS, AO.STRENGTH);
      const far = 1 - proxyOcclusion(p, n);
      const lit = Math.pow(near, AO.NEAR_MIX) * Math.pow(far, 1 - AO.NEAR_MIX);
      const ao = AO.FLOOR + (1 - AO.FLOOR) * lit;
      if (ao < darkest) darkest = ao;
      const b = Math.round(Math.max(0, Math.min(1, ao)) * 255);
      out[vi * 4] = b; out[vi * 4 + 1] = b; out[vi * 4 + 2] = b; out[vi * 4 + 3] = 255;
    }
    r.AO = out;
  }
  return darkest;
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

/* --- And the ankle that puts that foot FLAT, solved the same way -----------
   Two legs at the same knee flexion have their ankles at exactly the same
   height whatever the fore/aft stagger, because the hip-ankle distance is fixed
   by the knee alone and only z^2 enters. Their SOLES are another matter: the
   back shank is raked and the front one is not, so feeding both the same ankle
   angle rakes the back foot toe-down and leaves the front one four centimetres
   in the air — groundedHips hangs the pelvis off the lowest point it can find,
   reports a contented zero, and the man stands on one toe.

   Nothing caught that for the life of the file, because every ground check ever
   written here asks whether a foot went THROUGH the turf. So the ankle becomes
   what it is on a real stance — the joint that accommodates — and a leg written
   [z, knee] with no third number means "this foot is on the ground", with the
   angle solved rather than guessed. f = t - k + ankle = 0, so:                */
const flatAnkle = (z, kneeDeg) => kneeDeg - plantHip(z, kneeDeg);
// One leg of a posed row: [z, knee, ankle?, toe?], ankle solved when omitted.
const legOf = L => [plantHip(L[0], L[1]), L[1], L[2] == null ? flatAnkle(L[0], L[1]) : L[2], L[3] || 0];

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

/* A leg swung out to the SIDE is shorter straight down than it is long.
   soleHeight is a sagittal solve — everything it computes has x = 0 — so a hip
   abduction of theta is a rotation of that whole chain about the leg's own Z,
   which sends a point at (0, y, z) to (-y*sin, y*cos, z). The height therefore
   scales exactly about the hip joint, with no approximation:
       y' = HIP_Y + (y - HIP_Y) * cos(theta)
   Which is the only reason abduction can be authored per-key at all: without
   it the solver would keep planting a foot that is no longer under the player,
   and drop the pelvis 60mm to do it. */
const abducted = (h, a) => (a ? HIP_Y + (h - HIP_Y) * Math.cos(a) : h);

function groundedHips(times, legL, legR, lift, roll, abd, step = 0.02) {
  const lerpLeg = (A, B, u) => A.map((v, i) => v + (B[i] - v) * u);
  const up = k => (lift ? lift[k] : 0);
  const rz = k => (roll ? roll[k] : 0);
  const ab = k => (abd ? abd[k] : [0, 0]);
  // Lowest sole of either leg with the pelvis tilted by `th`, whose two hip
  // joints therefore sit +/- HIP_HALF*sin(th) either side of the pelvis.
  const low = (L, R, th, aL, aR) => {
    const dy = HIP_HALF * Math.sin(th);            // + raises the LEFT hip joint
    return Math.min(abducted(soleHeight(...L), aL) + dy,
                    abducted(soleHeight(...R), aR) - dy);
  };
  const T = [], Y = [];
  for (let k = 0; k < times.length - 1; k++) {
    const span = times[k + 1] - times[k];
    const n = Math.max(1, Math.round(span / step));
    const a0 = ab(k), a1 = ab(k + 1);
    for (let i = 0; i < n; i++) {
      const u = i / n;
      T.push(times[k] + span * u);
      Y.push(1.000 - low(lerpLeg(legL[k], legL[k + 1], u), lerpLeg(legR[k], legR[k + 1], u),
        rz(k) + (rz(k + 1) - rz(k)) * u,
        a0[0] + (a1[0] - a0[0]) * u, a0[1] + (a1[1] - a0[1]) * u)
        + up(k) + (up(k + 1) - up(k)) * u);
    }
  }
  const last = times.length - 1;
  T.push(times[last]);
  Y.push(1.000 - low(legL[legL.length - 1], legR[legR.length - 1], rz(last),
    ab(last)[0], ab(last)[1]) + up(last));
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
  const extras = gaitMetrics(dur, legAt, rise, name);
  CLIPS.push({ name, duration: dur, tracks, extras: extras });
  // Kept so blendMetrics() can build the pose HALFWAY between two gaits and
  // measure it the same way this measured them.
  GAIT_SOLVE[name] = { dur: dur, legAt: legAt, rise: rise, extras: extras };
}
const GAIT_SOLVE = {};

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
function gaitMetrics(dur, legAt, riseAt, label) {
  const dt = dur / STEPS;
  /* Within 4mm of the turf — or of the closest this cycle ever gets to it, if
     that is worse. An authored gait is solved onto the ground and the two are
     the same number; a BLENDED one (see blendMetrics) is not solved at all, so
     its lowest sole can hover a centimetre up for the whole cycle, and a fixed
     4mm would then find no stance phase and report a ground speed of zero. */
  let floor = Infinity;
  for (let i = 0; i < STEPS; i++) {
    for (const right of [false, true]) {
      const p = solePoints(...legAt(i, right));
      let k = 0;
      for (let m = 1; m < 3; m++) if (p[m].y < p[k].y) k = m;
      floor = Math.min(floor, p[k].y + riseAt(i, right));
    }
  }
  const ON = 0.004 + Math.max(0, floor);
  let sum = 0, n = 0, stanceL = 0, anyDown = 0;
  const rates = [];
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
      const v = -(nxt[k].z - now[k].z) / dt;       // ground travels backward under it
      sum += v; rates.push({ v, at: i / STEPS, k, right });
      n++;
    }
    anyDown += down;
  }
  /* HOW EVENLY THE STANCE SWEEPS, not just how far.

     `groundSpeed` is a mean, and a mean is exactly the wrong summary if the
     support foot does not travel at a constant rate: a stance that sweeps
     slowly for most of its length and then whips through toe-off averages out
     to the right number while sliding forward under the player for the part of
     it the eye is actually watching. That is a micro-skate, it is invisible in
     any still frame, and the mean cannot see it.

     So report the middle of the distribution as well. `steady` is the median
     sweep and `even` is the interquartile spread as a fraction of the mean; a
     clip whose stance is honest has steady within a few percent of groundSpeed
     and `even` well under 0.3. Anything worse means the stance rows need
     re-spacing, not the divisor changing. */
  const sorted = rates.map(r => r.v).sort((a, b) => a - b);
  const at = q => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const mean = n ? sum / n : 0;
  /* GAIT_DEBUG=1 prints the whole series rather than its summary, which is the
     only way to see WHERE a stance is uneven — and therefore which authored row
     to move. The contact point is named: h(eel), b(all), t(ip). */
  if (process.env.GAIT_DEBUG && label) {
    console.log('    ' + label.padEnd(10) + ' sweep  ' + rates.filter(r => !r.right)
      .map(r => `${(r.at * 100).toFixed(0)}%:${r.v.toFixed(1)}${'hbt'[r.k]}`).join(' '));
  }
  return {
    gait: 1,
    groundSpeed: mean,              // metres/sec at the model's authored scale
    steady: at(0.5),                // the median of the same measurement
    even: mean ? (at(0.75) - at(0.25)) / mean : 0,
    stance: stanceL / STEPS,        // fraction of the cycle one given foot is down
    flight: 1 - anyDown / STEPS,    // fraction with neither foot down
    cycle: dur
  };
}

/* ------------------------------------------------------------------ Idle

   A FOOTBALL PLAYER WAITING FOR A SNAP IS NOT STANDING STILL, and this clip
   used to have him doing exactly that: 16 degrees of hip, 28 of knee and the
   arms 6 degrees off vertical with the elbows barely folded. Rendered, that is
   a man standing to attention with his hands by his pockets — feet together,
   legs locked, arms hanging down the sides — and with ten of them in a
   formation holding it, the pre-snap read as a row of stalks rather than as a
   team about to play.

   What replaces it is the stance the sport is actually played from: feet
   roughly shoulder width, knees loaded past 40 degrees, chest out over them,
   and the hands UP — off the ribs, in front of the body, elbows near a right
   angle, where a pair of hands has to be if it is going to catch anything or
   rip a flag off anybody.

   The stagger is deliberate and small. A stance square to the world is a
   diagram; every athlete waiting on a whistle has one foot a little behind the
   other, and 5 degrees of difference between the legs is enough to read as
   weight on one side without looking like a lunge.                          */
const IDLE_L = [28, 42, 19];                    // hip, knee, ankle — trail leg
const IDLE_R = [33, 45, 21];                    // lead leg, a touch deeper
const IDLE_STAND = standHipY(IDLE_L, IDLE_R);
const IDLE_SPREAD = 0.13;                       // hip abduction -> feet apart
/* ------------------------------------------------------------------ Idle
   THE POSE THE GAME IS SEEN IN MOST. Between plays, in the huddle, waiting on
   the snap — the clock spends more time here than in any gait, and the old
   version of this clip said so itself: "the breathing is the only motion in
   here, and it is 12mm of it". Twelve millimetres over 2.4 seconds is a
   photograph, and ten of them standing in a photograph is what a video game
   looked like in 1998.

   Standing still is not motionless. A person waiting shifts their weight from
   one leg to the other and back, and everything else answers it: the loaded
   knee straightens while the free one softens, the pelvis lists toward the
   free side and drops on it, the shoulders counter, and the head moves on its
   own clock rather than in time with the hips.

   The pelvis height is re-solved at every key from the leg angles actually in
   force there (standHipY), which is what stops the feet sinking or floating as
   the weight moves — the reason the old clip could not shift weight is that
   its hips track was a single hand-entered constant.

   6.4 seconds, and the head sub-cycle deliberately does not divide into it, so
   the loop does not announce itself. */
{
  const D_IDLE = 6.4;
  //  w = -1 fully on the LEFT leg, +1 fully on the RIGHT.
  const KP = [0, 0.14, 0.30, 0.46, 0.58, 0.74, 0.88, 1];
  const W  = [0, -0.55, -1.00, -0.62, 0.30, 1.00, 0.45, 0];
  const T = KP.map(p => p * D_IDLE);
  // Loaded leg straightens (less knee), free leg softens.
  const legFor = (base, load) => [base[0] - load * 4, base[1] - load * 7, base[2] - load * 3];
  const legL = W.map(w => legFor(IDLE_L, -w));      // w<0 loads the left
  const legR = W.map(w => legFor(IDLE_R, w));
  const breath = u => 0.010 * Math.sin(2 * Math.PI * u * 3.5);

  clip('Idle', D_IDLE, [
    hipY(T, W.map((w, i) => standHipY(legL[i], legR[i]) - 0.004 * Math.abs(w) + breath(KP[i]))),
    // Pelvis lists toward the unloaded side and swings a little with it.
    rot('Hips',  T, W.map(w => [0, w * 0.045, w * 0.060])),
    rot('Spine', T, W.map((w, i) => [0.26 + breath(KP[i]) * 0.9, -w * 0.030, -w * 0.032])),
    rot('Chest', T, W.map((w, i) => [0.10 - breath(KP[i]) * 1.4, -w * 0.045, -w * 0.022])),
    /* The head runs on its own clock. It is the single strongest signal that
       there is somebody in there, and tying it to the hips would make the
       whole body one metronome. In play the renderer layers a look-at over
       this and the two simply add. */
    rot('Head', T, KP.map(p => {
      const a = 2 * Math.PI * p * 1.75;
      return [-0.30 + 0.020 * Math.sin(a * 0.6), 0.16 * Math.sin(a), 0.02 * Math.sin(a * 0.5)];
    })),
    rot('UpperArm_L', T, W.map(w => [shoulder(-2 - w * 3), 0, 0.26 - w * 0.03])),
    rot('LowerArm_L', T, W.map(w => [elbow(66 + w * 6), -0.28, 0.06])),
    rot('UpperArm_R', T, W.map(w => [shoulder(-2 + w * 3), 0, -0.26 - w * 0.03])),
    rot('LowerArm_R', T, W.map(w => [elbow(66 - w * 6), 0.28, -0.06])),
    rot('UpperLeg_L', T, legL.map(l => [hip(l[0]), 0, IDLE_SPREAD])),
    rot('LowerLeg_L', T, legL.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_L',     T, legL.map(l => [ankle(l[2]), 0, 0])),
    rot('UpperLeg_R', T, legR.map(l => [hip(l[0]), 0, -IDLE_SPREAD])),
    rot('LowerLeg_R', T, legR.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_R',     T, legR.map(l => [ankle(l[2]), 0, 0])),
    rot('Flag_L', T, W.map(w => [0.02 - w * 0.035, 0, 0.04 + w * 0.02])),
    rot('Flag_R', T, W.map(w => [-0.02 + w * 0.035, 0, -0.02 - w * 0.02]))
  ]);
}

/* ================== THE GAIT LADDER: WALK, JOG, RUN, SPRINT ===============

   FOUR CLIPS RATHER THAN TWO, BECAUSE A CLIP CAN ONLY BE PLAYED FASTER.

   A single run cycle scaled by playback rate changes CADENCE and nothing else:
   the stride stays exactly as long as it was authored, so a player at 8yd/s
   takes the same 1.9m steps as one at 5.8yd/s, 40% more often. Real running
   does not work like that. Speed is stride length times stride frequency and
   both of them rise — over the range this game covers, roughly two thirds of
   the extra speed comes from a longer stride and one third from a faster
   turnover. Getting that from playback rate alone gives a sprinter with the
   twinkling feet of a cartoon and a jogger who wades.

   So the ladder covers the range with four authored strides:

       Walk    1.8 m/s   120 steps/min   0.9m steps    heel strike, no flight
       Jog     3.5 m/s   167 steps/min   1.2m steps    midfoot, a little flight
       Run     6.1 m/s   194 steps/min   1.9m steps    the old clip
       Sprint  8.5 m/s   250 steps/min   2.0m steps    forefoot, front-side

   and the renderer blends the two that bracket a player's actual speed
   (flagster/js/playermodel.js, api.gait). Because the blend weight is chosen so
   that the pair's own natural speeds interpolate TO the player's speed, both
   the stride length and the cadence come out at the authored values for that
   speed, and the playback rate stays near 1.0 everywhere in the range instead
   of being stretched to 2.4x at the top.

   Blending only works if the clips agree about where the cycle starts. All four
   put the LEFT FOOT'S CONTACT AT PHASE 0 and the right foot's half a cycle
   later, so a blend never has one clip landing while the other is airborne.
   `node tools/measure-clip.mjs <clip>` prints both contact phases; keep them at
   0% and 50%.                                                               */

/* ------------------------------------------------------------------- Jog */
/* Between a walk and a run, and NOT a slow version of either. It has a flight
   phase, so it is a run; the flight is a tenth of the cycle rather than a
   third, the knee never drives above the horizontal, and the heel recovers to
   about half the height the run's does. The foot lands nearly flat and close
   under the hips, which is the thing that separates a jog from a run at a
   glance: no reach out in front. */
cyclicGait('Jog', 0.72, {
  leg: [
    //  phase  hip  knee  ankle  toe
    [0.00, 26, 12, 0, 4],      // contact, midfoot, close under the hips
    [0.08, 18, 26, 4, 1],      // loading
    [0.16, 7, 32, 10, 0],      // mid-stance
    [0.26, -11, 22, 4, 10],    // the heel comes up
    [0.38, -32, 10, -22, 40],  // toe-off over a flat forefoot
    [0.46, -14, 62, -8, 18],   // early flight, the knee folds
    [0.56, 6, 88, 6, 3],       // recovery — heel to mid-thigh, not to the glute
    [0.70, 40, 76, 12, 0],     // knee drive, thigh no higher than 40
    [0.84, 37, 44, 9, 0],
    [0.92, 34, 22, 3, 2],      // reach
    [1.00, 26, 12, 0, 4]
  ],
  arm: [
    [0.00, -27, 70, 9],        // left foot lands — left hand behind the hip
    [0.06, -25, 69, 9],
    [0.20, -6, 76, 9],
    [0.34, 12, 82, 8],
    [0.46, 20, 86, 8],         // shoulder furthest forward
    [0.54, 16, 90, 8],         // ...elbow peaks a beat later
    [0.68, 2, 82, 9],
    [0.84, -20, 73, 10],
    [0.95, -30, 70, 10],       // shoulder furthest back
    [1.00, -27, 70, 9]
  ],
  lift: 0.015, stanceEnd: 0.38,
  lean: 0.15, head: -0.09,
  yaw: 0.085, yawPhase: 0.25,
  obliq: 0.080, sway: 0.022, tilt: 0.058, splay: 0.02
});

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
    [0.06, 25, 30, 4, 2],      // 2. loading — the ankle collapses under the weight
    [0.13, 9, 39, 11, 0],      // 3. mid-stance — knee deepest, hips lowest
    [0.21, -16, 27, 3, 14],    // 4. the heel comes up, the MTP starts to extend
    [0.30, -38, 11, -30, 48],  // 5. toe-off — everything extends over a flat forefoot
    [0.38, -19, 79, -13, 22],  // 6. early flight, the trailing knee folds
    [0.48, 11, 123, 5, 4],     // 7. recovery — heel snaps up under the glute
    [0.62, 61, 96, 14, 0],     // 8. knee drive — hip flexors carry the knee through
    [0.78, 57, 55, 10, 0],
    [0.90, 50, 30, 2, 2],      // 9. reach — the shin unfolds toward the next contact
    [1.00, 34, 20, -4, 6]
  ],
  /* CONTRALATERAL, AND MEASURED TO BE.

     At the instant the left foot lands, the RIGHT hand is at the front of its
     swing and the LEFT hand is behind the hip. That is not a stylistic
     preference — it is what cancels the angular momentum the legs put into the
     trunk, and it is the most recognisable single fact about a running human.

     This table used to be a third of a cycle early, which is a mistake no
     individual frame shows: every pose in it was a good pose, the arms swung
     the right distance at the right rate, and they arrived at the wrong time.
     Measured, the left hand reached the back of its swing at 67% of the cycle
     when the left foot had landed at 0%. The result reads as a wind-up toy
     rather than a runner, and it survived several passes of authoring-by-eye
     because looking at it frame by frame is exactly how you miss it.

     `node tools/measure-clip.mjs Run` now reports that number — foot contact
     phase against rearmost-hand phase, per side. Keep it inside a few percent.

     Both extremes of the elbow are placed a beat AFTER the shoulder's: the
     forearm is dragged round by the upper arm and arrives late, and that lag is
     most of what separates an arm from a lever. Hand travels roughly
     sternum-to-hip-pocket. */
  arm: [
    //  phase  shoulder  elbow  abduct
    [0.00, -47, 67, 13],       // LEFT FOOT LANDS — left hand behind the hip
    [0.05, -43, 66, 13],       // ...elbow bottoms out a beat later
    [0.19, -8, 80, 11],
    [0.33, 20, 94, 9],
    [0.45, 30, 104, 8],        // shoulder furthest forward (right foot landing)
    [0.53, 24, 110, 8],        // ...elbow peaks a beat later
    [0.67, 2, 94, 10],
    [0.83, -34, 74, 13],
    [0.95, -52, 68, 14],       // shoulder furthest back
    [1.00, -47, 67, 13]
  ],
  lift: 0.030, stanceEnd: 0.30,
  lean: 0.22, head: -0.13,
  yaw: 0.10, yawPhase: 0.25,
  obliq: 0.075, sway: 0.016, tilt: 0.055, splay: 0.02
});

/* ---------------------------------------------------------------- Sprint */
/* FLAT OUT. The kinematic differences from the run are not a matter of degree —
   they are the specific things the sprint literature calls "front-side
   mechanics", and they are what makes a sprint read as a sprint:

     * the foot lands on the FOREFOOT, under the hips rather than ahead of them,
       with the ankle already plantarflexed and held stiff through the impact
       (contact ankle -12 rather than the run's -4, and it collapses 18 degrees
       instead of 15 across a stance half as long);
     * stance is a fifth of the cycle rather than a third, so the two flight
       phases together fill nearly 60% of it;
     * the recovery heel comes all the way to the glute — 140 degrees of knee
       flexion, the deepest fold of any clip here — because a folded leg is a
       short pendulum and swings through faster;
     * peak thigh flexion is 74 degrees, well above the horizontal, and peak
       extension behind the body is no greater than the run's. That asymmetry
       IS front-side mechanics: faster runners do not reach further back, they
       carry the knee further forward;
     * the arms swing hand-to-chin and hand-past-the-hip, roughly a third again
       the run's amplitude, with the elbow held tighter.

   Authored at 250 steps/min and ~2m steps, which is where a fast athlete is at
   this speed. Above it the renderer runs out of ladder and goes back to
   stretching playback rate, but the top of the game's speed range (9.2 yd/s)
   is inside this clip, so that only bites for a downhill kick-return dream. */
cyclicGait('Sprint', 0.48, {
  leg: [
    //  phase  hip  knee  ankle  toe
    [0.00, 22, 16, -12, 10],   // contact — forefoot, UNDER the hips, ankle stiff
    [0.05, 13, 26, -2, 4],     // loading — a fraction of the run's collapse
    [0.11, 1, 33, 6, 0],       // mid-stance
    [0.16, -17, 26, 0, 16],    // the heel comes up early
    [0.21, -34, 8, -32, 52],   // toe-off — full extension over a flat forefoot
    [0.30, -24, 92, -18, 26],  // the trailing knee folds hard
    [0.42, 4, 140, 2, 6],      // heel to the glute
    [0.60, 56, 122, 12, 0],
    [0.70, 74, 92, 14, 0],     // peak knee drive — front-side
    [0.84, 64, 48, 10, 0],
    [0.93, 46, 24, 0, 4],      // the shin unfolds and starts coming back down
    [1.00, 22, 16, -12, 10]
  ],
  arm: [
    [0.00, -60, 82, 12],       // left foot lands — left hand behind the hip
    [0.05, -55, 80, 12],
    [0.19, -18, 92, 10],
    [0.33, 22, 104, 8],
    [0.45, 42, 112, 7],        // shoulder furthest forward, hand to the chin
    [0.53, 34, 120, 7],        // ...elbow peaks a beat later
    [0.67, 8, 104, 9],
    [0.83, -42, 88, 12],
    [0.95, -66, 80, 13],       // shoulder furthest back, hand past the hip
    [1.00, -60, 82, 12]
  ],
  lift: 0.055, stanceEnd: 0.21,
  lean: 0.20, head: -0.15,
  yaw: 0.115, yawPhase: 0.25,
  obliq: 0.070, sway: 0.014, tilt: 0.060, splay: 0.02
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
    [0.00, 26.5, 3, 4, 0],     // heel strike — toes held up, knee almost straight
    [0.08, 23, 17, -7, 0],     // loading response — the forefoot slaps flat
    [0.20, 7, 17, -1, 0],      // the shin begins to roll forward over the foot
    [0.32, -9, 5, 9, 3],       // mid-stance — tallest point, leg nearly straight
    [0.46, -22, 7, 12, 24],    // terminal stance — heel off, MTP extending
    [0.58, -15, 36, -16, 48],  // toe-off — ankle plantarflexes over a flat forefoot
    [0.70, 6, 68, -2, 14],     // early swing — the knee folds
    [0.82, 24, 45, 10, 2],     // mid-swing — toes up to clear the turf
    [0.93, 31, 13, 6, 0],      // terminal swing — the shin reaches out
    [1.00, 26.5, 3, 4, 0]
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
cyclicGait('Backpedal', 0.58, {
  leg: [
    //  phase  hip  knee  ankle  toe
    [0.00, 34, 64, 12, 0],     // knee up in front, foot about to reach back
    [0.14, 16, 40, -4, 4],
    [0.26, -4, 24, -16, 8],    // the forefoot lands behind and drives the body back
    [0.40, -24, 24, -13, 8],
    [0.52, -44, 34, -4, 4],    // hip fully extended behind, the knee begins to fold
    [0.68, -20, 68, 8, 0],     // the knee folds and swings through under the hips
    [0.84, 12, 84, 14, 0],
    [1.00, 34, 64, 12, 0]
  ],
  /* Contralateral, same rule and same check as the run — this table was a
     quarter of a cycle early too. A backpedalling defender's arms are short and
     high (they are being kept out of the way of the hips, and they are ready to
     break on the ball), so the amplitude is small; the TIMING still has to be
     right or the whole thing paddles. */
  arm: [
    [0.00, -18, 62, 14],
    [0.24, 6, 74, 15],
    [0.48, 14, 86, 17],
    [0.74, -4, 72, 16],
    [1.00, -18, 62, 14]
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
    { t: 0.00, pel:  0, trk:   0, lean:  8, tilt:  0, L: [0.10, 30], R: [-0.10, 30], arm: [ 16,  20,  10,  55], off: [ 16,  20,  10,  55] },
    { t: 0.14, pel: -2, trk:  -4, lean: 22, tilt:  0, L: [0.10, 42], R: [-0.10, 42], arm: [ 48,  72,  20,  62], off: [ 44,  70,  16,  66] },
    { t: 0.28, pel: -3, trk:  -6, lean: 34, tilt:  0, L: [0.10, 50], R: [-0.10, 50], arm: [ 62,  80,  10,  22], off: [ 58,  78,   8,  28] },
    { t: 0.40, pel:  0, trk:   2, lean: 30, tilt: -2, L: [0.10, 46], R: [-0.10, 46], arm: [ 58,  62,  -6,  34], off: [ 52,  60,   0,  40] },
    { t: 0.55, pel:  8, trk:  16, lean: 12, tilt: -4, L: [0.10, 36], R: [-0.10, 36], arm: [118,   4, -30,  66], off: [ 30, -20, -20,  80] },
    { t: 0.72, pel:  5, trk:  10, lean:  2, tilt: -2, L: [0.10, 30], R: [-0.10, 30], arm: [150,  -6, -10,  42], off: [ 20,  -8,  -6,  62] },
    // Ends with the flag still held up, because what follows it is Celebrate,
    // whose arms are also up: dropping to a rest pose here would put a fast
    // arm-swing down and straight back up either side of the crossfade.
    { t: 0.90, pel:  0, trk:   0, lean:  5, tilt:  0, L: [0.10, 30], R: [-0.10, 30], arm: [146,  -2,  -6,  44], off: [ 18,   4,   4,  56] }
  ];
  const T = G.map(k => k.t);
  const legL = G.map(k => legOf(k.L));
  const legR = G.map(k => legOf(k.R));
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
          L, R  [z, knee, ankle, toe] — the foot's fore/aft POSITION in metres,
                its knee flexion, its ankle and its MTP; the hip angle is solved
                from them so a planted foot stays where it was put. OMIT the
                ankle and it is solved too, for a foot flat on the turf, which
                is what a stance wants and what a stagger cannot be given by
                hand (see flatAnkle)
          abd   optional [left, right] hip ABDUCTION in degrees, + = swung out
                to that side. The ground solve knows about it, so the leg that
                is out can never be the one the pelvis is hung from
          up    how far the whole body is off the turf, metres (a hop)
          arm   [elev, horiz, er, elbow] for the RIGHT arm, through armQ
          off   ditto for the LEFT
          look  optional [pitch, yaw] for the head, radians; NEGATIVE pitch is
                the chin coming UP, which is why the default counters lean     */
function posedClip(name, dur, rows, opts = {}) {
  const T = rows.map(k => k.t);
  // The toe goes into the LEG rather than only onto its own track: MTP
  // extension lifts the sole off the forefoot, and a solver that doesn't know
  // that hangs the pelvis from a toe tip which is no longer the lowest point.
  const legL = rows.map(k => legOf(k.L));
  const legR = rows.map(k => legOf(k.R));
  const lift = rows.map(k => k.up || 0);
  const sway = k => (k.sway || 0);
  const splay = opts.splay == null ? 0.03 : opts.splay;
  const abdL = k => ((k.abd ? k.abd[0] : 0) * D);
  const abdR = k => ((k.abd ? k.abd[1] : 0) * D);
  const hips = groundedHips(T, legL, legR, lift, rows.map(k => (k.roll || 0) * D),
    rows.map(k => [abdL(k), abdR(k)]));
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
    rot('UpperLeg_L', T, legL.map((l, i) => [hip(l[0]), 0, splay + abdL(rows[i])])),
    rot('LowerLeg_L', T, legL.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_L', T, legL.map(l => [ankle(l[2]), 0, 0])),
    rot('Toe_L', T, legL.map(l => [toe(l[3]), 0, 0])),
    rot('UpperLeg_R', T, legR.map((l, i) => [hip(l[0]), 0, -splay - abdR(rows[i])])),
    rot('LowerLeg_R', T, legR.map(l => [knee(l[1]), 0, 0])),
    rot('Foot_R', T, legR.map(l => [ankle(l[2]), 0, 0])),
    rot('Toe_R', T, legR.map(l => [toe(l[3]), 0, 0])),
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
  { t: 0.00, pel: 0, trk: 0, lean: 8, tilt: 0, L: [0.12, 30], R: [-0.12, 30], arm: [30, 30, 10, 70], off: [24, 24, 8, 62] },
  { t: 0.20, pel: 0, trk: 4, lean: -14, tilt: 0, L: [0.12, 16, -18], R: [-0.12, 16, -20], up: 0.02, arm: [162, 26, 40, 44], off: [140, 34, 30, 58] },
  // the ball is at the top and the body is stretched: heels off, back arched
  { t: 0.30, pel: 0, trk: 6, lean: -20, tilt: 0, L: [0.12, 12, -26], R: [-0.12, 12, -28], up: 0.04, arm: [172, 20, 46, 30], off: [148, 30, 26, 62] },
  // SLAM. Trunk folds, the arm whips through past the knee, the knees give.
  { t: 0.42, pel: 0, trk: -2, lean: 46, tilt: 0, L: [0.12, 54], R: [-0.12, 54], arm: [24, 8, -60, 16], off: [40, -10, -30, 40] },
  { t: 0.52, pel: 0, trk: -4, lean: 52, tilt: 0, L: [0.12, 62], R: [-0.12, 62], arm: [16, -14, -70, 22], off: [30, -22, -40, 46] },
  // up out of it, arms thrown wide, chest open, head back — the pose the crowd
  // shot is framed on.
  { t: 0.74, pel: 0, trk: 0, lean: -14, tilt: 0, L: [0.12, 26], R: [-0.12, 26], arm: [96, -34, 40, 26], off: [96, -34, 40, 26], look: [0.22, 0] },
  { t: 0.94, pel: 0, trk: 0, lean: -16, tilt: 0, L: [0.12, 22, -10], R: [-0.12, 22, -10], up: 0.03, arm: [118, -26, 50, 22], off: [118, -26, 50, 22], look: [0.26, 0] },
  { t: 1.15, pel: 0, trk: 0, lean: -8, tilt: 0, L: [0.12, 28], R: [-0.12, 28], arm: [128, -12, 46, 34], off: [128, -12, 46, 34], look: [0.14, 0] }
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
  { t: 0.000, pel: 0, trk: 0, lean: -6, tilt: 0, L: [0.16, 24], R: [-0.16, 24], arm: [82, 4, 88, 128], off: [82, 4, 88, 128], look: [0.06, 0] },
  { t: 0.325, pel: 6, trk: -6, lean: -10, tilt: -4, L: [0.16, 18], R: [-0.16, 30], arm: [88, -6, 94, 138], off: [78, 10, 82, 122], look: [0.10, -0.14] },
  { t: 0.650, pel: 0, trk: 0, lean: -6, tilt: 0, L: [0.16, 26], R: [-0.16, 26], arm: [80, 6, 86, 126], off: [80, 6, 86, 126], look: [0.06, 0] },
  { t: 0.975, pel: -6, trk: 6, lean: -10, tilt: 4, L: [0.16, 30], R: [-0.16, 18], arm: [78, 10, 82, 122], off: [88, -6, 94, 138], look: [0.10, 0.14] },
  { t: 1.300, pel: 0, trk: 0, lean: -6, tilt: 0, L: [0.16, 24], R: [-0.16, 24], arm: [82, 4, 88, 128], off: [82, 4, 88, 128], look: [0.06, 0] }
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

/* ================= FIVE MORE, AND WHY THESE FIVE ======================

   The first four (Spike, Dance, Flex, HighStep) were chosen to be different in
   SHAPE, because shape is all that reads at chase-camera distance. They are
   also, all four, a man standing upright and moving his arms. Watch a whole
   game of it and the end zone still looks like one idea with four settings.

   So the axes these five add are the ones the set did not have:

     Bow      the only FOLD. Everything else keeps the trunk within twenty
              degrees of vertical; this one puts it past sixty, which at
              distance is a completely different silhouette rather than a
              different arm pose.
     Lasso    the only thing with a large MOVING element: a straight arm
              circling a half-metre radius over the head, once a second. Motion
              that big is legible at a range where a hand is two pixels.
     Salute   the only NARROW one. Flex holds a silhouette by being wide; this
              holds one by being a column — heels together, arms in. In a group
              of five it is the one that isn't waving.
     Griddy   the only thing that moves in the FRONTAL plane below the pelvis.
              Dance rocks the pelvis side to side over sagittal legs; this
              swings the legs themselves out at the hip, which is what the
              heel-toe step actually is, and is why groundedHips had to learn
              about abduction before this clip could exist.
     Point    the first-down signal, and the first celebration in here that is
              about the DOWN rather than about the man. It is the referee's
              chop, thrown by the player who just moved the chains, out to the
              side so it reads as a full-length horizontal line to a camera
              that is always square behind him.

   Every one is authored the way everything else in this file is: feet by where
   they are, hips solved so the soles stay on the turf, shoulders through
   armQ. None of them translates the player — the engine has stopped moving
   bodies by the time any of them plays.                                     */

/* ------------------------------------------------------------------- Bow */
/* Take a bow. Arms high and open, then a deep fold with the right hand sweeping
   across the waist and the left flung back — and the chin stays UP through the
   bottom of it, because a bow with the face pointing at the grass is a man
   looking for a contact lens. Loops on a slow 1.9s bar: the one celebration in
   the set with a long period, so a group of them never falls into step. */
posedClip('Bow', 1.90, [
  // t     pelvis trunk lean tilt |  left foot     right foot  | sweeping arm            trailing arm
  { t: 0.00, pel: 0, trk: 0, lean: -8, tilt: 0, L: [0.10, 20], R: [-0.10, 20], arm: [138, -10, 44, 40], off: [138, 10, 44, 40], look: [-0.22, 0] },
  // The two arms take DIFFERENT paths down, which is the whole reason this
  // clip has six keys instead of four: sweep them symmetrically and they pass
  // through shoulder height together with the elbows open, and for a third of
  // a second the man is a scarecrow. The right folds in early and low, the left
  // stays high and goes back.
  { t: 0.36, pel: 0, trk: -4, lean: 14, tilt: 0, L: [0.10, 24], R: [-0.10, 24], arm: [86, 30, 10, 76], off: [120, -12, 34, 44], look: [-0.14, 0.08] },
  { t: 0.72, pel: 0, trk: -9, lean: 58, tilt: 0, L: [0.10, 21], R: [-0.10, 23], arm: [36, 78, -18, 104], off: [78, -48, 24, 52], look: [-0.50, 0.16] },
  // the bottom of it: right hand across the belt, left arm back and open
  { t: 1.02, pel: 0, trk: -10, lean: 70, tilt: 0, L: [0.10, 19], R: [-0.10, 21], arm: [28, 86, -22, 112], off: [88, -62, 28, 40], look: [-0.58, 0.16] },
  { t: 1.34, pel: 0, trk: -6, lean: 40, tilt: 0, L: [0.10, 24], R: [-0.10, 25], arm: [50, 60, -6, 96], off: [100, -40, 30, 50], look: [-0.42, 0.10] },
  { t: 1.62, pel: 0, trk: -2, lean: 2, tilt: 0, L: [0.10, 25], R: [-0.10, 25], arm: [104, 16, 26, 62], off: [122, -14, 36, 46], look: [-0.20, 0.04] },
  { t: 1.90, pel: 0, trk: 0, lean: -8, tilt: 0, L: [0.10, 20], R: [-0.10, 20], arm: [138, -10, 44, 40], off: [138, 10, 44, 40], look: [-0.22, 0] }
], { splay: 0.05 });

/* ----------------------------------------------------------------- Lasso */
/* Roping the crowd. The right arm is nearly straight and swept to an elevation
   of 132, which armQ turns into a humerus 42 degrees off vertical — so driving
   `horiz` once round the clock traces a cone, and the hand draws a half-metre
   circle above the head. That is the whole clip: everything else (the pelvis
   turning under it, the weight bobbing on the knees, the eyes on the rope) is
   there so the circle isn't a detached arm.

   Nine keys, because a circle sampled at 45 degrees is a circle and a circle
   sampled at 90 is a diamond — slerp takes the short way round between two
   keys, which is a chord, not an arc. */
{
  const HZ = [90, 45, 0, -45, -90, -135, -180, -225, -270];   // one full turn
  const N = HZ.length - 1, DUR = 0.90;
  posedClip('Lasso', DUR, HZ.map((hz, i) => {
    const ph = i / N, w = Math.sin(ph * Math.PI * 2), b = Math.cos(ph * Math.PI * 4);
    return {
      t: +(DUR * ph).toFixed(4),
      pel: 7 * w, trk: -9 * w, lean: 2, tilt: -4 * w,
      L: [0.13, 24 + 6 * b], R: [-0.13, 24 + 6 * b],
      arm: [132, hz, 62, 22],
      off: [24, -12, 12, 98],                       // spare hand at the belt
      look: [-0.20, 0.26 * w]
    };
  }), { splay: 0.075 });
}

/* ---------------------------------------------------------------- Salute */
/* Heels together, chest up, hand at the brow, and then almost nothing: a slow
   breath and a two-degree sway. It is deliberately the quiet one. A group
   celebration is read by contrast, and four men waving next to one man standing
   perfectly still is a picture; five men waving is wallpaper.

   The right elbow folds 140 degrees about a humerus held out at shoulder height
   with ER near 80, which is what puts the hand at the temple rather than in
   front of the face — the difference between a salute and a phone call. */
posedClip('Salute', 1.50, [
  { t: 0.00, pel: 0, trk: 0, lean: -5, tilt: 0, L: [0.03, 12], R: [-0.03, 12], arm: [92, 44, 72, 142], off: [10, 4, -6, 8], look: [-0.06, 0] },
  { t: 0.50, pel: 2, trk: -2, lean: -8, tilt: -2, L: [0.03, 10], R: [-0.03, 14], arm: [95, 47, 74, 145], off: [12, 2, -8, 6], look: [-0.09, -0.07] },
  { t: 1.00, pel: -2, trk: 2, lean: -8, tilt: 2, L: [0.03, 14], R: [-0.03, 10], arm: [95, 41, 74, 145], off: [12, 6, -4, 6], look: [-0.09, 0.07] },
  { t: 1.50, pel: 0, trk: 0, lean: -5, tilt: 0, L: [0.03, 12], R: [-0.03, 12], arm: [92, 44, 72, 142], off: [10, 4, -6, 8], look: [-0.06, 0] }
], { splay: 0.012 });

/* ---------------------------------------------------------------- Griddy */
/* The heel-toe swing, with the hands as goggles at the eyes. The lower body is
   the reason this clip is here: each leg in turn swings OUT at the hip, twenty
   degrees, while the other carries the weight — motion in the frontal plane,
   which nothing else in the set has below the pelvis.
   That swing is also why groundedHips learned `abd`. Abducting a leg shortens
   it straight down by L*(1-cos), which is 55mm on a 0.87m leg at 20 degrees; a
   solver that didn't know would keep hanging the pelvis off the swinging foot
   and drop the whole body by that much, twice a cycle, in time with the dance.

   Fast — 0.72s a bar — because the griddy is a fast dance and because a quick
   period next to Bow's slow one is the other half of making a group read as
   several people rather than one animation with an offset. */
posedClip('Griddy', 0.72, [
  //  t     pel  trk lean tilt sway   abduction      left foot         right foot      | goggles, both hands at the eyes
  { t: 0.00, pel: 10, trk: -6, lean: 7, tilt: -3, sway: 0.030, abd: [22, 0], L: [0.05, 36, 2], R: [-0.03, 20, 8], arm: [88, 34, 78, 134], off: [88, 34, 78, 134] },
  { t: 0.18, pel: 0, trk: 0, lean: 9, tilt: 0, sway: 0.000, abd: [4, 4], L: [0.01, 26, 6], R: [-0.01, 26, 6], arm: [85, 38, 75, 130], off: [85, 38, 75, 130], up: 0.022 },
  { t: 0.36, pel: -10, trk: 6, lean: 7, tilt: 3, sway: -0.030, abd: [0, 22], L: [0.03, 20, 8], R: [-0.05, 36, 2], arm: [88, 34, 78, 134], off: [88, 34, 78, 134] },
  { t: 0.54, pel: 0, trk: 0, lean: 9, tilt: 0, sway: 0.000, abd: [4, 4], L: [0.01, 26, 6], R: [-0.01, 26, 6], arm: [85, 38, 75, 130], off: [85, 38, 75, 130], up: 0.022 },
  { t: 0.72, pel: 10, trk: -6, lean: 7, tilt: -3, sway: 0.030, abd: [22, 0], L: [0.05, 36, 2], R: [-0.03, 20, 8], arm: [88, 34, 78, 134], off: [88, 34, 78, 134] }
], { splay: 0.05 });

/* ----------------------------------------------------------------- Point */
/* THE FIRST DOWN SIGNAL, thrown by the man who just got it. A one-shot, like
   the Spike, and for the same reason: it is an event with a beginning (the arm
   still down from the run), a middle (two hard chops) and an end.

   Out to the SIDE, not downfield. The renderer turns whoever has the ball to
   face the camera, so an arm thrust at the lens is a fist and three inches of
   forearm; the same arm thrown laterally is the longest line a body has. The
   trunk turns and side-bends into each chop so it is a whole player signalling
   rather than a shoulder joint animating, and the head snaps along the arm.

   It ends high and open, which is the pose the loop it hands over to begins
   from — the crossfade rule the Spike is written to as well. */
posedClip('Point', 0.95, [
  // t     pelvis trunk lean tilt |  left foot        right foot     | signalling arm          off arm
  { t: 0.00, pel: 0, trk: 0, lean: 8, tilt: 0, L: [0.10, 30], R: [-0.10, 30], arm: [36, 26, 6, 72], off: [34, 22, 4, 68] },
  // the arm comes up and out, and the plant that stops him goes with it
  { t: 0.16, pel: -6, trk: 8, lean: 4, tilt: -6, L: [0.16, 24], R: [-0.14, 34], arm: [104, -14, 22, 26], off: [48, 16, 0, 60], look: [-0.10, -0.24] },
  { t: 0.28, pel: -8, trk: 12, lean: 2, tilt: -10, L: [0.16, 20], R: [-0.14, 30], arm: [122, -20, 26, 8], off: [54, 12, -2, 56], look: [-0.16, -0.34] },
  // CHOP. Twice, and the second is shorter and harder than the first.
  { t: 0.42, pel: -6, trk: 8, lean: 6, tilt: -6, L: [0.16, 28], R: [-0.14, 36], arm: [72, -8, 10, 14], off: [50, 14, 0, 58], look: [-0.06, -0.28] },
  { t: 0.56, pel: -8, trk: 12, lean: 2, tilt: -10, L: [0.16, 22], R: [-0.14, 30], arm: [118, -18, 24, 10], off: [54, 12, -2, 56], look: [-0.16, -0.34] },
  { t: 0.68, pel: -6, trk: 8, lean: 7, tilt: -5, L: [0.16, 30], R: [-0.14, 36], arm: [78, -6, 12, 16], off: [50, 14, 0, 58], look: [-0.04, -0.26] },
  // open up: both arms wide and high, back to the camera-square stance
  { t: 0.82, pel: -2, trk: 2, lean: -6, tilt: -2, L: [0.14, 26], R: [-0.12, 28], arm: [116, -26, 40, 24], off: [96, -20, 32, 30], look: [-0.20, -0.10] },
  { t: 0.95, pel: 0, trk: 0, lean: -10, tilt: 0, L: [0.13, 24], R: [-0.11, 24], arm: [132, -18, 46, 26], off: [124, -16, 42, 28], look: [-0.24, 0] }
], { splay: 0.05 });

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
  /* The head baseColor multiplies the runtime face texture, so it carries the
     skin tone exactly like `skin` does; the map supplies the features as dark
     values on white. Baked as skin rather than white so a head still looks
     like a head if the texture never gets generated. */
  ['head',   [0.91, 0.72, 0.56], 0.78, 0.00],
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
const NORMALS = normalsFor(REGIONS.filter(r => r.I.length));
/* Bake occlusion once the welded normals exist — the hemisphere the rays are
   cast over is oriented by them, and using the raw per-region normals would
   put a seam through the shading exactly where normalsFor() just removed one.
   The alternate hairstyles and beards are baked but never used as OCCLUDERS:
   the .glb carries all of them and the game shows one, so letting a beard
   nobody is wearing cast a shadow onto the jaw would darken every face. */
{
  const lit = REGIONS.filter(r => r.I.length);
  for (const r of lit) r.N = NORMALS.get(r);
  var aoDarkest = bakeAO(lit, lit.filter(r => !/^(hair_|beard_)/.test(r.name)));
}
for (const r of REGIONS) {
  if (!r.I.length) continue;
  const N = NORMALS.get(r);
  const prim = {
    attributes: {
      POSITION: accessor(new Float32Array(r.P), 'VEC3', COMP.f32, 34962, { minmax: true }),
      NORMAL: accessor(N, 'VEC3', COMP.f32, 34962),
      COLOR_0: accessor(r.AO, 'VEC4', COMP.u8, 34962, { normalized: true }),
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
/* ================ HOW FAST A BLEND OF TWO GAITS ACTUALLY IS ===============

   The renderer does not play one of these clips. It plays two, blended, and it
   picks the blend weight on the assumption that a half-and-half mix of a jog
   and a run covers the ground at the average of their two speeds.

   That assumption is wrong, and it is wrong by more than it sounds. A blended
   pose is not the pose halfway between two gaits in any sense the ground cares
   about: the legs interpolate, the pelvis height interpolates SEPARATELY (it is
   a translation track, and nothing re-solves it against the blended legs), and
   the ground speed of the result is whatever falls out of those two facts
   together. Measured end to end in the browser, a half-blended jog-run swept
   the turf 13% slower than the average of the two — which is a support foot
   sliding forward under a player for the whole of every stance, at exactly the
   speeds a receiver spends most of a play at.

   It can be predicted here rather than measured there, and exactly, because of
   a property of this rig: every joint a gait animates in the sagittal plane
   rotates about ONE axis, and a slerp between two rotations about a common axis
   is a plain interpolation of the angle. So the blended pose the mixer will
   produce is the interpolation of these tables, and the same kinematics that
   measured each clip can measure the mix.

   What comes out is a small correction curve per adjacent pair, baked onto the
   slower clip as `blendUp`, sampled at w = 0, 0.25, 0.5, 0.75, 1. playermodel
   divides by it. Anyone re-authoring a stride gets a new curve for free, which
   is the entire reason it is computed here and not typed into the renderer —
   this file has had two hand-copied constants drift out of step already. */
const BLEND_LADDER = ['Walk', 'Jog', 'Run', 'Sprint'];
for (let i = 0; i < BLEND_LADDER.length - 1; i++) {
  const A = GAIT_SOLVE[BLEND_LADDER[i]], B = GAIT_SOLVE[BLEND_LADDER[i + 1]];
  if (!A || !B) continue;
  const mix = (a, b, w) => a + (b - a) * w;
  const curve = [1];
  for (const w of [0.25, 0.5, 0.75]) {
    const legAt = (k, right) => {
      const p = A.legAt(k, right), q = B.legAt(k, right);
      return [mix(p[0], q[0], w), mix(p[1], q[1], w), mix(p[2], q[2], w), mix(p[3], q[3], w)];
    };
    const rise = (k, right) => mix(A.rise(k, right), B.rise(k, right), w);
    const m = gaitMetrics(mix(A.dur, B.dur, w), legAt, rise,
      process.env.GAIT_DEBUG ? BLEND_LADDER[i] + '+' + w : null);
    const linear = mix(A.extras.groundSpeed, B.extras.groundSpeed, w);
    curve.push(linear > 0 ? m.groundSpeed / linear : 1);
  }
  curve.push(1);
  A.extras.blendUp = curve.map(v => +v.toFixed(4));
  console.log('  blend ' + (BLEND_LADDER[i] + '->' + BLEND_LADDER[i + 1]).padEnd(14) +
    A.extras.blendUp.map(v => v.toFixed(3)).join('  '));
}

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
console.log('  baked AO      ' + AO.RAYS + ' rays @ ' + AO.MAX_DIST + 'm, darkest vertex ' + aoDarkest.toFixed(3));
console.log('  file size     ' + (size / 1024).toFixed(1) + ' KB');
