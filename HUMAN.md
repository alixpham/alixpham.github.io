# Make them look human — red team, and what came of it

Benchmark: the [Sketchfab American-football players](https://sketchfab.com/3d-models/american-football-players-animated-rigged-cc4472e54f0c4cd0909a26cb50c7797f)
pack, and Madden. Both are ~15–40k triangles per player with a full PBR texture
set (albedo, normal, roughness, AO) and mocap. We generate `flagplayer.glb`
parametrically and have a zero-build-step rule, so the question is how much of
that gap is reachable without an asset pipeline.

## Red team

Rendered the rig large from four angles, in rest and across the gait cycle, and
probed every bone numerically over every clip.

**R1 — Nothing is shaded, so everything is plastic.** Every region is one flat
base colour at one uniform roughness. No occlusion, no cavity darkening, no
colour variation. Real-time humanity comes mostly from shading relief: the
shadow under a jaw, in an armpit, behind a knee. There was none.

**R2 — There is no muscle anywhere.** Deltoid, trapezius, pectoral, lat,
quadriceps sweep, calf belly — all absent. The body was a set of smooth tapered
tubes with a convex cross-section at every height. The shoulder line slid
straight off the neck because there was no trapezius to break it.

**R3 — The face was a decal on an egg** — no brow, cheekbone, jaw or chin, with
the eyes stuck *proud of* a round skull so they broke the silhouette at the
temples.

**R4 — The hands were paddles.** No thumb, no knuckle: a flat blade on the end
of the forearm, unmistakable whenever an arm swung past the camera.

**R5 — Everyone was the same person** — one head, one haircut, skin tone picked
by roster index rather than by player.

**R6/R7/R8 — Motion.** Sprint arm carriage reached out in front instead of
driving hip-to-chin; the Idle clip moved the hand 8 mm in 2.4 s; the `Spine`
track was a literal constant, so shoulder-vs-pelvis twist through the run was
1.7°.

## What landed here

R3, R5 and the gait findings were fixed in parallel by other work on `master`
(v2.19–v2.31: a 2,184-triangle sculpted head, six hairstyles and two beards,
per-player looks, and a Jog/Run/Sprint/HighStep set built on a real
pelvis-versus-trunk model). Those are better than what this branch had and were
taken as-is.

What `master` still had none of, and what this change adds:

**Baked ambient occlusion (R1).** Per-vertex, into `COLOR_0`, which glTF
multiplies into base colour and THREE honours automatically — 4 bytes a vertex,
no textures, no extra draw calls, and it survives per-instance team tinting
because tinting multiplies too. Two scales: 48 short rays (0.22 m) against the
real mesh for creases, and analytic solid angle against a 40-blob volumetric
proxy for bulk shading bulk — the inside of an arm, between the thighs, under
the jaw. Rays are short on purpose; a long ray would bake the torso into the
inner arm and the arm would then carry that shadow around when it swings clear.
The alternate hairstyles and beards are shaded but never used as *occluders*,
since the file carries all of them and the game wears one.

The first bake barely showed, and that was the finding: **occlusion needs
concavity, and a figure made of convex tubes has none.** It only started paying
once R2 was fixed.

**Muscle (R2, R4).** `loft()` now takes a per-angle radius modulation, so a ring
can carry muscle without carrying vertices. Pectorals either side of a sternal
groove, obliques, lats, a spinal channel, trapezius, deltoid, biceps and
triceps, quadriceps sweep, hamstring, patella, calf belly. The hand is a loose
fist with a thumb across the front and a squared knuckle line. Shorts hem closed
onto the thigh instead of flaring past it; belt 66 mm → 40 mm.

Tessellation went 14 → 26 segments around the body and 10 → 16 around the limbs,
because at 14 segments the samples are 26° apart and a 20°-wide sternal groove
falls between two of them.

## Measured

| | before | after |
| --- | --- | --- |
| triangles / player | 11,048 | 13,856 |
| ten players on the field | 110k | 139k |
| vertex occlusion | none | 48-ray + proxy, darkest vertex 0.42 |
| `flagplayer.glb` | 643 KB | 763 KB |
| console / page errors, landscape + portrait | 0 | 0 |
| frozen players / closest body approach | 0 / 0.9 yd | 0 / 0.9 yd |

139k triangles is still under half of what one reference model costs, and the
headless frame rate is unchanged — swiftshader here is fill-rate bound, not
vertex bound. Nothing in this change reaches the simulation.

## Still open

No albedo, normal or roughness map, so cloth is one flat colour — the largest
remaining gap to the reference and the one that needs an asset pipeline to
close. The ear is a lobe rather than an ear. Beyond the players, the distance to
Madden is presentation the field doesn't have yet: replays, depth of field,
sidelines and benches, and contact animation.

---

# Round two: the animation

Same benchmark. This pass looked at motion rather than mesh, and at what the
game does over time rather than what it looks like in a frame. `tools/animcheck.mjs`
(new, committed) drives the real game and samples once per rendered frame;
`tools/measure-clip.mjs` (already here) does the offline biomechanics.

## What is already good, measured

The gait system is genuinely well built and most of a red team's default
checklist comes back clean:

| | |
| --- | --- |
| stride phase spread across ten players | 0.55–0.82 (0 = lockstep) — nobody marches in unison |
| facing vs line of travel, median | 0.9–4.6° — the skate is gone |
| gait playback rate saturated on its clamp | 0.6–3.8% of moving frames |
| Run / Sprint stance:flight | 31:38 and 22:56 — textbook |
| bank into turns | 3–7° median, derived from lateral acceleration, not tuned |

## A2 — Walk and Jog limp. Found, not fixed.

`measure-clip` puts the right foot's contact at **40%** of the cycle in Walk and
**38%** in Jog, against the 50% the file's own comment demands ("keep them at 0%
and 50%"). Run is 48% and Sprint 53%. Walk+Jog is the most-used rung on the
ladder in every probe run, so this is the limp you see most.

The left contact reads 0% in both, which is what hid it: the detector scans from
index 0 and the foot is already planted there, so it reports the frame it
started on rather than the frame the foot landed. True contact is ~10–12% of a
cycle late, and the right foot — exactly half a cycle behind whatever the left
actually does — inherits the error.

**I tried to fix it and backed the fix out.** Rotating the cycle's origin onto
the measured contact fixed the symmetry (Walk 40→50%, Jog 38→52%) but moved the
pelvis-lift window with it, and the flight fractions went with it: Jog 19%→38%,
Run 38%→50%, both far from the values a jog and a run actually have. Deriving
the lift window from the same sole trace instead made it worse — stance and the
trace that produces it feed back on each other, and Run ended at 16% stance /
69% flight. The clips as they stand measure correctly on every other axis, and I
would rather ship a documented limp than an undocumented regression in four
clips at once.

The real fix is in the contact POSE, not the timing: at phase 0 the sole is a
few millimetres off the turf, so the body is still riding the other foot. That
is a pose edit with a measurement loop, and it is the next thing to do here.

## A3 — Nobody watched the ball. Fixed.

There was no gaze behaviour anywhere: every head pointed wherever the body
pointed, all game, and the only neck yaw in the game was whatever a clip
happened to bake. Ten people chasing something and not one of them looking at
it reads as mannequins on rails.

`gazeAt` layers a look-at over the mixer — multiplied onto what the clip wrote,
the same bargain as `leadTrunk` and the carry pose, so the gait's own head
motion survives underneath. Split across neck and skull, eased over ~0.2s, and
clamped at 70°, because past that a person turns their shoulders instead of
unscrewing their head. The carrier is excluded: the ball is in his hands and he
is reading the field. One-shots keep the head.

| | |
| --- | --- |
| turn the ball asks for, median | 41° |
| turn the renderer applies | 35° (the rest is the clamp) |
| gaze lag | **1.1°** |
| heads within 12° of the ask | **85%** |

## A4 — Idle was a photograph. Fixed.

The clip said so itself: *"the breathing is the only motion in here, and it is
12mm of it."* Twelve millimetres over 2.4 seconds, and this is the pose the
game spends most of its clock in — between plays, in the huddle, at the snap.

Rebuilt at 6.4s as a weight shift: the loaded knee straightens while the free
one softens, the pelvis lists and drops toward the free side, the shoulders
counter, and the head runs on a sub-cycle that deliberately does not divide into
the loop. Pelvis height is re-solved at every key from the leg angles in force
there, which is what lets the weight move at all — the old clip's hips track was
a single hand-entered constant, so it *couldn't* shift.

Peak hand speed 0.003 → **0.05 m/s**, with the planted feet still planted
(0.06 m/s drift).

## On the instrument

Four separate attempts to measure the gaze off the skeleton produced impossible
numbers — 94° of neck turn against a 70° cap — because the rig's rest frame, the
root's heading offset, the holder's bank quaternion and the clip's own baked head
motion all compose, and picking one factor back out of that product is not a
thing a probe should do. The renderer now publishes the applied angle through
`debugPlayers()`, which is the bargain that surface already exists for, and the
number became coherent immediately. The in-game foot-slip metric was cut for the
same reason: at ~2 rendered frames a second under swiftshader, two samples are a
tenth of a stride apart and no contact phase can be resolved — it reported a
"planted" foot moving at 1.27× the body's own speed. `measure-clip` does that
job properly, offline.

## Still open

The Walk/Jog limp above. Backpedal's planted foot sweeps unevenly (spread 47% of
its own median, flagged `UNEVEN STANCE`). The top of the gait ladder is nearly
dead — `Run+Sprint` appears in single-digit frames per run while `Walk+Jog` and
`Jog+Run` carry everything, so the best-measured clip in the file is the one
almost nobody ever sees.
