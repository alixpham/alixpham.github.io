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

## A2 — CORRECTION: the limp did not exist. It was the instrument.

Last round this document reported that Walk and Jog limp, on the strength of
`measure-clip` putting the right foot's contact at 40% and 38% of the cycle
against an expected 50%. **That was wrong, and the clips are fine.**

The gaits are generated by rotating one leg's curve by exactly half a cycle
(`halfCycle`, 32 samples, a 16-sample shift), and the pelvis solve is symmetric
in both feet. A limp is not merely absent, it is *mathematically impossible*.
Comparing the whole left sole trace against the right shifted half a cycle:

| Walk | Jog | Run | Sprint | Backpedal |
| --- | --- | --- | --- | --- |
| 0.00 mm | 0.00 mm | 0.00 mm | 0.00 mm | 0.00 mm |

Three separate bugs in the measurement produced the phantom, and each one had
to be found before the next was visible:

1. **The contact scan started on a planted foot.** It took the first grounded
   sample scanning from index 0, and at index 0 the left foot is already down —
   so the left always "contacted" at 0%, reporting the frame the scan began on.
   Contact is now the start of the *longest* grounded run.
2. **A fixed 12 mm threshold is meaningless during flight.** With both feet
   airborne the lower one's height is the pelvis-lift envelope, which crosses
   12 mm going up and again coming down; the right foot "contacted" wherever
   that envelope happened to dip. This is why chasing it through the leg poses
   went nowhere — raising the swing knee raises the *pelvis* too, because
   `hipsY = 1.000 - min(lowL, lowR)`, so the lower foot's height is pinned to
   the lift envelope regardless of the pose.
3. **My replacement check invented its own asymmetry.** Half a cycle is `N/2`
   samples, which is not a whole number when `N` is odd, and interpolating a
   curved trace across that half-sample gap manufactured up to 34 mm of
   asymmetry — on exactly the clips whose sample count happened to be odd. It
   "confirmed" the limp it was written to disprove. The analysis grid is now
   forced even, and the check reads zero at every frame rate.

`measure-clip` now reports the symmetry directly, which is the honest test: it
does not depend on picking a threshold, and nothing that limps can hide from it.

### What was real, and is fixed

One thing the noise was hiding. In Walk the swing foot was still **11 mm above
the turf at its nominal heel strike**, then skimmed 10–29 mm through the last
fifth of the cycle before taking weight. That is not a limp — it happens
identically on both feet — but it does mean the clip's phase 0 was not where
contact actually was.

That matters because `playermodel` blends the four rungs of the ladder on a
single shared phase, on the stated assumption that phase 0 is contact in all of
them. A rung whose real contact is 5% late lands its feet out of step with the
rung it is blended against.

The fix is 1.5° of hip. Reach is `L·cos(hip)`, so at 28° with a 0.87 m leg it is
7.1 mm per degree — 11 mm of float is 1.5° of hip flexion. Opening the contact
pose from 28° to 26.5° closes it, and nothing else moves:

| | before | after |
| --- | --- | --- |
| sole height at heel strike | 11 mm, then a 10–29 mm skim | **5 mm, descending monotonically** |
| natural speed | 1.77 m/s | 1.78 m/s |
| stride / cadence | 1.77 m / 120 | 1.78 m / 120 |
| stance : flight | 53 : 0 | 53 : 0 |

Jog, Run and Sprint were left alone: with a flight phase their sole trace is
governed by the lift envelope rather than the pose, so there is nothing there to
correct.

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

## A5 — The lean was a carve, not a cut. Fixed.

Reported from watching it: *"banking is too steep and looks like a hockey
player doing a slow turn."* Correct, and my own earlier report of "3-7 degrees
median" was measured across every sampled frame including players standing
still. Over RUNNING frames only:

| | before | after |
| --- | --- | --- |
| bank, median | 9.9° | **1.8°** |
| bank, p90 / max | 15.5° / 15.5° — pinned to the clamp | **8.9° / 9.0°** |
| running frames past 8° | 55.8% | **19.1%** |
| lean held, median | 0.6 s | **0.20 s** |
| lean held, p90 | 1.5 s | **0.85 s** |

A football cut lasts 0.2–0.4 s. Half of every play spent past eight degrees,
routinely pinned at the ceiling, held for the better part of a second, is a
hockey rink.

Three causes, all of them in one block, and the third was deliberate:

**`atan(lateral acceleration / g)` is the balance angle of a sustained turn.**
It is the physics of a speed skater on an edge or a cyclist on a banked curve —
bodies that carve. A runner does not. Their lateral force arrives in discrete
foot plants, the legs splay out under a trunk that stays far closer to upright,
and it is gone by the next step. The balance angle is now scaled to a trunk
fraction and capped at 9° rather than 15.5°.

**A 0.28 s low-pass on the force.** Added to stop steering noise leaning
everybody, which it did — but it also delayed the lean past the step that
earned it and kept it alive afterwards.

**"Attack fast, release slow."** The old comment says so outright: `ease(13)`
rising, `ease(6)` falling, on the theory that coming out of a cut is a recovery.
It isn't — pushing off out of a lean is the most violent part of the move, and
holding the angle afterwards is the single thing that makes it read as a glide.

The replacement is a **washout**: what leans a body is the lateral force minus
its own slow average, so the *onset* of a cut leans you and merely being in a
turn does not. A receiver running a curl now settles back toward upright instead
of holding an edge all the way round. It is the same filter a motion platform
uses, for the same reason — sustained acceleration is not what a body reads as a
manoeuvre. A third of the steady component survives, because a hard sustained
turn is not perfectly upright either. Release is now nearly as quick as attack.

## Still open

Backpedal's planted foot sweeps unevenly (spread 47% of
its own median, flagged `UNEVEN STANCE`). The top of the gait ladder is nearly
dead — `Run+Sprint` appears in single-digit frames per run while `Walk+Jog` and
`Jog+Run` carry everything, so the best-measured clip in the file is the one
almost nobody ever sees.

---

# v3.0 — the players stop being interchangeable

Two things, one behavioural and one material, chosen because each closes a gap
this document had already named and measured.

## B1 — Fatigue you can see

The engine has simulated stamina for a long time: effort drains it, it recovers
between plays, and it scales a player's top speed down to `STAM_FLOOR = 0.55`.
It drives a bar on the HUD. **It had never once reached the body.**

Measured over a full CPU-vs-CPU game, 6,290 samples:

| min | p10 | median | p90 | max |
| --- | --- | --- | --- | --- |
| 0.000 | 0.555 | 0.853 | 0.991 | 1.000 |

62.6% of samples below 0.9, 20.3% below 0.7, 7.9% below 0.5. So a fifth of
every game is played by people who are visibly tiring, drawn as though they had
just come off the bench.

What tiredness does to a runner, in the order you notice it: the trunk folds
forward, the head drops, the shoulders round, and the arms stop being *carried*
— the elbows open and the hands fall toward the hips. Standing still and blown
is a different picture again, so it gets its own amplitude: that is the shape
everyone recognises.

The stride shortens too, and that is deliberately **not** done here. The engine
already slows a tired player, and the gait ladder answers a lower ground speed
with a lower rung and a shorter stride on its own — adding it again would be
counting the same thing twice.

Layered after the mixer and multiplied onto the clip, like `leadTrunk` and the
gaze. Nothing shows above 0.85 stamina, because being slightly winded is not a
posture, and it reaches full expression by 0.35. A one-shot keeps the body: a
throw, a catch and a dive are committed actions and a tired man still makes them
properly.

Verified end to end by pinning stamina: `fatigue` reads 0.000 at full and 1.000
at 0.15, and in an ordinary demo 19% of frames are visibly tired — which matches
the 20.3% of the simulation that sits below 0.7.

## B2 — Cloth that looks like cloth

The last flat thing. Every region was one base colour at one uniform roughness,
which is the remaining reason the figure reads as injection-moulded next to the
reference pack — those carry a full albedo/normal/roughness set and we carried
none. An authored texture set stays out: it means binary assets and a pipeline,
and this character is a text file on purpose.

Generating the maps at load time does not. Two small canvases, built once and
**shared by every player on the field** — team colour lives in `material.color`,
which multiplies over the map, so sharing costs nothing and one upload serves
twenty players:

- **cloth** — a knit grid, the fine horizontal ribbing a mesh football jersey
  actually has, plus low-frequency mottling so large flat panels stop looking
  like plastic under a moving light. Jersey, shorts, socks, trim, flags.
- **skin** — very low frequency tonal variation only. Skin is not patterned; it
  is uneven, and evenness is the tell.

Both are near-white and multiply, so they add texture without shifting the
colour a kit was tinted to. The lofts write cylindrical UVs, so a tiling pattern
lands square on the body with no unwrap. The noise is deterministic — `Math.random`
here would reshuffle the field on every refresh. The head's existing runtime
face texture is left alone; nothing overwrites a material that already has a map.

## Measured

| | |
| --- | --- |
| frames visibly tired, ordinary play | 19% |
| fatigue at stamina 1.00 / 0.15 | 0.000 / 1.000 |
| textures added to the repo | none — both generated at load |
| gait clips | unchanged (Walk 1.78, Run 6.09, Sprint 8.98 m/s) |
| simulation | unchanged — 64.5 plays/game, 44% completions, 0 unresolved |
| console / page errors | 0 |
