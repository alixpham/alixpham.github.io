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
                              onto the same rig — helmeted; the graft's INPUT,
                              and the only way back to a helmet
flagster/lib/ochibare.glb     the same athlete with the helmet cut off,
                              flagplayer's head, hair and beards grafted on,
                              and the shoulder pads sculpted away; what the
                              game loads. Stamped, so a sculpt can't run twice
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
tools/glb-deshoulder.mjs      takes the shoulder pads off — flag football is
                              played in a shirt, and the pads are the SHAPE of
                              that shirt, not a part and not a bone
tools/glb-graft-head.mjs      cuts a helmet off one character and grafts
                              another's head, hair and beards on; --report
                              prints the neck seam as a number
tools/mocap/ochi-clips.mjs    the game's own 22 clips -> the Ochi metarig
tools/ochi-fetch.mjs          gets the licensed pack back into tools/ochi/ from
                              $FLAGSTER_OCHI_URL — the folder is named in the
                              tool, the rlkey stays out of a PUBLIC repo
tools/clip-audition.mjs       is a bought clip worth adopting? peak hand speed,
                              root travel, and whether it ends where it began,
                              for a whole pack in one table
tools/mocap/ochi-cycle.mjs    ONE cycle out of a bought 4-second performance:
                              period by whole-pose autocorrelation (harmonics
                              score better, so the shortest good lag wins),
                              phase matched against the clip it replaces
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
tools/posecheck.mjs           can a body HOLD this? centre of mass over the base
                              of support, and rotation integrated so a slow
                              360 shows up; a loop must pass, a one-shot may
                              be a controlled fall
tools/herocheck.mjs           the landing screen's cast, read out of hero3d.js
                              and run through posecheck — the menu is a claim
                              about what a player can do, and this checks it
tools/gaitslip.mjs            planted-foot slip from the LADDER alone, with the
                              facing, the lean and the camera taken away —
                              deterministic, where bodycheck is not
tools/bodycheck.mjs           is this body possible? planted-foot slip and
                              float, and every arm joint against a human's
                              limits — off the RENDERER, with a standing
                              player as the control
tools/touchcheck.mjs          can a THUMB play this? every control against the
                              44pt/48dp floors and the notch insets, a hit-test
                              grid for the dead channels between the buttons,
                              and a real CDP stroke to catch the slash steering
                              the player before it becomes a route. Tracks the
                              carrier's screen box over a whole down, because
                              one frame is not a measurement
tools/pickcheck.mjs           does the PICK SIX actually play? forces
                              interceptions in a real game and reads the camera
                              back off the renderer — a lens on the wrong side
                              of the ball still draws a clean frame with the
                              ball in it, so nothing else can catch this
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
  by `P.gait(kind, speed)`, on the field AND on the menu. A clip can
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
- **A HELMET IS NOT A PART, IT IS A BONE.** `build-ochi-player.mjs` files the
  shell and facemask under `jersey` so they take the team's primary, and the
  stripe and chinstrap under `trim` — so the triangles are merged into the
  SHIRT, and nothing in the renderer can address them. The only thing that
  tells a helmet triangle from a sleeve triangle is which bone it hangs off.
  And what is under it is not a head: sixteen `skin` triangles of flat
  face-plate and twelve of `hair`, 0.17m tall where a head is 0.23m, with no
  face at all. So `tools/glb-graft-head.mjs` cuts the helmet AND grafts on the
  head this repo already builds — which is a pure scale and shift, and only
  because `glb-rerig.mjs` guarantees no rest rotation in either rig. The face
  comes free: that head carries the UVs `playermodel.js` draws its face canvas
  into, so eyes, nose, mouth and hair light up with no renderer change.
- **The seam is at the NECK, and the neck is not neck-weighted.** This body's
  is mostly `spine.003`/`spine.004`, with one band straddling Head and Neck
  that carries the jaw flare — 0.0464 half-wide at y 1.478, 0.0629 by 1.528.
  By majority those triangles are Neck's, they survive a dominant-bone cut,
  and the flare then stands 12mm outside the new jaw. On `skin` and `hair` a
  triangle goes if ANY vertex is Head's; on `jersey` and `trim` the majority
  rule stays, because their neck triangles are the COLLAR and a collar is
  shirt. Measure the ring against the neck the cut LEAVES BEHIND, not against
  the file as it stands — the face-plate you are about to delete reads as an
  overhang that does not exist.
- **A SHOULDER PAD IS NEITHER A PART NOR A BONE — IT IS THE SHAPE OF THE
  SHIRT.** The helmet at least hung off `Head`, which is what made the graft
  possible. The pads are 41 jersey vertices per `Shoulder_*` and 27 per
  `UpperArm_*`, in the same primitive as the sleeve and the chest, sharing the
  same accessors: nothing to delete, and deleting would open a hole in a closed
  shirt. So the geometry is sculpted. Three formulations, and the two that
  failed are the lesson. Shrinking TOWARD the joint moves a shell sitting at a
  constant distance from that joint by almost nothing (5mm against a 90mm pad),
  and widening the falloff to fix it reaches the elbow and SHORTENS THE ARM.
  Deflating along the normal turns thin features inside out — the cap's lip is
  thinner than the 65mm being taken off, so its underside was pushed up through
  its own top and the measured shoulder went UP, 1.496 to 1.539. What works is
  contracting the radius ABOUT THE ARM AXIS: a linear contraction in a plane
  cannot invert, and the component along the bone is untouched so the arm keeps
  its length by construction.
- **And only the EXCESS radius comes off.** Contracting by a flat fraction
  thinned the limb as well — the upper arm lost 40% along its whole length,
  which is a padless player with the arms of a bird. `keep` is what a shoulder
  is, and it is not a taste setting: it has to clear the LIMB's own radius
  (0.061-0.084 here, so 0.095) or the tool is sculpting the arm rather than the
  pad. At 0.070 the arm loses 14%; at 0.055, a third.
- **Nothing tears, and that is not luck.** `glb-repaint.mjs` built the body so
  all seven parts share ONE position accessor and differ only in index buffers,
  so moving a vertex moves it for every part that uses it and the sleeve cannot
  come away from the arm. Both `glb-deshoulder` and `glb-graft-head` assert the
  sharing rather than assuming it. A deform also has to REBUILD normals — no
  cheap rule carries them through a non-uniform change — and stamp the output,
  because running a sculpt twice sculpts twice.
- **`hair_long` was 326 vertices of NaN, and had been forever.** Its row in the
  builder's style table sets `rib` and forgets `ribs`, so the thickness term is
  `Math.cos(NaN)`: one player in six, bald, invisibly, because a style that
  renders nothing looks exactly like a style you did not roll. A donor mesh is
  not automatically good geometry — `glb-graft-head` refuses non-finite
  positions and names them, and `showOne` falls back to a style the model
  actually carries.
- **THE LINK TO THE LICENSED PACK DOES NOT GO IN THIS REPO, BECAUSE THIS REPO IS
  PUBLIC.** `alixpham.github.io` is a GitHub Pages site with `visibility:
  public`, so a Dropbox share link committed here is a working download of
  licensed artwork for anyone who reads it — the same redistribution the
  `.gitignore` entries for `*.fbx`, `*.blend` and `tools/ochi/` exist to
  prevent, one hop removed. The FOLDER is named in `tools/ochi-fetch.mjs` and
  HANDOFF.md so nobody has to describe it from memory; the `rlkey` lives in
  `$FLAGSTER_OCHI_URL` in the environment config, beside `FLAGSTER_CHROME`.
  `npm run ochi:fetch` is then one command, and prints the folder and asks for
  the key when the variable is unset.
- **THE STUDIO OCHI SOURCE IS IN THE DROPBOX, AND IT REPRODUCES THE SHIPPED
  CHARACTER BYTE FOR BYTE.** `build-ochi-player.mjs --fbx <_ANIM.fbx> --texture
  <atlas.png>` remakes `ochiplayer.glb` at the same 856,816 bytes and the same
  sha256 as the committed asset, which is what makes any of the chain safe to
  re-run. **The `--fbx` must be one of the six `*_ANIM.fbx`**: the static
  `AmericanFootballMan.00N.fbx` meshes carry no skin and the build stops at
  stage 3 with "not a skinned model". The pack holds six athletes x six
  hand-authored clips — Catch and Fall, Hold, Kick, Kickoff, Run Fast, Throw 01
  — on this character's own metarig, and the `.blend` carries exactly the same
  six. **There is no Celebrate and no Lasso in it**; those are this repo's, and
  what the source unblocked was the CHAIN, not the clips.
- **A BOUGHT CLIP IS A PERFORMANCE, NOT A CYCLE.** All six are 4.125s and about
  nine strides, and a gait rung is one. `ochi-cycle.mjs` extracts one — the clip
  is already in place, so there is no root motion to strip, and its period
  measures 0.454s against the authored Sprint's 0.48s, which is the same
  cadence. Two traps: a HARMONIC scores better than the fundamental on
  autocorrelation (three strides averages over fewer and more similar pairs), so
  take the shortest lag within tolerance of the best; and the phase cannot be
  guessed, because every rung must put the LEFT foot's contact at phase 0.
  Matching the clip it replaces is a stand-in for the FK that would find contact
  properly, and it is not reliable — matched against Sprint it gives a clean
  5.43 m/s and 18% spread, matched against Run it lands half a cycle out and
  measures 2.64 m/s at 255%.
- **THE WHOLE STUDIO OCHI PACK WAS AUDITIONED AND DECLINED, EACH FOR ITS OWN
  REASON.** `npm run audition` puts a pack in one table — peak hand speed, how
  far the body travels, whether it ends where it began. **Kick, Kickoff and Hold
  are placekicking**, and `engine.js` says out loud that "there is no kicking of
  any kind in flag football"; Hold is the holder's crouch, hand at 0.14m.
  **Catch and Fall** catches at 2.09m and then goes to ground and stays there —
  its head ends at 0.24m, 1.46m from where it started — and this game's Catch has
  to leave a receiver running. **Throw 01 peaks at 5.93 m/s at the hand against
  this game's authored Throw at 19.69**, which is roughly where a real
  quarterback is, and it strides 1.12m forward where the passer is set. Sample
  finely or the number flatters it: at 10 samples a second that throw reads 4.45
  m/s and at 400 it reads 5.93. **A bought pack is a stylised set; these clips
  are deliberately athletic, and every one of the six measured slower than the
  clip it would have replaced.**
- **AND `Run Fast` IS NOT A SPRINT: 5.43 m/s, measured.** That is slower than
  this game's own Run (6.02) and a long way under its Sprint (8.83), so it
  cannot be the top rung and there is no rung it improves. Studio Ochi animated
  a realistic fast run; this ladder is deliberately heroic. Measured and
  declined, the same way the QB expected-value model was — the tooling is here
  (`fbx-to-glb --adopt`, `ochi-cycle.mjs`) for when a clip does win.
- **DO NOT REBUILD `flagplayer.glb` CASUALLY.** A rebuild from the current
  `build-player-glb.mjs` drops `extras.sweepWarp` from all four gait clips —
  the committed asset went through `glb-gait.mjs` afterwards, and the builder
  alone does not emit it. Rebuilding to fix a cosmetic bug would quietly
  reinstate the skating. `build:player` is only half the pipeline.
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
- **A QUARTERBACK SCRAMBLES SIDEWAYS, BECAUSE A3 SAYS SO.** `AI_SCRAMBLE_AT`
  sat unreferenced for its whole life under a comment saying "before a QB tucks
  and runs", while `_aiQBOrCarrier` said the opposite in prose. Both were half
  right: tucking and running FORWARD is a dead ball at the line, but a passer
  who has held it past his read does not stand in the pocket shuffling half a
  yard either. He breaks it laterally, at a run, away from the nearest man and
  toward the wider side. Two things it must have: the target clamped behind the
  line AND `qb.x` held there outright, because `_seek` integrates and a clamp on
  the target is not a clamp on where a frame lands him; and a POSSESSION gate —
  `_dropback` is called for the quarterback on every frame of every pass play,
  thrown or not, so a time test without one reported the pocket broken on 92% of
  pass plays, most of them after the ball had gone. 28% with the gate, and
  `simstats` asserts passers-past-the-line is 0.
- **A FLEA FLICKER HANDS IT OVER FOR REAL, AND IT TOOK THREE THINGS TO AFFORD
  IT.** The play names the QB as its carrier because he is the man who THROWS
  it, and `op.carrier !== 'QB'` therefore skipped the transfer and just set
  `handoffDone` — the flag that stops him being a passer — so a designed deep
  shot resolved as a quarterback keeper. The ball goes to the back now and comes
  back on a pitch, and `handoffDone` going false again is what puts the QB back
  under A3, keeps `_isRunner` false so the defence covers, and lets `_aiThrow`
  fire at all.
- **AND THE FAKE WAS UNSTOPPABLE UNTIL THE PLAY-CALLING WAS FIXED, NOT THE
  DEFENCE.** `_isRunner` sent ALL FIVE defenders at a live runner, so the fake
  emptied the secondary and the ball came back to a field with nobody in it:
  four flea flickers in five scored, and touchdowns went 13.9% of plays to
  **17.6% on that one play alone**. Five defensive answers were measured and
  every one of them cost more than it saved — holding the deepest man out of the
  pursuit entirely took yards per carry 4.5 -> 9.2, making him idle for a beat
  cost most of the same, and applying leverage to every deep defender rather
  than one took it to 7.2 while helping touchdowns not at all. **The actual
  problem was that the CPU picked uniformly from fifteen plays, so a FIFTH of
  every game was a trick and a flea flicker came round every five possessions.**
  It is not that one is too strong; it is that twenty of them are.
  `AI_PLAY_WEIGHT` puts tricks at a quarter weight — about 5% of snaps — and the
  fake then ships at 15.9% touchdowns against 15.7% without it, inside the
  seed-to-seed noise. Weight the CALL before nerfing the mechanic.
- **THE LAST MAN PLAYS LEVERAGE, NOT THE BALL.** The one defensive change worth
  keeping: the deepest defender holds his depth and mirrors the carrier across
  the field rather than running at him, and comes downhill only once the run is
  inside `DEEP_TRIGGER` (9 yards). Depth is the thing to keep, not stillness —
  he stays goal-side and useful against the run the whole time, and he is still
  deep when a play-action throw goes up. Costs 0.4 yards a carry.
- **AND `handoffDone` GOING FALSE AGAIN RE-ARMS THE AUTO-HANDOFF.** The pitch
  back set it false on purpose; the auto-handoff is gated on exactly that flag,
  so the next frame handed the ball straight back — **343 pitches in a single
  down**, ping-ponging every other frame. It survived a first look because the
  play still LOOKED right (the quarterback ends up with it and throws) and
  because the probe recorded a BOOLEAN "did this play flick?", which reported a
  contented 1. Count the thing itself. `trickStage` is the real "has this trick
  already resolved" flag.
- **A TRICK IS NOT A RUN.** `simstats` bucketed by `/pass/.test(type)`, so all
  three trick plays counted as runs — and the moment Flea Flicker became a real
  deep shot its completions dragged "yards per run" from 4.5 to 8.0 with no
  handoff changing at all. Runs 5.3, tricks 9.1, on their own lines.
- **AN INTERCEPTION IS A LIVE BALL, AND THE FIELD TURNS ROUND WITH IT.** A pick
  used to be a whistle and a spot at `50 - yardsToGoal`, so the play that most
  often ends in six points could not end in any. `state.possession` moves the
  instant the ball is caught, and because every role in the update loop is
  asked of `offenseTeam()`/`defenseTeam()` rather than remembered, that one
  assignment re-points all of it. The direction does NOT come free:
  `attackDir()` is -1 while `state.returning`, and every goal line, leverage
  test and lateral goes through it. Four things bit. `_update` takes
  its offence and defence lists at the TOP of the frame and the catch is
  resolved half way down it, so on the frame of the pick the flag-pull check is
  handed the new carrier's OWN side, himself included at range zero: measured,
  he is recorded as grabbed by *himself* with the meter filling, 1.9% of a pull
  in one frame and the renderer drawing the grab. It comes right on the next
  frame, so a test that intercepts from OUTSIDE `_update` cannot see it at all —
  `ruletest` forces the pick from inside the frame, where `_resolveCatch` does. `_steer` flags ANY player who would have left the
  field and only the carrier is ever asked, so a corner who has been running
  the paint carries a stale `outOfBounds` into the first frame of being one.
  A marker already on the field cannot survive the flip — `against: 'defense'`
  is resolved through `defenseTeam()` at the end of the play — so a pick with a
  flag down is settled the old way, which is also the case the live ball exists
  to allow (an interception under a defensive foul comes back). And the
  takeover cannot go through `_takeOver`: possession has ALREADY changed, so
  mirroring it a second time hands the ball straight back.
- **THE OLD SPOT WAS TOO KIND, WHICH IS WHY THE SCORELINE DID NOT MOVE.**
  `50 - yardsToGoal` is the mirror of the LINE OF SCRIMMAGE — where the ball
  was snapped, not where it was caught — and an interception happens downfield
  of the line. Spotting a return where it really ends starts the returning side
  about five yards worse off on average (22.6 -> 27.2 to go), and 8.7 yards of
  average return earns most of that back. Combined points per game 66.3 +/- 1.8
  before, 66.0 +/- 1.5 after, over 64 games each: a free six every five games,
  paid for on every other one. A mechanic that adds a way to score is not
  automatically a buff — measure the field position it replaces.
- **A PROBE MUST CHANGE THE STATE WHERE THE ENGINE CHANGES IT.** `pickcheck`
  forces an interception from inside `externalRender`, and forcing it AFTER the
  inner render call left the camera one frame behind the flip — 1.9% of return
  frames on the wrong side of the ball, which is precisely the failure the probe
  exists to find. A real pick is resolved in `_update`, which runs before the
  renderer sees the state; force it there and it reads 0%. The same lesson as
  `celebcheck` waiting on the celebration rather than on the clock: match the
  engine's own ordering or you measure your own harness.
- **A CONVERSION AND AN OVERTIME POSSESSION HAVE NO RETURN,** and neither is a
  shortcut: the try is over the moment the defence has the ball, and a change
  of possession in overtime ends the possession. Some codes award points for a
  defensive return on a try; this file has no source for that number and does
  not invent one — see `touchdownsPerPlay`, which was guessed at and wrong for
  eleven releases.
- **There are no chains: four downs to reach midfield, FOUR more to score.** So
  there is always exactly one line that matters, and the read has to know which.
  It was three to score for a long time, which is NFL Flag's rule in a game that
  calls itself IFAF everywhere else — `data.js` says "5v5 IFAF Olympic flag
  football" and the engine header lists IFAF halves, no-run zones and rush line.
  **The width is the one deliberate departure**: 70 x 30 is NFL Flag's, kept on
  purpose because five yards is a fifth of the surface and decides how much room
  a receiver has against man coverage. YAC is worth counting on a first down and worth nothing on a last
  one — you do not bet a series on five yards of run-after-catch — so the
  allowance is discounted by what the down is worth.
- **THE TOUCHDOWN TARGET WAS WRONG, AND THE GAME WAS RIGHT.** `simstats` has
  carried `touchdownsPerPlay: '~5-8%'` with no source since the beginning, and
  REALISM.md has called the game "about double where it should be" since
  v2.17.0. Hold the target against this file's own play count: 45-60 plays at
  5-8% is **16 to 34 combined points a game**. Twenty real games — the 2024 IFAF
  Men's World Championship group stage and the whole knockout bracket — average
  **64.5 combined points**, which is ~9.2 touchdowns, which at ~60 plays is
  **16% of plays**. Flagster measures 65.3 points and 16.1%. Eleven releases
  were spent chasing a number that was half of reality. `simstats` reports
  points and touchdowns per GAME now: it tracked the score all along and never
  printed it, and every other line in that box score is a rate — a rate can be
  right while the game it adds up to is nothing like the sport. Unsourced
  targets are marked as such now. **Find the number before tuning the game to
  it.**
- **A ROUTE NEEDS SOMEWHERE TO RUN.** The CPU picked uniformly from the
  playbook, so it called Four Verticals from the five-yard line as readily as
  from its own thirty. Measured on conversions — always snapped from the five —
  **35% of its calls were deep concepts**, converting at 18-33% against 62-67%
  for the short ones. `AI_PLAY_ROOM` gives each family the depth it needs and
  the weight falls off as the SQUARE of the room that is missing, because half a
  field is not half a Four Verticals. Deep calls from the five 35% -> 11%.
- **A BREAK-UP DOES NOT ALWAYS HIT THE FLOOR.** Every contested failure was an
  incompletion, so the only way to be intercepted was for a defender to win the
  ball outright — and since the QB started measuring separation where the ball
  ARRIVES he almost never throws one there. Picks fell to **0.8% of attempts
  against a real 3-5%**. The fix is not a worse quarterback: a ball that is got
  to and not caught goes up, and whoever is standing there has a play on it.
  `TIP_PICK` only turns over a deflection made by a DEFENDER — a tip a receiver
  recovers is just a completion nobody would credit. 0.8% -> 4.8%, read
  untouched.
- **THE RULES-CORRECT CHANGE MADE THE GAME LESS LIKE THE SPORT, AND THAT WAS THE
  FINDING.** Giving the offence IFAF's fourth down to score took combined points
  from 67.0 a game to **76.3**, against a real 64.5 — the three-down rule had
  been masking a defence that gives up too much per possession. So the rule fix
  is not shippable on its own; it is shippable with the thing it exposes.
- **AND WHAT IT EXPOSED WAS THE FLAG PULL, NOT PURSUIT.** The yards were not
  going to bad angles. 12% of pass plays were gaining 25+, 15-yard-plus plays
  carried **73% of all passing yardage**, and the average throw travelled 7.2
  yards against 14.4 yards per completion — so **over half of passing yardage
  was run after the catch**. `npm run pulls` said why: a pull took 1.35s against
  its own 0.6-1.0s bar, and only 71% of plays where a defender got a hand on
  ended in one. **Only the CLOSEST defender fed the meter**, so a carrier
  surrounded by three men was pulled at the speed of being chased by one, and
  gang pursuit is the only thing this sport has to stop anybody with. A second
  man is worth half a man and a third half of that. Pull conversion 71% ->
  **81%**, median 1.35s -> 1.12s, and yards per carry fell into its 4-5 band on
  its own — which is how you find out a band was right and the mechanic was
  wrong, rather than tuning to the band.
- **NO PUBLIC BOX SCORE EXISTS FOR THIS SPORT.** `yardsPerRun`,
  `gainsOfThreeOrFewer` and `playsPerGame` were searched for and cannot be
  sourced — there is no statistical database for IFAF or NFL Flag, only
  rulebooks and scorelines. They stay marked. **Scorelines are the one thing
  that IS public**, which is why points per game is the metric to steer by.
- **A CONVERSION IS A PLAY, AND THE PROBE COUNTED ZERO OF THEM.** `patPlays`
  filtered on a field the row never set, so it was hard-wired to 0 while ~9.8
  were being played every game. And reading success off the conversion's own
  score delta reports 0% every time, because the points post from a drained
  continuation one row later — the engine emits `patresult` with the answer in
  it, so take that rather than inferring it.
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
- **THE MENU IS A DIFFERENT RENDERER, and it was never being checked.** The
  landing screen is `hero3d.js`, not `field3d.js`: its own camera, its own move
  drivers, its own cast list. A whole investigation into "the arms rotate 360"
  measured the in-game demo, found every joint inside a human's range, and was
  looking at the wrong screen. `npm run hero` reads the cast OUT of hero3d.js
  and refuses a move whose clip a body could not perform.
- **A PLANAR STANCE TEST CANNOT SEE A HOP, AND A ONE-AXIS CONTACT PATCH
  COLLAPSES A SQUARE STANCE TO A LINE.** Two more of the same bug that has now
  bitten `posecheck` four times. `travel` measured the hips in the GROUND PLANE
  only, so a body going straight up read as perfectly still and Celebrate was
  judged on 119 of its 120 frames, the airborne ones included — an 8.5cm hop
  against a 6cm contact band, and the toe of a tilted foot never leaves it. And
  the sole points were padded by half a boot in x and NOTHING in z, so two feet
  level with each other were collinear, `hull()` correctly dropped them to a
  two-point line, and `marginInside` fell to its degenerate branch and answered
  with the distance to the nearest vertex: a centre of mass 2.4cm behind the
  middle of the feet was reported 17.3cm outside them. The tell was that the two
  numbers disagreed — every healthy clip's margin is smaller than its offset,
  and Celebrate's was seven times larger. A stance is settled in THREE
  dimensions and a contact patch has two axes. Celebrate needed no change at
  all; it now reads -0.4cm, inside the slack, and Dive, Spike and HighStep
  correctly report no settled stance instead of a fictitious one.
- **AND WHICH WAY HE IS FALLING IS HALF THE ANSWER.** A margin on its own says a
  pose is impossible and leaves you to guess whether the fix is the arms, the
  lean or the stance — at a full asset rebuild per guess. `posecheck` reports
  the offset from the base's own centroid now, and it is what showed the
  reported margin could not be believed.
- **AT VERTICAL, AZIMUTH AND AXIAL ROTATION ARE THE SAME DEGREE OF FREEDOM.**
  Lasso swept `horiz` a full 360 with `elev` reaching 178 — two degrees off
  straight up — to clear the skull. Driving azimuth through the top of a bone
  that is already lying on that axis does not swing the arm, it SPINS it: the
  humerus wound 365 degrees about its own axis every 0.9s, forever, against a
  shoulder's ~180 of total axial range. The clip's own notes had already proved
  no full turn exists that clears the head; what they missed is what the
  near-vertical escape costs. A real twirl never asks the shoulder for a
  revolution — the arm holds up and outboard and traces a SMALL circle while the
  wrist drives the rope. Two sinusoids in QUADRATURE (azimuth about a centre,
  elevation a quarter-turn out of phase) trace a closed circle about a TILTED
  axis, which a fixed-elevation sweep cannot do. Winding 365 -> 40 degrees, and
  skull clearance went the right way too, 63mm -> 129mm.
- **`flagplayer` NEVER HAD SHOULDER PADS.** The note that said it did was an
  assumption that the fallback shared the bought character's problem. Its
  shoulder is an anatomical deltoid: joint at 0.200, sleeve radius 0.094, 12mm
  of bulge on top, and nothing above the collar line at 1.512 — where the Ochi
  pads rose 10cm above the neck joint, level with the jaw. Measure the fallback
  before assuming it inherited anything.
- **A LOOP IS WHAT MAKES A POSE IMPOSSIBLE, not the pose.** A one-shot may put
  the centre of mass outside the feet — a dive, a cut and a jump are exactly
  that, a controlled fall — and it may sweep an arm through most of a
  revolution, because a throw does. A LOOPING clip may do neither: it plays for
  as long as the move is on screen, so 360 degrees a cycle never unwinds and
  a lean past your own feet never gets caught. That one distinction is the
  whole verdict in `npm run pose`.
- **Degrees per second cannot see an arm going round.** `bodycheck` measures
  rate and found nothing; Lasso winds a forearm 363 degrees every cycle at a
  perfectly human speed. Integrate the rotation along its path — the NET
  winding about an axis — or a slow full revolution is invisible.
- **Balance is a point and a polygon.** Centre of mass from Dempster's segment
  masses on the bones (trunk 49.7%, thigh 10.0% each…), base of support from
  the sole points that are on the ground. Three ways to get the base wrong,
  all of them found the hard way: a band too tight collapses a two-footed
  stance to ONE point (this rig's heels differ 3cm in height) and everything
  reads off balance including Idle; a per-frame floor can never report anybody
  airborne, so both-knees-up in HighStep became a foot planted 58cm forward;
  and judging any frame but a settled TWO-FOOTED stance grades running, which
  is a controlled fall by definition.
- **The hero glided because two numbers disagreed and nothing compared them.**
  `play('run') + setSpeed(1.35)` sweeps a 6.02 m/s clip's feet at 8.13 m/s
  while the root translated at 1.01 m/s — eight times — and then `travel` hit
  a cap and the root stopped while the legs kept going. The menu goes through
  `P.gait(kind, speed)` with the speed it is actually covering now, and the
  move lasts exactly one traversal of the runway so nothing needs capping.
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
- The camera sits behind whoever HAS THE BALL. For the whole of an ordinary
  down the offence attacks +x, so it never turns round — **and an interception
  return is the one time it does.** `engine.viewSign()` is the seam that says
  which way is downfield, `state.viewDir` is the answer, and the same number
  rotates the stick, so the controls and the picture cannot disagree. `viewDir`
  outlives `state.returning` on purpose: it holds through the dead ball so the
  shot does not whip back across the field over the celebration, and
  `setupFormation` is what puts it back to +1.
- **THE CONTROLS' CONTAINER IS NOT A CONTROL.** `pointer-events:auto` on
  `.right-cluster` made the whole column eat touches — the 8px flex gaps, the
  ragged edge where a row wraps short, the strip above SNAP — and none of it
  has a handler, on a layer sitting directly over the swipe pad. Measured on a
  hit-test grid across five phones, **7-10% of the entire screen** hit that
  container and did nothing: a thumb landing there neither pressed a button nor
  steered. The container is transparent now and only the BUTTONS take touch.
  The same bug twice: `.game-top-btns` had it too, and the pause button inside
  it was ALSO missing from the probe's classifier, so a working control was
  being counted as a dead zone. Both halves have to be right or the number lies.
- **A HOLD BUTTON NEEDS A WAY TO BE LET GO OF THAT ISN'T THE FINGER LIFTING.**
  Sprint listened for `touchend` only. The OS takes touches away without ever
  sending one — an edge swipe, a notification, palm rejection, a call — and
  every one of those fires `touchcancel` instead. Miss it and sprint is latched
  ON for the rest of the game, stamina on the floor, with nothing the user can
  press to release it. `blur` is the desktop half of the same hole.
- **A GESTURE THAT MIGHT STILL BECOME A SLASH MUST NOT STEER YET.** Leaving the
  stick live while a route is being drawn "is how you end up on the sideline
  before the route even exists" — and the code did exactly that for the first
  64px of every stroke, going live at 7px and only releasing when the slash
  threshold fired. An L-shaped slash fed the engine NINE live steering frames
  along its first leg. What tells a stroke from a drag is SPEED, not distance:
  `STICK_HOLD_MS` waits for the gesture to declare itself. The knob still
  follows the thumb from the first pixel, so it feels immediate either way.
- **A HEADLESS BROWSER HAS NO NOTCH.** `env(safe-area-inset-*)` resolves to 0
  in one, so a stylesheet that pads for a notch and one that ignores it lay out
  identically — the check was grading the stylesheet's intentions. Reading the
  insets through `--safe-*` variables that DEFAULT to `env()` lets the harness
  stand a real device's insets up in their place and measure where the buttons
  actually went. (`viewport-fit=cover` is set, so without the padding SWITCH,
  PULL and sprint sat in the bottom inset on every iPhone tested.)
- **A LANDSCAPE PHONE IS WIDE AND SHORT**, and the situation panels were only
  dropped by a `max-width:620px` query — a portrait breakpoint no landscape
  phone ever reaches, because they are 850-950px across. So on every landscape
  handset the button stack sat on top of `.sit`. What makes the screen small
  there is the HEIGHT, so that is what the query has to ask about.
- **THE MAN YOU ARE DRIVING WAS PERMANENTLY UNDER YOUR OWN THUMB, and one
  frame could not see it.** The action buttons are 172px of a 375px screen —
  46% of the width, left edge at half of it — and the chase camera puts the
  carrier dead centre by construction, so his right shoulder is always inside
  them. A single-frame probe read 52% on one device and a clean 0% on the other
  four; sampled over 90 live frames it is **100% of frames on both portrait
  handsets**, up to 46% of his body, and **0% on all three landscape** ones —
  the same lesson as the single seed in the QB work. The fix is
  `CAM.tall.latBias`, yards of look-at offset toward screen-right (which is
  `+z*s`), spent on the LOOK-AT alone so the lens never moves and no downfield
  visibility is lost: 1.6yd carries him from x=50% to x=35% and the overlap to
  zero. Raising him in the frame instead is the obvious alternative and the
  wrong one — it means aiming nearer his own feet, and the downfield he stops
  seeing is exactly where the play is going. Gated on `is-touch`, so a narrow
  desktop window with no buttons keeps the centred shot.
- **A TOUCH PROBE THAT REACHES ITS OWN FIXTURE BY MOUSE DESERVES TO BE BITTEN.**
  `locator.click()` waits for "visible, enabled and stable" and timed out after
  ten seconds on every device, while the play card's bounding box was
  byte-identical across six consecutive frames and `elementFromPoint` at its
  centre returned the card. The same tap dispatched as a real CDP touch selects
  the play in 800ms. Two devices were silently measuring through the opaque
  full-screen play-call sheet, and only the `state` guard caught it.

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
  `npm run pose` (can a body hold these poses at all),
  `npm run hero` (…and is every move on the FRONT PAGE one of them),
  `npm run touch` (can a thumb play it — targets, safe areas, dead zones),
  `npm run pick` (does the pick six play, and is the camera behind him),
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
