/* ============================================================================
   FLAGSTER — THE GLB READER, ONCE

   Not a tool. The shared half of every script here that opens a .glb:
   `measure-clip.mjs` reads the built player back out, `glb-repaint.mjs` splits
   its materials, and `mocap/retarget-ochi.mjs` reads the game's own clips as a
   retarget SOURCE. Three copies of a container parser is three chances for one
   to drift, which is the lesson this repo has already paid for twice — with a
   hand-copied ground speed, and with a rig table that lived in three files
   before `rig-def.mjs` existed.

   Deliberately thin. It hands back the JSON, the binary chunk, accessors, the
   node tree and animation channels; matrices, kinematics and anatomy stay in
   the callers, because those differ per tool and this does not.

   glTF stores an accessor as a typed range of a bufferView, optionally
   interleaved with a byteStride. `accessor()` returns the numbers flat and
   de-interleaved; `rows()` groups them by component count, which is what most
   callers here actually want.
   ============================================================================ */
import fs from 'node:fs';

const MAGIC = 0x46546c67, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;

export const CTYPE = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array
};
export const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function readGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('not a glb: ' + file);
  const version = buf.readUInt32LE(4);
  let off = 12, json = null, bin = Buffer.alloc(0);
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    else if (type === CHUNK_BIN) bin = body;
    off += 8 + len;
  }
  if (!json) throw new Error('no JSON chunk in ' + file);
  return { file, version, json, bin };
}

/* Flat, de-interleaved, in the accessor's own component type. */
export function accessor(g, i) {
  const a = g.json.accessors[i];
  const n = NCOMP[a.type], T = CTYPE[a.componentType];
  if (!T || !n) throw new Error('accessor ' + i + ': type ' + a.type + '/' + a.componentType);
  if (a.bufferView == null) return new T(a.count * n);          // spec: all zeros
  const bv = g.json.bufferViews[a.bufferView];
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const packed = T.BYTES_PER_ELEMENT * n;
  if (!bv.byteStride || bv.byteStride === packed) {
    /* .slice() rather than a view: a bufferView is not guaranteed to start on
       the component's alignment, and a typed array over a misaligned offset
       throws. */
    return new T(g.bin.buffer.slice(g.bin.byteOffset + base, g.bin.byteOffset + base + a.count * packed));
  }
  const out = new T(a.count * n);
  for (let k = 0; k < a.count; k++) {
    const at = g.bin.byteOffset + base + k * bv.byteStride;
    out.set(new T(g.bin.buffer.slice(at, at + packed)), k * n);
  }
  return out;
}

/* Grouped by component count; SCALAR comes back as plain numbers. */
export function rows(g, i) {
  const a = g.json.accessors[i], n = NCOMP[a.type];
  const flat = accessor(g, i);
  if (n === 1) return Array.from(flat);
  const out = new Array(a.count);
  for (let k = 0; k < a.count; k++) out[k] = Array.from(flat.subarray(k * n, k * n + n));
  return out;
}

/* nodes, each node's parent (-1 at the top) and a name -> index table. */
export function nodeIndex(g) {
  const nodes = g.json.nodes || [];
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => { for (const c of n.children || []) parent[c] = i; });
  const byName = {};
  nodes.forEach((n, i) => { if (n.name != null && byName[n.name] === undefined) byName[n.name] = i; });
  return { nodes, parent, byName };
}

export const clipNames = g => (g.json.animations || []).map(a => a.name);

export function loadClip(g, name) {
  const anim = (g.json.animations || []).find(a => a.name === name);
  if (!anim) throw new Error('no clip named ' + name + ' (have: ' + clipNames(g).join(', ') + ')');
  const tracks = [];
  let dur = 0;
  for (const ch of anim.channels) {
    const s = anim.samplers[ch.sampler];
    const times = rows(g, s.input);
    const values = rows(g, s.output);
    dur = Math.max(dur, times[times.length - 1]);
    tracks.push({ node: ch.target.node, path: ch.target.path, times, values });
  }
  return { name, dur, tracks, extras: anim.extras || {} };
}

export function quatSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) {
    const o = a.map((v, i) => v + (bb[i] - v) * t);
    const L = Math.hypot(o[0], o[1], o[2], o[3]) || 1;
    return o.map(v => v / L);
  }
  const th = Math.acos(Math.max(-1, Math.min(1, d))), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
}

export function sampleTrack(times, values, t, slerp) {
  if (t <= times[0]) return values[0];
  const last = times.length - 1;
  if (t >= times[last]) return values[last];
  let i = 0;
  while (i < last - 1 && times[i + 1] < t) i++;
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  if (slerp) return quatSlerp(values[i], values[i + 1], u);
  return values[i].map((v, k) => v + (values[i + 1][k] - v) * u);
}

/* Per-node local translation/rotation at time t, clip tracks applied over the
   node's own rest. */
export function localsAt(g, clip, t) {
  const { nodes } = nodeIndex(g);
  const local = nodes.map(n => ({
    t: (n.translation || [0, 0, 0]).slice(),
    q: (n.rotation || [0, 0, 0, 1]).slice()
  }));
  for (const tr of clip.tracks) {
    const v = sampleTrack(tr.times, tr.values, t, tr.path === 'rotation');
    if (tr.path === 'rotation') local[tr.node].q = v;
    else if (tr.path === 'translation') local[tr.node].t = v;
  }
  return local;
}
