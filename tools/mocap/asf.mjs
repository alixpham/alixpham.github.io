/* ============================================================================
   FLAGSTER — CMU ASF/AMC READER

   The CMU Graphics Lab motion capture database ships its skeletons as .asf and
   its motions as .amc: two plain text formats, which is the whole reason this
   project can take mocap at all. Everything else the world distributes motion
   in (FBX, and the Sketchfab packs that wrap it) needs a binary parser or a
   Blender install, and this repo ships neither a build step nor a dependency.

   http://mocap.cs.cmu.edu/ — the database is free for all uses; see
   tools/mocap/README.md for the attribution this project carries.

   WHAT COMES OUT

     readSkeleton(text)  -> { bones, order, scale }
     readMotion(text)    -> [ { root:[x,y,z], dof:{ bone:[deg,...] } }, ... ]
     forward(skel, fr)   -> { q:{bone:[x,y,z,w]}, p:{bone:[x,y,z]}, root:[..] }

   in METRES, +Y up, +X the subject's LEFT and +Z the direction they face — the
   same frame Flagster's own rig uses, which is a piece of luck worth stating
   plainly because it means no basis change anywhere in the retarget.

   THE ONE PIECE OF ASF THAT IS NOT OBVIOUS is that a bone's rotation in the
   file is expressed in its OWN axis frame, not its parent's. Each bone carries
   an `axis` triple C, and the rotation that lands in the world is

       M_bone = M_parent . C . R . C^-1

   which has a consequence this whole pipeline leans on: at rest, R is identity
   and every bone's M collapses to its parent's, so the rest orientation of
   EVERY ASF bone is the identity. A bone's M is therefore exactly "how far
   this bone has turned from its rest direction" — directly comparable with a
   rig whose rest pose carries no rotations either, which is what Flagster's is.
   ============================================================================ */

const D = Math.PI / 180;

/* ------------------------------------------------------------ quaternions */
export const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];
export const qConj = q => [-q[0], -q[1], -q[2], q[3]];
export const qAxis = (ax, ang) => {
  const s = Math.sin(ang / 2);
  return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)];
};
export const qRot = (q, v) => {
  const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
  return [
    v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1],
    v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2],
    v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0]
  ];
};
export const qNorm = q => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
export const qSlerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let c = b;
  if (d < 0) { c = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) return qNorm(a.map((v, i) => v + (c[i] - v) * t));
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + c[0] * wb, a[1] * wa + c[1] * wb, a[2] * wa + c[2] * wb, a[3] * wa + c[3] * wb];
};

/* ASF euler triples are XYZ order in the STATIC frame — X turns first, so the
   matrix is Rz.Ry.Rx and the quaternion product reads in the same order. */
export const qEulerXYZ = (x, y, z) => qMul(qAxis([0, 0, 1], z), qMul(qAxis([0, 1, 0], y), qAxis([1, 0, 0], x)));

/* Shortest rotation taking unit vector a onto unit vector b. Used to reconcile
   two rigs' rest directions; it leaves the twist about the bone's own axis
   alone, which is what makes the source's axial rotation survive retargeting
   instead of being overwritten by an arbitrary convention. */
export function minArc(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d > 0.999999) return [0, 0, 0, 1];
  if (d < -0.999999) {                                   // antiparallel: any perpendicular axis
    let ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    ax = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]];
    const n = Math.hypot(...ax);
    return [ax[0] / n, ax[1] / n, ax[2] / n, 0];
  }
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return qNorm([c[0], c[1], c[2], 1 + d]);
}

/* --------------------------------------------------------------- skeleton */

/* CMU stores lengths in the file's own units; `:units length 0.45` is the
   divisor that takes them to inches, and 2.54/100 takes those to metres. */
const UNIT = 2.54 / 100;

export function readSkeleton(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim());
  const bones = { root: { name: 'root', dir: [0, 0, 0], len: 0, C: [0, 0, 0, 1], Cinv: [0, 0, 0, 1], dof: [], parent: null, children: [] } };
  let unit = 0.45, section = '', cur = null, rootOrder = ['TX', 'TY', 'TZ', 'RX', 'RY', 'RZ'];

  for (const line of lines) {
    if (!line) continue;
    if (line[0] === ':') { section = line.slice(1).split(/\s+/)[0]; continue; }
    const tok = line.split(/\s+/);

    if (section === 'units' && tok[0] === 'length') unit = Number(tok[1]);
    else if (section === 'root' && tok[0] === 'order') rootOrder = tok.slice(1).map(s => s.toUpperCase());
    else if (section === 'bonedata') {
      if (tok[0] === 'begin') { cur = { dof: [], C: [0, 0, 0, 1], children: [] }; continue; }
      if (tok[0] === 'end') { bones[cur.name] = cur; cur = null; continue; }
      if (!cur) continue;
      if (tok[0] === 'name') cur.name = tok[1];
      else if (tok[0] === 'direction') cur.dir = tok.slice(1, 4).map(Number);
      else if (tok[0] === 'length') cur.len = Number(tok[1]);
      else if (tok[0] === 'axis') cur.axisDeg = tok.slice(1, 4).map(Number);
      else if (tok[0] === 'dof') cur.dof = tok.slice(1).map(s => s.toLowerCase());
    } else if (section === 'hierarchy' && tok[0] !== 'begin' && tok[0] !== 'end') {
      const p = tok[0];
      for (const c of tok.slice(1)) { if (bones[c]) { bones[c].parent = p; bones[p].children.push(c); } }
    }
  }

  const scale = (1 / unit) * UNIT;
  for (const n in bones) {
    const b = bones[n];
    if (b.axisDeg) { b.C = qEulerXYZ(b.axisDeg[0] * D, b.axisDeg[1] * D, b.axisDeg[2] * D); b.Cinv = qConj(b.C); }
    b.len = (b.len || 0) * scale;
    // Normalise the rest direction: the files carry it to six figures and the
    // occasional 1e-11 component, and a minArc against a non-unit vector is a
    // scale as well as a rotation.
    const L = Math.hypot(...(b.dir || [0, 0, 0]));
    b.dir = L > 1e-9 ? b.dir.map(v => v / L) : [0, 0, 0];
  }
  return { bones, rootOrder, scale };
}

/* ----------------------------------------------------------------- motion */

export function readMotion(text) {
  const frames = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ':') continue;
    if (/^\d+$/.test(line)) { cur = { root: [0, 0, 0], rootRot: [0, 0, 0], dof: {} }; frames.push(cur); continue; }
    if (!cur) continue;
    const tok = line.split(/\s+/);
    cur.dof[tok[0]] = tok.slice(1).map(Number);
  }
  return frames;
}

/* Forward kinematics for one frame. Returns each bone's world ROTATION (which,
   per the note at the top, is measured from a rest pose of all identities) and
   the world POSITION of the joint at its head. */
export function forward(skel, frame) {
  const { bones, rootOrder, scale } = skel;
  const q = {}, p = {};
  const rootDof = frame.dof.root || [0, 0, 0, 0, 0, 0];
  const rv = { TX: 0, TY: 0, TZ: 0, RX: 0, RY: 0, RZ: 0 };
  rootOrder.forEach((k, i) => { rv[k] = rootDof[i] || 0; });
  q.root = qEulerXYZ(rv.RX * D, rv.RY * D, rv.RZ * D);
  p.root = [rv.TX * scale, rv.TY * scale, rv.TZ * scale];

  const walk = name => {
    for (const c of bones[name].children) {
      const b = bones[c];
      const vals = frame.dof[c] || [];
      let rx = 0, ry = 0, rz = 0, i = 0;
      for (const d of b.dof) {
        const v = vals[i++] || 0;
        if (d === 'rx') rx = v; else if (d === 'ry') ry = v; else if (d === 'rz') rz = v;
      }
      const R = qEulerXYZ(rx * D, ry * D, rz * D);
      q[c] = qMul(q[name], qMul(b.C, qMul(R, b.Cinv)));
      const off = qRot(q[c], b.dir);
      p[c] = [p[name][0] + off[0] * b.len, p[name][1] + off[1] * b.len, p[name][2] + off[2] * b.len];
      walk(c);
    }
  };
  walk('root');
  return { q, p };
}
