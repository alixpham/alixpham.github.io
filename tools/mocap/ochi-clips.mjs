#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — THE WHOLE CLIP VOCABULARY, ONTO THE OCHI RIG

     node tools/mocap/ochi-clips.mjs --fbx path/to/ManA.fbx
     node tools/mocap/ochi-clips.mjs --fbx ManA.fbx --only Run,Juke   # a subset
     node tools/mocap/ochi-clips.mjs --fbx ManA.fbx --report          # measure only

   Runs `retarget-ochi.mjs --src-glb flagster/lib/flagplayer.glb` once per clip
   and writes tools/motion-ochi/<Clip>.json, which `fbx-to-glb.mjs --motion`
   then bakes into the player.

   WHY THE GAME'S OWN PLAYER IS THE SOURCE. A flag pull, a juke and ten
   celebrations do not exist in any motion capture library, free or paid — they
   were authored here, in anatomical angles, against this game's rig. CMU
   supplies a better walk than anyone can hand-author and nothing else that
   this game needs. So the character comes from Studio Ochi, the locomotion can
   come from either, and everything with Flagster in it comes from the model
   the game already ships.

   CYCLIC IS NOT A STYLE CHOICE. A looping clip is sampled without repeating
   its first frame at the end, or the loop stutters one frame every cycle; a
   one-shot is sampled endpoint to endpoint. The list below is the same one
   `playermodel.js` calls LOOPING, and the two must agree.

   SAMPLE COUNT FOLLOWS DURATION, not a constant. 48 samples across a 0.48s
   sprint is 100Hz and across a 6.4s idle is 7.5Hz, and the idle is the one
   with the slow drift that aliases. Roughly 60Hz, floored at 32 and capped at
   192, keeps every clip honest without making a six-second file enormous.
   ============================================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGLB, clipNames, loadClip } from '../glb-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PLAYER = path.join(ROOT, 'flagster', 'lib', 'flagplayer.glb');
const RETARGET = path.join(HERE, 'retarget-ochi.mjs');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FBX = opt('fbx', null);
const ONLY = opt('only', null);
const REPORT = argv.includes('--report');
if (!FBX) {
  console.error('usage: node tools/mocap/ochi-clips.mjs --fbx <character.fbx> [--only A,B] [--report]');
  console.error('       the Ochi FBX is licensed and not in the repo — see HANDOFF.md');
  process.exit(2);
}
if (!fs.existsSync(FBX)) { console.error('no such file: ' + FBX); process.exit(1); }

/* Mirrors LOOPING in playermodel.js. */
const CYCLIC = new Set(['Idle', 'Run', 'Walk', 'Backpedal', 'Jog', 'Sprint',
  'Celebrate', 'Dance', 'Flex', 'HighStep', 'Bow', 'Lasso', 'Salute', 'Griddy']);

const g = readGLB(PLAYER);
let clips = clipNames(g);
if (ONLY) {
  const want = new Set(ONLY.split(',').map(x => x.trim()));
  clips = clips.filter(c => want.has(c));
  if (!clips.length) { console.error('--only matched nothing; have: ' + clipNames(g).join(', ')); process.exit(1); }
}

const rows = [];
for (const name of clips) {
  const dur = loadClip(g, name).dur;
  const steps = Math.max(32, Math.min(192, Math.round(dur * 60)));
  const args = [RETARGET, '--src-glb', PLAYER, '--src-clip', name, '--name', name,
    '--fbx', FBX, '--steps', String(steps)];
  if (CYCLIC.has(name)) args.push('--cyclic');
  if (REPORT) args.push('--report');
  let out;
  try {
    out = execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    console.log(`  ${name.padEnd(12)} FAILED  ${String(e.stderr || e.message).trim().split('\n')[0]}`);
    rows.push({ name, ok: false });
    continue;
  }
  const grab = re => { const m = out.match(re); return m ? m[1] : '?'; };
  rows.push({
    name, ok: true, dur, steps, cyclic: CYCLIC.has(name),
    mapped: grab(/bones mapped\s+(\d+)/),
    axis: grab(/agree to ([\d.]+) deg/),
    bob: grab(/pelvis bob\s+([\d.]+) cm/),
    kb: grab(/\((\d+) KB/)
  });
}

console.log(`\n  ${'clip'.padEnd(12)} ${'sec'.padStart(5)} ${'steps'.padStart(6)} ${'loop'.padStart(5)} ${'bones'.padStart(6)} ${'bob cm'.padStart(7)} ${'KB'.padStart(4)}`);
console.log('  ' + '-'.repeat(52));
for (const r of rows) {
  if (!r.ok) { console.log(`  ${r.name.padEnd(12)}  FAILED`); continue; }
  console.log(`  ${r.name.padEnd(12)} ${r.dur.toFixed(2).padStart(5)} ${String(r.steps).padStart(6)} ` +
    `${(r.cyclic ? 'yes' : '-').padStart(5)} ${String(r.mapped).padStart(6)} ${String(r.bob).padStart(7)} ${String(r.kb).padStart(4)}`);
}
const bad = rows.filter(r => !r.ok);
console.log(`\n  ${rows.length - bad.length} of ${rows.length} clips retargeted` + (bad.length ? `, ${bad.length} FAILED` : '') + (REPORT ? '  (report only, nothing written)' : ''));
console.log('');
process.exit(bad.length ? 1 : 0);
