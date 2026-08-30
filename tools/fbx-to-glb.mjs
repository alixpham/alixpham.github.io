#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — FBX -> GLB (skinned character)

   Converts a Studio Ochi rigged FBX into the glTF 2.0 binary the game already
   knows how to load, WITHOUT Blender: mesh, normals, UVs, the 58-bone Rigify
   metarig, skin weights, the embedded texture, and the bundled clips.

     node tools/fbx-to-glb.mjs in.fbx -o out.glb [--texture atlas.png]
     node tools/fbx-to-glb.mjs in.fbx -o out.glb --no-anim --stats

   WHY NOT BLENDER. There is no Blender binary in this environment — it is the
   same reason build-player-glb.mjs writes glTF by hand — and the asset pipeline
   has to be reproducible in the repo rather than on one machine. The FBX record
   tree is read by fbx-read.mjs; everything below is the conversion.

   THE FOUR THINGS THAT ARE EASY TO GET WRONG, and how each is handled:

   1. VERTEX IDENTITY. FBX indexes positions per CONTROL POINT and normals/UVs
      per POLYGON VERTEX, so one control point carries several normals across a
      hard edge. glTF has one attribute set per vertex, so the tuple
      (controlPoint, normal, uv) is what gets de-duplicated into a vertex — and
      the skin has to follow that mapping, not the original indices, or the
      weights land on the wrong people.

   2. POLYGONS ARE NOT TRIANGLES. PolygonVertexIndex marks the last index of
      each polygon by storing its bitwise NOT, so a quad is [a, b, c, ~d]. Fan
      triangulation, which is right for the convex quads a low-poly character is
      made of.

   3. THE BIND POSE. glTF wants an inverse bind matrix per joint. FBX gives it
      as two matrices per cluster: `Transform` (the MESH at bind time) and
      `TransformLink` (the JOINT at bind time), and the inverse bind is
      inverse(TransformLink) * Transform. Guessing that it is just the inverse
      of the joint's world matrix works only while the mesh sits at the origin.

   4. ROTATION ORDER. FBX Lcl Rotation is Euler degrees in the node's own
      RotationOrder, XYZ unless it says otherwise, and glTF wants a quaternion.

   Units and axes need no conversion here and that is checked, not assumed:
   these files report UnitScaleFactor 1 (metres) and a Y-up right-handed frame,
   which is glTF's. The converter refuses a file that says otherwise rather than
   silently producing a character lying on his side at 100x scale.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { parseFBX, indexScene, kid, kids, prop70, KTIME } from './fbx-read.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = n => argv.includes(n);
const IN = argv.find(a => !a.startsWith('-') && /\.fbx$/i.test(a));
const OUT = arg('-o', arg('--out', null));
const TEX = arg('--texture', null);
const NO_ANIM = has('--no-anim');
const MOTION = arg('--motion', null);
/* ADOPTING STUDIO OCHI'S OWN CLIPS.

   The character ships six hand-authored animations — Catch and Fall, Hold,
   Kick, Kickoff, Run Fast, Throw 01 — on this exact metarig, so unlike the CMU
   material they need no retargeting at all: they are already the right bones in
   the right rest pose, and the converter above turns them into glTF samplers
   like any other stack.

   What they lack is the game's vocabulary. `--adopt "Run Fast=Sprint"` gives an
   FBX clip a game clip's name, and any adopted name is then EXCLUDED from the
   tools/motion-ochi swap below — otherwise the retargeted clip of the same name
   would replace the very thing being adopted, silently and in the direction
   nobody wanted. Explicit rather than a directory listing, because which of the
   six is better than what this repo already authored is a question to be
   measured one clip at a time, not assumed for all six. */
const ADOPT = new Map();
for (const pair of (arg('--adopt', '') || '').split(',').map(s => s.trim()).filter(Boolean)) {
  const i = pair.indexOf('=');
  if (i < 0) { console.error('--adopt wants "FBX clip name=GameName", got: ' + pair); process.exit(2); }
  ADOPT.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
}
const adopted = new Set();
const STATS = has('--stats');

if (!IN || !OUT) {
  console.error('usage: node tools/fbx-to-glb.mjs in.fbx -o out.glb [--texture atlas.png] [--motion dir] [--adopt "Run Fast=Sprint,..."] [--no-anim] [--stats]');
  process.exit(2);
}

/* ------------------------------------------------------------------- maths */
const M4 = {
  ident: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  mul(a, b) {                                   // column-major, a then b applied
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  invert(m) {
    const inv = new Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (!det) return M4.ident();
    det = 1 / det;
    return inv.map(v => v * det);
  }
};

const D2R = Math.PI / 180;
/* Euler degrees -> quaternion, in the given order. FBX defaults to XYZ, which
   means "rotate about X, then Y, then Z" in the PARENT frame. */
function eulerToQuat(x, y, z, order = 'XYZ') {
  const hx = x * D2R / 2, hy = y * D2R / 2, hz = z * D2R / 2;
  const qx = [Math.sin(hx), 0, 0, Math.cos(hx)];
  const qy = [0, Math.sin(hy), 0, Math.cos(hy)];
  const qz = [0, 0, Math.sin(hz), Math.cos(hz)];
  const mul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
  const by = { X: qx, Y: qy, Z: qz };
  let q = [0, 0, 0, 1];
  /* Reverse of the name — see the note in fbx-pose.mjs. "XYZ" is the order the
     rotations are APPLIED and quaternion multiplication applies right-to-left.
     This was backwards here too; it survived because the Studio Ochi clips sit
     nowhere near gimbal lock, where the error is small rather than absent. */
  for (const axis of [...order].reverse()) q = mul(q, by[axis]);
  return q;
}
const ORDER = ['XYZ', 'XZY', 'YZX', 'ZXY', 'YXZ', 'ZYX', 'XYZ'];

/* TRS out of a column-major 4x4, for glTF nodes. Shear is not representable
   and these rigs have none, so an orthogonal basis is assumed after the scale
   is divided out. */
function decompose(m) {
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  const s = [det < 0 ? -sx : sx, sy, sz];
  const r = [m[0] / s[0], m[1] / s[0], m[2] / s[0], m[4] / s[1], m[5] / s[1], m[6] / s[1], m[8] / s[2], m[9] / s[2], m[10] / s[2]];
  const tr = r[0] + r[4] + r[8];
  let q;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; q = [(r[5] - r[7]) / S, (r[6] - r[2]) / S, (r[1] - r[3]) / S, 0.25 * S]; }
  else if (r[0] > r[4] && r[0] > r[8]) { const S = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; q = [0.25 * S, (r[3] + r[1]) / S, (r[6] + r[2]) / S, (r[5] - r[7]) / S]; }
  else if (r[4] > r[8]) { const S = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; q = [(r[3] + r[1]) / S, 0.25 * S, (r[7] + r[5]) / S, (r[6] - r[2]) / S]; }
  else { const S = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2; q = [(r[6] + r[2]) / S, (r[7] + r[5]) / S, 0.25 * S, (r[1] - r[3]) / S]; }
  return { t: [m[12], m[13], m[14]], q, s };
}

/* Euler degrees + TRS -> column-major matrix, matching the FBX node convention. */
function trsMatrix(t, q, s) {
  const [x, y, z, w] = q;
  const m = [
    (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
    (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
    (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
  return m;
}

/* ---------------------------------------------------------------- the file */
const { version, root } = parseFBX(fs.readFileSync(IN));
const scene = indexScene(root);
const { byId, parentOf, childrenOf } = scene;

/* Refuse a file whose units or axes are not what the rest of this assumes.
   Silently converting the wrong way round produces a character lying on his
   side at 100x, which is obvious; getting it subtly wrong is not. */
{
  const gs = kid(root, 'GlobalSettings');
  const unit = (prop70(gs, 'UnitScaleFactor') || [1])[0];
  const up = (prop70(gs, 'UpAxis') || [1])[0];
  const upSign = (prop70(gs, 'UpAxisSign') || [1])[0];
  if (Math.abs(unit - 1) > 1e-6) {
    console.error(`refusing: UnitScaleFactor is ${unit}, expected 1 (metres). Re-export at 1.0 or teach this tool to scale.`);
    process.exit(1);
  }
  if (up !== 1 || upSign !== 1) {
    console.error(`refusing: UpAxis ${up} sign ${upSign}, expected Y-up (1, +1) to match glTF.`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------- nodes */
const models = [...byId.values()].filter(o => o.type === 'Model');
const localOf = new Map();
for (const m of models) {
  const t = prop70(m.node, 'Lcl Translation') || [0, 0, 0];
  const r = prop70(m.node, 'Lcl Rotation') || [0, 0, 0];
  const s = prop70(m.node, 'Lcl Scaling') || [1, 1, 1];
  const ord = ORDER[(prop70(m.node, 'RotationOrder') || [0])[0]] || 'XYZ';
  localOf.set(m.id, {
    t: [t[0] || 0, t[1] || 0, t[2] || 0],
    q: eulerToQuat(r[0] || 0, r[1] || 0, r[2] || 0, ord),
    s: [s[0] == null ? 1 : s[0], s[1] == null ? 1 : s[1], s[2] == null ? 1 : s[2]]
  });
}

const bones = models.filter(m => m.sub === 'LimbNode');
const meshModels = models.filter(m => m.sub === 'Mesh');

/* ---------------------------------------------------------------- geometry */
function layer(geoNode, which) {
  const L = kid(geoNode, which);
  if (!L) return null;
  const mapping = (kid(L, 'MappingInformationType') || {}).props;
  const reference = (kid(L, 'ReferenceInformationType') || {}).props;
  const dataName = which === 'LayerElementNormal' ? 'Normals'
    : which === 'LayerElementUV' ? 'UV'
      : which === 'LayerElementMaterial' ? 'Materials' : null;
  const idxName = which === 'LayerElementUV' ? 'UVIndex' : which === 'LayerElementNormal' ? 'NormalsIndex' : null;
  const data = (kid(L, dataName) || {}).props;
  const index = idxName ? (kid(L, idxName) || {}).props : null;
  return {
    mapping: mapping ? mapping[0] : null,
    reference: reference ? reference[0] : null,
    data: data ? data[0] : [],
    index: index ? index[0] : null
  };
}

function readGeometry(geo) {
  const verts = (kid(geo, 'Vertices') || { props: [[]] }).props[0];
  const pvi = (kid(geo, 'PolygonVertexIndex') || { props: [[]] }).props[0];
  const nrm = layer(geo, 'LayerElementNormal');
  const uv = layer(geo, 'LayerElementUV');
  const mat = layer(geo, 'LayerElementMaterial');

  /* Pull an attribute for polygon-vertex `pv`, whose control point is `cp`. */
  const fetch = (L, pv, cp, n) => {
    if (!L || !L.data.length) return null;
    const byCP = L.mapping === 'ByVertice' || L.mapping === 'ByVertex' || L.mapping === 'ByControlPoint';
    let i = byCP ? cp : pv;
    if (L.reference === 'IndexToDirect' || L.reference === 'Index') i = L.index ? L.index[i] : i;
    const out = [];
    for (let k = 0; k < n; k++) out.push(L.data[i * n + k] || 0);
    return out;
  };

  const key = new Map();            // "cp|nx,ny,nz|u,v" -> new index
  const position = [], normal = [], uvOut = [], cpOf = [];
  const indices = [];
  const matPerTri = [];

  let poly = [], polyStart = 0, polyIdx = 0;
  for (let pv = 0; pv < pvi.length; pv++) {
    let cp = pvi[pv];
    const last = cp < 0;
    if (last) cp = ~cp;
    poly.push({ pv, cp });
    if (!last) continue;

    // fan-triangulate this polygon
    const emit = (o) => {
      const n = fetch(nrm, o.pv, o.cp, 3) || [0, 1, 0];
      const t = fetch(uv, o.pv, o.cp, 2) || [0, 0];
      const k = o.cp + '|' + n.map(v => v.toFixed(4)) + '|' + t.map(v => v.toFixed(5));
      let id = key.get(k);
      if (id == null) {
        id = position.length / 3;
        key.set(k, id);
        position.push(verts[o.cp * 3], verts[o.cp * 3 + 1], verts[o.cp * 3 + 2]);
        normal.push(n[0], n[1], n[2]);
        uvOut.push(t[0], 1 - t[1]);            // FBX V is up, glTF V is down
        cpOf.push(o.cp);
      }
      return id;
    };
    const ids = poly.map(emit);
    let m = 0;
    if (mat && mat.data && mat.data.length) {
      m = mat.mapping === 'AllSame' ? (mat.data[0] || 0) : (mat.data[polyIdx] || 0);
    }
    for (let k = 1; k + 1 < ids.length; k++) {
      indices.push(ids[0], ids[k], ids[k + 1]);
      matPerTri.push(m);
    }
    poly = []; polyStart = pv + 1; polyIdx++;
  }
  return { position, normal, uv: uvOut, indices, cpOf, matPerTri, controlPoints: verts.length / 3 };
}

/* ------------------------------------------------------------------- build */
const geoms = [];
const skipped = [];
const retargeted = [];
for (const mm of meshModels) {
  // the Geometry connected to this Model
  const gid = (childrenOf.get(mm.id) || []).map(c => byId.get(c.id)).find(o => o && o.type === 'Geometry');
  if (!gid) continue;
  const geo = readGeometry(gid.node);
  /* Skip empty geometry. These files carry a leftover stub mesh with zero
     control points (AmericanFootballWoman.003 inside the Man export), and
     emitting it gives glTF an accessor with count 0 whose min/max are null —
     legal-ish, useless, and it was the first accessor, so every bounds report
     read the empty one. */
  if (!geo.position.length) { skipped.push(gid.name); continue; }
  geoms.push({ model: mm, geoObj: gid, geo });
}
if (!geoms.length) { console.error('no mesh geometry found'); process.exit(1); }

/* Joint order: a stable depth-first walk from the roots, so the skin's joint
   indices and the node list agree and a diff between two characters lines up. */
const boneIds = bones.map(b => b.id);
const boneSet = new Set(boneIds);
const rootsB = boneIds.filter(id => !boneSet.has(parentOf.get(id)));
const jointOrder = [];
(function walk(id) {
  jointOrder.push(id);
  const ch = (childrenOf.get(id) || []).map(c => c.id).filter(c => boneSet.has(c));
  ch.sort((a, b) => byId.get(a).name.localeCompare(byId.get(b).name));
  ch.forEach(walk);
})(rootsB[0]);
for (const id of boneIds) if (!jointOrder.includes(id)) jointOrder.push(id);
const jointIndex = new Map(jointOrder.map((id, i) => [id, i]));

/* Skin: cluster -> per-control-point influences, then remapped onto the
   de-duplicated vertices. */
function skinFor(geoObj, geo, meshGlobal) {
  const skinObj = (childrenOf.get(geoObj.id) || []).map(c => byId.get(c.id))
    .find(o => o && o.type === 'Deformer' && o.sub === 'Skin');
  if (!skinObj) return null;
  const perCP = Array.from({ length: geo.controlPoints }, () => []);
  const ibm = new Map();
  for (const c of (childrenOf.get(skinObj.id) || [])) {
    const cl = byId.get(c.id);
    if (!cl || cl.type !== 'Deformer' || cl.sub !== 'Cluster') continue;
    const boneObj = (childrenOf.get(cl.id) || []).map(x => byId.get(x.id)).find(o => o && o.type === 'Model');
    if (!boneObj || !jointIndex.has(boneObj.id)) continue;
    const j = jointIndex.get(boneObj.id);
    const idxs = (kid(cl.node, 'Indexes') || { props: [[]] }).props[0] || [];
    const wts = (kid(cl.node, 'Weights') || { props: [[]] }).props[0] || [];
    for (let k = 0; k < idxs.length; k++) {
      const cp = idxs[k];
      if (cp >= 0 && cp < perCP.length && wts[k] > 0) perCP[cp].push([j, wts[k]]);
    }
    /* THE BIND POSE — see the header. TransformLink is the joint at bind time,
       in the file's world space, so inverse(TransformLink) takes a world-space
       point into that joint. What it has to be composed with is the transform
       that puts a RAW VERTEX into that same world space — which is the mesh
       MODEL's matrix, carrying Blender's -90 X and its scale of 100.

       Not the cluster's own `Transform`. That one is the mesh at bind time in
       the geometry's space and comes out at scale 1 here, so pairing it with an
       inverse TransformLink at scale 1/100 produced inverse binds at 0.01 and a
       character rendered one hundredth of life size — measured off the emitted
       file rather than guessed at. */
    const TL = (kid(cl.node, 'TransformLink') || {}).props;
    if (TL) ibm.set(j, M4.mul(M4.invert(TL[0]), meshGlobal));
  }
  const n = geo.position.length / 3;
  const joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
  let maxInf = 0;
  for (let v = 0; v < n; v++) {
    const list = perCP[geo.cpOf[v]] || [];
    maxInf = Math.max(maxInf, list.length);
    const top = list.slice().sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = top.reduce((a, x) => a + x[1], 0) || 1;
    for (let k = 0; k < top.length; k++) {
      joints[v * 4 + k] = top[k][0];
      weights[v * 4 + k] = top[k][1] / sum;
    }
    if (!top.length) weights[v * 4] = 1;        // orphan vertex rides joint 0
  }
  const inverseBind = new Float32Array(jointOrder.length * 16);
  for (let j = 0; j < jointOrder.length; j++) {
    const m = ibm.get(j) || M4.ident();
    for (let k = 0; k < 16; k++) inverseBind[j * 16 + k] = m[k];
  }
  return { joints, weights, inverseBind, maxInf };
}

/* -------------------------------------------------------------- animations */
function animations() {
  /* `--no-anim` drops the FBX's own stacks — all six of Studio Ochi's clips are
     713 KB of samplers the game has never played, and the shipped character is
     animated entirely from tools/motion-ochi. An ADOPTED clip is the exception
     by definition: it is the one thing being taken from the FBX, so it survives
     --no-anim and nothing else does. */
  if (NO_ANIM && !ADOPT.size) return [];
  const stacks = [...byId.values()].filter(o => o.type === 'AnimationStack');
  const out = [];
  for (const st of stacks) {
    const layers = (childrenOf.get(st.id) || []).map(c => byId.get(c.id))
      .filter(o => o && o.type === 'AnimationLayer');
    // node id -> { T: {x,y,z}, R: {...}, S: {...} } of curves
    const tracks = new Map();
    for (const L of layers) {
      for (const cn of (childrenOf.get(L.id) || []).map(c => byId.get(c.id))) {
        if (!cn || cn.type !== 'AnimationCurveNode') continue;
        // which Model property does this curve node drive?
        const target = (scene.parentsOf.get(cn.id) || [])
          .map(p => ({ o: byId.get(p.id), prop: p.prop }))
          .find(x => x.o && x.o.type === 'Model');
        if (!target || !jointIndex.has(target.o.id)) continue;
        const kind = /Translation/.test(target.prop || '') ? 'T'
          : /Rotation/.test(target.prop || '') ? 'R'
            : /Scaling/.test(target.prop || '') ? 'S' : null;
        if (!kind) continue;
        if (!tracks.has(target.o.id)) tracks.set(target.o.id, {});
        const slot = tracks.get(target.o.id);
        slot[kind] = slot[kind] || {};
        for (const cc of (childrenOf.get(cn.id) || [])) {
          const cur = byId.get(cc.id);
          if (!cur || cur.type !== 'AnimationCurve') continue;
          const axis = (cc.prop || 'd|X').slice(-1);
          const times = (kid(cur.node, 'KeyTime') || { props: [[]] }).props[0] || [];
          const vals = (kid(cur.node, 'KeyValueFloat') || { props: [[]] }).props[0] || [];
          slot[kind][axis] = { times: times.map(t => t / KTIME), vals };
        }
      }
    }
    if (tracks.size) out.push({ name: st.name, tracks });
  }
  return out;
}

/* ------------------------------------------------------------------ writer */
const bin = [];
let binLen = 0;
function push(buf, align = 4) {
  const pad = (align - (binLen % align)) % align;
  if (pad) { bin.push(Buffer.alloc(pad)); binLen += pad; }
  const off = binLen;
  bin.push(buf); binLen += buf.length;
  return off;
}
const gltf = {
  asset: { version: '2.0', generator: 'flagster/tools/fbx-to-glb.mjs' },
  scene: 0, scenes: [{ nodes: [] }],
  nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [],
  materials: [], skins: [], animations: []
};
const CT = { f32: 5126, u32: 5125, u16: 5123, u8: 5121 };
function accessor(data, type, comp, target, opts = {}) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const off = push(buf, 4);
  gltf.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: buf.length, ...(target ? { target } : {}) });
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
  const a = { bufferView: gltf.bufferViews.length - 1, componentType: comp, count: data.length / n, type };
  if (opts.minmax) {
    const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
    for (let i = 0; i < data.length; i += n) for (let k = 0; k < n; k++) {
      min[k] = Math.min(min[k], data[i + k]); max[k] = Math.max(max[k], data[i + k]);
    }
    a.min = min; a.max = max;
  }
  if (opts.normalized) a.normalized = true;
  gltf.accessors.push(a);
  return gltf.accessors.length - 1;
}

/* THE REST POSE IS NOT IN THE BONE NODES.

   Blender's FBX export writes each bone's Lcl Translation/Rotation at the frame
   the file happened to be saved on — a POSE — while the true bind pose survives
   only in each skin cluster's TransformLink. Checked rather than assumed:
   composing the node chain for `spine` gives a global of [-1.48, 38.37, -7.50]
   against a TransformLink of [0.00, 85.75, -0.72]. A pelvis 38cm off the ground
   on a 1.74m man is a crouch, and every bone disagreed the same way, which is
   what tore the skin apart when the inverse binds (correctly taken from
   TransformLink) were applied to a hierarchy standing somewhere else.

   So the rest hierarchy is rebuilt FROM the bind globals: local = inverse(parent
   bind) * own bind. The 15 bones with no cluster — tips and a few unweighted
   helpers — keep their authored local, which now hangs off a corrected parent.
   The result is a character whose rest pose IS its bind pose, which is also
   what you want from a canonical rig to retarget onto. */
const bindGlobal = new Map();
for (const cl of [...byId.values()].filter(o => o.type === 'Deformer' && o.sub === 'Cluster')) {
  const boneObj = (childrenOf.get(cl.id) || []).map(x => byId.get(x.id)).find(o => o && o.type === 'Model');
  const TL = (kid(cl.node, 'TransformLink') || {}).props;
  if (boneObj && TL) bindGlobal.set(boneObj.id, TL[0]);
}
if (bindGlobal.size) {
  /* Walk parents before children so a parent's corrected global is known. */
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
  const globalNow = new Map();
  for (const id of order) {
    const p = parentOf.get(id);
    const pg = p != null ? globalNow.get(p) : null;
    let g = bindGlobal.get(id);
    if (!g) {
      const l = localOf.get(id);
      const lm = trsMatrix(l.t, l.q, l.s);
      g = pg ? M4.mul(pg, lm) : lm;
    }
    globalNow.set(id, g);
    const local = pg ? M4.mul(M4.invert(pg), g) : g;
    const d = decompose(local);
    localOf.set(id, { t: d.t, q: d.q, s: d.s });
  }
}

/* NODES. Every Model becomes a node, not just the bones.

   Dropping the non-bone Models is what put the character face-down and
   0.39m tall: Blender writes its Z-up -> Y-up conversion as a -90 degree X
   rotation on the ARMATURE (a Null named "Metarig Man.013"), together with a
   scale of 100, and leaves the vertex data in Blender's own frame. Read the
   geometry without its parent and you get a man lying along Z.

   The Null is also an ancestor of every joint, so its transform has to be a
   real node rather than something folded into the root bone: the inverse bind
   matrices were computed from FBX's own global bind matrices, which include
   that rotation and that scale, and they only stay consistent if the joint
   world matrices do too.

   The unit conversion then goes OUTSIDE all of it. FBX's native unit is the
   centimetre and Blender exports objects at scale 100, so the raw values are
   metres wearing a x100 coat; a wrapper node at 1/100 takes the coat off
   uniformly, above the skeleton, without touching the bind pose. */
const nodeIndex = new Map();
for (const m of models) {
  const l = localOf.get(m.id);
  nodeIndex.set(m.id, gltf.nodes.length);
  gltf.nodes.push({
    name: m.name,
    translation: l.t, rotation: l.q,
    ...(Math.abs(l.s[0] - 1) + Math.abs(l.s[1] - 1) + Math.abs(l.s[2] - 1) > 1e-6 ? { scale: l.s } : {})
  });
}
for (const m of models) {
  const ch = (childrenOf.get(m.id) || []).map(c => c.id).filter(c => nodeIndex.has(c));
  if (ch.length) gltf.nodes[nodeIndex.get(m.id)].children = ch.map(c => nodeIndex.get(c));
}

/* material + texture */
let matIndex = 0;
{
  const texPath = TEX || null;
  let texIdx = null;
  if (texPath && fs.existsSync(texPath)) {
    const png = fs.readFileSync(texPath);
    const off = push(png, 4);
    gltf.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: png.length });
    gltf.images = [{ bufferView: gltf.bufferViews.length - 1, mimeType: 'image/png' }];
    gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }];
    gltf.textures = [{ sampler: 0, source: 0 }];
    texIdx = 0;
  }
  gltf.materials.push({
    name: 'ochi',
    pbrMetallicRoughness: {
      ...(texIdx != null ? { baseColorTexture: { index: texIdx } } : { baseColorFactor: [0.8, 0.8, 0.8, 1] }),
      metallicFactor: 0, roughnessFactor: 0.85
    }
  });
}

/* mesh + skin */
const meshNodes = [];
let totalTris = 0, totalVerts = 0, maxInfluences = 0;
for (const g of geoms) {
  const geo = g.geo;
  const pos = new Float32Array(geo.position);
  const nor = new Float32Array(geo.normal);
  const uv0 = new Float32Array(geo.uv);
  const idx = new Uint32Array(geo.indices);
  const attributes = {
    POSITION: accessor(pos, 'VEC3', CT.f32, 34962, { minmax: true }),
    NORMAL: accessor(nor, 'VEC3', CT.f32, 34962),
    TEXCOORD_0: accessor(uv0, 'VEC2', CT.f32, 34962)
  };
  /* The mesh model's own global — it is a scene root in these files, so its
     local IS its global; compose the chain anyway rather than assume. */
  let meshGlobal = M4.ident();
  for (let id = g.model.id; id != null && byId.has(id); id = parentOf.get(id)) {
    const l = localOf.get(id);
    meshGlobal = M4.mul(trsMatrix(l.t, l.q, l.s), meshGlobal);
  }
  const sk = skinFor(g.geoObj, geo, meshGlobal);
  let skinIdx = null;
  if (sk) {
    maxInfluences = Math.max(maxInfluences, sk.maxInf);
    attributes.JOINTS_0 = accessor(sk.joints, 'VEC4', CT.u16, 34962);
    attributes.WEIGHTS_0 = accessor(sk.weights, 'VEC4', CT.f32, 34962);
    const ibmAcc = accessor(sk.inverseBind, 'MAT4', CT.f32, null);
    gltf.skins.push({ inverseBindMatrices: ibmAcc, joints: jointOrder.map(id => nodeIndex.get(id)), skeleton: nodeIndex.get(jointOrder[0]) });
    skinIdx = gltf.skins.length - 1;
  }
  gltf.meshes.push({
    name: g.geoObj.name,
    primitives: [{ attributes, indices: accessor(idx, 'SCALAR', CT.u32, 34963), material: matIndex, mode: 4 }]
  });
  const mn = nodeIndex.get(g.model.id);
  gltf.nodes[mn].mesh = gltf.meshes.length - 1;
  if (skinIdx != null) gltf.nodes[mn].skin = skinIdx;
  meshNodes.push(mn);
  totalTris += idx.length / 3; totalVerts += pos.length / 3;
}

/* animations: sample every driven joint onto a common timeline */
const anims = animations();
for (const a of anims) {
  const channels = [], samplers = [];
  for (const [nodeId, slot] of a.tracks) {
    const j = nodeIndex.get(nodeId);
    const rest = localOf.get(nodeId);
    const ord = ORDER[(prop70(byId.get(nodeId).node, 'RotationOrder') || [0])[0]] || 'XYZ';
    // union of key times across this node's curves
    const ts = new Set();
    for (const kind of ['T', 'R', 'S']) for (const ax of 'XYZ') {
      const c = slot[kind] && slot[kind][ax];
      if (c) c.times.forEach(t => ts.add(+t.toFixed(6)));
    }
    const times = [...ts].sort((x, y) => x - y);
    if (!times.length) continue;
    const at = (c, t, dflt) => {
      if (!c || !c.times.length) return dflt;
      let i = 0;
      while (i < c.times.length - 1 && c.times[i + 1] <= t) i++;
      if (t <= c.times[0]) return c.vals[0];
      if (t >= c.times[c.times.length - 1]) return c.vals[c.vals.length - 1];
      const t0 = c.times[i], t1 = c.times[i + 1];
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      return c.vals[i] + (c.vals[i + 1] - c.vals[i]) * u;
    };
    const T = new Float32Array(times.length * 3);
    const R = new Float32Array(times.length * 4);
    const S = new Float32Array(times.length * 3);
    let hasT = !!slot.T, hasR = !!slot.R, hasS = !!slot.S;
    times.forEach((t, i) => {
      if (hasT) {
        T[i * 3] = at(slot.T.X, t, rest.t[0]); T[i * 3 + 1] = at(slot.T.Y, t, rest.t[1]); T[i * 3 + 2] = at(slot.T.Z, t, rest.t[2]);
      }
      if (hasR) {
        const q = eulerToQuat(at(slot.R.X, t, 0), at(slot.R.Y, t, 0), at(slot.R.Z, t, 0), ord);
        R[i * 4] = q[0]; R[i * 4 + 1] = q[1]; R[i * 4 + 2] = q[2]; R[i * 4 + 3] = q[3];
      }
      if (hasS) {
        S[i * 3] = at(slot.S.X, t, rest.s[0]); S[i * 3 + 1] = at(slot.S.Y, t, rest.s[1]); S[i * 3 + 2] = at(slot.S.Z, t, rest.s[2]);
      }
    });
    const tAcc = accessor(new Float32Array(times), 'SCALAR', CT.f32, null, { minmax: true });
    const add = (data, type, pathName) => {
      samplers.push({ input: tAcc, output: accessor(data, type, CT.f32, null), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: j, path: pathName } });
    };
    if (hasT) add(T, 'VEC3', 'translation');
    if (hasR) add(R, 'VEC4', 'rotation');
    if (hasS) add(S, 'VEC3', 'scale');
  }
  if (channels.length) {
    // "Metarig Man.013|American Football Run Fast" -> "American Football Run Fast"
    const raw = a.name.includes('|') ? a.name.split('|').pop() : a.name;
    // …and then to the game's own vocabulary, if this one is being adopted.
    if (NO_ANIM && !ADOPT.has(raw)) continue;    // dropped, as --no-anim asks
    const nm = ADOPT.get(raw) || raw;
    if (ADOPT.has(raw)) adopted.add(nm);
    gltf.animations.push({ name: nm, channels, samplers });
  }
}

/* RETARGETED CLIPS, baked in from tools/motion-ochi/*.json.

   These are CMU motion capture carried onto this rig by
   tools/mocap/retarget-ochi.mjs: quaternion tracks per bone plus a pelvis
   height, already sampled, so nothing here needs the network or the .amc. A
   clip whose name matches one of the FBX's own replaces it — the same swap
   mechanism tools/motion/ has for the game's rig, and for the same reason: what
   ships should be a matter of listing a directory. */
const skippedForAdopt = [];
if (MOTION && fs.existsSync(MOTION)) {
  const files = fs.readdirSync(MOTION).filter(f => f.endsWith('.json')).sort();
  for (const f of files) {
    const m = JSON.parse(fs.readFileSync(path.join(MOTION, f), 'utf8'));
    // An adopted clip is Studio Ochi's own, and it wins: replacing it here with
    // the retargeted clip of the same name is exactly what adopting means not
    // to do.
    if (adopted.has(m.clip)) { skippedForAdopt.push(m.clip); continue; }
    /* A CYCLIC CLIP NEEDS ITS CLOSING KEY. The samples cover the cycle at
       dur*i/n for i < n, so the last one sits at dur*(n-1)/n and three.js — 
       which takes a clip's duration from its final keyframe — would loop
       1/n of a stride early, every stride. Repeating sample 0 at t = dur costs
       one key and makes the cadence the authored one: Run came out at 0.60s
       against the 0.62s its own extras declare. */
    const n0 = m.steps, dur = m.duration || 1;
    const n = m.cyclic ? n0 + 1 : n0;
    const at = i => (i % n0);
    const times = new Float32Array(n);
    for (let i = 0; i < n; i++) times[i] = (dur * i) / (m.cyclic ? n0 : Math.max(1, n0 - 1));
    const tAcc = accessor(times, 'SCALAR', CT.f32, null, { minmax: true });
    const channels = [], samplers = [];
    for (const bone in m.tracks) {
      const target = models.find(mm => mm.name === bone);
      if (!target || !nodeIndex.has(target.id)) continue;
      const q = m.tracks[bone];
      if (!q || q.length !== n0) continue;
      const R = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { const v = q[at(i)]; R[i * 4] = v[0]; R[i * 4 + 1] = v[1]; R[i * 4 + 2] = v[2]; R[i * 4 + 3] = v[3]; }
      samplers.push({ input: tAcc, output: accessor(R, 'VEC4', CT.f32, null), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex.get(target.id), path: 'rotation' } });
    }
    /* The pelvis height, in the rig's own units — the JSON carries metres and
       the bone sits under the armature's x100, so it goes back up by the same
       factor the wrapper takes off. */
    if (m.root && m.root.length === n0) {
      const hips = models.find(mm => mm.name === 'spine');
      if (hips && nodeIndex.has(hips.id)) {
        const rest = localOf.get(hips.id);
        const T = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { T[i * 3] = rest.t[0]; T[i * 3 + 1] = rest.t[1]; T[i * 3 + 2] = m.root[at(i)][1]; }
        samplers.push({ input: tAcc, output: accessor(T, 'VEC3', CT.f32, null), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node: nodeIndex.get(hips.id), path: 'translation' } });
      }
    }
    if (!channels.length) continue;
    const existing = gltf.animations.findIndex(a => a.name === m.clip);
    const anim = { name: m.clip, channels, samplers };
    if (existing >= 0) gltf.animations[existing] = anim; else gltf.animations.push(anim);
    retargeted.push(m.clip + (existing >= 0 ? ' (replaced)' : ''));
  }
}

/* The unit wrapper, and the scene under it. FBX's unit is the centimetre; the
   raw values are metres scaled by 100, so 1/100 hands back metres. */
const UNIT = 0.01;
const modelRoots = models.filter(m => !parentOf.has(m.id)).map(m => nodeIndex.get(m.id));
gltf.nodes.push({ name: 'FlagFootballRig', scale: [UNIT, UNIT, UNIT], children: modelRoots });
gltf.scenes[0].nodes = [gltf.nodes.length - 1];

/* ------------------------------------------------------------------- emit */
const binBuf = Buffer.concat(bin);
gltf.buffers = [{ byteLength: binBuf.length }];
const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
const binPad = Buffer.alloc((4 - (binBuf.length % 4)) % 4, 0);
const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);
const binChunk = Buffer.concat([binBuf, binPad]);
const header = Buffer.alloc(12);
header.write('glTF', 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonChunk.length, 0); jh.write('JSON', 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(binChunk.length, 0); bh.write('BIN\0', 4);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, jh, jsonChunk, bh, binChunk]));

/* ----------------------------------------------------------------- report */
const posAcc = gltf.meshes.map(m => gltf.accessors[m.primitives[0].attributes.POSITION]).filter(a => a.min);
const bbox = posAcc.length ? {
  min: [0, 1, 2].map(k => Math.min(...posAcc.map(a => a.min[k]))),
  max: [0, 1, 2].map(k => Math.max(...posAcc.map(a => a.max[k])))
} : null;
console.log(`\n${path.basename(IN)}  ->  ${OUT}`);
console.log(`  joints        ${jointOrder.length}`);
console.log(`  meshes        ${gltf.meshes.length}, ${totalVerts} vertices, ${totalTris} triangles`);
console.log(`  skin          ${gltf.skins.length ? 'yes' : 'NO'}, up to ${maxInfluences} influences per control point (top 4 kept)`);
console.log(`  texture       ${gltf.images ? 'embedded' : 'none — pass --texture'}`);
if (retargeted.length) console.log(`  retargeted    ${retargeted.join(', ')}`);
if (adopted.size) console.log(`  adopted       ${[...adopted].join(', ')}  (Studio Ochi's own, kept over ${skippedForAdopt.join(', ') || 'nothing'})`);
console.log(`  animations    ${gltf.animations.length}${gltf.animations.length ? ': ' + gltf.animations.map(a => a.name).join(', ') : ''}`);
if (bbox) {
  /* Report in the frame a viewer will see: the -90 X puts raw Z up, and the
     wrapper's 1/100 times the models' 100 is unity, so raw units are metres. */
  const up = [bbox.min[2], bbox.max[2]];
  const depth = [-bbox.max[1], -bbox.min[1]];
  console.log(`  height        ${(up[1] - up[0]).toFixed(3)} m   (y ${up[0].toFixed(3)} .. ${up[1].toFixed(3)} after the Z-up correction)`);
  console.log(`  width/depth   x ${(bbox.max[0] - bbox.min[0]).toFixed(3)} m,  z ${(depth[1] - depth[0]).toFixed(3)} m`);
}
if (skipped.length) console.log(`  skipped       ${skipped.length} empty geometry: ${skipped.join(', ')}`);
{
  const used = new Set();
  gltf.animations.forEach(a => a.samplers.forEach(sm => { used.add(sm.input); used.add(sm.output); }));
  let animB = 0, meshB = 0;
  gltf.accessors.forEach((a, i) => {
    const n = gltf.bufferViews[a.bufferView].byteLength;
    if (used.has(i)) animB += n; else meshB += n;
  });
  console.log(`                mesh+skin ${(meshB / 1024).toFixed(0)} KB, animation ${(animB / 1024).toFixed(0)} KB` +
    (gltf.images ? `, texture ${(gltf.bufferViews[gltf.images[0].bufferView].byteLength / 1024).toFixed(0)} KB` : ''));
}
console.log(`  file size     ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
if (STATS) {
  console.log('\n  joints, in order:');
  jointOrder.forEach((id, i) => console.log(`    ${String(i).padStart(2)} ${byId.get(id).name}`));
}
console.log('');
