# tools/mocap — motion capture, retargeted onto the Flagster rig

Every clip in `flagster/lib/flagplayer.glb` used to be hand-authored: a table of
joint angles, solved onto the ground in the sagittal plane. That gets you a
correct stride and it does not get you a human one, because the things that make
motion read as a person — the asymmetry, the settle at the end of a swing, an
arm that is a beat late — are not things anybody types into a table.

This directory converts real motion capture onto our rig instead.

## Attribution

The motions come from the **CMU Graphics Lab Motion Capture Database**,
<http://mocap.cs.cmu.edu/>, created with funding from NSF EIA-0196217. The
database is free for all uses and asks only to be credited, which is what this
section is.

Nothing here needs an account or a key, which is the whole reason the pipeline
can run end to end inside an ephemeral container: CMU serves plain `.asf`
skeletons and `.amc` motions over HTTP, both of them text.

## The pipeline

```
mocap.cs.cmu.edu                fetch.mjs      cache/*.asf, *.amc   (gitignored)
        │                                             │
        │  asf.mjs — parse + forward kinematics       │
        ▼                                             ▼
   retarget.mjs  ──────────────────────────►  tools/motion/<Clip>.json   (committed)
                                                      │
                                build-player-glb.mjs  ▼
                                              flagplayer.glb
```

**The `.amc` never enters the build.** What is committed is the retargeted
result — a few hundred quaternions per clip, human-readable, reviewable in a
diff — so a rebuild in a fresh container needs no network and produces the same
bytes. The cache is a convenience, not an input.

**A file in `tools/motion/` whose clip name matches an authored clip replaces
it.** That is the entire swap mechanism, and it is the file system on purpose:
what shipped is a matter of listing a directory.

## Two targets: the game rig, and the Studio Ochi metarig

`retarget.mjs` targets the game's own 27-bone rig. `retarget-ochi.mjs` targets
the Studio Ochi character's 58-bone Blender Rigify metarig, so the purchased
model can be driven by the same free capture database instead of a paid
animation pack.

```sh
node tools/mocap/retarget-ochi.mjs 35_02 --fbx ManA.fbx --name Walk --cyclic
node tools/mocap/retarget-ochi.mjs 35_21 --fbx ManA.fbx --name Run --cyclic
node tools/fbx-to-glb.mjs ManA.fbx -o player.glb --texture atlas.png \
    --motion tools/motion-ochi
```

Output lands in `tools/motion-ochi/` on the same terms as `tools/motion/`:
committed, sampled, no network needed to rebuild.

### Two sources, one interface

CMU arrives as `.asf`/`.amc`; a downloaded or purchased pack arrives as FBX.
Both give the same three things — a bone's rest direction, its rotation
relative to that rest at time *t*, and a root position — so both are wrapped
behind one `src` and nothing downstream knows which it got.

```sh
# CMU
node tools/mocap/retarget-ochi.mjs 35_02 --fbx ManA.fbx --name Walk --cyclic
# an FBX pack (Mixamo, MocapFlow, anything with a humanoid rig)
node tools/mocap/retarget-ochi.mjs --src-fbx Dodge.fbx --fbx ManA.fbx \
    --name Juke --from 0.4 --to 1.8
```

The bone-naming convention is **detected, not declared**: the CMU and Mixamo
tables are both tried and the one that matches more source bone names wins, with
the count printed. A convention that half-matches is worse than one that does
not — it retargets the bones it recognises and silently leaves the rest at rest —
so the report says so when the match is poor, and `fbx-inspect --bones` shows
what the file actually calls things.

Validated against `Samba Dancing.fbx` from three.js (MIT): mixamo detected,
**22 of 22** bone names matched, and the dance comes out upright on the Ochi
character with the pelvis bob intact.

### Source conventions that ship

| table | naming | note |
|---|---|---|
| `rokoko` | `Hips`, `Spine1..Spine4`, `LeftThigh/Shin/Toe` | maps 23/23 — `Spine4` lands on Rigify's `spine.004`, which Mixamo has no bone for |
| `mixamo` | `mixamorig:Hips`, `mixamorig:LeftUpLeg` … | 22/22; **validated end to end** |
| `cmu` | `root`, `lfemur`, `ltibia` … | ASF; **validated end to end** |

All three are validated end to end. Rokoko's free packs are the best of them
for this game: `media.rokoko.com/WALK-RUN-CYCLES-MOCAP.zip` is a direct public
link with no gate, 16 clips, and two **treadmill** runs — in place by
construction, which is what the locomotion ladder wants and what CMU's 3m x 8m
capture volume cannot provide.

### Speed from the stance sweep — a treadmill clip DOES have a ground speed

An earlier version of this note said a treadmill capture has no ground speed
because the performer does not move. That was wrong, and the correction matters.

A treadmill is kinematically identical to running overground. In both cases the
foot in contact travels BACKWARD RELATIVE TO THE BODY at exactly the ground or
belt speed — overground the body advances over a planted foot, on a belt the
foot rides back under a fixed body, and the relative motion is the same. So
measure the stance foot against the PELVIS instead of against the world and the
speed comes back either way, with no travel required at all.

`clipspeed.mjs` does that, and it is validated twice over:

- **CMU 35_21**, whose retargeted ground speed measures 3.41 m/s through full
  kinematics, reads **3.25 / 3.29** for left and right here — within 5%, and
  symmetric.
- The **walk** clips in Rokoko's pack read **1.14–1.45 m/s at 120–150
  steps/min**, which are textbook walking figures.

```sh
node tools/mocap/clipspeed.mjs some/dir --window 2
```

It slides a window and keeps the best, because a library clip is not one gait:
sixteen seconds of "running" opens with the performer standing, walks in, runs,
and stops. Averaging the whole thing reported that run at 0.12 m/s — and worse,
the stance gate (the lowest quartile of ankle height) was then set by the
standing frames, so the samples counted as contact were the ones where nothing
moved. Every clip read near zero and nearly all flagged asymmetric, which is the
signature of measuring the wrong frames rather than of a bad capture.

**What it says about this pack.** The walks are good and usable. The three
"running" clips come back at 1.30–1.43 m/s — the same speed as the walks — while
reporting 210–270 steps/min. A stride of 0.3m at a sprinter's cadence is not a
gait anybody has; it is what a capture looks like when the foot travel has been
solved away. So the method recovers speed from a treadmill fine, and these
particular running captures simply do not carry it. Left/right split is printed
for the same reason: a real gait is symmetric.

### Feeding the game rig from an FBX

`retarget.mjs` takes `--src-fbx` too, presenting the source under CMU's bone
names so the delta solve, contact search, planting and ground-speed measurement
all run unchanged:

```sh
node tools/mocap/retarget.mjs --src-fbx run.fbx --name Sprint --cyclic --fps 30
```

Two things it had to learn, both real bugs rather than FBX quirks:

- **The sample rate and `FPS` are the same number.** An FBX clip is sampled at a
  rate we choose; leaving `FPS` at CMU's 120 while sampling at 30 reported a
  465 steps-per-minute sprint, four times a real one.
- **Facing comes from the pelvis when there is no travel.** The window's heading
  was taken from how far the pelvis moved, with a 0.15m threshold below which it
  gave up and used zero. A treadmill subject runs for fifteen seconds and goes
  nowhere, so the clip kept whichever way the room faced — Rokoko's faces −Z,
  which came out as a sprint at **−0.52 m/s**. The pelvis's own forward axis,
  averaged over the window, is well defined without travel.

### The euler order, which is invisible until it is catastrophic

FBX names a rotation order the way the rotations are APPLIED — `XYZ` means turn
about X, then Y, then Z — and quaternion multiplication applies right to left,
so the composition is `qZ * qY * qX`. Getting that backwards is a small error
almost everywhere and a total one near gimbal lock.

Rokoko's treadmill run holds the pelvis at **Y = 88 degrees**, one degree off
the XYZ singularity, where X and Z trade off wildly against each other (−63,
−73, then back to −1.7 within a tenth of a second) while the real orientation
barely moves. Composed in the wrong order that decoded to a spine pointing
DOWN on **55 of 318** sampled frames, and the retarget window happened to open
on one of them — so the heading correction was taken from a corrupt frame and
the entire clip came out inverted. Right order: **0 of 318**.

`fbx-to-glb.mjs` had the same bug and it had gone unnoticed, because the Studio
Ochi clips sit nowhere near lock: the error there was small rather than absent,
and their run reads visibly better now it is gone.

Euler channels are also unwrapped at load (no step over 180 degrees) so that
interpolating between keys never sweeps the long way round.

### Which rest pose — and it depends what you want it for

A skinned FBX holds two, and they are **not** the same: the skin clusters'
`TransformLink` (what the mesh is bound to) and the bone nodes' own `Lcl` values
(what the animation curves continue). Measured on the Studio Ochi export, they
sit up to **163°** apart.

- For a **target** character you want the cluster bind — it is the pose the mesh
  deforms from, and it is what gets the inverse binds right.
- For an **animation source** you want whichever the curves are expressed
  against, because a rotation is only meaningful against the rest it was
  measured from. Pairing curve-composed world rotations with an unrelated bind
  measures the gap between two poses and calls it motion.

`fbx-pose.mjs` takes `restFrom: 'clusters' | 'nodes' | 'auto'` and reports which
it used rather than leaving it to be guessed at.

### Why it is a second file rather than a flag

The game rig's rest LOCAL rotations are all identity, which lets `retarget.mjs`
treat a bone's rest direction as its offset to the next child and compose
straight onto that. Every bone of a Rigify metarig carries a real rest rotation,
so the general form is needed:

    W = S * DELTA * R

where `S` is their world rotation relative to their rest (what `asf.mjs`'s
`forward()` returns), `R` is our bone's bind world rotation, and
`DELTA = minArc(d, theirDir)` lays our bind direction `d` along theirs. `W`
applied to the bone's own axis gives `S * theirDir`, which is where their bone
points. Local is `conj(W_parent) * W`.

Three things had to be measured rather than assumed, each of which produced a
plausible-looking wreck first:

- **The root is a frame, not a bone.** CMU's `root` has `dir [0,0,0]` and length
  0, so `minArc` against it is degenerate. It laid a perfectly good jog on its
  back with the feet in the air while every limb articulated correctly — which
  is exactly what a bad root and good bones look like. The pelvis takes their
  rotation directly onto our bind.
- **The armature above the root bone still applies.** `spine` has no bone
  parent but is not a world root: it hangs off the Null carrying Blender's −90°
  X. Writing its world rotation as a local applies that −90 twice.
- **The bind pose is in centimetres.** `TransformLink` is in the file's world
  units, so the leg came out at 87.9 and a leg-scale of ×101 before the ×0.01.

`bindDir` measures a bone's direction toward the child that continues it, so no
axis convention has to be declared; where a bone tips into an `_end` with no
skin cluster it falls back to Rigify's +Y, and the report prints how far the two
disagree where both are available (12.3° worst, at `shoulder.R`).

---

## Adding a clip

```sh
node tools/mocap/retarget.mjs 35_21 --name Jog --cyclic     # a gait
node tools/mocap/retarget.mjs 79_91 --name Throw --from 420 --to 560
node tools/mocap/retarget.mjs 09_01 --cyclic --report --debug   # measure only
node tools/build-player-glb.mjs
node tools/measure-clip.mjs Jog                             # verify
node tools/posesheet.mjs Jog                                # and look at it
```

`--cyclic` cuts one stride between left-foot contacts, closes the loop, and
anchors the landing at phase 0 — the invariant the whole gait ladder rests on.
Without it the window is `--from`/`--to` and the clip is a one-shot.

## Four things that will bite you

**CMU's frame rate is not always 120Hz, and the index says it is.** Subject
141's runs come out at 7 m/s and 2.9 strides a second if you believe the
column, which is a stride rate no human has produced. The retargeter prints
stride length (pure geometry, independent of the rate) beside stride rate, and
says so when the pair is impossible. Re-read those with `--fps 60`.

**The capture volume is 3m x 8m.** You cannot sprint in it. CMU tops out around
4 m/s, so `Sprint` — 9.1 m/s on our rig — stays hand-authored, and always will
unless the motion comes from somewhere else.

**A retargeted clip is asymmetric and slightly non-contralateral, and that is
the data, not a bug.** `measure-clip` knows: clips carrying `extras.mocap` get
the numbers without the verdict. Real walkers carry 30-40mm of left/right
difference and swing their arms a tenth of a cycle off the textbook.

**Which rest pose means what is the whole of the retarget.** See the header of
`retarget.mjs`: the femur takes its rest direction from the subject, the foot
does not (the two rigs draw the foot bone at different pitches and both stand
flat, so aligning the bones would drive the toe through the turf), and the
clavicle does not (ours is drawn horizontal because that is where the mesh is
bound; honouring the subject's would lift the shoulder joint 56mm at rest).
