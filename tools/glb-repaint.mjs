#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — REPAINT A GLB BY ITS TEXTURE ATLAS

     node tools/glb-repaint.mjs model.glb --report
     node tools/glb-repaint.mjs model.glb out.glb --map 262262=jersey,27aae1=helmet
     node tools/glb-repaint.mjs model.glb out.glb --map 262262=jersey:ffffff --debug

   WHY. The game tints every player by team: `playermodel.js` hands each of ten
   named material regions its own `material.color`, and the multiply lands on
   white artwork. A bought character arrives with the opposite arrangement —
   ONE material, ONE texture, and the shirt colour baked into the pixels — so
   there is nothing to tint, which is what blocked the Studio Ochi athletes
   from being usable at all.

   THE OCHI ATLAS IS A PALETTE, NOT A PAINTING. Eight 1000x1000 tiles of flat
   colour laid side by side. Five are a single colour to the pixel; the other
   three carry one small decal apiece — a jersey number, in the three
   colourways the shirt needs. So the texture is really an eight-entry lookup
   table, the mesh is already partitioned into eight paint regions, and the
   partition is recovered by asking one question per triangle: which colour do
   my UVs sit in?

   That makes the split all but lossless. Triangles are regrouped into one
   primitive per colour, all of them still pointing at the SAME position,
   normal, joint and weight accessors — no vertex is duplicated, no seam is
   introduced, the skinning is untouched. Only the index buffer is rewritten,
   and each group gets a material whose `baseColorFactor` is the colour it
   replaces. The texture is then dead, and dropped.

   Anything a group is named through `--map` becomes a material of that name,
   which is the contract `playermodel.js` looks for. Give it a colour after a
   colon (`jersey:ffffff`) to hand the runtime white to multiply into.

   ONE PALETTE ENTRY CAN BE TWO GARMENTS. A colour is a paint bucket, not a
   region: Ochi's navy is the trousers AND the panel the chest number sits on,
   so tinting by colour alone drags the trousers along with the shirt. Writing
   `262262@breast=panel` splits that entry by the bone its triangles hang off,
   which is the one label that knows a chest from a thigh — the pattern is a
   regular expression against the dominant joint's name.

   ASK THE TRIANGLE, NOT THE POINT. A triangle is assigned the MODAL colour
   over its whole UV footprint, sampled barycentrically, rather than the colour
   under its centroid. One sample gets two things wrong that matter here: a
   triangle straddling a tile seam lands on the blended pixel between them and
   invents a ninth region out of a single face, and a triangle over a decal is
   filed under the decal rather than under the shirt it is printed on.

   WHAT IS LOST is exactly the samples that disagreed with their triangle's
   mode, and `--report` prints that as a percentage. Near zero means the
   regions really are flat and the split costs nothing. A few percent means
   small painted detail is being flattened away — on Ochi that is the number,
   which cannot survive anyway, because a tintable shirt is a shirt with no
   pixels of its own. Tens of percent means the atlas is a picture and this
   tool is the wrong one.

   `--debug` paints the groups in loud primaries instead, so a render names
   them: run it, view the result, then write the real `--map`.
   ============================================================================ */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readGLB, accessor } from './glb-read.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && opt(argv[i - 1].slice(2)) === a));
const SRC = files[0];
const REPORT = has('report');
const DEBUG = has('debug');
const OUT = REPORT ? null : files[1];

if (!SRC || (!REPORT && !OUT)) {
  console.error('usage: node tools/glb-repaint.mjs <in.glb> --report');
  console.error('       node tools/glb-repaint.mjs <in.glb> <out.glb> [--map hex=name[:rrggbb],...] [--debug]');
  process.exit(2);
}

/* ------------------------------------------------------------------ glTF io */
function writeGLB(file, json, bin) {
  const pad = (b, v) => b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4, v)]) : b;
  const j = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const d = pad(bin, 0);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + (d.length ? 8 + d.length : 0), 8);
  const parts = [head, Buffer.alloc(8), j];
  parts[1].writeUInt32LE(j.length, 0); parts[1].writeUInt32LE(0x4E4F534A, 4);
  if (d.length) { const h = Buffer.alloc(8); h.writeUInt32LE(d.length, 0); h.writeUInt32LE(0x004E4942, 4); parts.push(h, d); }
  fs.writeFileSync(file, Buffer.concat(parts));
}

/* -------------------------------------------------------------------- PNG in */
/* 8-bit, non-interlaced, greyscale/RGB/RGBA. Enough for an atlas; node:zlib is
   the only import, which is the same bargain fbx-read.mjs strikes. */
function decodePNG(buf) {
  let p = 8; const idat = []; let w = 0, h = 0, ch = 0;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), off = p + 8;
    if (type === 'IHDR') {
      w = buf.readUInt32BE(off); h = buf.readUInt32BE(off + 4);
      if (buf[off + 8] !== 8) throw new Error('PNG bit depth ' + buf[off + 8] + ' unsupported');
      ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[buf[off + 9]];
      if (!ch) throw new Error('PNG colour type ' + buf[off + 9] + ' unsupported');
      if (buf[off + 12]) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(buf.subarray(off, off + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++], line = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prv = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prv ? prv[i] : 0, c = (prv && i >= ch) ? prv[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}
const sRGBtoLinear = s => (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4));


/* ==================================================================== repaint */
const G = readGLB(SRC);
const J = G.json, bin = G.bin;

/* Find the primitives worth splitting: textured, UV'd, indexed. */
const targets = [];
for (const mesh of J.meshes || []) {
  for (const prim of mesh.primitives) {
    if (prim.indices == null || prim.attributes.TEXCOORD_0 == null || prim.material == null) continue;
    const tex = J.materials[prim.material]?.pbrMetallicRoughness?.baseColorTexture;
    if (!tex) continue;
    targets.push({ mesh, prim, image: J.textures[tex.index].source });
  }
}
if (!targets.length) { console.error('nothing to repaint: no indexed, UV-mapped, textured primitive'); process.exit(1); }

/* Decode each atlas once. */
const atlas = new Map();
for (const t of targets) {
  if (atlas.has(t.image)) continue;
  const img = J.images[t.image];
  if (img.bufferView == null) throw new Error('image ' + t.image + ' is a URI, not embedded');
  const bv = J.bufferViews[img.bufferView];
  atlas.set(t.image, decodePNG(bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength)));
}

const hex3 = (r, g, b) => [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
const DEBUG_COLOURS = ['ff2d2d', '2dff4a', '2d6bff', 'ffe62d', 'ff2df0', '2df0ff', 'ff8c2d', 'ffffff', '8a2dff', '9c6b3a'];

/* Parse --map: "262262=jersey,27aae1=trim:ffffff,262262@breast=panel" */
const MAP = new Map();
const BONE_RULES = [];
for (const e of (opt('map', '') || '').split(',').filter(Boolean)) {
  const [key, rest] = e.split('=');
  if (!rest) { console.error('bad --map entry: ' + e); process.exit(2); }
  const [name, colour] = rest.split(':');
  const k = key.replace(/^#/, '').toLowerCase();
  MAP.set(k, { name, colour: colour ? colour.replace(/^#/, '').toLowerCase() : null });
  if (k.includes('@')) {
    const [hex, pat] = k.split('@');
    BONE_RULES.push({ key: k, hex, re: new RegExp(pat, 'i') });
  }
}

const groupsByPrim = [];
for (const t of targets) {
  const img = atlas.get(t.image);
  const UV = accessor(G, t.prim.attributes.TEXCOORD_0);
  const POS = accessor(G, t.prim.attributes.POSITION);
  const IDX = accessor(G, t.prim.indices);
  /* Barycentric sample grid: the lower triangle of a 6x6 lattice, 21 points,
     nudged off the edges so a sample never sits exactly on a shared boundary. */
  const BARY = [];
  for (let a = 0; a <= 5; a++) for (let b = 0; a + b <= 5; b++)
    BARY.push([(a + 0.4) / 6.2, (b + 0.4) / 6.2, 1 - (a + 0.4) / 6.2 - (b + 0.4) / 6.2]);

  /* A UV outside 0..1 is a repeat, not an error. */
  const wrap = x => { const y = x - Math.floor(x); return y >= 1 ? 0 : y; };
  const sample = (u, v) => {
    const px = Math.min(img.w - 1, Math.floor(wrap(u) * img.w));
    const py = Math.min(img.h - 1, Math.floor((1 - wrap(v)) * img.h));
    const o = (py * img.w + px) * img.ch;
    return img.ch <= 2 ? [img.data[o], img.data[o], img.data[o]] : [img.data[o], img.data[o + 1], img.data[o + 2]];
  };

  /* The joint carrying the most weight over a triangle, for --map hex@bone. */
  let domBone = null;
  if (BONE_RULES.length && t.prim.attributes.JOINTS_0 != null && J.skins?.length) {
    const skin = J.skins[(J.nodes || []).find(n => n.mesh != null && J.meshes[n.mesh] === t.mesh)?.skin ?? 0];
    const JO = accessor(G, t.prim.attributes.JOINTS_0);
    const WE = accessor(G, t.prim.attributes.WEIGHTS_0);
    const wScale = WE instanceof Float32Array ? 1 : 1 / (WE instanceof Uint8Array ? 255 : 65535);
    domBone = (a, b, c) => {
      const tally = new Map();
      for (const i of [a, b, c]) for (let k = 0; k < 4; k++) {
        const w = WE[i * 4 + k] * wScale;
        if (w > 0) tally.set(JO[i * 4 + k], (tally.get(JO[i * 4 + k]) || 0) + w);
      }
      let bestJ = -1, bestW = -1;
      for (const [j, w] of tally) if (w > bestW) { bestW = w; bestJ = j; }
      return J.nodes[skin.joints[bestJ]]?.name || '';
    };
  }

  const groups = new Map();
  let samples = 0, disagreed = 0;
  for (let f = 0; f < IDX.length; f += 3) {
    const i0 = IDX[f], i1 = IDX[f + 1], i2 = IDX[f + 2];
    const tally = new Map();
    for (const [wa, wb, wc] of BARY) {
      const u = UV[i0 * 2] * wa + UV[i1 * 2] * wb + UV[i2 * 2] * wc;
      const v = UV[i0 * 2 + 1] * wa + UV[i1 * 2 + 1] * wb + UV[i2 * 2 + 1] * wc;
      const rgb = sample(u, v);
      const k = hex3(...rgb);
      if (!tally.has(k)) tally.set(k, { n: 0, rgb });
      tally.get(k).n++;
    }
    let key = null, best = -1;
    for (const [k, e] of tally) if (e.n > best) { best = e.n; key = k; }
    samples += BARY.length; disagreed += BARY.length - best;

    const rgb = tally.get(key).rgb;
    if (domBone) {
      const bone = domBone(i0, i1, i2);
      const rule = BONE_RULES.find(r => r.hex === key && r.re.test(bone));
      if (rule) key = rule.key;
    }

    if (!groups.has(key)) groups.set(key, { rgb, tris: [], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], impure: 0 });
    const g = groups.get(key);
    g.tris.push(f);
    if (best < BARY.length) g.impure++;
    for (let k = 0; k < 3; k++) {
      const i = IDX[f + k];
      for (let a = 0; a < 3; a++) {
        g.lo[a] = Math.min(g.lo[a], POS[i * 3 + a]);
        g.hi[a] = Math.max(g.hi[a], POS[i * 3 + a]);
      }
    }
  }
  groupsByPrim.push({ ...t, groups, IDX, lost: disagreed / samples });
}

/* ----------------------------------------------------------------- --report */
/* Which BONES a group hangs off names it, and a picture does not. Debug
   colours have to be read off a render and matched back by eye, which is how
   a facemask and a shoulder stripe end up sharing a verdict; the skin weights
   say "Head" or "LeftForeArm" outright. */
function boneWeights(t) {
  const prim = t.prim;
  if (prim.attributes.JOINTS_0 == null || !J.skins?.length) return null;
  const skin = J.skins[(J.nodes || []).find(n => n.mesh != null && J.meshes[n.mesh] === t.mesh)?.skin ?? 0];
  const JO = accessor(G, prim.attributes.JOINTS_0);
  const WE = accessor(G, prim.attributes.WEIGHTS_0);
  const wScale = WE instanceof Float32Array ? 1 : 1 / (WE instanceof Uint8Array ? 255 : 65535);
  const out = new Map();
  for (const [key, g] of t.groups) {
    const tally = new Map();
    const seen = new Set();
    for (const f of g.tris) for (let k = 0; k < 3; k++) {
      const i = t.IDX[f + k];
      if (seen.has(i)) continue;
      seen.add(i);
      for (let c = 0; c < 4; c++) {
        const w = WE[i * 4 + c] * wScale;
        if (w < 0.05) continue;
        const node = skin.joints[JO[i * 4 + c]];
        const nm = J.nodes[node]?.name || ('node' + node);
        tally.set(nm, (tally.get(nm) || 0) + w);
      }
    }
    const tot = [...tally.values()].reduce((a, b) => a + b, 0) || 1;
    out.set(key, [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([nm, w]) => `${nm} ${(100 * w / tot).toFixed(0)}%`).join(', '));
  }
  return out;
}

if (REPORT) {
  for (const t of groupsByPrim) {
    const bones = boneWeights(t);
    const total = t.IDX.length / 3;
    console.log(`\n${t.mesh.name || '(mesh)'}   ${total} triangles   ${t.groups.size} colour groups`);
    console.log(`  ${'colour'.padEnd(9)} ${'tris'.padStart(5)} ${'mixed'.padStart(6)}   ${'x'.padEnd(16)} ${'y'.padEnd(16)} z`);
    const f = v => (Number.isFinite(v) ? v.toFixed(2) : '-').padStart(6);
    for (const [key, g] of [...t.groups].sort((a, b) => b[1].tris.length - a[1].tris.length)) {
      const named = MAP.get(key);
      console.log(`  #${key}  ${String(g.tris.length).padStart(5)} ${String(g.impure).padStart(6)}   ` +
        `${f(g.lo[0])}..${f(g.hi[0])}  ${f(g.lo[1])}..${f(g.hi[1])}  ${f(g.lo[2])}..${f(g.hi[2])}` +
        (named ? '   -> ' + named.name : ''));
      if (bones) console.log(`             ${bones.get(key)}`);
    }
    console.log(t.lost > 0.10
      ? `  ${(t.lost * 100).toFixed(1)}% of texel samples disagree with their triangle — this atlas is a PICTURE, not a palette`
      : `  ${(t.lost * 100).toFixed(2)}% of texel samples disagree with their triangle — flat regions, the split holds`);
  }
  console.log('');
  process.exit(0);
}

/* ------------------------------------------------------------------ rewrite */
/* Every group becomes a primitive sharing the source attributes, so only the
   index buffer is new. Written as u32 unconditionally: the source may already
   be u16, but re-deriving the width per group buys a few kilobytes and costs a
   class of bug, and a skinned character's indices are the small half anyway. */
const newViewBytes = [];
function addIndexAccessor(list) {
  const arr = new Uint32Array(list.length);
  arr.set(list);
  const bytes = Buffer.from(arr.buffer);
  J.bufferViews.push({ buffer: 0, byteOffset: -1, byteLength: bytes.length, target: 34963 });
  newViewBytes.push({ view: J.bufferViews.length - 1, bytes });
  J.accessors.push({
    bufferView: J.bufferViews.length - 1, componentType: 5125, count: list.length,
    type: 'SCALAR', min: [Math.min(...list)], max: [Math.max(...list)]
  });
  return J.accessors.length - 1;
}

let dbg = 0;
for (const t of groupsByPrim) {
  /* Two palette entries given the SAME name become one primitive. The runtime
     shares a material across meshes by name, so an Ochi shirt whose front and
     back panels are separate tiles has to end up as one 'jersey' or a tint
     lands on half of it. */
  const merged = new Map();
  for (const [key, g] of [...t.groups].sort((a, b) => b[1].tris.length - a[1].tris.length)) {
    const mapped = MAP.get(key);
    const name = mapped?.name || ('paint_' + key.replace(/[^0-9a-z]/gi, '_'));
    if (!merged.has(name)) merged.set(name, { keys: [], tris: [], rgb: g.rgb, colour: mapped?.colour || null });
    const m = merged.get(name);
    m.keys.push(key);
    m.tris.push(...g.tris);
    if (mapped?.colour) m.colour = mapped.colour;
  }

  const prims = [];
  for (const [name, g] of merged) {
    const flat = [];
    for (const f of g.tris) { flat.push(t.IDX[f], t.IDX[f + 1], t.IDX[f + 2]); }
    const hexOut = DEBUG ? DEBUG_COLOURS[dbg++ % DEBUG_COLOURS.length] : (g.colour || hex3(...g.rgb));
    const rgb = [0, 2, 4].map(i => parseInt(hexOut.slice(i, i + 2), 16) / 255);
    J.materials.push({
      name,
      pbrMetallicRoughness: {
        baseColorFactor: [...rgb.map(sRGBtoLinear), 1],
        metallicFactor: 0,
        roughnessFactor: J.materials[t.prim.material]?.pbrMetallicRoughness?.roughnessFactor ?? 0.85
      }
    });
    prims.push({ attributes: { ...t.prim.attributes }, indices: addIndexAccessor(flat), material: J.materials.length - 1 });
  }
  const at = t.mesh.primitives.indexOf(t.prim);
  t.mesh.primitives.splice(at, 1, ...prims);
}

/* --------------------------------------------------------------- compaction */
/* Drop everything the new scene no longer reaches — the source index accessor,
   the source material, and the atlas image, which is the big one. Accessor and
   bufferView indices move when things go, so every reference is remapped:
   accessors are named by meshes, skins, animations and morph targets; buffer
   views by accessors and images. */
const usedAcc = new Set();
for (const m of J.meshes || []) for (const p of m.primitives) {
  for (const k in p.attributes) usedAcc.add(p.attributes[k]);
  if (p.indices != null) usedAcc.add(p.indices);
  for (const tg of p.targets || []) for (const k in tg) usedAcc.add(tg[k]);
}
for (const s of J.skins || []) if (s.inverseBindMatrices != null) usedAcc.add(s.inverseBindMatrices);
for (const a of J.animations || []) for (const s of a.samplers) { usedAcc.add(s.input); usedAcc.add(s.output); }

const accOrder = J.accessors.map((_, i) => i).filter(i => usedAcc.has(i));
const accMap = new Map(accOrder.map((old, n) => [old, n]));

const usedView = new Set();
for (const i of accOrder) if (J.accessors[i].bufferView != null) usedView.add(J.accessors[i].bufferView);
const usedMat = new Set();
for (const m of J.meshes || []) for (const p of m.primitives) if (p.material != null) usedMat.add(p.material);
const usedTex = new Set();
for (const i of usedMat) {
  const pbr = J.materials[i].pbrMetallicRoughness || {};
  for (const s of [pbr.baseColorTexture, pbr.metallicRoughnessTexture, J.materials[i].normalTexture,
    J.materials[i].occlusionTexture, J.materials[i].emissiveTexture]) if (s) usedTex.add(s.index);
}
const usedImg = new Set([...usedTex].map(i => J.textures[i].source));
for (const i of usedImg) if (J.images[i].bufferView != null) usedView.add(J.images[i].bufferView);

const viewOrder = J.bufferViews.map((_, i) => i).filter(i => usedView.has(i));
const viewMap = new Map(viewOrder.map((old, n) => [old, n]));

const parts = []; let off = 0;
const outViews = [];
for (const i of viewOrder) {
  const bv = J.bufferViews[i];
  const fresh = newViewBytes.find(n => n.view === i);
  const bytes = fresh ? fresh.bytes : bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  if (off % 4) { const pad = 4 - off % 4; parts.push(Buffer.alloc(pad)); off += pad; }
  const nv = { buffer: 0, byteOffset: off, byteLength: bytes.length };
  if (bv.byteStride) nv.byteStride = bv.byteStride;
  if (bv.target) nv.target = bv.target;
  outViews.push(nv);
  parts.push(bytes); off += bytes.length;
}
J.bufferViews = outViews;
J.accessors = accOrder.map(i => { const a = { ...J.accessors[i] }; a.bufferView = viewMap.get(a.bufferView); return a; });
for (const m of J.meshes || []) for (const p of m.primitives) {
  for (const k in p.attributes) p.attributes[k] = accMap.get(p.attributes[k]);
  if (p.indices != null) p.indices = accMap.get(p.indices);
  for (const tg of p.targets || []) for (const k in tg) tg[k] = accMap.get(tg[k]);
}
for (const s of J.skins || []) if (s.inverseBindMatrices != null) s.inverseBindMatrices = accMap.get(s.inverseBindMatrices);
for (const a of J.animations || []) for (const s of a.samplers) { s.input = accMap.get(s.input); s.output = accMap.get(s.output); }

const imgOrder = (J.images || []).map((_, i) => i).filter(i => usedImg.has(i));
const imgMap = new Map(imgOrder.map((o, n) => [o, n]));
J.images = imgOrder.map(i => { const im = { ...J.images[i] }; if (im.bufferView != null) im.bufferView = viewMap.get(im.bufferView); return im; });
const texOrder = (J.textures || []).map((_, i) => i).filter(i => usedTex.has(i));
const texMap = new Map(texOrder.map((o, n) => [o, n]));
J.textures = texOrder.map(i => ({ ...J.textures[i], source: imgMap.get(J.textures[i].source) }));
if (!J.textures.length) { delete J.textures; delete J.images; delete J.samplers; }

const matOrder = J.materials.map((_, i) => i).filter(i => usedMat.has(i));
const matMap = new Map(matOrder.map((o, n) => [o, n]));
J.materials = matOrder.map(i => {
  const m = JSON.parse(JSON.stringify(J.materials[i]));
  const pbr = m.pbrMetallicRoughness || {};
  for (const s of [pbr.baseColorTexture, pbr.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture])
    if (s) s.index = texMap.get(s.index);
  return m;
});
for (const m of J.meshes || []) for (const p of m.primitives) if (p.material != null) p.material = matMap.get(p.material);

J.buffers = [{ byteLength: off }];
writeGLB(OUT, J, Buffer.concat(parts));

const before = fs.statSync(SRC).size, after = fs.statSync(OUT).size;
console.log(`\n  ${OUT}`);
for (const t of groupsByPrim) {
  for (const p of t.mesh.primitives) {
    const n = J.accessors[p.indices].count / 3;
    console.log(`    ${String(n).padStart(5)} tris   ${J.materials[p.material].name}`);
  }
}
console.log(`  ${J.materials.length} materials, texture dropped, ${(before / 1024).toFixed(0)}K -> ${(after / 1024).toFixed(0)}K\n`);
