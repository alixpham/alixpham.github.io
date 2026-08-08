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
`Backpedal`, `Throw`, `Catch`, `Dive`, `FlagPulled`, `Celebrate`, `Juke`.

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
  it. The `Throw` clip drives the release by *decreasing abduction* while X
  sweeps forward.

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
