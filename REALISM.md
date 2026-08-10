# Flagster — realism plan

An investigation of where Flagster diverges from real IFAF 5v5 flag football,
and a prioritised plan to close the gap. Written against **v2.11.0**
(`f408a5f`).

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

### A8. Laterals

Pitches and laterals behind the line are legal and are a staple of the sport.
Only the pre-baked `reverse` trick play approximates one, and it doesn't
actually model a pitch.

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
