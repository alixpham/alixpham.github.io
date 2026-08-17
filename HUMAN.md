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
