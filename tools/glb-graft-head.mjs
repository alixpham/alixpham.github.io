#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — TAKE THE HELMET OFF, AND PUT A FACE ON

     node tools/glb-graft-head.mjs <target.glb> <out.glb> [--donor <donor.glb>]
     node tools/glb-graft-head.mjs <target.glb> --report

   The Studio Ochi athlete wears a helmet, and the helmet is not a part you can
   hide: `tools/build-ochi-player.mjs` files the shell and the facemask under
   `jersey` on purpose, so they take the team's primary colour, and the stripe
   and chinstrap under `trim`. The triangles are therefore MERGED INTO THE
   SHIRT, in one primitive with one material, and nothing in the renderer can
   address them. The only thing that tells a helmet triangle from a sleeve
   triangle is which bone it hangs off.

   THERE IS A HEAD UNDER THERE, AND IT IS NOT A HEAD. Sixteen `skin` triangles
   of flat face-plate, twelve of `hair` behind them: a closed shape, so nothing
   is inside out, but 0.17 m tall on a 1.74 m body where a head is 0.23 m, and
   with no face at all — no eyes, no nose, no mouth, no ears. It was never
   going to be seen. Delete the helmet and you get a small blank egg.

   So this does two things that only make sense together:

     1. DELETE, from the target, the helmet, the facemask, the face-plate and
        the hair cap — see `drops()` below for the rule and the one place it
        has to be stricter than "dominant bone is Head".

     2. GRAFT, from the donor, the head this repo already builds — `head`,
        the `hair_*`, the two `beard_*` and `band` — plus the donor's own
        neck, the `skin` rings above --neck. That head carries the UVs that
        `playermodel.js` draws its face canvas into (see `headUV` in
        build-player-glb.mjs, and `faceTexture` in playermodel.js), so the
        face, the eyes, the beard shadow and the hair styles all light up the
        moment the mesh is present. Nothing in the renderer changes.

        A donor mesh that is not finite geometry is REFUSED and named rather
        than copied: `hair_long` is 326 vertices of NaN in flagplayer.glb and
        would have arrived as one grafted player in six going bald.

   THE GRAFT IS A PURE SCALE AND SHIFT, and it is allowed to be because of a
   guarantee `glb-rerig.mjs` already makes: NO BONE CARRIES A REST ROTATION, in
   either rig. Both `Head` frames are world-aligned in bind pose, so a vertex
   moves by

        p' = Head_target + s * (p - Head_donor)

   with `s` the height ratio, and its normal does not move at all. Anything
   else — a rest rotation on either side — and this would need `restAlign` and
   a conjugation, which is the trap the CLAUDE.md notes describe twice.

   WHY THE NECK COMES TOO. The donor's neck is 0.054 m half-wide at the head
   seam and the target's flares to 0.063 m as it merges into the old chin:
   graft the head alone and that flare stands 12 mm proud of the new jaw, a
   shelf of flesh round the throat. Taking the donor's neck down to --neck
   (donor-space y, default 1.545) puts the seam at the target's own collar
   line, inside the shirt, with the graft sleeving 15 mm over what is left of
   the old neck so the rim is plugged from underneath. `--report` prints every
   candidate ring against the neck the cut actually leaves behind, so the fit
   is a number rather than a screenshot.

   A dev tool. Nothing in flagster/ imports it; the site ships no build step.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB, accessor, CTYPE, NCOMP } from './glb-read.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && opt(argv[i - 1].slice(2)) === a));

const TARGET = files[0];
const REPORT = has('report');
const OUT = REPORT ? null : files[1];
const DONOR = path.resolve(ROOT, opt('donor', 'flagster/lib/flagplayer.glb'));
const NECK_CUT = parseFloat(opt('neck', '1.545'));
const SCALE_OPT = opt('scale', 'auto');
const LIFT = parseFloat(opt('lift', '0'));

if (!TARGET || (!REPORT && !OUT)) {
  console.error('usage: node tools/glb-graft-head.mjs <target.glb> <out.glb> [--donor <donor.glb>] [--neck 1.545] [--scale auto] [--lift 0]');
  console.error('       node tools/glb-graft-head.mjs <target.glb> --report');
  process.exit(2);
}

/* Which donor nodes come across, and what each becomes in the target. The
   NODE name is what `playermodel.js` looks a part up by (`parts[o.name]`, and
   then `showOne('hair_', …)`), so these names are an interface, not labels. */
const GRAFT = [
  { node: 'head', material: 'head' },
  { node: 'hair_buzz', material: 'hair' }, { node: 'hair_crop', material: 'hair' },
  { node: 'hair_fade', material: 'hair' }, { node: 'hair_afro', material: 'hair' },
  { node: 'hair_locs', material: 'hair' }, { node: 'hair_long', material: 'hair' },
  { node: 'beard_goatee', material: 'hair' }, { node: 'beard_full', material: 'hair' },
  { node: 'band', material: 'trim' }
];

/* ------------------------------------------------------------------ glTF io */
function writeGLB(file, json, bin) {
  const pad = (b, v) => b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4, v)]) : b;
  const j = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const d = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + d.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(j.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(d.length, 0); bh.writeUInt32LE(0x004E4942, 4);
  fs.writeFileSync(file, Buffer.concat([head, jh, j, bh, d]));
}

/* Bind-pose world translation of a bone. Both rigs are rest-rotation-free by
   construction, so the chain is an addition and a matrix would only hide
   that — but it is asserted rather than assumed, below. */
function bindWorld(j, name) {
  const parent = new Int32Array(j.nodes.length).fill(-1);
  j.nodes.forEach((n, i) => (n.children || []).forEach(c => parent[c] = i));
  let i = j.nodes.findIndex(n => n.name === name);
  if (i < 0) throw new Error('no bone named ' + name);
  const p = [0, 0, 0];
  for (; i >= 0; i = parent[i]) {
    const n = j.nodes[i];
    if (n.matrix) throw new Error(name + ': node ' + n.name + ' carries a matrix, not TRS');
    if (n.rotation && n.rotation.some((v, k) => Math.abs(v - (k === 3 ? 1 : 0)) > 1e-6)) {
      throw new Error(name + ': node ' + n.name + ' carries a rest rotation — this graft assumes none (see glb-rerig.mjs)');
    }
    if (n.scale && n.scale.some(v => Math.abs(v - 1) > 1e-6)) throw new Error(name + ': node ' + n.name + ' carries a rest scale');
    const t = n.translation || [0, 0, 0];
    p[0] += t[0]; p[1] += t[1]; p[2] += t[2];
  }
  return p;
}

/* Height of the character as its geometry actually stands, which is not always
   what `extras.authorHeight` says once triangles have been added or removed.
   `only` restricts it to named nodes. */
function meshHeight(g, only) {
  let lo = Infinity, hi = -Infinity;
  for (const n of g.json.nodes) {
    if (n.mesh == null) continue;
    if (only && !only.includes(n.name)) continue;
    for (const p of g.json.meshes[n.mesh].primitives) {
      const pos = accessor(g, p.attributes.POSITION);
      for (const v of new Set(accessor(g, p.indices))) {
        const y = pos[v * 3 + 1];
        if (y < lo) lo = y; if (y > hi) hi = y;
      }
    }
  }
  return { lo, hi, h: hi - lo };
}

/* THE SCALE IS A RATIO OF AUTHORED HEIGHTS, NOT OF BOUNDING BOXES. The tallest
   vertex on the donor belongs to the afro, which is 26 mm of hair and not part
   of anybody's height; measuring the box instead of the character shrank the
   graft by 1%. `authorHeight` is the same number `playermodel.js` normalises
   both characters by, so a head scaled by it lands the same size on the field
   whichever body is underneath. */
const DOC_HEIGHT = 1.850;
function authorHeight(g) {
  const ud = (g.json.scenes[0] && g.json.scenes[0].extras) || {};
  return ud.authorHeight > 0 ? ud.authorHeight : DOC_HEIGHT;
}

/* Which bone owns a vertex. The rule everywhere in this repo is the dominant
   one, not the weighted mean: a mean of Head and Neck is neither. */
function dominant(jo, we, v) {
  let b = -1, w = -1;
  for (let k = 0; k < 4; k++) { const ww = we[v * 4 + k]; if (ww > w) { w = ww; b = jo[v * 4 + k]; } }
  return b;
}

/* Every vertex of a model that belongs to a triangle passing `keep`, as plain
   points. Rings are then measured off THAT — a ring taken off the file as it
   stands measures the face-plate this graft is about to delete, which is how
   the seam first read as a 12 mm overhang that did not exist. */
function pointsOf(g, keep) {
  const out = [];
  for (const node of g.json.nodes) {
    if (node.mesh == null) continue;
    for (const p of g.json.meshes[node.mesh].primitives) {
      const mat = g.json.materials[p.material].name;
      const pos = accessor(g, p.attributes.POSITION);
      const jo = accessor(g, p.attributes.JOINTS_0), we = accessor(g, p.attributes.WEIGHTS_0);
      const idx = accessor(g, p.indices);
      const seen = new Set();
      for (let t = 0; t < idx.length; t += 3) {
        const vs = [idx[t], idx[t + 1], idx[t + 2]];
        if (!keep(node, mat, vs.map(v => dominant(jo, we, v)))) continue;
        for (const v of vs) {
          if (seen.has(v)) continue;
          seen.add(v);
          out.push([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
        }
      }
    }
  }
  return out;
}

/* A ring of those points at a height, as the two numbers that decide whether a
   seam shows: how wide it is and where its centre sits. */
function ringAt(points, y, tol) {
  let x = 0, z0 = Infinity, z1 = -Infinity, n = 0;
  for (const [px, py, pz] of points) {
    if (Math.abs(py - y) > tol) continue;
    x = Math.max(x, Math.abs(px));
    z0 = Math.min(z0, pz); z1 = Math.max(z1, pz);
    n++;
  }
  return n ? { halfWidth: x, z0, z1, n } : null;
}

/* ------------------------------------------------------------------- inputs */
const T = readGLB(path.resolve(ROOT, TARGET));
const D = readGLB(DONOR);
const TJ = T.json, DJ = D.json;

const tJoints = TJ.skins[0].joints.map(i => TJ.nodes[i].name);
const dJoints = DJ.skins[0].joints.map(i => DJ.nodes[i].name);
const T_HEAD = tJoints.indexOf('Head'), T_NECK = tJoints.indexOf('Neck');
if (T_HEAD < 0 || T_NECK < 0) { console.error('target rig has no Head/Neck joint'); process.exit(1); }

const hT = bindWorld(TJ, 'Head'), hD = bindWorld(DJ, 'Head');
const tH = meshHeight(T), dH = meshHeight(D);
const S = SCALE_OPT === 'auto' ? authorHeight(T) / authorHeight(D) : parseFloat(SCALE_OPT);
const map = p => [hT[0] + S * (p[0] - hD[0]), hT[1] + LIFT + S * (p[1] - hD[1]), hT[2] + S * (p[2] - hD[2])];

/* --------------------------------------------------------------- what goes */
/* WHAT GOES, AND THE ONE PLACE THE RULE HAS TO BE STRICTER.

   Everywhere: a triangle owned by `Head` is helmet or stub head, and goes.

   On `skin` and `hair` that is not enough, and the file says why. This body's
   neck is not neck-weighted — it is mostly `spine.003`/`spine.004`, with one
   band of triangles that straddles Head and Neck and carries the JAW FLARE:
   half-width 0.0464 at y 1.478 and 0.0629 by 1.528, widening as it merges
   into the old chin. Judged by majority those triangles are Neck's, they
   survive, and the flare then stands 12 mm outside the new jaw — a shelf of
   flesh round the throat. So on skin and hair a triangle goes if ANY of its
   three vertices is Head's, which takes the whole band and leaves a neck that
   tops out at 0.045 and stays inside the graft.

   `jersey` and `trim` keep the majority rule, because their neck triangles are
   the COLLAR and a collar is shirt: widen the rule there and the shirt loses
   its neckline along with the chinstrap. */
function drops(mat, ds) {
  const head = ds.filter(d => d === T_HEAD).length;
  if (mat === 'hair') return head >= 1 || ds.filter(d => d === T_NECK).length >= 2;
  if (mat === 'skin') return head >= 1;
  return head >= 2;
}

/* ------------------------------------------------------------------ report */
if (REPORT) {
  console.log(`\n  target ${path.relative(ROOT, path.resolve(ROOT, TARGET))}   ${tH.h.toFixed(4)} m   Head bone y ${hT[1].toFixed(4)} z ${hT[2].toFixed(4)}`);
  console.log(`  donor  ${path.relative(ROOT, DONOR)}   ${dH.h.toFixed(4)} m   Head bone y ${hD[1].toFixed(4)} z ${hD[2].toFixed(4)}`);
  console.log(`  scale  ${S.toFixed(4)}${SCALE_OPT === 'auto' ? '  (height ratio)' : '  (given)'}${LIFT ? '   lift ' + LIFT.toFixed(4) : ''}\n`);

  let total = 0;
  for (const p of TJ.meshes[TJ.nodes.find(n => n.mesh != null).mesh].primitives) { void p; }
  for (const node of TJ.nodes) {
    if (node.mesh == null) continue;
    for (const p of TJ.meshes[node.mesh].primitives) {
      const mat = TJ.materials[p.material].name;
      const jo = accessor(T, p.attributes.JOINTS_0), we = accessor(T, p.attributes.WEIGHTS_0);
      const idx = accessor(T, p.indices);
      let n = 0;
      for (let t = 0; t < idx.length; t += 3) {
        const ds = [dominant(jo, we, idx[t]), dominant(jo, we, idx[t + 1]), dominant(jo, we, idx[t + 2])];
        if (drops(mat, ds)) n++;
      }
      if (n) { console.log(`  drop  ${mat.padEnd(8)} ${String(n).padStart(4)} of ${String(idx.length / 3).padStart(4)} triangles`); total += n; }
    }
  }
  console.log(`  drop  ${'total'.padEnd(8)} ${String(total).padStart(4)}\n`);

  /* WHERE TO CUT THE DONOR'S NECK is the one number this graft turns on, so it
     is a table and not a guess. Each donor ring, scaled and placed, against
     whatever the target's own neck is doing at that height: the right cut is
     the row where the two half-widths meet AND the target still has geometry
     to plug the rim. A grafted ring wider than the old one stands proud of the
     collar; a narrower one leaves the old neck showing round the new jaw. */
  console.log('  donor neck rings, placed, against the neck the target is LEFT with');
  console.log(`    ${'donor y'.padStart(8)} ${'-> target'.padStart(9)}  ${'grafted'.padStart(8)} ${'target'.padStart(8)}  ${'diff'.padStart(7)}`);
  const donorNeck = pointsOf(D, n => n.name === 'skin');
  const targetNeck = pointsOf(T, (n, m, ds) => m === 'skin' && !drops(m, ds));
  const donorYs = [...new Set(donorNeck.map(p => Math.round(p[1] * 1e4) / 1e4))].filter(y => y >= 1.40 && y <= 1.62).sort((a, b) => a - b);
  for (const dy of donorYs) {
    const r = ringAt(donorNeck, dy, 0.0005);
    const ty = hT[1] + LIFT + S * (dy - hD[1]);
    const o = ringAt(targetNeck, ty, 0.015);
    const d = r && o ? (r.halfWidth * S - o.halfWidth) : null;
    const mark = d == null ? '  (nothing to plug the rim)' : (d > 0 && d < 0.008 ? '  <- fits: the graft sleeves over it' : (d <= 0 ? '  the old neck would show' : ''));
    console.log(`    ${dy.toFixed(4).padStart(8)} ${ty.toFixed(4).padStart(9)}  ${(r ? (r.halfWidth * S).toFixed(4) : '-').padStart(8)} ${(o ? o.halfWidth.toFixed(4) : '-').padStart(8)}  ` +
      `${(d != null ? (d * 1000).toFixed(1) + 'mm' : '-').padStart(7)}${mark}`);
  }

  const hd = meshHeight(D, ['head']);
  console.log(`\n  grafted head   y ${(hT[1] + LIFT + S * (hd.lo - hD[1])).toFixed(4)}..${(hT[1] + LIFT + S * (hd.hi - hD[1])).toFixed(4)}` +
    `   ${(hd.h * S).toFixed(4)} m tall, 1/${(tH.h / (hd.h * S)).toFixed(1)} of the body`);
  console.log(`  it replaces    y 1.4658..${tH.hi.toFixed(4)}   the helmet, which is ${(tH.hi - 1.4658).toFixed(4)} m of the same\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------ rewrite */
const newViews = [];
function addAccessor(arr, componentType, type, normalized, extra) {
  const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  TJ.bufferViews.push({ buffer: 0, byteOffset: -1, byteLength: bytes.length, ...(extra || {}) });
  newViews.push({ view: TJ.bufferViews.length - 1, bytes });
  const n = NCOMP[type];
  const a = { bufferView: TJ.bufferViews.length - 1, componentType, count: arr.length / n, type };
  if (normalized) a.normalized = true;
  if (type === 'VEC3' && componentType === 5126) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < arr.length; k += 3) for (let c = 0; c < 3; c++) {
      if (arr[k + c] < min[c]) min[c] = arr[k + c];
      if (arr[k + c] > max[c]) max[c] = arr[k + c];
    }
    a.min = min; a.max = max;
  }
  if (type === 'SCALAR') { a.min = [Math.min(...arr)]; a.max = [Math.max(...arr)]; }
  TJ.accessors.push(a);
  return TJ.accessors.length - 1;
}

/* A material the target does not have yet — `head`, on a character that never
   had a face. White, so `material.color` still carries the whole tint and the
   runtime face canvas multiplies over it; everything in this pipeline hands
   the renderer white artwork for exactly that reason. */
function materialIndex(name) {
  let i = TJ.materials.findIndex(m => m.name === name);
  if (i >= 0) return i;
  const donor = DJ.materials.find(m => m.name === name);
  const skin = TJ.materials.find(m => m.name === 'skin');
  TJ.materials.push({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      metallicFactor: (skin || donor).pbrMetallicRoughness.metallicFactor ?? 0,
      roughnessFactor: (skin || donor).pbrMetallicRoughness.roughnessFactor ?? 0.85
    }
  });
  return TJ.materials.length - 1;
}

/* Donor joint index -> target joint index, by bone NAME. The two skins have
   different joint orders and different lengths; indexing one with the other is
   the same class of bug as indexing a five-long celebration pool by a global
   slot. A donor bone the target does not have is a hard error, not a silent
   weight dropped on the floor.

   Resolved lazily, per joint the grafted triangles ACTUALLY reference: the
   donor rig carries bones this one does not (`Flag_L`, `Flag_R` — it grows its
   own flag belt, and the target hangs one off a socket instead), and mapping
   the whole skin up front turned a bone the head never touches into a fatal
   error. */
const jointMap = i => {
  const nm = dJoints[i];
  const k = tJoints.indexOf(nm);
  if (k < 0) throw new Error(`grafted geometry is weighted to donor bone ${nm}, which the target rig does not have`);
  return k;
};

/* Take one donor primitive across: transform the positions, keep everything
   else, remap the joints. `pick` selects triangles; null takes them all. */
function transplant(prim, pick) {
  const pos = accessor(D, prim.attributes.POSITION);
  const idx = accessor(D, prim.indices);

  /* A DONOR MESH IS NOT AUTOMATICALLY GOOD GEOMETRY, and this is the check
     that says so. `hair_long` in flagplayer.glb is 326 vertices of NaN — its
     row in the builder's style table sets `rib` and forgets `ribs`, so the
     thickness term is Math.cos(NaN) — and it has therefore rendered as
     nothing for as long as it has existed. Carried across silently it would
     have made one grafted player in six bald and looked like this tool's
     fault. Refuse it, name it, and let the caller go on without it. */
  for (let k = 0; k < pos.length; k++) {
    if (!Number.isFinite(pos[k])) return { bad: 'position ' + (k / 3 | 0) + ' is not a finite number' };
  }

  const keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    if (pick && !pick([idx[t], idx[t + 1], idx[t + 2]], pos)) continue;
    keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  if (!keep.length) return null;

  /* Only the vertices the kept triangles actually reference, renumbered. A
     transplanted neck that carried the whole body's vertex array would work
     and would also quadruple the file. */
  const remap = new Map();
  const order = [];
  for (const v of keep) if (!remap.has(v)) { remap.set(v, order.length); order.push(v); }

  const P = new Float32Array(order.length * 3);
  order.forEach((v, k) => { const q = map([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]); P[k * 3] = q[0]; P[k * 3 + 1] = q[1]; P[k * 3 + 2] = q[2]; });

  const attributes = { POSITION: addAccessor(P, 5126, 'VEC3', false, { target: 34962 }) };

  /* A uniform scale leaves a normal exactly where it was, which is the whole
     reason this graft is allowed to be a scale and a shift. */
  for (const [name, type, ct] of [['NORMAL', 'VEC3', 5126], ['TEXCOORD_0', 'VEC2', 5126], ['WEIGHTS_0', 'VEC4', 5126]]) {
    if (prim.attributes[name] == null) continue;
    const src = accessor(D, prim.attributes[name]);
    const n = NCOMP[type];
    const out = new Float32Array(order.length * n);
    order.forEach((v, k) => out.set(src.subarray(v * n, v * n + n), k * n));
    attributes[name] = addAccessor(out, ct, type, false, { target: 34962 });
  }
  if (prim.attributes.COLOR_0 != null) {
    const a = DJ.accessors[prim.attributes.COLOR_0];
    const src = accessor(D, prim.attributes.COLOR_0);
    const n = NCOMP[a.type];
    const out = new (CTYPE[a.componentType])(order.length * n);
    order.forEach((v, k) => out.set(src.subarray(v * n, v * n + n), k * n));
    attributes.COLOR_0 = addAccessor(out, a.componentType, a.type, a.normalized, { target: 34962 });
  }
  {
    const src = accessor(D, prim.attributes.JOINTS_0);
    const out = new Uint16Array(order.length * 4);
    order.forEach((v, k) => { for (let c = 0; c < 4; c++) out[k * 4 + c] = jointMap(src[v * 4 + c]); });
    attributes.JOINTS_0 = addAccessor(out, 5123, 'VEC4', false, { target: 34962 });
  }

  const I = new Uint32Array(keep.length);
  keep.forEach((v, k) => I[k] = remap.get(v));
  return { attributes, indices: addAccessor(I, 5125, 'SCALAR', false, { target: 34963 }), tris: keep.length / 3 };
}

/* ---- 1. cut the helmet and the stub head out of the target --------------- */
let cut = 0;
for (const node of TJ.nodes) {
  if (node.mesh == null) continue;
  for (const p of TJ.meshes[node.mesh].primitives) {
    const mat = TJ.materials[p.material].name;
    const jo = accessor(T, p.attributes.JOINTS_0), we = accessor(T, p.attributes.WEIGHTS_0);
    const idx = accessor(T, p.indices);
    const keep = [];
    for (let t = 0; t < idx.length; t += 3) {
      const ds = [dominant(jo, we, idx[t]), dominant(jo, we, idx[t + 1]), dominant(jo, we, idx[t + 2])];
      if (drops(mat, ds)) { cut++; continue; }
      keep.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    if (keep.length === idx.length) continue;
    const I = new Uint32Array(keep);
    p.indices = addAccessor(I, 5125, 'SCALAR', false, { target: 34963 });
    console.log(`  cut   ${mat.padEnd(8)} ${String((idx.length - keep.length) / 3).padStart(4)} triangles`);
  }
}

/* ---- 2. graft the donor's head, hair, beards, band and neck -------------- */
const skinIndex = 0;
function addNode(name, prims) {
  TJ.meshes.push({ name, primitives: prims });
  TJ.nodes.push({ name, mesh: TJ.meshes.length - 1, skin: skinIndex });
  TJ.scenes[0].nodes.push(TJ.nodes.length - 1);
}

let added = 0;
const skipped = [];
for (const g of GRAFT) {
  const node = DJ.nodes.find(n => n.name === g.node);
  if (!node || node.mesh == null) { console.log(`  skip  ${g.node} — not in the donor`); continue; }
  const out = [];
  let tris = 0, bad = null;
  for (const prim of DJ.meshes[node.mesh].primitives) {
    const t = transplant(prim, null);
    if (!t) continue;
    if (t.bad) { bad = t.bad; continue; }
    out.push({ attributes: t.attributes, indices: t.indices, material: materialIndex(g.material) });
    tris += t.tris;
  }
  if (out.length) addNode(g.node, out);
  added += tris;
  if (bad && !out.length) { skipped.push(g.node); console.log(`  SKIP  ${g.node.padEnd(13)} broken in the donor: ${bad}`); }
  else console.log(`  graft ${g.node.padEnd(13)} ${String(tris).padStart(5)} triangles  -> ${g.material}`);
}

/* The neck, which is a slice of the donor's `skin` mesh rather than a mesh of
   its own: everything at or above --neck, taken whole-triangle so the rim
   stays closed. */
const donorSkin = DJ.nodes.find(n => n.name === 'skin');
if (donorSkin) {
  const out = [];
  for (const prim of DJ.meshes[donorSkin.mesh].primitives) {
    const t = transplant(prim, (vs, pos) => vs.every(v => pos[v * 3 + 1] >= NECK_CUT - 1e-4));
    if (t && t.bad) { console.log('  SKIP  neck — ' + t.bad); continue; }
    if (t) { out.push({ attributes: t.attributes, indices: t.indices, material: materialIndex('skin') }); console.log(`  graft ${'neck'.padEnd(13)} ${String(t.tris).padStart(5)} triangles`); }
  }
  if (out.length) addNode('neck', out);
}

/* ---- 3. re-pack ---------------------------------------------------------- */
const parts = [T.bin];
let off = T.bin.length;
for (const nv of newViews) {
  const padTo = (4 - off % 4) % 4;
  if (padTo) { parts.push(Buffer.alloc(padTo)); off += padTo; }
  TJ.bufferViews[nv.view].byteOffset = off;
  parts.push(nv.bytes); off += nv.bytes.length;
}
const bin = Buffer.concat(parts);
TJ.buffers[0].byteLength = bin.length;
delete TJ.buffers[0].uri;

const outPath = path.resolve(ROOT, OUT);
writeGLB(outPath, TJ, bin);

const after = meshHeight(readGLB(outPath));
console.log(`\n  scale ${S.toFixed(4)}   cut ${cut} triangles   grafted ${added} + neck`);
console.log(`  height ${tH.h.toFixed(4)} m -> ${after.h.toFixed(4)} m   (authorHeight left alone: it is the reference the gait ladder was measured against)`);
console.log(`  ${path.relative(ROOT, outPath)}   ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB\n`);
