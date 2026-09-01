# Where this repo is — read before doing anything else

**`master` is v3.23.0 and it is live at https://alixpham.github.io/.** Nothing
is unmerged and nothing is waiting on a human. `claude/status-sx79gn` is the
working branch and is restarted from `origin/master` after every squash merge.

This file exists because the container does not survive and neither does a
conversation. It records what is decided, what is proved, what is only half
built, and — most importantly — which of the things this repo depends on are
**not in it** and have to be fetched again.

> **This file has been badly stale once.** It sat claiming "the live site is
> v3.6.0; none of this has shipped" for seventeen releases, under a heading
> telling the reader to trust it before anything else. If you ship a version,
> the version number at the top of this file is part of shipping it.

---

## 1. The two architecture decisions — already made, do not reopen

Both were put to the user and answered:

* **Keep the zero-build plain Three.js runtime. NOT React Three Fiber.**
  `<script>` tags, an import map, vendored Three.js, no bundler, no npm runtime
  dependency. Playwright is a devDependency for the test harnesses only.
* **Extend the existing Node retargeter. NOT Blender.** There is no Blender in
  this environment and there is not going to be. Everything reads and writes
  FBX and glTF directly.

---

## 2. How to check the ground is where you think it is

```sh
npm run lint      # 60/60 files parse
npm test          # 55 rule assertions
npm run smoke     # every screen x both orientations, 0 errors, field3d alive
node tools/simstats.mjs
```

A clean console does **not** mean the 3D renderer is running — `engine.js`
swallows `externalRender` throws and hands over to the 2D canvas after five of
them. `npm run smoke` is what actually asserts `activeShell.field3d` is alive.

And check the container is not stale before trusting the tree. A new container
is a *snapshot*, not a fetch, and has been many releases behind before now:

```sh
git fetch origin master && git rev-list --count HEAD..origin/master
```

`.claude/hooks/session-start.sh` does this automatically and prints a banner. If
the banner did not appear, do it by hand.

### The full probe set

Each of these exists because something shipped broken and nothing was measuring
it. They are cheap; run the ones near what you touched.

| | |
| --- | --- |
| `npm run stats` | the box score — points per game is the one metric with a real source |
| `npm test` | the rules, 55 assertions |
| `npm run qb` | what the quarterback threw at, and what he passed up |
| `npm run pick` | does the pick six play, and is the camera behind him |
| `npm run pulls` / `pursuit` | the flag pull, and whether anyone is chasing |
| `npm run passes` | the ball in flight |
| `npm run ball` | is the football actually in his hands |
| `npm run pose` | can a body hold these poses at all |
| `npm run hero` | …and is every move on the FRONT PAGE one of them |
| `npm run body` / `slip` | do the feet slide (live game / gait ladder alone) |
| `npm run feet` | where the feet really are relative to the turf |
| `npm run celebs` | every celebration, forced and read off the renderer |
| `npm run touch` | can a thumb play it — targets, safe areas, dead zones |

---

## 3. What is NOT in this repository and must be fetched again

This is the part a new container silently loses.

* **The Studio Ochi FBX files and their atlas PNG.** Licensed; `.gitignore`
  excludes `*.fbx`, `*.blend` and `tools/ochi/`. They come from a Dropbox link
  the user supplied. The finished `flagster/lib/ochiplayer.glb` and
  `ochibare.glb` ARE committed, so the game works without them — but nothing in
  the character chain can be REBUILT until they are fetched again.

  **Two things about that pack are worth not rediscovering.** It reproduces the
  shipped character *byte for byte* — `build-ochi-player.mjs` remakes
  `ochiplayer.glb` at the same 856,816 bytes and the same sha256 — so the chain
  is safe to re-run. And the `--fbx` must be one of the six `*_ANIM.fbx`: the
  static `AmericanFootballMan.00N.fbx` meshes carry no skin and the build stops
  at stage 3 with "not a skinned model".

* **CMU `.asf`/`.amc` sources** — the one safe case: `tools/mocap/fetch.mjs`
  re-downloads them on demand, and the retargeted JSON in `tools/motion*/` is
  committed, so the build does not need them.

* Everything under the scratchpad. Gone. Every measurement worth quoting has its
  script in `tools/`; if a new one is written, it belongs there too.

---

## 4. What is open

Ordered, with the dependency that matters called out.

1. **Source or retire the last unsourced targets.** `simstats` still carries
   `yardsPerRun: '~4-5'`, `gainsOfThreeOrFewer: '~35%'` and
   `playsPerGame: '45-60'` with nothing behind them, plus a conversion rate
   guessed at 60-75%. One target in that same set —
   `touchdownsPerPlay: '~5-8%'` — was chased for eleven releases and turned out
   to be **half of reality**; the others have earned no more credit than they
   can show. See REALISM.md v3.22.0 for the method: twenty real scorelines,
   held against the game's own play count.

2. **Defensive pursuit and contain — BLOCKED ON (1).** Yards per carry reads
   5.6 against that unsourced 4-5, so do not tune to it until the number is
   found. The structural problem is real either way: `_isRunner` sends all five
   defenders at the carrier, there is no contain behind them, and that is what
   made the flea flicker unstoppable until the play-calling was weighted.

3. **The five unmeasured Studio Ochi clips.** Catch and Fall, Hold, Kick,
   Kickoff, Throw 01. Each is a 4.125s performance, so each needs a segment
   pulled with `tools/mocap/ochi-cycle.mjs` and measured against the authored
   clip it would replace. `Run Fast` is the one that has been done: 5.43 m/s,
   slower than this game's own Run, measured and declined.

4. **Presentation (E3), the only phase never finished.** Benches, coaches,
   officials, a chain crew, a crowd that is not static. Nothing to do with
   correctness — but the simulation is now more finished than the stadium
   around it.

Also true and worth stating: **points per game has drifted to ~70 against a
real 64.5** since the live interception return landed. Still inside the band,
but it is the one number with a source, so it is the one to watch.

Live page: **https://alixpham.github.io/**
