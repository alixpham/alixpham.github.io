# Where this branch is — read before doing anything else

`claude/status-sx79gn`, ahead of `origin/master` and not merged. **The live
site is v3.6.0; none of this has shipped.** The branch carries v3.7.0 (a
defensive-AI fix) and v3.8.0 (the Studio Ochi player).

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
| `glb-read.mjs` / `glb-skin.mjs` | the GLB container, and posing/skinning it — shared, so there is one copy of each |
| `glb-repaint.mjs` | splits a baked atlas into named, tintable material regions |
| `glb-rerig.mjs` | rebuilds a character onto this game's rig conventions, and proves the skin did not move |
| `glb-ground.mjs` | puts a retargeted clip's feet back on the turf |
| `glb-gait.mjs` | `groundSpeed` + `blendUp` off a baked clip, from a sole taken from the mesh |
| `build-ochi-player.mjs` | all five stages → `flagster/lib/ochiplayer.glb` |
| `mocap/retarget.mjs` | CMU (and, via `--src-fbx`, Mixamo/Rokoko) → the game's own rig |
| `mocap/retarget-ochi.mjs` | the same onto the Ochi metarig, plus `--src-glb` for the game's own player as a source |
| `mocap/ochi-clips.mjs` | drives that over all 22 of the game's clips |
| `mocap/clipspeed.mjs` | ground speed and cadence of any FBX clip, before retargeting |

Committed motion: `tools/motion-ochi/*.json` — all 22 clips, retargeted from
the game's own player. `tools/motion-ochi-cmu/` holds the four CMU gaits
(free, real capture) which are kept but not shipped; `tools/motion/Jog.json` is
CMU on the game's own rig.

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

## 4. Studio Ochi — DONE, and on the field

The athlete is now the player the game ships: `flagster/lib/ochiplayer.glb`,
836 KB, 62 bones, 22 clips, ten tintable regions. `playermodel.js` loads it by
default; the menu's **Player** button switches to the classic one and back, and
`?character=flagplayer` does the same without touching a saved preference.

Two things blocked it, and neither was the skeleton.

**Colour.** The game tints ten named material regions by multiplying
`material.color` over white artwork; Ochi ships ONE material with the kit
painted into an eight-swatch palette atlas. `tools/glb-repaint.mjs` regroups
the triangles by which swatch they sample into one primitive per region, all
still pointing at the SAME position, normal, joint and weight accessors — only
the index buffer is new, so nothing can tear. 0.96% of texel samples are lost,
all of them the baked number 10, which cannot survive anyway.

**Rest.** `rig-def.mjs` says "no bone carries a rest ROTATION" and the renderer
leans on it everywhere. A Rigify metarig carries one on all 58 bones.
`tools/glb-rerig.mjs` rebuilds the CHARACTER onto the game's convention —
every rest rotation removed at the position it already occupied, the mesh baked
into world space, every animation rewritten exactly, bones renamed, four
sockets added — and proves it: **0.0287 mm** worst vertex movement across every
clip, which is the six-decimal quantisation. That self-check is what caught the
six bundled Ochi clips whose per-bone scale tracks the conversion cannot carry;
they threw a vertex 14 metres and are now dropped by name.

Two more had to be true before it worked:

* **A retarget carries angles, not contact.** The walk came back with 53%
  flight. `tools/glb-ground.mjs` matches the reference's own foot-height
  profile per frame.
* **`playermodel.js` drops a gait rung with no measured `groundSpeed`,** and a
  player with no rungs never steps. `tools/glb-gait.mjs` measures it from a
  sole taken from the mesh, and `--check` reproduces the builder's own numbers
  to 1.2% from independent code and geometry.

Where a rest DIRECTION still differs — this athlete stands in an A-pose, its
upper arm 62 degrees off — the constant is measured per bone into
`extras.restAlign`, and `field3d.js` composes it onto the poses it authors
itself. It is absent on the game's own player, so nothing changed there.

**The build, in one command** (source assets are not in the repo — see below):

```sh
node tools/mocap/ochi-clips.mjs --fbx ManA.fbx
node tools/build-ochi-player.mjs --fbx ManA.fbx --texture atlas.png
```

The 22 clips come from the game's OWN player, retargeted onto the metarig: a
flag pull, a juke and ten celebrations exist in no capture library, free or
paid. `tools/motion-ochi-cmu/` keeps the four CMU gaits, which are real capture
and better walks, but cannot be mixed into the ladder without re-phasing — see
the README there.

**Also fixed, and older than all of it:** the rigged model only ever appeared
if it loaded before the first snap. `Player3D.build` falls back to the
procedural rig silently, so a kickoff that beat the fetch fielded the fallback
for the whole game. Invisible for as long as it was because `flagplayer.glb` is
built from the same parts as that fallback and looks identical.

**What is still imperfect, honestly:** the retargeted walk's stance sweep is
less even than the authored one (48% spread against 34%), so the support foot
slides slightly more at walking pace. Fixing it properly means re-solving the
legs, not re-measuring them.

## 5. What is NOT in this repository and must be fetched again

This is the part a new container silently loses.

* **The Studio Ochi FBX files and their atlas PNG.** Licensed; `.gitignore`
  excludes `*.fbx` and `tools/ochi/`. They came from a Dropbox link the user
  supplied. The finished `flagster/lib/ochiplayer.glb` IS committed, so the
  game works without them — but nothing in section 4 can be REBUILT until they
  are fetched again.
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
