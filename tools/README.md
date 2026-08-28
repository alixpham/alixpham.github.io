# tools/

Asset generators for Flagster. Everything here runs with plain Node (>= 18) and
has **no dependencies** — the repo stays a zero-build static site.

---

## `build-player-glb.mjs` — the rigged player model

Generates `flagster/lib/flagplayer.glb`, the skinned flag-football character the
game loads through `flagster/js/playermodel.js`.

```sh
node tools/build-player-glb.mjs
```

It prints the joint count, region list, vertex/triangle counts and file size.
Re-run it after any edit; the output is deterministic.

### Why hand-written glTF instead of Blender

No Blender binary is available in this environment, so the script emits glTF 2.0
JSON + a binary buffer directly: it lofts superellipse cross-sections into
tubes, computes per-vertex skin joints/weights, derives the inverse bind
matrices (bind pose == rest pose, so each one is a pure translation), and packs
everything into a GLB. Editing a radius or a keyframe is a one-line change.

### What the asset contains

| | |
|---|---|
| Height | **1.850 m** (authored in metres, feet on `y = 0`) |
| Facing | **+Z**, character's LEFT at **+X** — same as `player3d.js` |
| Joints | 27, single root `Hips` |
| Triangles | ~3.5k |
| File size | ~220 KB |
| Skinning | one `skin`, `JOINTS_0` + `WEIGHTS_0`, max 4 influences, weights normalised |

**Armature**

```
Hips
├─ Spine ─ Chest ─ Neck ─ Head
│            ├─ Shoulder_L ─ UpperArm_L ─ LowerArm_L ─ Hand_L ─ Socket_Hand_L
│            └─ Shoulder_R ─ UpperArm_R ─ LowerArm_R ─ Hand_R ─ Socket_Hand_R
├─ UpperLeg_L ─ LowerLeg_L ─ Foot_L ─ Toe_L
├─ UpperLeg_R ─ LowerLeg_R ─ Foot_R ─ Toe_R
├─ Socket_Flag_L ─ Flag_L
└─ Socket_Flag_R ─ Flag_R
```

`Socket_*` joints carry no skin weights — they exist purely so a ball or a
torn-off flag can be parented at runtime.

**Mesh regions** — each is its own node/mesh/material so it can be tinted
independently: `jersey`, `trim`, `skin`, `hair`, `shorts`, `socks`, `shoes`,
`belt`, `flag`.

**Clips** (all in place, no root translation drift): `Idle`, `Walk`, `Jog`,
`Run`, `Sprint`, `Backpedal`, `Throw`, `Catch`, `Dive`, `FlagGrab`,
`FlagPulled`, `Celebrate`, `Spike`, `Dance`, `Flex`, `HighStep`, `Juke`.

The five gaits and `HighStep` are built by one function, `cyclicGait()`, from
two authored phase tables — one leg and one arm, each of which the other side
repeats half a cycle later. It also solves the frontal plane (pelvic drop toward
the swing leg, lateral sway over the stance leg, shoulder counter-tilt) from
where the feet actually are, rather than from a hand-keyed sine that can fall
out of step with the footfalls.

### The gait ladder

`Walk`, `Jog`, `Run` and `Sprint` are one **ladder**, not four alternatives.
The renderer blends the two rungs that bracket a player's speed
(`flagster/js/playermodel.js`, `api.gait`), because a clip can only be played
*faster*: playback rate changes cadence and leaves the baked stride exactly as
long as it was authored, and real speed is stride length times stride frequency
with both of them rising.

| | speed | cadence | step | source |
|---|---|---|---|---|
| `Walk` | 1.8 m/s | 120 /min | 0.9 m | authored |
| `Jog` | 3.4 m/s | 167 /min | 1.2 m | CMU 35_21, retargeted |
| `Run` | 6.2 m/s | 194 /min | 1.9 m | authored |
| `Sprint` | 9.1 m/s | 250 /min | 2.2 m | authored |

Speeds are **measured off the baked clip** through `rig-fk.mjs`, not off the
table it was authored from — see the note under `rig-fk.mjs` for why those two
are not the same number. CMU's capture volume is 3m x 8m, so nobody sprints in
it and the top two rungs will stay authored.

Two invariants make the blend work, and both are checked by `measure-clip`:

* **The left foot's contact is at phase 0** in every rung, the right foot's half
  a cycle later. Blend two clips that disagree about that and one lands while
  the other is still airborne.
* **The arms are contralateral**: at the instant the left foot lands, the right
  hand is at the front of its swing. This was a third of a cycle out in `Run`
  for the whole life of the clip — a mistake no single frame shows, and one that
  makes a runner read as a wind-up toy.

The five celebrations are deliberately different in SHAPE, not in detail,
because shape is all that reads at chase-camera distance: `Spike` is a
whole-body slam (the only one-shot of them), `Dance` is lateral, `Flex` is wide
and static, `HighStep` is vertical and fast, and `Celebrate` is the original
hop. field3d gives the scorer the spike and then a dance, and picks one of the
loops per team-mate off their roster index.

`FlagGrab` and `FlagPulled` are the two halves of the same event and belong to
two different players: **FlagGrab** is the defender reaching out and ripping the
flag off, **FlagPulled** is the ball carrier's reaction to losing it.

### Conventions worth knowing before you edit

* Every joint's rest rotation is identity and limbs hang along `-Y`. So a
  **positive X rotation swings a limb backward** (`-Z`) and a **positive Z
  rotation abducts the LEFT limb outward**. Animation eulers are therefore
  directly comparable to the hand-authored clips in `js/player3d.js`.
* Because bind pose == rest pose, `inverseBindMatrices` are pure translations.
  If you ever give a bone a non-identity rest rotation you must change that.
* Ring lofts wind `quad(A, B, B', A')` with rings advancing along a direction
  `dir` where `dir · (u × v) < 0`. Flip that and the surface silently
  back-faces (which is exactly how the first pass lost one of the two jersey
  side stripes).
* A fully abducted arm cannot be swung by an X rotation — that axis only twists
  it, and an elevated arm that is also swept across the chest and rotated about
  its own axis does not decompose into an XYZ euler you can hold in your head.
  Shoulders in `Throw` and `FlagGrab` are therefore **authored in the three
  angles a throwing study reports** — elevation, horizontal adduction and axial
  (external) rotation, all relative to the trunk — and the rotation is solved by
  `armQ()`. Don't hand-type euler triples at a shoulder.
* **The foot is two segments.** Heel and ball ride on `Foot_*`; the tip rides on
  `Toe_*` and moves with it. `solePoints()` returns all three and every ground
  solve takes the lowest — which is what lets the ankle plantarflex 30 degrees
  through toe-off while the forefoot stays flat on the turf. Before the gaits
  animated the toes at all, the foot was one rigid plank from heel to tip, and
  that is the single loudest thing in a bad walk cycle.
* **Gait tables are resampled with a cyclic cubic, not linearly.** Linear
  interpolation makes every joint's angular velocity a staircase with a corner
  at each authored phase, which is most of what reads as "marionette"; it also
  clips the peaks flat when a row lands between two samples. `sampleGait()` fits
  a cubic Hermite through the rows on their real (non-uniform) phase spacing.
* Feet are authored by **where they are**, not by hip angle: `plantHip(z, knee)`
  solves the hip so a planted foot stays planted while the knee bends and the
  hips rotate over it. Pelvis height is solved too — `groundedHips()` samples the
  leg angles finely enough that the sole is on the turf between the keys as well
  as on them.

### Clip metadata (glTF `extras`)

Each gait clip carries what the renderer needs to play it at the right rate:

```json
{ "gait": 1, "groundSpeed": 6.09, "steady": 6.44, "even": 0.29,
  "stance": 0.31, "flight": 0.38, "cycle": 0.62,
  "blendUp": [1, 1.021, 1.026, 0.993, 1] }
```

`steady` (the median sweep) and `even` (its interquartile spread) exist because
`groundSpeed` is a *mean*, and a mean is exactly the wrong summary if the
support foot does not travel at a constant rate: a stance that creeps for most
of its length and then whips through toe-off averages out to the right number
while sliding forward under the player for the part of it the eye is watching.
Keep `steady` within a few percent of `groundSpeed` and `even` under about 0.3.
`GAIT_DEBUG=1 node tools/build-player-glb.mjs` prints the whole per-sample
series, which is what tells you *which* authored row to move.

`blendUp` is the correction from this rung to the next one up. A pose halfway
between a jog and a run does not cover the ground at the average of their two
speeds — the legs interpolate, the pelvis height interpolates as a separate
translation track and is never re-solved against them, and the stride that falls
out is a little short. It can be computed exactly here rather than guessed at
runtime, because every joint a gait animates in the sagittal plane rotates about
ONE axis and a slerp between two rotations about a common axis is a plain
interpolation of the angle — so the blended pose the mixer will produce is the
interpolation of these tables, and the same kinematics that measured each clip
can measure the mix. Sampled at w = 0, ¼, ½, ¾, 1.

`groundSpeed` is metres per second at the model's authored height, measured off
the same kinematics the clip is built from: at every sample where a foot's
lowest sole point is on the turf, the fore/aft velocity of *that material
point*, averaged over the cycle. `GLTFLoader` copies `extras` onto
`AnimationClip.userData`, `playermodel.js` exposes it as `P.naturalSpeed(clip,
buildScale)`, and `field3d.js` divides the player's real speed by it.

This replaced a pair of constants hand-copied into `field3d.js`. They had
already drifted twice — once when the run's stride grew 32% and the divisor
didn't, and once for the backpedal, which had no constant of its own and
borrowed the run's, so it played four times too slowly and skated for the whole
snap.

---

## `measure-clip.mjs` — reading a clip back out in anatomical terms

```sh
node tools/measure-clip.mjs Throw            # whole clip, 40 samples/sec
node tools/measure-clip.mjs Throw --at 0.374 # one instant
node tools/measure-clip.mjs Run --fps 24
```

Parses the built `.glb`, runs forward kinematics over a clip, and prints the
numbers a biomechanist would put on the pose — shoulder elevation / horizontal
adduction / external rotation, elbow flexion, trunk and pelvis rotation and the
separation between them, trunk lean and side-bend, knee flexion, hand height and
speed — plus two checks that catch the things that are invisible in a still:

* **lowest foot point** — anything below zero is being driven through the turf.
* **planted foot drift** — a foot within a centimetre of the ground that is also
  travelling is skating. (A gait clip is the honest exception and is labelled as
  one: its planted foot is *supposed* to sweep backward at ground speed.)

For a gait clip it also prints a **coupling** block, which catches the class of
error that is invisible in every individual frame because it is an error of
*timing*:

```
gait coupling
  L  contact   98%   hand back   97%   forward   40%   swing 0.69m   arm/leg error   -2%
  R  contact   48%   hand back   47%   forward   90%   swing 0.69m   arm/leg error   -2%
  step symmetry   right contact 50% after left
  extras          6.09 m/s, stride 3.77m, cadence 194 steps/min, stance 31%, flight 38%
  stance sweep    median 6.44 m/s (6% off the mean), spread 29% of it
```

Foot contact phase against rearmost-hand phase, per side. Zero is a runner;
past about 8% is worth looking at; 50% is a toy soldier. This is how the `Run`
clip was found to be swinging its arms 33% of a cycle early — every pose in it
was a good pose, the arms swung the right distance at the right rate, and they
arrived at the wrong time.

This is how `Throw` was rebuilt. The previous version measured, at the exact
instant the engine released the ball, as: hand 0.41 m **behind** the chest,
trunk still 67° closed, elbow at 95° and shoulder external rotation of 9° — a
quarterback throwing the ball out of the back of his own shoulder while facing
away from the target. None of that is visible in a screenshot; all of it is
obvious in a table.

---

### Using it from the game

`flagster/js/playermodel.js` is the runtime adapter and is a drop-in
alternative to `FLAGSTER.Player3D.build()`:

```js
FLAGSTER.PlayerModel.preload(THREE);
// ...
var P = FLAGSTER.PlayerModel.build(THREE, {
  jersey: '#d80621', trim: '#ffdf00', skin: '#e8b98f', number: 7, name: 'RIVERA'
});
scene.add(P.root);
P.play('celebrate');    // lower-camel game names are mapped to the .glb names
```

For a player who is **moving**, drive locomotion through the ladder instead —
`play('run')` is one clip at one stride length and is only right for the menu
hero, which runs at a fixed speed:

```js
P.setBuildScale(0.87);      // this athlete's height multiplier
P.setPhaseOffset(0.31);     // so a squad isn't ten men in lockstep
// ...each frame, while they're moving...
P.gait('forward', speedInWorldUnits);   // or 'backward'
P.update(dt);
```

`gait()` is a request, not a state change: the blend owns the body only for as
long as something keeps asking, so dropping into a one-shot or a celebration
needs no matching "stop" call.

It scales metres to world units (1 unit = 1 yard) by `1 / 0.9144 = 1.0936`,
giving a 2.023-unit-tall player, and uses the game's heading convention
`root.rotation.y = Math.PI / 2 - yaw`.

---

## `headshot.mjs` — the head, at a distance the game never shows it

Renders the built rig's head through the real `playermodel.js` build path, from
four angles, for as many seeded appearances as you ask for.

```sh
node tools/headshot.mjs                     # 6 seeds x 4 angles -> .headshots/
node tools/headshot.mjs --seeds 12 --out /tmp/heads
node tools/headshot.mjs --angles front,profile
```

It prints each seed's resolved appearance — tone, hair colour and style, facial
hair, the face parameters — so a bad one can be reproduced exactly, and writes
a `contact-sheet.html` for comparing several at once.

Unlike everything else in this directory it needs Playwright and the
pre-installed Chromium, because it renders. Nothing under `flagster/` imports
it; it is a dev tool.

### Why it exists

Every earlier round of head work was judged from a 40-pixel-tall player jogging
past a broadcast camera, and at that size everything reads as "a head". That is
how a skull with no jaw, eyes stuck to the outside of the face, and a hair
patch hovering off the back of the scalp all survived several passes. Rendering
the thing at 400 px, from the back and in profile as well as head-on, is what
makes those visible — and the four angles are chosen for what each catches:

* **front** — feature placement, brow, eye spacing, the hairline
* **three-quarter** — whether the cheekbone and jaw have any form at all
* **profile** — anything that breaks the silhouette; the ear; the nose
* **back** — the hairline at the nape, and shading seams down the skull

`measure-clip.mjs` does the equivalent job for motion; this one is for form.

---

## `posesheet.mjs` — a clip, big enough to judge

Renders any baked clip full-body at several phases and angles, through the real
`playermodel.js` build path, onto one contact sheet.

```sh
node tools/posesheet.mjs Bow Lasso Salute      # -> .posesheets/clip-<name>.png
node tools/posesheet.mjs --frames 8 --angles three-quarter,front Griddy
node tools/posesheet.mjs --out /tmp/poses Point
```

`measure-clip.mjs` is the honest test of whether a clip is *correct* — feet on
the turf, shoulders where a biomechanist would put them, arms in step with the
legs. It cannot tell you whether the pose is any *good*, and a celebration is
judged on nothing else. This is the same argument `headshot.mjs` makes about
faces, one level up: the game shows a player forty pixels tall from behind, and
at that size a scarecrow reads as a man with his arms out.

It caught exactly that. The first Bow swept both arms down symmetrically with
the elbows open, so for a third of a second the player passed through a perfect
T-pose; the first Griddy had the hands flat over the face rather than at the
eyes. Both measured clean.

Stills only, deliberately. A timing error is invisible in a still — that is what
`measure-clip.mjs`'s arm/leg coupling check is for — and the grid at `y = 0` is
there because half of what goes wrong with a pose is a foot an inch under it.

---

## `celebcheck.mjs` — the celebrations, forced and read back

Drives the real game in headless Chromium, fires each kind of celebration
through the engine's own entry point, and reports what the ten bodies did.

```sh
npm run celebs                                # or: node tools/celebcheck.mjs
node tools/celebcheck.mjs --shots /tmp/celeb  # keep a screenshot of each
```

```
  TOUCHDOWN
    men celebrating    5   over 50 sampled frames
    clips on screen    Spike, Dance, Idle, Flex, Bow, Lasso
    per player         *0:Spike/Dance  1:Idle/Flex  2:Idle/Bow  3:Idle/Dance  4:Idle/Lasso
    distinct clips     6
    the star ran       Spike -> Dance
    lowest body        0.100 yd
```

Celebrations are the rarest thing the renderer draws: a touchdown is about one
event a minute, the first-down celebration fires only on the down that crosses
midfield, and a demo can run for minutes without a takeaway. `animcheck.mjs` is
the honest measure of what a player typically *sees*, and it can watch for three
minutes and report nothing at all about a clip that is wired up perfectly. So
this one asks the engine for each piece of news in turn and reads the answer
back off the renderer.

It exits non-zero if a celebration never starts, if a group of five holds fewer
than two distinct clips, if the star's one-shot never fires, or if a body ends
up through the turf.

**It waits in SIM time, not wall time.** swiftshader renders this page about
twice a second and the engine clamps its frame delta to 50 ms, so animation runs
at roughly a tenth of wall speed: three real seconds is a third of a second of
clip, which is not even the length of the one-shot. Waiting three seconds is how
the first version of this reported that a first down plays the *Spike* — it was
still watching the touchdown from the previous case. Nothing here waits a number
of seconds; it waits for the celebration the renderer is running to end.

---

## `fbx-read.mjs` — the binary FBX record tree

Not a tool; the shared parser that `fbx-inspect.mjs` and `fbx-to-glb.mjs` both
import. One copy, for the same reason the rig lives once in `rig-def.mjs`.

Handles the 7x00 record tree, u32/u64 offsets, zlib-deflated property arrays,
`Properties70` lookups, and the scene index — objects by id plus the
Model→Model parent links. That last one is fiddlier than it looks: a bone has
several OO connections (its parent, its skin clusters, its animation nodes), so
last-one-wins resolves 15 of 58 parents and leaves `spine.001` an orphan.

---

## `fbx-to-glb.mjs` — a purchased FBX, converted without Blender

```sh
node tools/fbx-to-glb.mjs ManA.fbx -o player.glb --texture atlas.png
node tools/fbx-to-glb.mjs ManA.fbx -o player.glb --no-anim --stats
```

Mesh, normals, UVs, skeleton, skin weights, inverse binds, embedded texture and
the bundled clips, straight to glTF 2.0 binary. There is no Blender in this
environment — the same reason `build-player-glb.mjs` writes glTF by hand — and
the pipeline has to be reproducible in the repo rather than on one machine.

Four things it gets right that are easy to get wrong, each of which broke the
output first and was found with `glb-view.mjs`:

| | |
|---|---|
| **Vertex identity** | FBX indexes positions per control point and normals/UVs per polygon vertex. The de-duplicated tuple is `(cp, normal, uv)`, and the skin has to follow that remap or the weights land on the wrong people. |
| **Polygons** | `PolygonVertexIndex` flags a polygon's last index by storing its bitwise NOT. Fan-triangulated. |
| **The rest pose is a POSE** | Blender writes each bone's `Lcl` at the frame the file was saved on; the real bind survives only in each cluster's `TransformLink`. Composing the node chain for `spine` gave a global of `[-1.48, 38.37, -7.50]` against a `TransformLink` of `[0, 85.75, -0.72]` — a pelvis 38cm up on a 1.74m man. The rest hierarchy is rebuilt from the bind globals. |
| **The inverse bind's other operand** | `inverse(TransformLink)` has to meet the transform that puts a *raw vertex* into the same world — the mesh MODEL's matrix, with Blender's −90° X and its scale of 100. The cluster's own `Transform` comes out at scale 1 here, which produced inverse binds at 0.01 and a character one hundredth of life size. |

Units and axes are checked rather than assumed: it refuses a file that is not
`UnitScaleFactor` 1 and Y-up, instead of silently emitting someone lying on
their side at 100×.

---

## `glb-view.mjs` — does the converted asset actually load?

```sh
node tools/glb-view.mjs player.glb .views "American Football Run Fast"
```

Loads any GLB through the vendored Three.js and the real `GLTFLoader` in
headless Chromium, writes four views, and prints bone count, skinned-mesh count,
world bounds and every clip with its duration.

`posesheet.mjs` is the equivalent for a clip on the game's own rig; this takes
any GLB, which is what an import pipeline needs. Every bug listed in the table
above was found here — the numbers said so before the picture did.

---

## `build-ochi-player.mjs` — the bought character, made a drop-in

```sh
node tools/mocap/ochi-clips.mjs --fbx ManA.fbx        # the 22 clips, retargeted
node tools/build-ochi-player.mjs --fbx ManA.fbx --texture atlas.png
```

Five stages, each its own tool with its own report, because each was a bug at
some point: convert the FBX with the retargeted clips baked in, split the
palette atlas into tintable regions, rebuild onto the game's rig conventions,
put the feet back on the turf, measure the gait ladder. Output is
`flagster/lib/ochiplayer.glb`, 836 KB, which is what the game loads.

Order matters twice. The repaint runs BEFORE the rerig, because its bone rules
are written in the source rig's own names. The grounding runs BEFORE the gait
measurement, because a foot that never lands measures its speed off the handful
of frames where it happens to touch.

The Ochi source assets are licensed and not in the repository; see `HANDOFF.md`.

---

## `glb-rerig.mjs` — rebuild a character onto this game's rig conventions

```sh
node tools/glb-rerig.mjs ochi.glb player.glb --preset ochi
node tools/glb-rerig.mjs ochi.glb --report
```

`rig-def.mjs` says it in one line — *no bone carries a rest rotation* — and the
whole renderer leans on it. The chest number hangs off `Chest` at "plain metres
relative to the chest joint"; the ball goes in `Socket_Hand_R` at a fixed
offset; a carrying arm is posed by writing euler triples straight onto
`UpperArm_*`. Every one of those is only meaningful because a Flagster bone's
rest frame IS the world frame. A Rigify armature is the opposite: 58 bones,
each carrying a real rest rotation and pointing down its own +Y.

So this does not adapt the game to the character. It rebuilds the character:
every rest rotation removed at the position it already occupied, the mesh baked
into that world space, every animation rewritten, bones renamed to the
vocabulary the game looks up, and the four sockets added. The conversion is
exact rather than approximate — with `R` the source's rest world rotation,
`W_new = W_old · conj(R)` is identity at rest and puts every joint back exactly
where it was.

**It proves itself.** After writing, it skins 240 vertices through both files at
six phases of every clip and prints the worst disagreement: **0.0287 mm**, which
is the six-decimal quantisation and nothing else. That check is not decoration —
it is what caught the six bundled Ochi clips whose per-bone scale tracks this
conversion cannot carry (they threw a vertex **14 metres**, and are now dropped
by name with a reason).

Sockets are measured, not copied: `rig-def` puts the hand socket 9 cm "down" the
hand, which is only down because the game's rig rests with its arms at its
sides. The palm is found from the mesh instead. And where a rest DIRECTION still
differs — Ochi's upper arm rests 62° from this rig's — the correction is written
to `extras.restAlign`, which `playermodel.js` hands to `field3d.js` to compose
onto poses it authors itself.

---

## `glb-ground.mjs` — put a retargeted clip back on the turf

```sh
node tools/glb-ground.mjs ochi.glb out.glb --like flagster/lib/flagplayer.glb
```

A retarget carries angles, not contact. Every joint is copied faithfully and the
pelvis is put at the character's own resting height, and that is not the same as
standing on the ground: this athlete's shin is 9 mm longer and his foot is a
different shape. Measured, the retargeted walk came back with **53% flight** —
a walk, by definition, has none — and the jog with 8% stance, while the speeds
looked plausible throughout, because a foot that only touches occasionally is
still measured correctly on the frames it does touch.

The fix is a height, not a re-solve. The reference clip already knows how far
its lowest sole sits off the turf at every instant; this reproduces that profile
with a per-frame pelvis offset. Nothing rotates. Clamping to zero instead would
mean a sprint that never leaves the ground.

---

## `glb-gait.mjs` — how fast a baked gait covers the ground

```sh
node tools/glb-gait.mjs player.glb out.glb            # writes the extras in
node tools/glb-gait.mjs flagster/lib/flagplayer.glb --check
```

`playermodel.js` will not put a clip on the locomotion ladder without a measured
`groundSpeed`, and a player with no rungs never takes a step. The game's own
four are measured by the builder through `rig-fk.mjs` using the three sole
points `rig-def.mjs` declares; a bought character has no such table, so the sole
is derived from the MESH — the vertices each foot owns, the lowest centimetres
of them, split fore-and-aft into thirds, one centroid each.

Three points, not all the low vertices: Ochi's boot has a score of separate
cleat studs, and tracking whichever is lowest hops between them from frame to
frame, which is motion the foot is not making. It read as a walk whose stance
sweep varied by 63% and came out a quarter slow.

`--check` runs it against the game's own player and prints its answer beside the
one the builder baked. Different code, different geometry, **1.2% worst
disagreement** across all four rungs, with stance and flight percentages
matching too — worth more than either number alone, which is why the flag
exists. It also found the one place a mesh sole cannot follow three declared
points: the floor has to be a percentile of the per-frame minima, not the global
minimum, because the game's own walk plants at 5 mm and then digs its toe 5 mm
deeper at toe-off.

---

---

### The stance sweep, and the warp that evens it

`groundSpeed` is a **mean**, and the ladder matches it to within a tenth of a
percent — right stride length, right cadence, playback rate 1.000. What a mean
cannot say is that the support foot **creeps through early stance and whips
through toe-off**, so it averages out correct while sliding for the part of it
the eye watches. That is the `spread` column, and it is what "the players
skate" actually is: measured off the renderer with `npm run body`, a planted
foot was travelling at **31% of the player's own speed**; measured offline at
60 fps with the lean, the facing and the camera all taken away, the clip and
the ladder on their own still did **10–35%**, worst at exactly the two clips
whose spread is worst (Ochi Walk 48%, Run 35%).

So the clip is **re-timed**, not re-authored. `du = (v/G) dt` through stance and
`du = dt` through flight makes the support foot's sweep constant; normalising
the result back to the clip's own duration means stride length, cadence, ground
speed and the left foot's contact at phase 0 are all exactly what they were,
and only the distribution of time inside the cycle changes. It is baked per
clip as `extras.sweepWarp` (33 samples, pinned to 0 and 1 so the loop closes)
and `playermodel.js` writes `warp(phase) * duration` into the action instead of
`phase * duration`. A clip with no table plays unwarped, which is what an older
`.glb` does.

Through double support there are two feet down and which one to believe looks
like it ought to matter. It was measured all three ways — faster, slower, mean
— on both characters at seven speeds: the resulting slip agreed to within a
tenth of a percent everywhere except the walk, where the spread across the
three was 1.2 points. It is not a knob.

## `glb-repaint.mjs` — make a bought character team-tintable

```sh
node tools/glb-repaint.mjs ochi-manA.glb --report
node tools/glb-repaint.mjs ochi-manA.glb kit.glb --map 'f1f2f2=jersey,ffffff=jersey'
node tools/glb-repaint.mjs ochi-manA.glb dbg.glb --debug     # loud colours, then render
```

The game tints ten named material regions per player and multiplies each
`material.color` over white artwork. A bought character arrives the other way
round — one material, one texture, the shirt colour baked into the pixels — so
there is nothing to tint. That, not the animations, was what blocked the Studio
Ochi athletes.

The Ochi atlas turns out to be a **palette**: eight 1000x1000 tiles of flat
colour side by side, five of them a single colour to the pixel and three
carrying one small decal apiece (a jersey number, in the three colourways the
shirt needs). So the mesh is already partitioned into paint regions and the
partition is recovered by asking each triangle which colour its UVs sit in.

The split is lossless where it counts. Triangles are regrouped into one
primitive per region, **all still pointing at the same position, normal, joint
and weight accessors** — no vertex duplicated, no seam introduced, the skinning
untouched. Only the index buffer is rewritten. The texture is then dead, and
dropped, which is why the file gets smaller.

Three things it gets right that a naive version does not:

* **Ask the triangle, not the point.** A triangle is filed under the modal
  colour over its whole UV footprint, sampled barycentrically. Sampling one
  centroid instead files a triangle over the number under the number, and
  invents a ninth region out of the single face that straddles a tile seam and
  lands on the blended pixel between them.
* **One palette entry can be two garments.** A colour is a paint bucket, not a
  region: Ochi's navy is the trousers *and* the panel the chest number sits on.
  `--map '262262@breast=trim'` splits an entry by the dominant bone of its
  triangles, which is the one label that knows a chest from a thigh.
* **Same name means one primitive.** The runtime shares a material across
  meshes by name, so a shirt whose front and back panels are separate tiles has
  to merge into one `jersey` or a tint lands on half of it.

`--report` prints each group's triangle count, bounding box and **dominant
bones** — the bones are what name a region; debug colours have to be read off a
render and matched back by eye, which is how a facemask and a shoulder stripe
end up sharing a verdict. It also prints the fraction of texel samples that
disagreed with their triangle: that is exactly what flattening throws away.
On Ochi it is 0.96% — the number, which cannot survive anyway, because a
tintable shirt is a shirt with no pixels of its own. Tens of percent would mean
the atlas is a picture and this is the wrong tool.

The verified Ochi kit:

| region | triangles | palette entries |
|---|---|---|
| `jersey` | 183 | `f1f2f2` body + `ffffff` back panel |
| `trim` | 53 | `262262` on torso bones + `27aae1` on the sleeve |
| `skin` | 406 | `f8b583` |
| `helmet` | 294 | `262262`/`27aae1`/`ffce00` on `spine.005/006` |
| `shorts` | 152 | `262262` on `thigh` |
| `socks` | 44 | `ffce00` on `shin` |
| `shoes` | 614 | the rest of the foot palette |
| `gloves` | 24 | `3452ff` on `forearm`/`hand` |

---

## `fbx-inspect.mjs` — what is actually inside a purchased FBX

```sh
node tools/fbx-inspect.mjs asset.fbx --bones
node tools/fbx-inspect.mjs --compare ManA.fbx ManC.fbx    # same armature?
```

Reads a binary FBX (Kaydara 7x00) without Blender, without Autodesk's SDK and
without adding a dependency: skeleton (every LimbNode, its parent, its rest
offset), animation stacks and their lengths, mesh vertex counts, materials and
textures. `node:zlib` is the only import, because FBX property arrays are
usually deflated.

It exists because an asset pipeline rests on claims about files nobody has
opened. The Studio Ochi pack ships six rigged characters and the whole plan for
one shared animation library turns on whether they share one armature —
`--compare` answers that in bone names and rest offsets rather than in trust.
(They do: 57 of 58 bones identical, the 58th being where the armature stands.)

---

## `footcheck.mjs` — do the players stand on the grass?

```sh
npm run feet
node tools/footcheck.mjs --secs 170 --character flagplayer
```

"Make sure gravity works" is a question about where the feet are, and the only
honest answer comes off the renderer: **the engine has no vertical physics for
a player at all.** Every centimetre of a player's rise and fall is the
animation plus one constant, `PLAYER_LIFT`, which raises the holder because the
rig dips below its own origin.

This wraps `field3d.render` and, on every frame it draws, skins each player's
meshes through three.js's own `applyBoneTransform` and records the lowest
vertex.

Two ways to get this wrong, both of which were got wrong first:

* **Polling from outside.** A first attempt sampled from Node every 180ms and
  reported players hovering 4 cm off the turf. They were not — it had never
  caught them in stance. Swiftshader draws about twice a second, so an outside
  sampler sees a handful of frames and the airborne half of a stride is half of
  them. Accumulating inside the frame costs nothing and cannot miss one.
* **Taking the minimum.** The lowest a player EVER gets includes the frame he
  dived, and a dive is *meant* to put him thirty centimetres down. One such
  frame in four hundred drags the number to −4 cm and makes a sound lift look
  broken. Each player is scored by the **tenth percentile** of his own
  per-frame low instead: stance, not the one frame he left his feet.

---

---

## `gaitslip.mjs` — does the ladder, on its own, slide a planted foot?

```sh
npm run slip
node tools/gaitslip.mjs flagster/lib/flagplayer.glb --nowarp
```

`bodycheck.mjs` measures the feet in the **live game**, which is the only place
the answer finally counts — and it cannot tell you *why*, because everything is
in the frame at once: the stride, the blend, the facing, the lean, the turn,
the acceleration. It is also far too noisy to judge a change by. **Three runs
of one unchanged build returned 31%, 42% and 57%.** That is not a statistic
with error bars; it is three different football matches.

So this takes everything else away. It reproduces `playermodel.js`'s blend
exactly — the two rungs bracketing the speed, weighted so their measured ground
speeds interpolate to it, corrected with `blendUp`, both driven from one shared
phase through `sweepWarp` — then skins the result and differences the sole in
world space with the body translating at the speed asked for. Constant speed,
straight line, no lean, no camera. If a foot slides here it is the clip and the
ladder and nothing else, and it answers the same every time.

That is how the skating was actually located. The **facing** was the obvious
suspect — a body pointing off its line of travel does slide, and `alongMotion`
exists for it — but the live median skew is **3.5 degrees**, worth about 6% of
slip against the 31% measured. This reported 10–35% with the facing removed
entirely, worst at exactly the two clips whose stance sweep is least even.

`--nowarp` ignores `extras.sweepWarp` and plays the clips as authored, which is
what the before/after of that fix is measured with:

| | as authored | warped |
|---|---|---|
| `ochiplayer.glb` | 18.0% | **13.1%** |
| `flagplayer.glb` | 17.3% | **11.7%** |

---

## `bodycheck.mjs` — is this body possible?

```sh
npm run body
node tools/bodycheck.mjs --secs 150 --character flagplayer
```

Two complaints, one run, because both are properties of the **skinned pose**
and the only way to see a skinned pose is to draw it.

### The feet

*"Players should never move like skaters... they always must have one or two
feet planted, and the feet never slide."* A foot that is on the ground and
whose world position is moving is sliding — that is the whole definition, and
it is not the facing, not the blend weight and not the playback rate, it is
those and the lean and the stride resolved together.

`debugPlayers` has reported **skew** (how far a body points off its line of
travel) for a while, and skew is a *proxy* for skating. This measures the thing
itself: the world position of `Foot_*`/`Toe_*`, differenced frame to frame,
against the ground moving under them.

**Support slip** is the number that matters — the minimum across whatever feet
are down, i.e. *is there at least one foot bearing weight that is not sliding*.
Not "how fast is a planted foot moving": a foot at touchdown and a foot at
toe-off are both legitimately in the plant band and both legitimately moving.

### The arms

*"Their arms cannot rotate 360 degrees: they are humans and have
limitations."* Measured at the joint from world positions, so it does not
depend on how any one bone's euler triple was authored: **elbow flexion** (0 is
straight, a human folds to ~145 and hyperextends ~10), **shoulder elevation**
in the *chest's* frame so a leaning body does not read as a raised arm, and two
rates — the upper arm's **sweep**, and each arm bone's **total turn including
twist**, taken from its world quaternion, because a forearm rotating on its own
length is exactly what "the arms spin" looks like while every joint position
stays put.

### Three ways to get this wrong

* **No control.** A standing player's support foot must be pinned. If the probe
  says otherwise, nothing else it says means anything. It reads 0.03 yd/s.
* **An absolute ground height.** There isn't one — build scale, `PLAYER_LIFT`
  and the clip mix move a sole by centimetres and a dive puts one 30 cm down.
  Each foot's own ground is the tenth percentile of its own height, the same
  lesson `footcheck.mjs` learned.
* **Indexing players by slot across a rebuild.** Every formation change
  disposes ten bodies and builds ten new ones at new spots, and the index is
  reused — so one frame either side of a rebuild differences *one man's arm
  against another man's arm*. It reported a 3,219 deg/s whip on a player
  standing still and it was the worst reading in the file. `debugLimbs`
  publishes a build generation; the pair is dropped.

`render` takes the game **state**, not a delta. The delta it uses is the
engine's own, clamped at 50 ms, and reading that back rather than timing the
wrapper is the difference between differencing positions over the interval they
actually moved in and differencing them over however long swiftshader took.

---

## `passstats.mjs` — did you ever SEE the pass?

```sh
npm run passes
node tools/passstats.mjs --games 8 --difficulty pro --seed 1
```

The box score says how many passes were completed. It cannot say whether you
watched one, and that is the complaint this exists for: *"on low / short
passes, we don't always see the ball move."*

Every pass is timed from release to arrival and reported by distance bucket:
hang time, the same number in frames at 60fps, the arc above the higher of its
two ends, and the launch angle.

It settled the diagnosis by ruling out the obvious answer. **No pass in the
game is on screen for fewer than eleven frames**, and none is under six — it is
not too quick. What the buckets show instead is that a 3–6 yard pass rises
**0.00 yards** and launches **2.4 degrees DOWNWARD**, because it leaves at the
ear and is caught at the chest. The camera sits behind the passer, so a ball
with no vertical component travels almost entirely along the view axis, where
perspective foreshortens it to nothing: projected through the real camera at
720p a 3-yard pass moves **17 pixels**, and the ball is **11 pixels** across.
It moves one and a half times its own width.

It also priced the tempting fix. A hang-time floor big enough to give a short
pass visible arc (0.40s) costs **six points of completion**, because every
defender breaks on `ball.to` the moment the ball is airborne; a floor small
enough to be nearly free (0.30s, about one point) leaves the arc at zero. The
physics was right and was left alone; the fix is the flight trail in
`field3d.js`.

---

---

## `pullstats.mjs` — why a flag pull takes as long as it does

```sh
npm run pulls                                  # 8 games, pro, CPU vs CPU
node tools/pullstats.mjs --difficulty rookie --user
```

`simstats.mjs` says how a game ENDS UP; this says why. Same headless engine,
instrumented on the one mechanic the box score keeps blaming, and reporting the
numbers a player actually feels: time from a defender first getting a hand on
the carrier to the flag coming off, how many separate engagements that took,
and where the meter GOES — filled, drained by losing contact, or wiped by a
juke. `--user` drops demo mode and splits every pull by which side made it,
which is the only way to see whether a difficulty is easy in both directions or
only while you have the ball. It was not: on Rookie your own defence measured
2.65s to a pull against the CPU's 1.37s, because `pullTime` was read off the
preset for both sides. See v3.3.0 in `DEPLOY.md`.

A pull that reads well sits near a 0.6-1.0s median with 75-90% of contacts
ending in a pull; the targets are printed beside each number.

---

## `smoke.mjs` — every screen, both orientations, zero errors

```sh
npm run smoke
```

The check CLAUDE.md has always asked for before claiming a change is done, which
until v3.3.0 had no tool and was re-improvised in a scratch file each session.
Loads the menu, World, Team Builder and Road to Glory plus a live Watch Demo
game at 1280x720 and 430x932, and reports console errors, page errors and
screenshots (into `.smoke/`, gitignored).

It also answers what a clean console cannot. engine.js swallows `externalRender`
throws and hands over to the 2D canvas after five, so a dead 3D scene looks like
a working game in a different art style — the `game` row wraps `externalRender`
to catch what it threw and asserts `FLAGSTER.activeShell.field3d` is still
non-null. Exit code is non-zero if anything fired.

---

## `rig-def.mjs` / `rig-fk.mjs` — the rig, and kinematics over it

`rig-def.mjs` holds the bone table, the three sole offsets and the leg
dimensions, and every other tool imports them. They used to be typed out in the
builder and again in the measurer; adding a third consumer (the mocap
retargeter) would have made three copies of a rig and three chances for one of
them to drift, which is the same failure that put a hand-copied ground speed out
of step with its own stride table twice.

`rig-fk.mjs` is the general case of what the builder does in the plane:
quaternion forward kinematics over the whole skeleton, the lowest of the three
sole points per foot, and the ground-speed measurement — same 4mm contact
tolerance, same outputs, so a retargeted clip's `extras` mean exactly what an
authored clip's do and both can hang off one blend ladder.

**This is now what measures every gait.** The stride tables still SHAPE a walk;
they no longer get the last word on how fast it covers the ground. A planar
solve cannot see the pelvis, and a walking pelvis yaws, lists and sways — all
three of which move the hip joint fore and aft over the standing foot. Reading
the baked clip back through full kinematics put the walk 7% away from what its
own table claimed, and showed the authored walk holding its stance foot up to
5.5mm off the turf for the whole of stance. The builder now re-solves the pelvis
height through these kinematics and measures the result: the walk's flight phase
went from a reported 38% to the 0% a walk actually has.

---

## `mocap/` — motion capture, retargeted

See [`mocap/README.md`](mocap/README.md). Converts CMU Graphics Lab `.asf`/`.amc`
captures onto this rig and writes `tools/motion/<Clip>.json`, which the builder
bakes; a name that matches an authored clip replaces it.
