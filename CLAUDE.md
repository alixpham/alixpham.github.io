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
- 1 world unit = **1 yard**. Field is 70 x 25, centred on the origin.
- Input arrives in **screen space** and must be rotated into field space via
  `engine.viewSign()` — the camera sits behind the user's team and flips with
  possession.
- `Player3D.build()` delegates to the rigged `PlayerModel` when loaded and falls
  back to the procedural rig otherwise. Both expose the same API.

## Workflow

- Develop on `claude/flagster-website-build-*`, PR into `master`, squash-merge.
- Bump `VERSION` and add a row to `DEPLOY.md` for each release.
- **Verify before claiming done:** drive the real thing in headless Chromium
  (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, args
  `--use-gl=swiftshader --enable-unsafe-swwebgl --ignore-gpu-blocklist`),
  screenshot it, and confirm 0 console/page errors across World, Team Builder,
  Road to Glory and the menu, in both landscape and portrait.
- Pages deploys usually land in ~40-90s; confirm the live `VERSION` before
  reporting a change as live.
