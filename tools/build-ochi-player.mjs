#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — BUILD THE STUDIO OCHI PLAYER

     node tools/build-ochi-player.mjs --fbx path/to/ManA.fbx --texture path/to/atlas.png

   One command, five stages, each of which has its own tool and its own report,
   because every one of them was a bug at some point:

     1. fbx-to-glb    the character, plus the 22 clips retargeted onto its
                      metarig by mocap/ochi-clips.mjs, out of an FBX and into a
                      GLB with no Blender anywhere near it
     2. glb-repaint   the baked palette atlas split into the ten named,
                      tintable material regions the game colours a team by
     3. glb-rerig     every rest rotation removed, bones renamed to the
                      vocabulary the game looks up, four sockets added; the
                      stage that makes the character a DROP-IN rather than
                      something the renderer has to special-case
     4. glb-ground    the feet put back on the turf, against the game's own
                      player as the reference for what the vertical story is
     5. glb-gait      groundSpeed and the blend correction measured off the
                      finished clips, because playermodel.js drops a rung that
                      has not been measured and a player with no rungs never
                      takes a step

   ORDER MATTERS IN TWO PLACES. The repaint runs BEFORE the rerig because its
   bone rules are written in the source rig's own names — `262262@breast=trim`
   knows a chest from a thigh only while the bone is still called `breast.L`.
   And the grounding runs BEFORE the gait measurement, because a foot that
   never lands measures a ground speed off the handful of frames where it
   happens to touch: the walk read 53% flight and a quarter fast before it.

   THE SOURCE ASSETS ARE NOT IN THE REPOSITORY. Studio Ochi's FBX and its atlas
   are licensed, and `.gitignore` keeps them out; what is committed is this
   script, the five tools, the retargeted motion in tools/motion-ochi/, and the
   finished .glb. See HANDOFF.md.
   ============================================================================ */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const FBX = opt('fbx', null);
const TEX = opt('texture', null);
const OUT = path.resolve(ROOT, opt('out', 'flagster/lib/ochiplayer.glb'));
const MOTION = opt('motion', path.resolve(ROOT, 'tools', 'motion-ochi'));
const KEEP = argv.includes('--keep');
/* Which of Studio Ochi's OWN six clips to take over the retargeted one of the
   same name. Passed straight through to fbx-to-glb, which documents the format;
   here so that what the shipped character is animated from is one visible
   string in the build command rather than a fact buried two tools down. */
const ADOPT = opt('adopt', null);

if (!FBX || !TEX) {
  console.error('usage: node tools/build-ochi-player.mjs --fbx <ManA_ANIM.fbx> --texture <atlas.png> [--out flagster/lib/ochiplayer.glb] [--adopt "American Football Run Fast=Sprint"]');
  console.error('       the FBX must be the rigged _ANIM one — the static meshes carry no skin');
  console.error('       the Ochi source assets are licensed and not in the repo — see HANDOFF.md');
  process.exit(2);
}
for (const f of [FBX, TEX]) if (!fs.existsSync(f)) { console.error('no such file: ' + f); process.exit(1); }
if (!fs.existsSync(MOTION)) { console.error('no retargeted motion in ' + MOTION + ' — run tools/mocap/ochi-clips.mjs first'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ochi-'));
const step = (n, label, args) => {
  console.log(`\n=== ${n}. ${label} ${'='.repeat(Math.max(0, 58 - label.length))}`);
  process.stdout.write(execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' }));
};

/* THE MATERIAL MAP, verified by rendering: see tools/README.md. `jersey` takes
   two palette entries because the shirt's front and its back panel are
   separate tiles, and the navy that is the trousers is ALSO the panel the
   chest number sits on — hence the bone rule, which is the one label that
   knows a chest from a thigh. Everything is handed to the runtime as white so
   `material.color` has something to multiply into.

   THE HELMET IS `jersey`, NOT `head`. The names on the right are not
   descriptions, they are the keys playermodel.js TINTS BY, and its table reads
   `skin: ['skin', 'head']` — because on the game's own player, `head` is the
   face. Filing the helmet shell under `head` therefore painted it flesh, and
   ten men took the field in skin-coloured helmets that read, at broadcast
   distance, as ten bare heads. A helmet takes the team's primary, which is
   what `jersey` is; the shell and the facemask are one palette entry, so they
   go together, and the stripe and the chinstrap take `trim`. */
const MAP = [
  'f1f2f2=jersey:ffffff',
  'ffffff=jersey:ffffff',
  '262262@(breast|shoulder|upper_arm|spine\\.003)=trim:ffffff',
  '262262@thigh=shorts:ffffff',
  '262262@spine\\.00[56]=trim:ffffff',
  '262262=shorts:ffffff',
  'f8b583=skin:ffffff',
  '27aae1@spine=jersey:ffffff',
  '27aae1@upper_arm=trim:ffffff',
  '27aae1=shoes:ffffff',
  'ffce00@shin=socks:ffffff',
  'ffce00@spine=trim:ffffff',
  'ffce00=shoes:ffffff',
  '3452ff@(forearm|hand)=trim:ffffff',
  '3452ff=shoes:ffffff',
  '934911=hair:ffffff'
].join(',');

try {
  const raw = path.join(tmp, 'raw.glb');
  const painted = path.join(tmp, 'painted.glb');
  const rerigged = path.join(tmp, 'rerigged.glb');
  const grounded = path.join(tmp, 'grounded.glb');

  step(1, 'convert the FBX, with the retargeted clips baked in',
    [path.join(HERE, 'fbx-to-glb.mjs'), FBX, '-o', raw, '--texture', TEX, '--motion', MOTION, '--no-anim']
      .concat(ADOPT ? ['--adopt', ADOPT] : []));
  step(2, 'split the palette atlas into tintable regions',
    [path.join(HERE, 'glb-repaint.mjs'), raw, painted, '--map', MAP]);
  step(3, "rebuild onto the game's rig conventions",
    [path.join(HERE, 'glb-rerig.mjs'), painted, rerigged, '--preset', 'ochi']);
  step(4, 'put the feet back on the turf',
    [path.join(HERE, 'glb-ground.mjs'), rerigged, grounded, '--like', 'flagster/lib/flagplayer.glb']);
  step(5, 'measure the gait ladder',
    [path.join(HERE, 'glb-gait.mjs'), grounded, OUT]);

  console.log(`\n  ${path.relative(ROOT, OUT)}   ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB\n`);
} finally {
  if (KEEP) console.log('  intermediates kept in ' + tmp);
  else fs.rmSync(tmp, { recursive: true, force: true });
}
