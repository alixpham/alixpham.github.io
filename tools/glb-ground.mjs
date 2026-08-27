#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — PUT A RETARGETED CLIP BACK ON THE TURF

     node tools/glb-ground.mjs ochi.glb out.glb --like flagster/lib/flagplayer.glb
     node tools/glb-ground.mjs ochi.glb --like flagster/lib/flagplayer.glb --report

   A RETARGET CARRIES ANGLES, NOT CONTACT. Every joint of the game's own player
   is copied faithfully onto the bought character and the pelvis is put at the
   character's own resting height, and that is not the same thing as standing
   on the ground: this athlete's shin is 9 mm longer, his ankle sits at its own
   height, and his foot is a different shape. The angles are right and the feet
   are in the wrong place.

   It shows up in the numbers before it shows up in a picture. Measured with
   `glb-gait.mjs`, the retargeted walk came back with 53% FLIGHT — a walk, by
   definition, never has both feet off the ground — and the jog with 8% stance.
   The speeds looked plausible throughout, because a foot that only touches
   occasionally is still measured correctly on the frames it does touch. This
   is exactly the failure CLAUDE.md warns about from the other direction: a
   foot that never lands is as wrong as one through the turf, and only one of
   those is obvious.

   THE FIX IS A HEIGHT, NOT A RE-SOLVE. The reference clip already knows what
   the vertical story is: how far the lowest sole sits off the turf at every
   instant, zero through a stance and rising through a flight. So take that
   profile from the reference and give the character a pelvis offset per frame
   that reproduces it. Nothing rotates, no leg is re-solved, and the authored
   motion is untouched — the body simply sits where the same motion would put a
   body with these legs.

   WHY NOT JUST CLAMP TO ZERO. Because then a sprint never leaves the ground.
   Matching a profile keeps the flight phases that make a run a run, and it is
   also what makes the result honest: if the reference's foot is 12 cm up at
   mid-flight, so is this one.

   A clip whose reference has no counterpart is left alone rather than guessed
   at, and the report says which.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { readGLB, clipNames, loadClip } from './glb-read.mjs';
import { skinnedRig } from './glb-skin.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && opt(argv[i - 1].slice(2)) === a));
const SRC = positional[0];
const REPORT = has('report');
const OUT = REPORT ? null : positional[1];
const LIKE = opt('like', 'flagster/lib/flagplayer.glb');
const STEPS = Math.max(16, Number(opt('steps', 96)));
if (!SRC || (!REPORT && !OUT)) {
  console.error('usage: node tools/glb-ground.mjs <in.glb> <out.glb> --like <reference.glb>');
  console.error('       node tools/glb-ground.mjs <in.glb> --report --like <reference.glb>');
  process.exit(2);
}

const g = readGLB(SRC);
const J = g.json;
const R = skinnedRig(g);
const soles = R.soles();
if (!soles.L || !soles.R) { console.error('no Foot_L / Foot_R vertices in ' + SRC); process.exit(1); }

const ref = readGLB(LIKE);
const RR = skinnedRig(ref);
const refSoles = RR.soles();
if (!refSoles.L || !refSoles.R) { console.error('no Foot_L / Foot_R vertices in ' + LIKE); process.exit(1); }
const refHave = new Set(clipNames(ref));

/* The lowest sole, either foot, at n evenly spaced phases of a clip. */
function profile(rig, sl, clip, n) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const JM = rig.jointMats(rig.localsOf(clip, (k / n) * clip.dur));
    const f = rig.soleFloor(JM, sl);
    out.push(Math.min(f.L.y, f.R.y));
  }
  return out;
}

const hipsNode = R.byName.Hips;
if (hipsNode == null) { console.error('no Hips bone in ' + SRC); process.exit(1); }

const rows = [];
for (const name of clipNames(g)) {
  if (!refHave.has(name)) { rows.push({ name, skipped: 'no counterpart in the reference' }); continue; }
  const mine = loadClip(g, name);
  const theirs = loadClip(ref, name);
  const a = profile(R, soles, mine, STEPS);
  const b = profile(RR, refSoles, theirs, STEPS);
  const delta = a.map((v, i) => b[i] - v);
  rows.push({
    name, clip: mine, delta,
    before: { lo: Math.min(...a), hi: Math.max(...a) },
    want: { lo: Math.min(...b), hi: Math.max(...b) },
    shift: { lo: Math.min(...delta), hi: Math.max(...delta) }
  });
}

if (!REPORT) {
  /* Fold the per-frame correction into the Hips translation track. The track's
     own key times are kept — the correction is sampled at them, not the other
     way round — so nothing is resampled and no motion is smoothed away. */
  for (const r of rows) {
    if (r.skipped) continue;
    const anim = J.animations.find(x => x.name === r.name);
    const ch = anim.channels.find(c => c.target.node === hipsNode && c.target.path === 'translation');
    if (!ch) { r.skipped = 'no Hips translation track'; continue; }
    const s = anim.samplers[ch.sampler];
    const view = J.bufferViews[J.accessors[s.output].bufferView];
    const times = J.accessors[s.input];
    const tView = J.bufferViews[times.bufferView];
    const T = new Float32Array(g.bin.buffer, g.bin.byteOffset + (tView.byteOffset || 0) + (times.byteOffset || 0), times.count);
    const V = new Float32Array(g.bin.buffer, g.bin.byteOffset + (view.byteOffset || 0) + (J.accessors[s.output].byteOffset || 0), J.accessors[s.output].count * 3);
    const dur = r.clip.dur || 1;
    for (let i = 0; i < times.count; i++) {
      const ph = ((T[i] / dur) % 1 + 1) % 1;
      const x = ph * STEPS;
      const k0 = Math.floor(x) % STEPS, k1 = (k0 + 1) % STEPS, u = x - Math.floor(x);
      V[i * 3 + 1] += r.delta[k0] + (r.delta[k1] - r.delta[k0]) * u;
    }
    /* The accessor's min/max must follow the data or a strict viewer culls it. */
    const acc = J.accessors[s.output];
    if (acc.min && acc.max) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < acc.count; i++) { lo = Math.min(lo, V[i * 3 + 1]); hi = Math.max(hi, V[i * 3 + 1]); }
      acc.min[1] = lo; acc.max[1] = hi;
    }
  }
}

/* ---------------------------------------------------------------- output */
const f = (v, d = 3) => (v * 100).toFixed(d === 3 ? 1 : d).padStart(6);
console.log(`\n${path.basename(SRC)}  grounded against ${path.basename(LIKE)}   (cm)`);
console.log(`  ${'clip'.padEnd(12)} ${'sole was'.padStart(14)} ${'wants'.padStart(14)} ${'pelvis shift'.padStart(15)}`);
for (const r of rows) {
  if (r.skipped) { console.log(`  ${r.name.padEnd(12)}  ${r.skipped}`); continue; }
  console.log(`  ${r.name.padEnd(12)} ${f(r.before.lo)}..${f(r.before.hi)} ${f(r.want.lo)}..${f(r.want.hi)} ${f(r.shift.lo)}..${f(r.shift.hi)}`);
}

if (REPORT) { console.log(''); process.exit(0); }

const jsonBuf = Buffer.from(JSON.stringify(J), 'utf8');
const jPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
const bPad = Buffer.alloc((4 - (g.bin.length % 4)) % 4, 0);
const jc = Buffer.concat([jsonBuf, jPad]), bc = Buffer.concat([g.bin, bPad]);
const head = Buffer.alloc(12);
head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jc.length + 8 + bc.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(jc.length, 0); jh.write('JSON', 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bc.length, 0); bh.write('BIN\0', 4);
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([head, jh, jc, bh, bc]));
console.log(`\n  wrote ${OUT}\n`);
