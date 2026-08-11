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

**Clips** (all in place, no root translation drift): `Idle`, `Run`, `Walk`,
`Backpedal`, `Throw`, `Catch`, `Dive`, `FlagGrab`, `FlagPulled`, `Celebrate`,
`Spike`, `Dance`, `Flex`, `HighStep`, `Juke`.

The three gaits (`Run`, `Walk`, `Backpedal`) and `HighStep` are built by one
function, `cyclicGait()`, from two authored phase tables — one leg and one arm,
each of which the other side repeats half a cycle later. It also solves the
frontal plane (pelvic drop toward the swing leg, lateral sway over the stance
leg, shoulder counter-tilt) from where the feet actually are, rather than from
a hand-keyed sine that can fall out of step with the footfalls.

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
{ "gait": 1, "groundSpeed": 6.10, "stance": 0.31, "flight": 0.38, "cycle": 0.62 }
```

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
P.play('run');          // lower-camel game names are mapped to the .glb names
```

It scales metres to world units (1 unit = 1 yard) by `1 / 0.9144 = 1.0936`,
giving a 2.023-unit-tall player, and uses the game's heading convention
`root.rotation.y = Math.PI / 2 - yaw`.
