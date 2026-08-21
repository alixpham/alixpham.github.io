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
