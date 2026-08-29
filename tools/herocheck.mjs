#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — THE LANDING SCREEN IS A CLAIM, AND THIS CHECKS IT

     npm run hero
     node tools/herocheck.mjs --character flagplayer

   Three players cycle through a list of moves on the front page. That list is
   the first thing anyone sees of what this game thinks a footballer looks
   like, so it had better be a list of things a footballer can do.

   It was not. Reported from the screen itself: *"they display impossible
   moves — turning an arm in the air 360 degrees, gliding, leaning back so that
   the centre of gravity is past the capacity for the feet to hold it."* All
   three were there, and each needed a different instrument to see:

     THE ARM.  `bodycheck.mjs` measures degrees per SECOND, and a lasso twirl
     at 400 deg/s trips no speed limit while winding a full revolution every
     0.9 seconds. `posecheck.mjs` integrates the rotation instead, and Lasso
     winds its right forearm 363 degrees EVERY CYCLE — in a loop that never
     unwinds, so it goes round for as long as the move is on screen.

     THE LEAN.  Every joint in Celebrate is inside a human's range, and the
     pose is still one nobody can hold: both feet planted, centre of mass
     outside the ground they cover, on 62% of the frames of a LOOP.

     THE GLIDE.  Arithmetic, and it needed no probe at all. The hero ran on
     `play('run') + setSpeed(1.35)`; the Run clip covers 6.02 m/s, so its feet
     swept 8.13 m/s while the root translated at 1.01 m/s — the legs went past
     the turf EIGHT TIMES faster than the turf went past the player — and then
     `travel` hit its cap and the root stopped dead while the legs kept going.

   So this reads the cast list OUT OF `hero3d.js` — the file is loaded against
   a bare `window`, no canvas and no WebGL — and runs every move's clip through
   the same checks. Reading it rather than restating it is the point: a move
   added to the screen is a move this refuses, and there is no second list to
   keep in step.

   Locomotion is checked differently, because a gait clip is not a pose: the
   speed the driver translates the body at is compared with the ground speed
   the ladder will actually produce, and they have to agree.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGLB, clipNames } from './glb-read.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CHAR = arg('character', 'ochiplayer');
const GLB = path.join(ROOT, 'flagster', 'lib', CHAR.endsWith('.glb') ? CHAR : CHAR + '.glb');

/* Load hero3d.js for its exports alone. It is an IIFE over `window` and does
   nothing at load but define; `mount` is never called, so there is no canvas,
   no THREE and no context to fake. */
const win = { addEventListener() {}, removeEventListener() {} };
win.window = win;
new Function('window', fs.readFileSync(path.join(ROOT, 'flagster/js/hero3d.js'), 'utf8'))(win);
const hero = win.FLAGSTER && win.FLAGSTER.hero3d;
if (!hero || !hero.CAST) { console.error('hero3d.js exports no CAST'); process.exit(1); }

/* The clip each move plays. Mirrors enterMove()'s switch: the locomotion moves
   go through the gait ladder rather than naming a clip, and everything else
   plays the clip of its own name. */
const CLIP_OF = { run: null, juke: 'Juke', highstep: 'HighStep', throw: 'Throw',
  dive: 'Dive', flaggrab: 'FlagGrab', celebrate: 'Celebrate', griddy: 'Griddy',
  lasso: 'Lasso', flex: 'Flex', dance: 'Dance', bow: 'Bow', salute: 'Salute' };
const LOCOMOTION = new Set(['run', 'juke']);

const g = readGLB(GLB);
const have = new Set(clipNames(g));
const gaits = {};
for (const a of g.json.animations || []) if (a.extras && a.extras.groundSpeed > 0) gaits[a.name] = a.extras.groundSpeed;
const ladder = Object.entries(gaits).sort((x, y) => x[1] - y[1]);

/* posecheck already knows how to answer "can a body hold this"; ask it rather
   than growing a second copy of the centre-of-mass model. */
const poses = JSON.parse(execFileSync(process.execPath,
  [path.join(ROOT, 'tools/posecheck.mjs'), GLB, '--json'], { encoding: 'utf8' }));
const poseOf = Object.fromEntries(poses.map(p => [p.name, p]));
const SLACK = 0.03;
const ENOUGH = 0.25;

const problems = [];
const rows = [];
for (const member of hero.CAST) {
  for (const move of member.moves) {
    const clipName = CLIP_OF[move];
    if (clipName === undefined) { problems.push(`${member.name}: '${move}' is not a move enterMove() knows`); continue; }
    if (LOCOMOTION.has(move)) {
      /* A gait is not a pose. What has to be true is that the ground the
         driver moves the body over and the ground the ladder's strides cover
         are the same ground — inside the ladder, so the blend has two rungs to
         work between and the playback rate stays near 1. */
      const v = (hero.SPEED && hero.SPEED[move]) || 0;
      const lo = ladder.length ? ladder[0][1] : 0, hi = ladder.length ? ladder[ladder.length - 1][1] : 0;
      const ok = v > 0 && v >= lo && v <= hi;
      rows.push({ who: member.name, move, what: `gait at ${v.toFixed(2)} u/s`,
        detail: `ladder ${lo.toFixed(2)}-${hi.toFixed(2)}`, ok });
      if (!ok) problems.push(`${member.name}: '${move}' asks the ladder for ${v.toFixed(2)} u/s, outside ${lo.toFixed(2)}-${hi.toFixed(2)}`);
      continue;
    }
    if (move === 'highstep') {
      const v = (hero.SPEED && hero.SPEED.highstep);
      const ok = v === 0;
      rows.push({ who: member.name, move, what: 'on the spot', detail: `translates ${v} u/s`, ok });
      if (!ok) problems.push(`${member.name}: 'highstep' plays an on-the-spot clip while translating ${v} u/s`);
    }
    if (!have.has(clipName)) { problems.push(`${member.name}: '${move}' wants clip ${clipName}, which ${path.basename(GLB)} does not have`); continue; }
    const p = poseOf[clipName];
    if (!p) { problems.push(`${member.name}: no pose report for ${clipName}`); continue; }
    const settled = p.judged / (p.frames || 1) >= ENOUGH;
    const offBalance = p.cyclic && !p.gait && settled && p.margin < -SLACK;
    const winds = p.cyclic && p.wind > 330;
    rows.push({
      who: member.name, move, what: clipName,
      detail: (Number.isFinite(p.margin) ? `balance ${(p.margin * 100).toFixed(1)}cm` : 'balance n/a') +
              `, winds ${p.wind.toFixed(0)}deg` + (p.cyclic ? ' (loops)' : ''),
      ok: !offBalance && !winds
    });
    if (offBalance) problems.push(`${member.name}: '${move}' (${clipName}) loops with its centre of mass ${(-p.margin * 100).toFixed(1)}cm outside its feet on ${p.overPct.toFixed(0)}% of frames`);
    if (winds) problems.push(`${member.name}: '${move}' (${clipName}) winds ${p.windBone} through ${p.wind.toFixed(0)}deg every cycle`);
  }
}

console.log(`\nFLAGSTER hero screen — ${path.basename(GLB)}, ${hero.CAST.length} players\n`);
let who = '';
for (const r of rows) {
  if (r.who !== who) { console.log(`  ${r.who}`); who = r.who; }
  console.log(`    ${r.ok ? 'ok  ' : 'FAIL'}  ${r.move.padEnd(10)} ${r.what.padEnd(18)} ${r.detail}`);
}
console.log('');
if (problems.length) {
  console.log('  IMPOSSIBLE ON THE LANDING SCREEN:');
  for (const p of problems) console.log('    - ' + p);
  console.log('');
  process.exit(1);
}
console.log(`  every move on the front page is one a body can perform\n`);
