# Flagster — working notes for Claude

## Communication

- **Always output the live page URL at the end of every completed task:**
  **https://alixpham.github.io/**
  State plainly whether the change is *live* or only *merged and deploying*.
  Don't claim it's live until it's actually verified serving.

## What this repo is

`alixpham.github.io` — a GitHub Pages site. The homepage is **Flagster**, an
Olympic-style 5v5 flag football game. The original personal portfolio is
preserved at `/index-portfolio.html` (see `ROLLBACK.md` to restore it).

## Layout

```
index.html              homepage -> loads the game from flagster/
flagster/js/            boot3d (ESM bootstrap), engine, ui, field3d, hero3d,
                        stadium3d, player3d, playermodel, fx3d, world,
                        teambuilder, roadtoglory, main
flagster/lib/three/     vendored Three.js r185 (ESM) + jsm addons
flagster/lib/flagplayer.glb   rigged, skinned, team-tintable player
tools/build-player-glb.mjs    regenerates flagplayer.glb (no deps, no Blender)
tools/measure-clip.mjs        reads a baked clip back out as joint angles
tools/simstats.mjs            headless CPU-vs-CPU box score
VERSION, DEPLOY.md      version <-> commit records (git tags can't be pushed
                        through this environment's proxy, so these are the
                        authoritative record)
```

## Conventions that matter

- **Zero build step.** Plain `<script>` tags + an import map. Never introduce a
  bundler or npm runtime deps.
- Modern Three.js is ESM-only; `flagster/js/boot3d.js` bridges it to the global
  `THREE` the classic scripts expect, and **still boots the game (2D fallback)
  if Three.js fails to load**. Keep that guarantee.
- Three.js r155+ uses **physically-correct light units** — r128-era intensities
  render far too dark. Re-tune lights when touching a scene.
- Rig faces **+Z**; heading maps as `root.rotation.y = Math.PI/2 - yaw`.
  Limb clips rotate about **X** (sagittal = fore/aft stride).
- 1 world unit = **1 yard**. Field is 70 x 30 (NFL Flag regulation), centred
  on the origin.
- Input arrives in **screen space** and must be rotated into field space via
  `engine.viewSign()`.
- `Player3D.build()` delegates to the rigged `PlayerModel` when loaded and falls
  back to the procedural rig otherwise. Both expose the same API.
- **Never hand-type an euler triple at a shoulder.** Elevation + horizontal
  adduction + axial rotation don't decompose into XYZ in any order you can hold
  in your head; author the three anatomical angles and let `armQ()` solve it.
  Check the result with `node tools/measure-clip.mjs <Clip>` — it also reports
  feet through the turf and planted feet that skate.
- **The foot is two segments, and gait tables interpolate as cubics.** Heel and
  ball on `Foot_*`, tip on `Toe_*`; every ground solve takes the lowest of the
  three. Cyclic gaits are built by `cyclicGait()` from one leg table and one arm
  table, resampled with a non-uniform cubic Hermite — linear interpolation puts
  a velocity corner at every authored phase, which is what makes a cycle read as
  a marionette.
- **A gait clip's natural ground speed lives IN the .glb**, as animation
  `extras` measured by the builder, and `field3d` reads it through
  `P.naturalSpeed()`. Don't reintroduce a hand-copied constant; it has drifted
  out of step with the stride tables twice already.
- The camera sits behind whoever HAS THE BALL, and the offence always attacks
  +x, so it never turns round; `engine.viewSign()` is the seam that says which
  way is downfield and now always returns 1.

## Workflow

- Develop on `claude/flagster-website-build-*`, PR into `master`, squash-merge.
- Bump `VERSION` and add a row to `DEPLOY.md` for each release.
- **A clean console does not mean the 3D renderer is running.** engine.js
  swallows `externalRender` throws and silently hands over to the 2D canvas
  after five of them, so a broken scene looks like a working game with a
  different art style. When verifying, check `shell.field3d` is still non-null
  and wrap `engine.externalRender` to catch what it threw.
- **Verify before claiming done:** drive the real thing in headless Chromium
  (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, args
  `--use-gl=swiftshader --enable-unsafe-swwebgl --ignore-gpu-blocklist`),
  screenshot it, and confirm 0 console/page errors across World, Team Builder,
  Road to Glory and the menu, in both landscape and portrait.
- Pages deploys usually land in ~40-90s; confirm the live `VERSION` before
  reporting a change as live.
