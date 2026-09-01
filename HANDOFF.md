# Where this repo is — read before doing anything else

**`master` is v3.25.2 and it is live at https://alixpham.github.io/.** Nothing
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
npm run lint      # 63/63 files parse
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
| `npm run subpath` | does the site still work served from a project-page folder |

---

## 3. What is NOT in this repository and must be fetched again

This is the part a new container silently loses.

* **The Studio Ochi FBX files and their atlas PNG.** Licensed; `.gitignore`
  excludes `*.fbx`, `*.blend` and `tools/ochi/`. The finished
  `flagster/lib/ochiplayer.glb` and `ochibare.glb` ARE committed, so the game
  works without them — but nothing in the character chain can be REBUILT until
  they are fetched again.

  **Getting them back is one command:**

  ```sh
  export FLAGSTER_OCHI_URL='<the Dropbox link, with its rlkey>'
  npm run ochi:fetch          # -> 42 files into tools/ochi/, all gitignored
  ```

  It is **this** Dropbox folder, so nobody has to describe it from memory:

  ```
  https://www.dropbox.com/scl/fo/v3ywmu88tkucol936m52s/AM-8GX07Xxm0CCMC32Pgnj0
  ```

  …plus the `?rlkey=…` the owner supplies. **That key is deliberately not in
  this repo, because this repo is public** — it is a GitHub Pages site, so a
  complete share link committed here is a working download of licensed artwork
  for anyone who reads it, which is the very thing the `.gitignore` entries
  exist to prevent. Keep it in the environment config beside `FLAGSTER_CHROME`.
  `npm run ochi:fetch` with nothing set prints the folder and asks for the key.

  **Two things about the pack are worth not rediscovering.** It reproduces the
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

## 4. MOVING THIS REPO TO PRIVATE `malixsys/flagster`

Decided, not yet done. The goal is that **the code is private and only the page
is public**, so the public mobile-testing URL survives.

`malixsys` is a personal account on a **paid** plan, which is the fact that
makes this simple: GitHub publishes Pages from a *private* repo on Pro, and the
published site is public. So this needs **no split and no publish step** — one
private repo, one public page. (On a free plan Pages only publishes from public
repos, which is why the alternative was ever considered.)

**The site moves from a domain root to a project page**, i.e. from
`alixpham.github.io/` to `https://malixsys.github.io/flagster/`. That is the one
technical risk, and it is checked: `npm run subpath` serves the repo under a
`/flagster` prefix, refuses everything outside it, and asserts Three.js loaded,
the menu rendered, no console errors and **no failed requests**. It passes,
because every path in the site is relative — the import map uses
`./flagster/lib/...`, the boot script has no leading slash, and `playermodel.js`
derives its base from its own `<script src>`. Run it again after the move.

### Why a Claude session cannot do this for you

Both were tried and both are hard limits, not workarounds waiting to be found:

* **Creating the repo** — the GitHub App returns `403 Resource not accessible by
  integration`. It can read and write repos it is installed on; it cannot make
  new ones.
* **Attaching it** — `add_repo` refuses: *"cross-tier adds are not supported in
  v1: requested malixsys/flagster but session already has repos from owner(s)
  [alixpham]"*. A session bound to one owner cannot reach another.

### The migration, which is two commands

The copy does not need Claude at all, and doing it with `--mirror` keeps every
branch, tag and commit rather than flattening to a snapshot:

```sh
# 1. create an EMPTY private repo at github.com/malixsys/flagster
#    (no README, no .gitignore, no licence — an init commit makes step 2 messier)

# 2. mirror the whole history across
git clone --mirror https://github.com/alixpham/alixpham.github.io.git
git push --mirror https://github.com/malixsys/flagster.git   # from inside the .git dir
```

Then, in the new repo: **Settings → Pages → Deploy from a branch → `master` →
`/ (root)`**. Confirm it reports the site live at
`https://malixsys.github.io/flagster/`.

### After the move

* **Start the next Claude session with `malixsys/flagster` as its source.** This
  one cannot follow you there.
* Decide what `alixpham/alixpham.github.io` becomes. `ROLLBACK.md` restores the
  original portfolio to it; leaving it as a stale copy of the game is the one
  outcome worth avoiding, since it will keep serving an old build forever.
* Update the live URL in `CLAUDE.md` (the "always output the live page URL" rule
  names the old one) and at the bottom of this file.
* **The `rlkey` argument changes.** `tools/ochi-fetch.mjs` keeps the Dropbox key
  out of the repo *because the repo is public*. Once it is private that reason
  is gone and the full link can live in the tool, so `npm run ochi:fetch` needs
  no environment variable. Nothing forces that change — but the comment
  explaining the omission will be wrong, and a wrong comment is worse than none.
* Going private does **not** retroactively unpublish. Everything here has been
  public since 2014 and this work has been public throughout. There are no forks
  (`forks_count` 0), but assume anything committed so far is public forever. No
  secret has been committed — the Dropbox key was deliberately kept out.

---

## 5. What is open

1. **Presentation (E3), the only phase never finished.** Benches, coaches,
   officials, a chain crew, a crowd that is not static. Nothing to do with
   correctness — but the simulation is now more finished than the stadium
   around it. **This is the biggest thing a player would actually notice.**

2. **Three targets that cannot be sourced.** `yardsPerRun`,
   `gainsOfThreeOrFewer` and `playsPerGame` have nothing behind them, plus a
   conversion rate guessed at 60-75%. They were searched for in v3.24.0 and
   **there is no public statistical database for either code** — only rulebooks
   and scorelines. They are marked unsourced in `simstats` and should stay that
   way until a real number turns up. One target in that same set,
   `touchdownsPerPlay: '~5-8%'`, was chased for eleven releases and turned out
   to be half of reality.

**The Studio Ochi clips are DONE and the answer was no.** All six were
auditioned (`npm run audition`) and declined — Kick, Kickoff and Hold are
placekicking, Catch and Fall ends prone, and Throw 01 and Run Fast are both
about a third slower than the clips they would replace. Do not re-fetch the
licensed pack to re-ask this; see REALISM.md v3.25.0. What the pack IS still
needed for is rebuilding the character, per section 3.

**The metric to steer by is combined points per game**, because scorelines are
the one thing about this sport that IS public: 64.5 across twenty IFAF World
Championship games, and the game currently measures 64.0. If a change moves
that, it matters; if it only moves an unsourced band, ask what the band is for.

Live page: **https://alixpham.github.io/**
