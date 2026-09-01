#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — IS A BOUGHT CLIP WORTH ADOPTING?

     node tools/fbx-to-glb.mjs "<pack>_ANIM.fbx" -o /tmp/pack.glb
     node tools/clip-audition.mjs /tmp/pack.glb

   Every bought animation pack looks good in its own preview. The question this
   repo keeps having to answer is narrower and duller: is this clip FASTER,
   better placed and better shaped than the one it would replace? Three packs'
   worth of clips have now been declined on exactly that, and each time the
   measurement was rebuilt from scratch in a scratchpad and then lost with the
   container. It lives here now.

   WHAT IT MEASURES, and why each one has decided something:

     peak hand speed   The single most useful number for a throw, and the one
                       that declined Studio Ochi's. A real quarterback's hand
                       is around 20 m/s at release; this game's authored Throw
                       measures 19.69 and the bought one 5.93. Sample it FINELY
                       — at 10 samples a second a throw reads 4.45 m/s and at
                       400 it reads 5.93, so a coarse pass understates the
                       thing being judged by a third.

     root travel       A game clip is played IN PLACE. A clip whose body moves
                       0.86m across the floor is a stride, and adopting it puts
                       a lurch in a quarterback who is supposed to be set.

     end vs start      A cycle must return to where it began; a one-shot need
                       not. This is what says which kind you are holding.

     lowest / highest  A clip that ends with the body on the ground is a fall,
                       whatever the file is called. Studio Ochi's "Catch and
                       Fall" catches at 2.02m and then lies down and stays
                       there for the last two seconds, which is not what this
                       game's Catch is for: a receiver has to get up and run.

   Y IS UP AND Z IS FORWARD in these files, which is worth stating because the
   raw node transforms come out of an FBX that was Z-up and it is easy to read
   a forward stride as a body levitating.
   ============================================================================ */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB } from './glb-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2];
const SAMPLES = Number(process.argv[3] || 400);
if (!SRC) {
  console.error('usage: node tools/clip-audition.mjs <pack.glb> [samples=400]');
  console.error('       make the glb with: node tools/fbx-to-glb.mjs <in_ANIM.fbx> -o <pack.glb>');
  process.exit(2);
}

const g = readGLB(SRC);
const j = g.json;

function acc(i) {
  const A = j.accessors[i], bv = j.bufferViews[A.bufferView];
  const off = (bv.byteOffset || 0) + (A.byteOffset || 0);
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4 }[A.type], out = [];
  for (let k = 0; k < A.count; k++) {
    const r = [];
    for (let c = 0; c < n; c++) r.push(g.bin.readFloatLE(off + (k * n + c) * 4));
    out.push(n === 1 ? r[0] : r);
  }
  return out;
}

const parent = new Map();
j.nodes.forEach((n, i) => (n.children || []).forEach(c => parent.set(c, i)));
const byName = {};
j.nodes.forEach((n, i) => { if (n.name) byName[n.name] = i; });

const mul = (a, b) => {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let v = 0; for (let k = 0; k < 4; k++) v += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = v;
  }
  return o;
};
function comp(t, q, s) {
  const [x, y, z, w] = q;
  const m = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 4 + c] *= s[c];
  m[3] = t[0]; m[7] = t[1]; m[11] = t[2];
  return m;
}

/* The metarig's names, and the game rig's, so this reads either a bought pack
   or one of our own .glb files without being told which. */
const pick = (...names) => { for (const n of names) if (byName[n] != null) return byName[n]; return null; };
const HAND = pick('hand.R', 'Hand_R');
const FOOT = pick('foot.R', 'Foot_R');
const HEAD = pick('spine.006', 'Head');
if (HAND == null) { console.error('no right hand bone found — is this a character glb?'); process.exit(1); }

function audition(anim) {
  const tracks = new Map();
  for (const c of anim.channels) {
    const s = anim.samplers[c.sampler];
    tracks.set(c.target.node + '|' + c.target.path, { t: acc(s.input), v: acc(s.output) });
  }
  const dur = Math.max(...[...tracks.values()].map(c => c.t[c.t.length - 1]));
  let TT = 0;
  const sample = (node, p, d) => {
    const c = tracks.get(node + '|' + p);
    if (!c) return d;
    const ts = c.t; let i = 0;
    while (i < ts.length - 2 && ts[i + 1] < TT) i++;
    const sp = ts[i + 1] - ts[i], u = sp > 0 ? Math.max(0, Math.min(1, (TT - ts[i]) / sp)) : 0;
    const A = c.v[i], B = c.v[Math.min(i + 1, c.v.length - 1)];
    return A.map((x, k) => x + (B[k] - x) * u);
  };
  const world = idx => {
    let m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const chain = [];
    for (let i = idx; i !== undefined; i = parent.get(i)) chain.push(i);
    for (const i of chain.reverse()) {
      const n = j.nodes[i];
      m = mul(m, comp(sample(i, 'translation', n.translation || [0, 0, 0]),
                      sample(i, 'rotation', n.rotation || [0, 0, 0, 1]),
                      sample(i, 'scale', n.scale || [1, 1, 1])));
    }
    return [m[3], m[7], m[11]];
  };

  let peak = 0, peakAt = 0, prev = null, lowest = 1e9, highest = -1e9;
  let first = null, last = null, firstFoot = null, lastFoot = null;
  for (let i = 0; i <= SAMPLES; i++) {
    TT = dur * i / SAMPLES;
    const h = world(HAND);
    const f = FOOT != null ? world(FOOT) : h;
    const hd = HEAD != null ? world(HEAD) : h;
    if (prev) {
      const v = Math.hypot(h[0] - prev[0], h[1] - prev[1], h[2] - prev[2]) / (dur / SAMPLES);
      if (v > peak) { peak = v; peakAt = TT; }
    }
    lowest = Math.min(lowest, hd[1]); highest = Math.max(highest, h[1]);
    if (i === 0) { first = hd; firstFoot = f; }
    last = hd; lastFoot = f;
    prev = h;
  }
  // How far the body itself travelled, in the ground plane (x, z).
  const travel = Math.hypot(last[0] - first[0], last[2] - first[2]);
  const footTravel = Math.hypot(lastFoot[0] - firstFoot[0], lastFoot[2] - firstFoot[2]);
  const closes = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
  return { dur, peak, peakAt, travel, footTravel, closes, lowestHead: lowest, highestHand: highest };
}

console.log(`\n${path.basename(SRC)} — ${(j.animations || []).length} clips, ${SAMPLES} samples each\n`);
console.log('  clip                          sec   peak hand   at      body     ends     head   hand');
console.log('                                        m/s      s     travel   where it   low    high');
console.log('  ' + '-'.repeat(88));
for (const a of (j.animations || [])) {
  const r = audition(a);
  const back = r.closes < 0.05 ? 'started' : (r.closes).toFixed(2) + 'm off';
  console.log('  ' + a.name.slice(0, 28).padEnd(28) +
    r.dur.toFixed(2).padStart(6) +
    r.peak.toFixed(2).padStart(9) + r.peakAt.toFixed(2).padStart(8) +
    r.travel.toFixed(2).padStart(9) + '  ' + back.padStart(9) +
    r.lowestHead.toFixed(2).padStart(7) + r.highestHand.toFixed(2).padStart(7));
}
console.log(`
  For scale, this game's OWN clips, measured the same way:
    Throw   peak hand 19.69 m/s at t=0.350 of 1.10s   (a real QB is ~20 m/s)
    Run     groundSpeed 6.02 m/s      Sprint 8.83 m/s

  A bought clip has to beat the one it would replace, not merely look good on
  its own. Studio Ochi's pack was measured against these and declined whole:
  Throw 01 at 5.93 m/s is under a third of this game's throw, Run Fast at
  5.43 m/s is slower than its Run, Catch and Fall ends prone and stays there,
  and Kick, Kickoff and Hold are placekicking — of which flag football has
  none. See REALISM.md.
`);
