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
flagster/lib/ochiplayer.glb   the Studio Ochi athlete, converted and rebuilt
                              onto the same rig; what the game loads by default
tools/build-player-glb.mjs    regenerates flagplayer.glb (no deps, no Blender)
tools/rig-def.mjs             the bone table + sole geometry, imported everywhere
tools/rig-fk.mjs              general quaternion FK + the ground-speed measurement
tools/mocap/                  CMU .asf/.amc -> this rig (fetch, asf, retarget)
tools/motion/*.json           retargeted clips, committed; the .amc never is
tools/measure-clip.mjs        reads a baked clip back out as joint angles
tools/glb-repaint.mjs         splits a bought character's baked atlas into
                              named, tintable material regions
tools/glb-rerig.mjs           rebuilds a character onto this game's rig
                              conventions; proves the skin did not move
tools/glb-ground.mjs          puts a retargeted clip's feet back on the turf
tools/glb-gait.mjs            groundSpeed + blendUp measured off a baked clip,
                              from a sole taken from the MESH
tools/glb-read.mjs            the GLB container, once
tools/glb-skin.mjs            posing and skinning a GLB, once
tools/build-ochi-player.mjs   all five stages -> flagster/lib/ochiplayer.glb
tools/mocap/ochi-clips.mjs    the game's own 22 clips -> the Ochi metarig
tools/simstats.mjs            headless CPU-vs-CPU box score
tools/qbstats.mjs             the QB's decision, frozen at the throw: how open
                              the man he chose is WHEN THE BALL GETS THERE, how
                              open the best one was, who got the ball, and what
                              he aimed at against what the down needed. Calls
                              the engine's own _readReceiver — it used to keep
                              a second copy, and the two had drifted
tools/ballcheck.mjs           is the football in his hands? read off the scene
                              graph, which no headless probe can see
tools/pullstats.mjs           the flag pull, timed; --user splits it by side
tools/gaitslip.mjs            planted-foot slip from the LADDER alone, with the
                              facing, the lean and the camera taken away —
                              deterministic, where bodycheck is not
tools/bodycheck.mjs           is this body possible? planted-foot slip and
                              float, and every arm joint against a human's
                              limits — off the RENDERER, with a standing
                              player as the control
tools/smoke.mjs               every screen x both orientations, 0 errors, field3d alive
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
- **The rig is defined once, in `tools/rig-def.mjs`.** Bone table, sole offsets,
  leg lengths. The builder, the measurer and the retargeter all import it —
  three copies of a rig is three chances for one to drift, which is the same
  failure that put a hand-copied ground speed out of step with its stride table
  twice.
- **A gait's ground speed is measured off the BAKED clip, through full
  kinematics** (`tools/rig-fk.mjs`), not off the table it was authored from. A
  planar solve cannot see the pelvis, and a walking pelvis yaws, lists and sways
  — all of which move the hip joint fore and aft over the standing foot. The
  walk's own table said 1.78 m/s and the clip it produced does 1.77 only because
  the pelvis is now re-solved through the same kinematics; before that it was
  holding its stance foot up to 5.5mm off the turf and measuring a 38% flight
  phase, which a walk does not have at all. Stride tables SHAPE a gait; they do
  not get the last word on how fast it covers the ground.
- **Motion capture goes through `tools/mocap/`, and lands as JSON.** A file in
  `tools/motion/` whose clip name matches an authored clip REPLACES it at build
  time — that is the whole swap mechanism. Sources are CMU (free, no account,
  plain text, credited in `tools/mocap/README.md`). Three things that bite:
  CMU's own index calls every trial 120Hz and some are not (the retargeter
  prints stride length beside stride rate and says when the pair is
  impossible); the capture volume is 3m x 8m so nobody sprints in it, and
  `Sprint` stays authored; and a retargeted clip is asymmetric and slightly
  non-contralateral because a person is, so `measure-clip` gives clips carrying
  `extras.mocap` the numbers without the verdict.
- **A bought character is blocked by its TEXTURE, not its skeleton.** The
  game tints ten named regions per player by multiplying `material.color`
  over white artwork; Studio Ochi's athletes ship one material with the kit
  baked into an eight-swatch palette atlas, so there is nothing to tint.
  `tools/glb-repaint.mjs` regroups the triangles by which swatch they sample
  into one primitive per region, sharing the SAME position, normal, joint and
  weight accessors — only the index buffer is new, so nothing can tear. Two
  traps: a colour is a paint bucket and not a body part (Ochi's navy is the
  trousers AND the chest panel, which is why the split also takes a dominant-
  bone rule), and one sample per triangle files the number under the number
  and invents a region out of the one face that straddles a tile seam.
- **A bought character is blocked by two things, and the second is the rig's
  REST.** `rig-def.mjs` says "no bone carries a rest ROTATION" and the whole
  renderer leans on it: the chest number hangs off `Chest` at plain metres, the
  ball goes in `Socket_Hand_R` at a fixed offset, a carrying arm is posed by
  writing euler triples onto `UpperArm_*`. A Rigify metarig carries a real rest
  rotation on all 58 bones. `tools/glb-rerig.mjs` rebuilds the CHARACTER onto
  this convention rather than teaching the renderer a second one, and it proves
  the rebuild moved nothing — 0.0287mm worst, which is the quantisation. Where
  a rest DIRECTION still differs (Ochi's upper arm rests 62 degrees off, in an
  A-pose) the constant is measured into `extras.restAlign` and `field3d`
  composes it onto poses it authors ITSELF. Only the absolute ones: the small
  relative nudges — fatigue, turn lead, gaze — are body-axis rotations and both
  rigs now rest world-aligned, so conjugating those would tilt the axis they
  turn about, which is exactly the head bug the gaze block spent a version
  getting rid of.
- **A retarget carries angles, not contact.** The pelvis at the character's own
  resting height is not the same as standing on the ground when the shin is 9mm
  longer and the foot a different shape: the retargeted walk measured 53%
  FLIGHT, which a walk does not have at all, while its speed still looked
  plausible because a foot that touches occasionally is measured correctly on
  the frames it does touch. `tools/glb-ground.mjs` matches the reference clip's
  own foot-height profile per frame. Clamping to zero instead means a sprint
  that never leaves the ground.
- **`playermodel.js` silently drops a gait rung with no measured
  `groundSpeed`,** and a player with no rungs never takes a step — so an
  imported character needs `tools/glb-gait.mjs`, which takes the sole from the
  MESH rather than from a table of offsets. Three centroids, not all the low
  vertices: Ochi's boot has a score of cleat studs and tracking whichever is
  lowest hops between them, which read as a walk a quarter slow. `--check`
  reproduces the builder's own four numbers to 1.2% from independent code and
  independent geometry, which is worth more than either alone.
- **The rigged model only ever appeared if it loaded before the first snap.**
  Players are built once and `Player3D.build` falls back to the procedural rig
  SILENTLY, so a kickoff that beat the fetch fielded the fallback for the whole
  game. Invisible for as long as it was because `flagplayer.glb` is built from
  the same parts as that fallback; it only showed when a character that looks
  like someone else failed to appear. `field3d` clears `playersRef` on
  `PlayerModel.whenReady` now.
- **An open receiver is open WHEN THE BALL GETS THERE.** `_aiThrow` ranked men
  by the nearest defender at the instant of the decision, and the wind-up plus
  the flight is over a second in which everyone is closing at nine yards a
  second: the quarterback read 4.62 yards of separation and the ball landed in
  1.87. `_readReceiver` measures it at the arrival point instead, off the same
  lead solve `_releaseThrow` uses. Two traps either side of that. Handing the
  defence the WIND-UP as well as the flight over-prices coverage — a covering
  defender is running with his receiver, not at the spot, and the geometry
  already counts that — and it produced a quarterback who threw the ball 0.06
  yards behind the line on every down. And **separation has to be capped**: a
  man three yards clear and a man eight yards clear are the same catch, so
  ranking them apart makes the checkdown win forever, because nobody covers
  the place the play is not going. `npm run qb` is the probe.
- **The quarterback throws when the PLAY is ready, not when a timer is.**
  `snapT > 1.6` was one number for the whole playbook, and he took the first
  frame it allowed him on every snap. On a deep call the deepest receiver is 7.6
  yards downfield at 1.6s, 12.6 at 2.6s and 16.2 at 3.6s — so Four Verticals was
  thrown while the `go` routes were still at the depth of a hitch, and the
  centre took a THIRD of all passes. `AI_DEVELOP` is per play type. He can
  afford the wait: the rush starts seven yards off the ball by rule and the
  passer drops five more, so a rusher gets inside two yards on **0.1%** of pass
  plays and the `heat` half of `urgency` has never once been non-zero. Four of
  the seven seconds on the pass clock were going unused. `npm run qb`.
- **A THROWING LANE IS A CORRIDOR, NOT A CONE.** The test was a radius of
  `d * 0.55 + 2` around the landing spot — which grows with the length of the
  throw — so it fired on 93% of reads past five yards and 100% past ten. It
  meant "this pass is long", and as a flat penalty on every downfield throw it
  was most of what kept the ball in the flat. Project the defender onto the LINE
  of the throw and ask whether he can cross it before the ball reaches his
  station.
- **There are no chains: four downs to reach midfield, three to score once you
  have.** So there is always exactly one line that matters, and the read has to
  know which. YAC is worth counting on a first down and worth nothing on a last
  one — you do not bet a series on five yards of run-after-catch — so the
  allowance is discounted by what the down is worth.
- **Measure the decision, then measure the OUTCOME, and believe the outcome.**
  Rewriting the read as an explicit expected-value model (catch and interception
  probabilities calibrated against arrival separation, priced in yards) is the
  obvious "smarter quarterback" and it bought 0.06 points per drive across 32
  games — inside the noise. It was thrown away. Two traps that produced it: a
  single seed is not a measurement (seed 1 alone read 6.73 yards per pass play
  where four seeds read 7.34, and half the "problems" in the seed-1 report were
  noise), and *threw to the most open man* gets WORSE when he starts taking the
  deeper man on purpose, because the checkdown is always the most open man.
  Points per drive over eight seeds, with a standard error printed beside it, is
  the number that decides.
- **A read ORDER is not a progression.** Taking the first man over a bar means
  nobody after him is ever looked at: read four, the centre, caught 0.0% of the
  passes in this game's existence. Score every read and let the best one win,
  with the order priced in as what it is worth — a yard of separation on read
  one, a quarter of one on read four.
- **The ball offsets are an ABSOLUTE POSE, and they need `restAlign` too.**
  The rest-alignment note above covers the ARM; nothing was carrying the BALL.
  `field3d`'s carry grip is authored in the game rig's forearm frame ("0.27
  down its own -Y to the wrist") and the Ochi athlete's forearm runs down its
  own -X, so the football hung 0.33 yards off the arm on every carried frame
  of every play — parented to exactly the right limb, and a foot away from the
  hand. A vector authored in the game's frame comes back the OTHER way from a
  pose: `A^-1 * v`, not `q * A`. `npm run ball` is the probe, and it asserts
  two bars — not in a hand at all, and held at arm's length. The second is the
  one that caught this.
- **A ball that is hard to see is not always a ball that is too fast.** "We
  don't see the ball move" on short passes measured out as: no pass in the game
  is on screen for under eleven frames at 60fps, but a 3-yard one moves
  SEVENTEEN PIXELS at 720p while being ELEVEN PIXELS across — the camera is
  behind the passer, so a flat pass travels along the view axis where
  perspective eats it. Lofting short passes to buy screen travel was measured
  and rejected: enough arc to see costs six points of completion, because every
  defender breaks on `ball.to` the moment the ball is airborne. The physics was
  right; the fix is a flight trail, and `npm run passes` is the probe.
- **A trail whose length is a SAMPLE COUNT is frame-rate dependent** — 14
  samples is 0.7s of history at 20fps and 0.12s at 120. Samples carry their age
  and are dropped by it, the same lesson as the ball's spin being a rate per
  second rather than per frame.
- **A GAIT'S GROUND SPEED IS A MEAN, AND A MEAN CANNOT SEE A SLIDE.** The
  ladder matches `groundSpeed` to within a tenth of a percent — right stride,
  right cadence, playback rate 1.000 — and the support foot still slid at 31%
  of the player's own travel speed, because it creeps through early stance and
  whips through toe-off. That is the `spread` column in `npm run body`'s
  cousin `glb-gait --report`, and it is what "the players skate" actually is.
  The fix is a re-timing, not a re-authoring: `du = (v/G) dt` through stance
  and `du = dt` through flight makes the sweep constant, and normalising back
  to the clip's own duration leaves stride length, cadence, ground speed and
  the left contact at phase 0 all exactly as they were. Baked per clip as
  `extras.sweepWarp`, read back by `playermodel.js`, same contract as
  `groundSpeed` and `blendUp` — no constant to keep in step.
- **Skating is measured in two places and they answer different questions.**
  `npm run body` measures the feet in the LIVE game, which is where it finally
  counts, and it is far too noisy to judge a change by: three runs of one
  unchanged build gave 31%, 42% and 57%, because each is a different football
  match. It is seeded now, and even so the pair has to be run seed for seed.
  `npm run slip` takes everything else away — constant speed, straight line, no
  lean, no turn, no camera — and answers the same question about the ladder
  ALONE, deterministically, in a second. Locate a cause with `slip`; confirm
  the game still looks right with `body`.
- **The obvious suspect for skating is the FACING, and it was not guilty.**
  A body pointing off its line of travel does slide, and `alongMotion` exists
  for it — but measured in the live game the median skew is **3.5 degrees**,
  which accounts for about 6% of slip against the 31% measured. Proving that
  took removing everything else: an offline replay of the ladder at 60fps with
  no lean, no facing and no camera reproduced 10-35% on its own. Measure the
  thing itself (where the foot IS, frame to frame, in world space) rather than
  a proxy for it.
- **A probe that indexes players by slot is comparing two different men.**
  Every formation change disposes ten bodies and builds ten new ones, and the
  index is reused, so one frame either side of a rebuild differences one man's
  arm against another's. It reported a 3,219 deg/s whip on a player standing
  still and it was the worst reading in the file. `debugLimbs` publishes a
  build generation now; drop the pair, do not believe it.
- **A player has NO vertical physics.** The engine gives gravity to the ball
  and to nothing else: every centimetre a player rises or falls is the clip
  plus `PLAYER_LIFT`, one constant that raises the holder because the rig dips
  below its own origin. `npm run feet` is how you find out where they really
  are, and it has to sample from INSIDE the render (an outside poll against
  swiftshader's two frames a second catches the airborne half of a stride and
  reports a squad hovering) and score each player by the TENTH PERCENTILE of
  his own lows rather than the minimum (the minimum is the frame he dived, and
  a dive is meant to go 30cm down).
- **`2.385 / 1.850` was a per-character constant pretending to be universal.**
  `player3d.js` normalised the loaded model's height by dividing by the height
  the GAME'S rig happens to be authored at, which silently overrode the
  `authorHeight` normalisation `playermodel.js` does for exactly this reason,
  and rendered a 1.744m character 6% short. Divide by the model's own height.
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
  different art style. `npm run smoke` checks this for you — it wraps
  `externalRender` and asserts `activeShell.field3d` is still non-null.
- `npm run lint` (syntax across every source file), `npm test` (rules
  regression), `node tools/simstats.mjs` (box score), `npm run pulls` (why the
  box score looks like that — the flag pull, timed and split by side),
  `npm run celebs` (every celebration, forced and read back off the renderer),
  `npm run qb` (what the quarterback threw at, and what he passed up),
  `npm run ball` (the football, in the carrier's hands or not),
  `npm run body` (do the feet slide, and are the arms a human's),
  `npm run slip` (…and how much of that is the gait ladder on its own),
  `node tools/posesheet.mjs <Clip>` (a clip big enough to judge the pose —
  measure-clip says whether it is correct, this says whether it is any good). Playwright is a
  devDependency purely so the browser harnesses survive a new container — the
  **site itself still ships no npm dependencies and no build step**.
- **Verify before claiming done:** `npm run smoke` drives the real thing in
  headless Chromium and confirms 0 console/page errors across the menu, World,
  Team Builder, Road to Glory and a live game, in both landscape and portrait,
  with screenshots in `.smoke/`. (It resolves `$FLAGSTER_CHROME`, exported by
  the session hook; the image pins a build number, so never hardcode the path.)
- **A difficulty knob is a statement about the CPU, not about the mechanic.**
  Read it as `team !== userSide` — `engine.knob(name, side)` does this, and
  every one of them must go through it. `pullTime` and `jukeCd` did not, and
  applied to both sides they inverted for half the game: Rookie, the setting
  that makes it easy while you carry the ball, made your own defence slower
  than the CPU's the moment you didn't.
- Pages deploys usually land in ~40-90s; confirm the live `VERSION` before
  reporting a change as live.
