# Where this branch is — read before doing anything else

`claude/status-sx79gn`, ten commits ahead of `origin/master`. Nothing here is
live. **The live site is v3.6.0 and none of this work has touched it.**

This file exists because the container does not survive and neither does a
conversation. It records what is decided, what is proved, what is only half
built, and — most importantly — which of the things this branch depends on are
**not in the repository** and have to be fetched again.

---

## 1. Unmerged and waiting on a human

**v3.7.0 — "nobody chased the runner"** (`2a8b055`), committed, tested, never
merged and never deployed. `_aiDefender` asked `s.carrier !== s.passer` where it
meant `p === s.passer && !s.handoffDone`, so after a handoff the pursuit test
picked the wrong man: **22% of frames with a live runner had no defender in
pursuit at all.** `npm run pursuit` is the probe that says so, and it fails
against the old behaviour.

`VERSION` already reads `3.7.0`. It has been raised repeatedly and not yet
answered. It is an ordinary gameplay fix and it is ready to ship; everything
below it in this file is exploratory pipeline work that is *not* ready and
should not be merged with it.

---

## 2. The two architecture decisions — already made, do not reopen

Both were put to the user and answered:

* **Keep the zero-build plain Three.js runtime. NOT React Three Fiber.** The
  original plan proposed R3F; it was rejected. `<script>` tags, an import map,
  vendored Three.js, no bundler, no npm runtime dependency. Playwright is a
  devDependency for the test harnesses only.
* **Extend the existing Node retargeter. NOT Blender.** There is no Blender in
  this environment and there is not going to be. Everything reads and writes
  FBX and glTF directly.

The user also redirected the asset plan twice: from paid packs (Mobility Pro,
a 22-animation football pack) to **free** mocap, and then away from MocapFlow
towards Rokoko. Both redirections stand.

---

## 3. What is built, and what each piece is actually good for

All committed, all documented in `tools/README.md`.

| tool | does |
|---|---|
| `fbx-read.mjs` | binary FBX (Kaydara 7x00) record tree — the shared parser |
| `fbx-inspect.mjs` | skeleton / clips / materials; `--compare` answers "same armature?" |
| `fbx-pose.mjs` | rest rig, clips, euler→quaternion, FK |
| `fbx-to-glb.mjs` | FBX → GLB, no Blender, no Autodesk SDK |
| `glb-view.mjs` | renders **any** GLB through the vendored Three.js in headless Chromium |
| `glb-repaint.mjs` | splits a baked atlas into named, tintable material regions |
| `mocap/retarget.mjs` | CMU (and, via `--src-fbx`, Mixamo/Rokoko) → the game's own rig |
| `mocap/retarget-ochi.mjs` | the same, onto the Ochi metarig |
| `mocap/clipspeed.mjs` | ground speed and cadence of any FBX clip, before retargeting |

Committed motion: `tools/motion-ochi/{Walk,Jog,Run,Sprint}.json`,
`tools/motion/Jog.json`. These are derived from CMU, which is free.

### The bugs that cost the most, so they are not paid for twice

* **Euler composition order was backwards.** FBX `XYZ` means apply X then Y
  then Z, which composes as `qZ·qY·qX`. Getting it inverted put 55 of 318
  Rokoko bones wrong and produced a character that looked *plausible* in stills.
  Fixing it took the count to 0/318 and visibly improved the bundled Ochi clips
  as well — the same bug was in `fbx-to-glb.mjs`. Gimbal lock at Y≈±90° is what
  finally exposed it.
* **FPS and sample rate were decoupled**, which reported a sprint at 465
  steps/min — four times a real one.
* **A treadmill clip DOES have a ground speed.** I claimed it did not; the user
  corrected me and was right. The stance foot travels backward relative to the
  pelvis at exactly belt speed, so measuring the foot against the *pelvis*
  rather than the world recovers it with no travel at all. Validated against
  CMU 35_21, whose retargeted speed is 3.41 m/s: `clipspeed` reads 3.25 / 3.29
  for left and right. Left-vs-right split is the quality signal.
* `clipspeed --window` was a no-op typo, so the stance gate was set by standing
  frames and every clip read ≈0 m/s. A library clip is not one gait — it opens
  standing, walks in, runs, stops. Slide a window, gate each window on its own
  frames, keep the best.
* Four `fbx-to-glb` bugs, all found by **rendering**, none findable by reading
  the file: face-down along Z, rest-treated-as-a-pose shattering the skin, IBM
  at 1/100 scale, an empty stub mesh occupying accessor 0.

---

## 4. Studio Ochi — the state of it

**The blocker was never the skeleton. It was the texture.** `playermodel.js`
tints ten named regions per player by multiplying `material.color` over white
artwork. Ochi ships one material with the kit painted in, so there was nothing
to tint.

**Solved** (`65a04d7`). The atlas is not a painting, it is a **palette**:
8000×1000, eight 1000×1000 tiles of flat colour side by side. Five are a single
colour to the pixel; three carry one small decal apiece — the jersey number
"10" in the three colourways the shirt needs. So the mesh is already
partitioned into paint regions; each triangle only has to be asked which swatch
its UVs sit in.

`tools/glb-repaint.mjs` regroups triangles into one primitive per region, all
still pointing at the **same** position, normal, joint and weight accessors —
no vertex duplicated, no seam introduced, only the index buffer is new, so the
skinning cannot tear. Verified by posing a clip on the split model. The atlas is
then dead and dropped, so the file shrinks (1225K → 1156K).

The verified Ochi kit:

| region | tris | palette entries |
|---|---|---|
| `jersey` | 183 | `f1f2f2` body + `ffffff` back panel |
| `shoes` | 614 | the foot palette |
| `skin` | 406 | `f8b583` |
| `helmet` | 294 | `262262`/`27aae1`/`ffce00` on `spine.005/006` |
| `shorts` | 152 | `262262` on `thigh` |
| `trim` | 53 | `262262` on torso bones + `27aae1` on the sleeve |
| `socks` | 44 | `ffce00` on `shin` |
| `gloves` | 24 | `3452ff` on `forearm`/`hand` |

The working invocation, which is worth keeping verbatim:

```sh
node tools/glb-repaint.mjs ochi-manA.glb kit.glb --map \
'f1f2f2=jersey,ffffff=jersey,262262@(breast|shoulder|upper_arm|spine\.003)=trim,\
262262@thigh=shorts,262262@spine\.00[56]=helmet,262262=shorts,f8b583=skin,\
27aae1@spine=helmet,27aae1@upper_arm=trim,27aae1=shoes,ffce00@shin=socks,\
ffce00@spine=helmet,ffce00=shoes,3452ff@(forearm|hand)=gloves,3452ff=shoes,\
934911=helmetStripe'
```

Costs, stated plainly: the baked number "10" is gone — 0.96% of texel samples,
and unavoidable, because a tintable shirt is a shirt with no pixels of its own.
And the whole approach only works on artwork that is flat per region;
`--report` prints the disagreement fraction so a real painted texture says so
rather than being silently flattened.

**Ochi is still NOT wired into the game.** Nothing in `flagster/` imports any
of it. `playermodel.js` still loads `flagster/lib/flagplayer.glb`. Making the
switch is a separate, unstarted piece of work and would need: the rig mapping
from the Ochi metarig (`spine.006`, `thigh.L`, `heel.02.R`, …) to the game's
bone names, ball sockets, and the whole locomotion ladder re-measured, because
**a gait's ground speed lives in the .glb as animation `extras`** and Ochi's
clips carry none.

---

## 5. What is NOT in this repository and must be fetched again

This is the part a new container silently loses.

* **The Studio Ochi FBX files and their atlas PNG.** Licensed; `.gitignore`
  excludes `*.fbx` and `tools/ochi/`. They came from a Dropbox link the user
  supplied. Without them nothing in section 4 can be re-run — the tools are
  committed, the assets are not.
* **The Rokoko free-library FBX files** (`WALK-RUN-CYCLES-MOCAP` and others),
  from rokoko.com/free-resources. Also excluded.
* **CMU `.asf`/`.amc` sources** — but these are the one safe case:
  `tools/mocap/fetch.mjs` re-downloads them on demand, and the retargeted JSON
  in `tools/motion*/` is committed, so the build does not need them.
* Everything under the scratchpad. Gone. Every measurement worth quoting has
  its script in `tools/`; if a new one is written, it belongs there too.

---

## 6. How to check the ground is where you think it is

```sh
npm run lint      # 40/40 files parse
npm test          # 39 rule assertions
npm run smoke     # every screen x both orientations, 0 errors, field3d alive
npm run pursuit   # the v3.7.0 fix
node tools/simstats.mjs
```

A clean console does **not** mean the 3D renderer is running — `engine.js`
swallows `externalRender` throws and hands over to the 2D canvas after five of
them. `npm run smoke` is what actually asserts `activeShell.field3d` is alive.

And check the container is not stale before trusting the tree:

```sh
git fetch origin master && git rev-list --count HEAD..origin/master
```

Live page: **https://alixpham.github.io/**
