#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — FETCH THE LICENSED STUDIO OCHI SOURCE

     export FLAGSTER_OCHI_URL='<the Dropbox share link, with its rlkey>'
     node tools/ochi-fetch.mjs

   Downloads the pack into `tools/ochi/` (gitignored) so the character chain can
   be rebuilt. Nothing it writes is ever committed.

   WHY THE LINK IS NOT IN THIS FILE. The pack is licensed commercial artwork,
   which is the whole reason `.gitignore` excludes `*.fbx`, `*.blend` and
   `tools/ochi/`. **This repository is public** — it is a GitHub Pages site — so
   a Dropbox share link committed here is a working download of that artwork for
   anyone who reads the repo, and the `rlkey=` in it is exactly the secret that
   makes it work. Committing the link would undo the .gitignore by one hop.

   So the URL lives in the ENVIRONMENT and the mechanism lives here. Set
   `FLAGSTER_OCHI_URL` in the Claude Code environment config (the same place
   `FLAGSTER_CHROME` comes from) and this is a one-liner forever after.

   WHICH FOLDER IT IS, so a new session can ask for the right thing rather than
   describing it from memory:

     https://www.dropbox.com/scl/fo/v3ywmu88tkucol936m52s/AM-8GX07Xxm0CCMC32Pgnj0
     (+ the ?rlkey=… the owner supplies; add &dl=1 to get the zip)

   That is 42 files, ~26.8 MB: six `*_ANIM.fbx` athletes, six static meshes with
   their .obj/.mtl/.gltf, six `StudioOchi Athletes 0N.png` atlases, and the
   11 MB `Studio Ochi American Football Players_ANIM.blend`.

   WHAT TO DO WITH IT ONCE IT IS HERE:

     node tools/build-ochi-player.mjs \
       --fbx "tools/ochi/Studio Ochi American Football Man A_ANIM.fbx" \
       --texture "tools/ochi/StudioOchi Athletes 01.png"

   The `--fbx` must be one of the six `*_ANIM.fbx`; the static meshes carry no
   skin and the build stops at stage 3 with "not a skinned model". A successful
   run reproduces the committed `flagster/lib/ochiplayer.glb` byte for byte —
   856,816 bytes, same sha256 — which is what makes the chain safe to re-run.
   ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'ochi');
const FOLDER = 'https://www.dropbox.com/scl/fo/v3ywmu88tkucol936m52s/AM-8GX07Xxm0CCMC32Pgnj0';

let url = process.env.FLAGSTER_OCHI_URL || process.argv[2];
if (!url) {
  console.error(`
  FLAGSTER_OCHI_URL is not set, and the Studio Ochi pack is licensed so the
  link cannot live in this repository — it is public.

  It is this Dropbox folder, plus the ?rlkey= the owner supplies:

    ${FOLDER}

  Then either:

    export FLAGSTER_OCHI_URL='<that link>'   # or set it in the environment config
    node tools/ochi-fetch.mjs

  or pass it straight in:

    node tools/ochi-fetch.mjs '<that link>'

  The pack is only needed to REBUILD the character. The finished
  flagster/lib/ochiplayer.glb and ochibare.glb are committed, so the game runs
  without it. And the clips in it have already been auditioned and declined —
  see REALISM.md v3.25.0; do not re-fetch it to re-ask that.
`);
  process.exit(2);
}
if (!/[?&]dl=1/.test(url)) url += (url.includes('?') ? '&' : '?') + 'dl=1';

fs.mkdirSync(OUT, { recursive: true });
const zip = path.join(OUT, '_pack.zip');
console.log('fetching the pack…');
execFileSync('curl', ['-sSL', '--max-time', '600', '-o', zip, url], { stdio: 'inherit' });

const size = fs.statSync(zip).size;
if (size < 1024 * 1024) {
  console.error(`only ${size} bytes came back — the link is probably missing its rlkey, or expired.`);
  fs.unlinkSync(zip);
  process.exit(1);
}
/* The archive carries a "/" entry that unzip refuses; -x skips it rather than
   letting one bad name fail the whole extraction. */
try { execFileSync('unzip', ['-o', '-q', zip, '-x', '/'], { cwd: OUT, stdio: 'inherit' }); }
catch (e) { /* unzip warns on the stripped path and exits non-zero; the files land anyway */ }
fs.unlinkSync(zip);

const files = fs.readdirSync(OUT);
const anim = files.filter(f => /_ANIM\.fbx$/.test(f));
console.log(`  ${files.length} files into tools/ochi/  (${anim.length} rigged *_ANIM.fbx)`);
for (const f of anim) console.log('    ' + f);
console.log(`
  Rebuild the character with:
    node tools/build-ochi-player.mjs --fbx "tools/ochi/${anim[0] || '<ManA_ANIM.fbx>'}" \\
      --texture "tools/ochi/StudioOchi Athletes 01.png"
`);
