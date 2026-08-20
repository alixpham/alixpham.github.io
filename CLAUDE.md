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
  `extras` measured by the builder, and `playermodel` reads it back. Don't
  reintroduce a hand-copied constant; it has drifted out of step with the stride
  tables twice already. The same goes for `blendUp`, the correction for how fast
  a *blend* of two gaits really is.
- **Locomotion is a ladder, not a clip.** Walk / Jog / Run / Sprint are blended
  by `P.gait(kind, speed)`; `play('run')` is for the menu hero only. A clip can
  only be played faster, and playback rate changes cadence while leaving the
  baked stride exactly as long as it was authored — which is how the old
  renderer ended up sprinting at 465 steps a minute. All four rungs put the LEFT
  foot's contact at phase 0, or a blend has one clip landing while the other is
  airborne.
- **Arms are contralateral, and `measure-clip` is how you know.** At the instant
  the left foot lands the right hand is at the front of its swing. The `Run`
  clip was a third of a cycle out for its whole life: every frame of it was a
  good pose, and it read as a wind-up toy. Timing errors are invisible in
  stills — check `arm/leg error` rather than screenshots.
- **A stance sweep has to be EVEN, not just long.** `groundSpeed` is a mean, and
  a stance that creeps then whips through toe-off averages out right while the
  support foot slides for the part of it the eye watches. `measure-clip` prints
  the median and spread; `GAIT_DEBUG=1` on the builder prints the series.
- **A foot that never lands is as wrong as one through the turf**, and only one
  of those had a check. `groundedHips` hangs the pelvis off whichever sole is
  lowest, so a pose the two legs cannot both reach reports a contented zero
  while the other foot hovers — Flex and Spike stood with the front foot four
  centimetres in the air for their whole lives. Author a stance foot as
  `[z, knee]` with no ankle and it is solved flat; `measure-clip` prints each
  foot's closest approach.
- **A celebration pool is five long because the roster is.** `state.players` is
  always the five on offence and then the five on defence, so a touchdown is
  celebrated by slots 0-4 and a takeaway by slots 5-9, forever. Indexing a pool
  of seven by the global slot reaches five of them and always the same five —
  two clips in the .glb that no one can ever see. Pools are five, indexed by
  `idx % 5` (the player's slot within his own side) with a stride co-prime to 5.
- **Celebrations only play while the ball is DEAD**, which is the one thing a
  headless probe forgets: `animcheck` returned early on any phase but `live` and
  so had never once sampled a celebration. And a probe that waits in WALL time
  measures nothing here — swiftshader renders about twice a second against a
  50ms clamped delta, so sim time runs at a tenth of real. `celebcheck` waits
  for the celebration to end, not for a number of seconds.
- The camera sits behind whoever HAS THE BALL, and the offence always attacks
  +x, so it never turns round; `engine.viewSign()` is the seam that says which
  way is downfield and now always returns 1.

## The container is not the repo

**Read this before trusting anything in the working tree.**

Sessions run in ephemeral containers whose clone is a *snapshot*, not a fetch.
A new container hands you the repository as it was when the image was taken,
which can be many releases behind `origin/master`. This has already caused real
damage once: a container came back holding `VERSION 2.20.0` and an `engine.js`
whose completion rate measured **1.2%** instead of 45%, twelve releases stale,
and work was built on top of it before the box score gave it away.

- `.claude/hooks/session-start.sh` now fetches and resyncs on every new session,
  saving the old tip to `refs/container-snapshot/<branch>/<utc>` first so the
  move is always reversible. It refuses to touch a dirty tree, and it leaves a
  divergent branch alone on `resume`/`compact` in case you are mid-task.
- It cannot help a snapshot older than the hook itself. If the banner does not
  appear at session start, check freshness by hand before doing anything:
  `git fetch origin master && git rev-list --count HEAD..origin/master`.
- **Nothing survives the container except what is pushed.** Push early. A
  scratch harness in `/tmp` is gone next session — if a measurement is worth
  quoting, the script that produced it belongs in `tools/`.

### Never merge this branch back after a squash merge

`claude/flagster-website-build-*` is long-lived and PRs are squash-merged, so
after a merge the branch's commits are content-in-master but ancestor-of-nothing.
Merging `master` back then offers them a second time, and git resolves it badly:
that is precisely how `engine.js` ended up at 1.2% completions. After a PR
merges, restart the branch instead — `git checkout -B <branch> origin/master`
(force-with-lease to push; safe, because the branch holds only merged history).

## Workflow

- Develop on `claude/flagster-website-build-*`, PR into `master`, squash-merge.
- Bump `VERSION` and add a row to `DEPLOY.md` for each release.
- **A clean console does not mean the 3D renderer is running.** engine.js
  swallows `externalRender` throws and silently hands over to the 2D canvas
  after five of them, so a broken scene looks like a working game with a
  different art style. When verifying, check `shell.field3d` is still non-null
  and wrap `engine.externalRender` to catch what it threw.
- `npm run lint` (syntax across every source file), `npm test` (rules
  regression), `node tools/simstats.mjs` (box score), `npm run celebs`
  (every celebration, forced and read back off the renderer),
  `node tools/posesheet.mjs <Clip>` (a clip big enough to judge the pose —
  measure-clip says whether it is correct, this says whether it is any good). Playwright is a
  devDependency purely so the browser harnesses survive a new container — the
  **site itself still ships no npm dependencies and no build step**.
- **Verify before claiming done:** drive the real thing in headless Chromium
  (`$FLAGSTER_CHROME`, exported by the session hook; the image pins a build
  number so do not hardcode the path — args
  `--use-gl=swiftshader --enable-unsafe-swwebgl --ignore-gpu-blocklist`),
  screenshot it, and confirm 0 console/page errors across World, Team Builder,
  Road to Glory and the menu, in both landscape and portrait.
- Pages deploys usually land in ~40-90s; confirm the live `VERSION` before
  reporting a change as live.
