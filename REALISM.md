# Flagster — realism plan

An investigation of where Flagster diverges from real IFAF 5v5 flag football,
and a prioritised plan to close the gap. Written against **v2.11.0**
(`f408a5f`).

---

## STATUS — all six phases shipped (v2.12.0 … v2.17.0)

| Phase | Shipped | What landed |
| --- | --- | --- |
| 1 — Rules (A1–A5) | v2.12.0 | 7-second pass clock, 7-yard rush line + illegal rush, passer may not run, no-run zones, extra points as a real play. Plus `tools/simstats.mjs`. |
| 2 — Movement (B1–B3) | v2.13.0 | Acceleration/turn limits, soft body separation, pursuit intercepts. The juke's scripted impulse retired for a real weight shift. |
| 3 — Ball (C1–C3) | v2.14.0 | Gravity and launch angle, contested catch resolved in space, ball shadow and a real spiral. |
| 4 — AI (D1–D4) | v2.15.0 | Coverage no longer empties on the throw, leverage, QB progression under pressure, leverage-aware breaks — and the undercut, which is what finally produced interceptions. |
| 5 — Presentation (E1–E3) | v2.16.0 | Body variance by position and ratings, a real snap off the turf, ball spot and down marker. **E3 partial** — benches, coaches, officials, chain crew and a non-static crowd were left. |
| 6 — Clock (A6–A8) | v2.17.0 | Two 20-minute halves, continuously running clock with last-two-minute stoppages, alternating-possession overtime, real laterals. **A7 was not actually shipped** — see below. |
| A7 redone (penalties) | v2.31.0 | The illegal rush rebuilt on measured eligibility and a live ball (v2.30.0), and flag guarding finally *called* rather than merely written. |
| A9 — one forward pass | v3.4.0 | Nothing recorded that a forward pass had happened, so the ball could be thrown forward again after a catch *behind* the line. 7.9% of CPU plays did it, up to three passes in one down. |

### Where the numbers ended up

Measured with `node tools/simstats.mjs --games 6 --difficulty pro`. The
absolute values are not comparable with the table below, which came from a
different harness — but simstats is a consistent instrument and these are
measured against the same targets.

| Metric | v2.11.0 | v2.17.0 | Real 5v5 |
| --- | --- | --- | --- |
| Plays per game | 23 | **62** | 45–60 |
| Pass plays never thrown | 26.7% | **3.9%** | ~2–4% |
| Interception rate | 3.5% | **3.3%** | ~3–5% |
| Yards per pass play | 2.06 | 5.05 | ~7–9 |
| Completion % | 51.8% | 46.5% | ~55–65% |
| Yards per run | 7.25 | 6.38 | ~4–5 |
| Touchdowns per play | 22.2% | 14.2% | ~5–8% |
| Time to throw | 2.38 s | 2.07 s | ~2.5–3.5 s |

**Still out, and worth being honest about.** Touchdowns per play is about
double where it should be and yards per run is a couple of yards high. They
are the same problem: five defenders with no blocking to beat still lose
contain once a back is into open space. Completion sits under its band on
purpose — the quarterback forces throws under pressure now, which is what pays
for the interceptions — but the two together suggest the next pass should be
at pursuit and leverage again rather than at another rule.

---

## v2.27.0 — the half break, and who has the ball

A6 shipped two 20-minute halves in v2.17.0, but only the *clock* knew about
them. When time expired the period counter incremented and play carried on:
whoever had the ball kept it, on the same down, at the same spot. Measured over
twenty CPU-vs-CPU games, **twenty out of twenty second halves opened mid-drive**
(`poss=home ytg=40 dn=3`, and so on). Overtime had the same hole one level down
— it flashed "alternating possessions from the 5" and then opened wherever
regulation happened to expire, `ytg=34` on second down; only the handovers
*between* OT possessions were ever spotted on the 5.

Both are now applied at the next snap rather than inside the clock, because the
clock runs in the middle of resolving the play that ran it out and the reset has
to outrank whatever that play concluded about downs. The side that did not take
the opening possession receives the second half, first down on their own 5.

And every change of possession now says so. The rule after a score was already
right — in IFAF the opponent takes over on their own 5, and across ~440 scoring
sequences the scoring team never once kept the ball — but the handover happened
in total silence: the flash said "conversion GOOD", and then a team, the other
one, lined up on a 5-yard line and snapped. Watching that, it reads as the
scoring side keeping the ball. It now names the team and the spot.

## v2.22.0 — the throw, and the rules around it

**A pass had stopped being catchable at all.** Measured over 32 CPU-vs-CPU
games at Pro, the completion rate at v2.20.0 was **1.75%** and a pass play was
worth **0.34 yards**. The cause was one line: the launch angle came from
`sin(2θ) = gd/v²`, which is the range of a projectile that lands at the height
it left from — but v2.19.0 had (correctly) started solving the flight between
release height and catch height, and that extra half yard of fall buys extra
distance. Every pass flew **2.8 yards past** the spot the receiver had been sent
to. The receivers were fine: they arrived within 0.24 yards of their aim point
and stood there while the ball went over their heads. The catch radius is 2.4.

**Two sessions found this at the same time**, and v2.21.0 shipped the fix from
the other one: the same physics as a closed-form quadratic rather than a
bisection, with the same conclusion about the artificial "loft floor" — that it
has to go, because every angle above the flat root lands past the target by
definition. The numbers below therefore credit v2.21.0 with the passing game;
what this release adds on top of it is the throw itself, arm strength actually
reaching the ballistics (it was computed in `throwTo()` and then shadowed by a
local `var throwSpeed = 22` in `_releaseThrow()`, so every arm in the league
threw at the same velocity), release and catch heights measured off the rig
rather than guessed, and the rules.

| Metric | v2.20.0 | v2.22.0 | Real 5v5 |
| --- | --- | --- | --- |
| Yards per pass play | 0.34 | **7.44** | ~7–9 |
| Completion % | 1.75% | **46.3%** | ~55–65% |
| Interception rate | 0.30% | **3.2%** | ~3–5% |
| Gains of 3 yards or fewer | 81.5% | **51.2%** | ~35% |
| Yards per run | 8.89 | 11.03 | ~4–5 |
| Touchdowns per play | 4.88% | 18.2% | ~5–8% |
| Plays per game | 73.2 | 65.3 | 45–60 |

(32 games per column, `node tools/simstats.mjs --games 8 --seed 1..4`.)

**Being honest about the bottom two rows.** Touchdowns per play and yards per
run are worse than they were, and neither is a new fault — they are the run
defence this document has flagged since v2.17.0, now visible because the offence
works. At v2.20.0 the TD rate was low for the worst possible reason: two thirds
of all plays were passes and every one of them fell incomplete. About 1.5–2.5 of
the extra yards per run come from the field being widened to its regulation 30
(five defenders now cover a fifth more width with no blocking to beat), which is
a rule, not a tuning knob. The next pass should be at pursuit and contain.

### The throw itself

`Throw` was re-authored against the measured kinematics of collegiate
quarterbacks (Bohnert, *A complete kinematic, kinetic and electromyographical
analysis of the football throw in collegiate quarterbacks*; and the IJSPT
inertial kinematic-sequencing study of the football pass), and a new tool,
`tools/measure-clip.mjs`, reads any clip back out in the same terms so the
result can be checked rather than admired.

At the exact instant the engine let go of the ball, the old clip measured:

| | Old | New | Measured QBs |
| --- | --- | --- | --- |
| Throwing hand, relative to the chest | **0.41 m behind** | 0.37 m in front | in front |
| Trunk rotation | 67° closed | 5° open | rotating through square |
| Elbow flexion | 95° | 31° | ~31° |
| Shoulder external rotation | 9° | 62° (from 134° at MER) | 134° → ~56° |
| Peak hand speed | 5.7 m/s, 0.18s AFTER release | 13.9 m/s, at release | at release |

The quarterback was throwing the ball out of the back of his own shoulder while
facing away from the target — and he was facing away because the renderer only
learned where the pass was going once the ball was already airborne, so the turn
began after the throw. He turns to the receiver on the wind-up now.

Shoulders are no longer hand-typed euler triples. An arm that is elevated, swept
across the chest and rotated about its own axis does not decompose into an XYZ
euler anybody can hold in their head, so `Throw` and the new `FlagGrab` are
authored in elevation / horizontal adduction / external rotation — the three
angles the literature reports — and `armQ()` solves the rotation. Feet are
authored by where they are, with the hip solved (`plantHip`) so a plant stays
planted, and the pelvis height solved densely enough (`groundedHips`) that no
sole enters the turf between keys either.

### Rules

* The field is **70 x 30**. It was 70 x 25.
* **Out of bounds** is crossing the line, not coming within 0.4 yards of it, and
  the ball is dead where the crossing happened. Leaving the field in your own
  end zone is a safety.
* A **thrown ball is not held to the field** — it was clamped inbounds, so a
  pass aimed at the touchline curved back and landed in play and a throwaway
  could not be thrown away.
* **Three downs to score** once you have crossed midfield. It was four.
* A **flag pull now actually happens to somebody**: `flagPulled` was initialised
  false on every player every snap, read in a dozen places, and set to true in
  none of them, so no carrier ever reacted and no defender ever celebrated. Two
  clips therefore played for the first time in this release, and both had been
  driving feet through the turf unseen — `FlagPulled` by 8.6cm and `Celebrate`
  by 4cm. Both are solved from the leg angles now, with the celebration's hop
  added on top of the solve rather than replacing it. (`Catch` at 2.5cm and
  `Juke` at 7cm are still hand-keyed and still out; they were already playing,
  so they are pre-existing and left for a pass at the remaining clips.)

---

Every claim below is either a line of code or a measurement. The measurements
come from running the real `engine.js` headless, CPU-vs-CPU on Pro, for 8 full
games (185 plays), and from driving the real page in headless Chromium.

---

## What the simulation currently produces

| Metric | Flagster (8 games, Pro) | Real 5v5 flag football |
| --- | --- | --- |
| Yards per pass play | **2.06** | ~7–9 |
| Yards per run | **7.25** | ~4–5 |
| Pass plays where the ball never got thrown | **26.7%** | ~2–4% |
| Completion % (of passes actually thrown) | 51.8% | ~55–65% |
| Interception rate | 3.5% | ~3–5% |
| Time to throw | 2.38 s | ~2.5–3.5 s |
| Touchdowns per play | **22.2%** | ~5–8% |
| Plays per game | **23** | 45–60 |
| Gains of 3 yards or fewer | **118 of 185 (64%)** | ~35% |

The shape is the problem, not the totals. **Runs gain more than three times what
passes gain**, which inverts the sport — 5v5 flag is a passing game. And the
gain distribution is bimodal: 118 plays smothered at or behind the line, then a
long tail of 25-yard scores, with almost nothing in between. There is no
realistic middle because there is no realistic pocket: a rusher lines up 1.5
yards from the quarterback on every single snap.

---

## A. Rules — the game is playing arcade tackle football

This tier is the highest realism-per-line-of-code in the whole codebase, and it
fixes the balance table above as a side effect.

### A1. The 7-second pass clock — *not modelled at all*

IFAF gives the quarterback 7 seconds to release the ball; if it doesn't come
out, the play is dead and it's a loss of down. Flagster has no such limit.
`AI_SCRAMBLE_AT = 3.4` makes the CPU tuck and run instead, and a human can hold
the ball indefinitely.

This single rule is what makes flag football a *timed read* rather than a
scramble drill. It should be a visible count on the HUD.

### A2. The 7-yard rush line — *the single biggest sim distortion*

Real rule: a defender may not rush the passer unless they start **7 yards** off
the line of scrimmage.

`engine.js:122` lines the rusher up at `losX + 1.5`, and
`_assignDefense` sets `rusher.blitz = true` unconditionally — so every defensive
call in the game, including Prevent Deep, sends a free rusher from a yard and a
half away. That is the direct cause of the 26.7% no-throw rate, the 2.06 yards
per pass play, and the 64% of plays smothered at the line.

Fix: move the rush spot to `losX + 7`, gate the rush on the play call, and make
crossing early an illegal-rush penalty (5 yards, replay the down).

### A3. The quarterback may not run

In IFAF the original passer cannot advance the ball past the line of scrimmage.
Flagster has `qb-sneak` / "QB Keeper" as a designed run with `carrier: 'QB'`
(`data.js:247`), and `_aiQBOrCarrier` hands every CPU quarterback to
`_aiCarrier` after 3.4 seconds, which simply runs at the end zone.

Fix: drop the keeper from the playbook, let the QB scramble laterally and
behind the line only, and make crossing the LOS with the ball a dead ball.

### A4. No-run zones

Running plays are prohibited in the 5 yards before each end zone and the 5 yards
before midfield — precisely so a team can't just power the ball over the line to
gain. Unmodelled. With runs currently at 7.25 yards a carry, this is a large
part of why the CPU converts so easily.

Fix: filter run/trick plays out of the play-call UI and out of `autoCall()` when
the LOS is inside a no-run zone.

### A5. Extra points are a play, not a kick

There is no kicking of any kind in flag football. Flagster resolves the PAT with
`Math.random() < 0.92` (`engine.js:1182`).

Fix: a real snap from the 5-yard line for 1 point or the 10 for 2, with a
defence on the field and a choice for the user. This also creates the first
genuinely interesting risk decision in the game.

### A6. Clock, halves, overtime

- IFAF plays **two 20-minute halves**, not four quarters (`cfg.quarters || 4`).
- The clock runs continuously except in the final two minutes; Flagster burns a
  flat `28 + rand*8` seconds per play regardless (`_advanceDown`), which is why
  a whole game is only 23 plays.
- IFAF overtime is alternating possessions from the 5-yard line; Flagster
  plays a 90-second sudden-death period.

### A7. No penalty system at all

Worth adding at least the two that change how you play:
- **Flag guarding** (the carrier shielding their flags) — the defining offensive
  foul of the sport.
- **Illegal rush** — falls out of A2 for free.

**Recorded as shipped in v2.17.0, and it was not.** Both fouls were written and
neither worked, which is exactly the failure mode a box score cannot see: an
average over a season looks the same whether a rule fires correctly, fires on
the wrong player, or never fires at all.

- `_flagGuard` was pushed with **no call sites**. It sat in `engine.js` for
  thirteen releases and never once ran.
- The illegal rush ran, and every flag it threw was wrong: measured at 3.9% of
  plays, 24 of 25 the middle linebacker, all under Man coverage, not one of
  them a rusher. It was catching a linebacker following his man into the
  backfield on a swing route. It also ended the play on the spot and charged
  the offence the down, which made fouling *profitable* for the defence on
  fourth down.

Both are fixed in v2.30.0 (rush) and v2.31.0 (guarding), on a shared model: the
marker goes down, the play runs to its end, and the side that did not foul
accepts or declines. `tools/ruletest.mjs` asserts the behaviour directly, which
is the lesson — `tools/simstats.mjs` could not have caught either of these.

### A8. Laterals

Pitches and laterals behind the line are legal and are a staple of the sport.
Only the pre-baked `reverse` trick play approximates one, and it doesn't
actually model a pitch.

### A9. Two forward passes on one down — *fixed in v3.4.0*

Only one forward pass is legal per down. Nothing in the engine recorded that a
pass had been thrown, so nothing could refuse a second: the only guard in
`throwTo` was positional — you may not throw from past the line of scrimmage.

That positional guard happens to cover the common case, which is why this
survived. A receiver who catches the ball *downfield* is past the line and is
refused. But a screen, a swing or a checkdown is caught **behind** the line,
and from there the receiver could simply throw it forward again: measured as
two `catch` events, a fully completed second pass and no penalty.

It reads like a human-only exploit and it was not. **7.9% of CPU-vs-CPU plays
contained more than one forward pass — up to three in a single down, four of
them scoring** (8 games, pro). `_dropback` runs for `s.passer` every frame while
`handoffDone` is false, which on a pass play it always is, and `_aiThrow` opens
with `var qb = s.carrier` — the man holding the ball *now*, not the passer. So
the instant a completion was gathered behind the line, the quarterback's own
pocket logic threw it again through the receiver.

The box score never showed it, and could not have. Over five seeds either side
of the fix, completions run 46.5–49.9% before against 47.9–51.3% after, yards
per run 8.14–10.1 against 7.92–8.80, touchdowns 14.5–16.5% against 14.3–16.5% —
overlapping ranges, no signal. Each individual throw is perfectly ordinary; it
is the *count per down* that is illegal, and nothing was counting. The one
measurement that sees it is a direct one: plays containing more than one
forward pass, **7.9% → 0%**. `tools/ruletest.mjs` asserts it directly, which is
the same lesson as A7.

A handoff is not a pass (`_doHandoff` moves possession without ever reaching
`_releaseThrow`), so the RB Option Pass and Flea Flicker keep their one legal
throw; laterals stay unlimited. The flag is set at *release*, not at the
wind-up, because a wind-up the play moves out from under never becomes a pass.

The refusal message for the positional rule was misleading too. "No forward
pass past the line!" has an ambiguous subject — the natural reading is that the
*pass* may not travel past the line, i.e. that you cannot throw downfield at
all, which is the opposite of the rule and of the point of the game. It is the
*passer* who must be behind it, and the message now says so, matching the A3
wording used when the passer crosses.

---

## B. Movement — nobody has any mass

### B1. There is no acceleration model

`_seek` (`engine.js:627`) and `_moveByInput` (`engine.js:668`) both assign
velocity **directly**:

```js
p.vx = dx / m * spd;  p.vy = dy / m * spd;
```

Every player on the field goes from a standstill to top speed in a single frame
and can reverse direction instantly. Confirmed by sampling: a receiver's speed
is at its steady-state value on frame 0 of the snap and never ramps.

Consequences that read as "not real" even to someone who can't name why:

- `speed` and `agi` ratings barely matter, because nobody ever spends time
  accelerating, which is where a fast player actually separates.
- Cuts are free. A 90° turn at full sprint costs nothing.
- The juke had to be implemented as a scripted 0.2 s positional impulse
  (`jukeImpT`) precisely because the movement model has no momentum to work
  against.

Fix: give each player an acceleration (yd/s², from `speed`/`agi`), a
deceleration, and a **maximum lateral acceleration** so that turning hard sheds
speed. This is maybe 30 lines in `_seek`/`_moveByInput` and it is the largest
single improvement available to how the game *feels*.

### B2. Players interpenetrate

There is no collision or separation code anywhere in the repo. Bodies occupy the
same yard — visible in a plain screenshot of a live play, where a defender and a
receiver render as one merged figure.

Blocking is illegal in flag football, so this must **not** become a blocking
system. But two bodies cannot share a point: a soft radial separation (~0.5 yd
body radius, positional only, no momentum transfer) is enough and cannot be
exploited as a block.

### B3. Defenders chase, they never cut off

`_aiDefender` seeks the carrier's **current** position. A defender pursuing a
carrier who is moving away therefore always trails and can never close.
Real pursuit solves an intercept point from relative speed and runs at that.

---

## C. The ball

### C1. Passes have no ballistics

`_releaseThrow` builds a ball that travels a **straight line at a fixed 22 yd/s**
regardless of distance, with a cosmetic `sin()` arc capped at 3.5 yards
(`engine.js:319-324`). There is no gravity, no launch angle, no hang time.

So a 5-yard flat and a 40-yard bomb are thrown at identical velocity, a deep
ball reaches its target in the same shape as a screen, and arm strength
(`data.throw`) only ever expresses itself as a random scatter term added to the
target point.

Fix: launch speed from the `throw` rating, a chosen launch angle, and gravity.
Underthrows and overthrows then emerge from arm strength and decision-making
instead of being sampled from a distribution.

### C2. The catch is a coin flip

`_resolveCatch` runs once, at `t >= 1`, and decides the outcome with a single
`Math.random()` against a probability assembled from ratings and distances.
Nothing is contested in space: a defender who is *right there* only shifts a
number.

Fix: resolve the catch geometrically. At the arrival window, every player within
reach of the ball has a chance to play it, scaled by reach, closing speed, and
whether they're facing it. Drops, tips, pass break-ups and contested catches all
fall out of that instead of needing separate branches.

### C3. Ball rendering

- The football **casts no shadow** (`field3d.js` sets `castShadow` on players
  and the sun only). A ball in flight over a flat green field with no shadow is
  genuinely hard to judge — this is the cheapest depth cue available.
- Spin is `ball.rotation.z += 0.5; ball.rotation.x += 0.2` **per frame**
  (`field3d.js:682`) — frame-rate dependent, and tumbling rather than spiralling
  about the flight axis.

---

## D. AI and tactics

### D1. Every defender abandons coverage on the throw

The moment the ball is airborne, `_aiDefender` sends **all five** defenders at
the catch point — non-blitzers via `this._seek(d, s.ball.to, ...)`, and the
blitzer via the `!s.carrier` branch to `s.thrownTo`. Zone discipline, trail
technique and second-level help all vanish on every pass.

### D2. Coverage is assigned once and never revisited

`_assignDefense` runs at formation time, matches defenders to receivers by raw
proximity, and is never called again. There is no leverage (inside/outside), no
press-versus-off decision, no zone handoff, no recognition of what route is
actually being run.

### D3. The quarterback has no progression

`_dropback` throws on a fixed 1.6 s timer if any receiver has 2.2 yards of
separation, and never throws the ball away. Under a 7-second clock (A1) this
becomes the interesting decision it should be: work a read order, check down
under pressure, or eat it.

### D4. Routes don't respond to anything

Routes are static waypoint lists mirrored by which side the receiver started on.
No release off the line, no break sharpness, no adjustment to leverage.
`_workOpen` — the post-route behaviour — is an explicit "drift away from the
nearest defender and back toward the passer" hack.

---

## E. Presentation

### E1. Every player has the same body

One rig, one height, one build, one run cycle, for all ten players on the field.
A 99-speed receiver and a centre are identical silhouettes. `PLAYER_SCALE` is a
single constant (`field3d.js:171`).

`tools/build-player-glb.mjs` already parameterises the rig, so height and build
variance driven by position and ratings is tractable without new art.

### E2. There is no snap

The ball materialises in the quarterback's hands when `snap()` runs. Pre-snap
there is no ball on the turf, the centre is not over it, and nobody is in a
stance — everyone stands in `Idle`. The `.glb` has ten clips
(`Idle/Run/Walk/Backpedal/Throw/Catch/Dive/FlagPulled/Celebrate/Juke`) and none
of them is a snap, a three-point stance, a plant/cut, a jump, or a lateral
shuffle.

### E3. The stadium is empty of everything except crowd

No benches, no coaches, no officials, no down marker or chain crew, no spot
marker for the ball. The apron is bare. The crowd is static coloured boxes.

---

## Suggested order of work

Each phase is independently shippable and independently verifiable against the
box-score table at the top.

**Phase 1 — Rules (A1–A5).** Highest value, lowest risk, mostly small edits to
`engine.js` and `data.js`. Ship the 7-second clock, the 7-yard rush line, the QB
run prohibition, no-run zones and real extra points together, then re-run the
headless box score. Expect yards-per-pass-play to rise sharply, yards-per-run to
fall, and the TD rate to come down out of the twenties.

**Phase 2 — Movement (B1–B3).** Acceleration and turn-rate limits, soft body
separation, pursuit angles. Biggest improvement to feel. Touches `_seek`,
`_moveByInput`, `_aiDefender`; the juke's positional impulse can then be
retired in favour of a real weight shift.

**Phase 3 — Ball (C1–C3).** Ballistics, geometric contested catch, ball shadow,
correct spin.

**Phase 4 — AI (D1–D4).** Coverage discipline on the throw, leverage, QB
progressions.

**Phase 5 — Presentation (E1–E3).** Body variance, a real snap, sideline life.

**Phase 6 — Clock, halves and penalties (A6–A8).** Deliberately last: it changes
game length and pacing, and is best tuned once the per-play simulation is right.

---

## How to verify

The headless harness used to produce the table at the top runs the real engine
with a stubbed DOM and a controlled clock, so a box score can be regenerated in
seconds after any change without touching a browser. It should be checked in
alongside Phase 1 as `tools/simstats.mjs` and treated the same way the project
already treats the Chromium screenshot pass: a change that improves realism
should be able to *show* it moved the numbers toward the right-hand column.
