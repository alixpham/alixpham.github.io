#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — DOES THE LADDER, ON ITS OWN, SLIDE A PLANTED FOOT?

     node tools/gaitslip.mjs [player.glb] [--fps 60] [--band 0.008] [--nowarp]

   `tools/bodycheck.mjs` measures the feet in the LIVE GAME, which is the only
   place the answer finally counts — and it cannot tell you WHY, because
   everything is in the frame at once: the stride, the blend, the facing, the
   lean, the turn, the acceleration. It is also noisy enough to be useless for
   a small change. Three runs of one unchanged build returned 31%, 42% and 57%;
   that is not a statistic with error bars, it is three different football
   matches.

   So this takes everything else away. It reproduces `playermodel.js`'s blend
   exactly — pick the two rungs that bracket the speed, weight them so their
   measured ground speeds interpolate to it, correct with `blendUp`, drive both
   from one shared phase through `sweepWarp` — then skins the result and
   differences the sole in WORLD space with the body translating at the speed
   asked for. Constant speed, straight line, no lean, no camera. If a foot
   slides here it is the clip and the ladder and nothing else, and the answer
   is the same every time you run it.

   That is how the skating was actually located: the facing was the obvious
   suspect and the live median skew is 3.5 degrees, nowhere near enough, while
   this reported 10-35% with the facing removed entirely.

   `--nowarp` ignores `extras.sweepWarp` and plays the clips as authored, which
   is what the before/after of that fix is measured with.
   ============================================================================ */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB, loadClip } from './glb-read.mjs';
import { skinnedRig } from './glb-skin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SRC = argv.find(a => !a.startsWith('--') && a.endsWith('.glb')) ||
            path.resolve(HERE, '..', 'flagster', 'lib', 'ochiplayer.glb');
const FPS = Number(opt('fps', 60));
const BAND = Number(opt('band', 0.008));
const NOWARP = argv.includes('--nowarp');
const SPEEDS = (opt('speeds', '1.6,2.5,3.4,4.5,6.0,7.5,8.8')).split(',').map(Number);

const g = readGLB(SRC);
const R = skinnedRig(g);
const soleOf = R.soles({ band: 0.03 });
if (!soleOf.L || !soleOf.R) { console.error('no Foot_L / Foot_R vertices in ' + SRC); process.exit(1); }

const rungs = [];
for (const nm of ['Walk', 'Jog', 'Run', 'Sprint']) {
  const anim = (g.json.animations || []).find(a => a.name === nm);
  if (!anim || !anim.extras || !(anim.extras.groundSpeed > 0)) continue;
  rungs.push({ name: nm, clip: loadClip(g, nm), nat: anim.extras.groundSpeed,
               blendUp: anim.extras.blendUp || null,
               warp: NOWARP ? null : (anim.extras.sweepWarp || null) });
}
rungs.sort((a, b) => a.nat - b.nat);
if (!rungs.length) { console.error('no measured gaits in ' + SRC); process.exit(1); }

/* The three functions playermodel.js uses, in the same form. */
const blendSag = (r, w) => {
  const c = r.blendUp;
  if (!c || c.length < 5) return 1;
  const x = w * 4, i = Math.floor(x);
  return i >= 4 ? c[4] : c[i] + (c[i + 1] - c[i]) * (x - i);
};
const warped = (r, p) => {
  const c = r.warp;
  if (!c || c.length < 2) return p;
  const x = p * (c.length - 1), i = Math.floor(x);
  return i >= c.length - 1 ? c[c.length - 1] : c[i] + (c[i + 1] - c[i]) * (x - i);
};
function pickPair(speed) {
  let i = 0;
  while (i < rungs.length - 2 && speed >= rungs[i + 1].nat) i++;
  const A = rungs[i], B = rungs[i + 1] || A;
  const lo = A.nat, hi = B.nat;
  return [A, B, B === A || hi <= lo ? 0 : Math.max(0, Math.min(1, (speed - lo) / (hi - lo)))];
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };

console.log(`\n${path.basename(SRC)} — planted-foot slip from the ladder alone` +
  `${NOWARP ? ', clips AS AUTHORED' : ''}   ${FPS}fps, ${(BAND * 100).toFixed(1)}cm plant band`);
console.log(`  ladder: ${rungs.map(r => `${r.name} ${r.nat.toFixed(2)}m/s`).join('   ')}` +
  (NOWARP ? '' : `   warp: ${rungs.filter(r => r.warp).length}/${rungs.length} rungs`));
console.log(`\n  ${'m/s'.padStart(5)} ${'rungs'.padStart(12)} ${'rate'.padStart(6)} ${'slip m/s'.padStart(9)} ${'% of speed'.padStart(11)} ${'float'.padStart(6)}`);
console.log('  ' + '-'.repeat(56));
const rel = [];
for (const speed of SPEEDS) {
  const p = pickPair(speed);
  const blendNat = (p[0].nat + (p[1].nat - p[0].nat) * p[2]) * blendSag(p[0], p[2]);
  let rate = blendNat > 0 ? speed / blendNat : 1;
  rate = rate < 0.55 ? 0.55 : rate > 1.9 ? 1.9 : rate;
  const cycle = (p[0].clip.dur + (p[1].clip.dur - p[0].clip.dur) * p[2]) / rate;
  const dt = 1 / FPS, N = Math.max(24, Math.round(cycle * FPS * 3));
  const frames = [];
  let phase = 0, bodyZ = 0;
  for (let k = 0; k < N; k++) {
    const JM = R.jointMats(R.localsMixed(
      p[0].clip, warped(p[0], phase) * p[0].clip.dur,
      p[1].clip, warped(p[1], phase) * p[1].clip.dur, p[2]));
    frames.push({ L: R.solePoints(JM, soleOf, 'L'), R: R.solePoints(JM, soleOf, 'R'), z: bodyZ });
    phase = (phase + dt / cycle) % 1;
    bodyZ += speed * dt;                        // the rig faces +Z and travels +Z
  }
  const minima = [];
  for (const f of frames) for (const s of ['L', 'R']) for (const q of f[s]) minima.push(q[1]);
  minima.sort((a, b) => a - b);
  const ON = minima[Math.floor(minima.length * 0.10)] + BAND;
  const slip = [];
  let float = 0;
  for (let k = 1; k < frames.length; k++) {
    const a = frames[k - 1], c = frames[k], down = [];
    for (const side of ['L', 'R']) {
      let best = Infinity;
      for (let m = 0; m < c[side].length; m++) {
        if (c[side][m][1] > ON || a[side][m][1] > ON) continue;
        const d = Math.hypot(c[side][m][0] - a[side][m][0],
                             (c[side][m][2] + c.z) - (a[side][m][2] + a.z)) / dt;
        if (d < best) best = d;
      }
      if (best < Infinity) down.push(best);
    }
    if (!down.length) { float++; continue; }
    slip.push(Math.min(...down));
  }
  const r = pct(slip, 0.5) / speed;
  rel.push(r);
  console.log(`  ${speed.toFixed(1).padStart(5)} ${(p[0].name + '/' + p[1].name).padStart(12)} ${rate.toFixed(3).padStart(6)} ` +
    `${pct(slip, 0.5).toFixed(3).padStart(9)} ${((100 * r).toFixed(1) + '%').padStart(11)} ` +
    `${((100 * float / (frames.length - 1)).toFixed(0) + '%').padStart(6)}`);
}
console.log(`\n  mean across the ladder: ${(100 * rel.reduce((a, b) => a + b, 0) / rel.length).toFixed(1)}% of travel speed\n`);
