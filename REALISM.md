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
| D6 — the quarterback read the wrong instant | v3.10.0 | Openness was measured where the receiver was standing when the decision was made, not where the ball would land — 4.62 yards read, 1.87 on arrival — and the read *order* was the whole decision, so the first man over the bar got it and two of the four eligible receivers were effectively not in the offence. Throws arriving into coverage 41.5% → **9.7%**. Plus `tools/qbstats.mjs`. |
| E6 — the ball was not in his hands | v3.10.0 | The carry offsets are authored in the game rig's forearm frame; the character the game actually loads rests in an A-pose, so `[0, -0.27, -0.08]` pointed somewhere its forearm does not go and the football hung **0.33 yards** off the arm. Plus `tools/ballcheck.mjs`. |
| D4 — nobody chased the runner | v3.7.0 | The defence asked "is there a runner?" as `carrier !== passer` while the carrier AI asked it as `!(passer && !handoffDone)`. They disagree on Flea Flicker, and there the whole defence stayed in coverage — 22% of every live-runner frame in the game had not one man in pursuit. Yards per run 8.75 → **4.33**. Plus `tools/pursuitstats.mjs`. |
| E5 — an arm inside a head | v3.6.0 | Lasso drove the elbow 61mm inside the skull on every turn, and nothing measured it. `measure-clip` reports arm-vs-skull clearance now; all 22 clips are clear. Plus FlagPulled's 19.8° backward arch, and the menu's defender playing the ball-carrier's clip. |
| A10 — chains after a turnover | v3.5.0 | Both turnover paths set `crossedMid = false` unconditionally, so a team handed the ball past midfield chased a line to gain behind it — and got a first down on the next snap however it went. 19.5% of takeovers; 23 free first downs in 8 games. |
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

## v3.23.0 — an interception is a live ball

**There is such a thing as a pick six in flag football, and there was no such
thing in Flagster.** A defender who came down with the ball was handed it, the
whistle went in the same breath, and the ball was spotted for his side at
`50 - yardsToGoal` — the mirror of the line of scrimmage. The one play in this
sport that most often ends in six points could not end in any, and every
interception in the game's existence was worth exactly zero yards.

The rule is not in question. NFL Flag and IFAF both play interceptions live:
the ball may be advanced, and a return to the other end zone is a touchdown.

### What it took, and what it cost

Everything in the update loop asks `offenseTeam()` and `defenseTeam()` rather
than remembering a side, so moving possession **while the ball is still live**
re-points all of it in one assignment: the man who caught it is driven as a
carrier, his team-mates escort him, and the five who were running routes a
frame ago become the pursuit and the only side that can take a flag.

What does not come for free is the direction. The end zone a defender scores in
is the one *behind* the offence he took it from, so a return runs toward -x
while every goal line, leverage rule and lateral test in the file was written
knowing that downfield is +x. `attackDir()` is that seam. `viewSign()` is the
other half of it and had been the constant `+1` for eleven releases, under a
comment promising that a camera which ever turned round again would only have
to change that one line. It did, and it was.

Three things that had to be found rather than reasoned about:

* **`_update` takes its offence and defence lists at the top of the frame, and
  the catch is resolved half way down it.** So on the frame of the pick the
  flag-pull check was handed the new carrier's own side — himself included, at a
  distance of zero. Measured, he is recorded as being grabbed by *himself* with
  the meter already filling, 1.9% of a pull in one frame and the renderer
  drawing it. The lists are right again on the next frame, so it is a flicker
  rather than a whistle; `tools/ruletest.mjs` has to intercept from inside the
  frame to catch it at all.
* **A stale `outOfBounds`.** `_steer` flags any player whose step would have
  left the field and only the carrier is ever asked about it, so a corner who
  had been running the paint carried the flag into the first frame of being one
  and the whistle went before he had taken a step.
* **A marker on the field cannot survive the flip.** `against: 'defense'` is
  resolved through `defenseTeam()` when the play ends, and a return changes what
  that word means half way through the down — the offence would be charged with
  the foul committed against it. A pick with a flag down is settled the old way,
  which is also the case the live ball was there to allow: an interception
  under a defensive foul comes back.

### Measured, 8 seeds x 8 games each

| | Before | After |
| --- | --- | --- |
| Interception rate | 4.8% | 4.5% |
| Yards returned, average | **0, always** | **8.7** |
| Longest return | — | 31 |
| Pick sixes | **impossible** | 0.19 a game (one every ~5) |
| Ball spotted after a pick | 22.6 yds to go | **27.2** |
| Combined points per game | 66.3 +/- 1.8 | 66.0 +/- 1.5 |

**The scoreline did not move, and the reason is the fifth row.** The old
takeover was the mirror of the LINE OF SCRIMMAGE — where the ball was snapped
from, not where it was caught — so it quietly ignored the fact that an
interception happens downfield of the line. Spotting a return where it actually
ends starts the returning side about ten yards worse off, and 8.7 yards of
return earns most but not all of it back. A free six once every five games is
paid for by five yards of field position on every other one.

`npm run stats` reports the return and the pick sixes; `npm run pick` drives the
real renderer, forces interceptions and asserts the shot comes round behind the
man carrying it, because a camera on the wrong side of the ball still renders a
clean frame with the ball in it.

---

## v3.22.0 — the touchdown target was wrong, and had been since v2.17.0

**`touchdownsPerPlay: '~5-8%'` has no source and cannot be right.** Hold it
against this file's own play count: 45-60 plays a game at 5-8% is 2.2 to 4.8
touchdowns, or **16 to 34 combined points**. Twenty real games — the 2024 IFAF
Men's Flag Football World Championship group stage and the entire knockout
bracket including the final — average **64.5 combined points**, median 66, range
36 to 86. At six for a touchdown plus the conversion that is about **9.2
touchdowns a game between the two sides**, and at ~60 plays a game that is
**16% of plays**, not 5-8%.

So the note under the v2.17.0 table — *"touchdowns per play is about double
where it should be"* — was measuring the game against a target that was itself
half of reality. It has been chased for eleven releases.

Measured now, against the scoreline rather than the guess:

| Metric | Real 5v5 | Flagster (4 seeds) |
| --- | --- | --- |
| **Combined points per game** | **64.5** (20 IFAF WC games) | **65.3** |
| **Touchdowns per game (both)** | ~9.2 | 9.9 |
| Touchdowns per play | ~16% | 16.1% |
| Interception rate | 3-5% | 4.8% |
| Completion % | 55-65% | 61.4% |
| Yards per pass play | 7-9 | 8.8 |
| Time to throw | 2.5-3.5s | 2.7s |

`simstats` reports points and touchdowns per game now. It tracked the score all
along and never once printed it — every other number in the box score is a
rate, and a rate can be right while the game it adds up to is nothing like the
sport.

### Two real gaps found on the way there, and both are fixed

**The play call did not know how much field was left.** The CPU picked uniformly
from the playbook, so it called Four Verticals from the five-yard line as
readily as from its own thirty. Measured on conversions — always snapped from
the five — **35% of its calls were deep concepts**, and they converted at 18-33%
against 62-67% for the short ones. `AI_PLAY_ROOM` gives each family of concept
the depth it needs to exist, and the weight falls off as the square of the room
that is missing, because half a field is not half a Four Verticals. Deep calls
from the five: **35% -> 11%**. Conversions **41% -> ~48%**.

**Every broken-up pass hit the floor.** The only way to be intercepted was for a
defender to win the ball outright, and since v3.10.0 taught the quarterback to
measure separation where the ball ARRIVES he almost never throws one there —
picks fell to **0.8% of attempts against a real 3-5%**. The fix is not a worse
quarterback: it is the thing that actually produces interceptions in a sport
with no pass rush to speak of. A ball that is got to and not caught goes up, and
whoever is standing there has a play on it. `TIP_PICK` turns a deflection into a
turnover when the man who made the play was a defender. **0.8% -> 4.8%**, with
the quarterback's read untouched.

### Still out, and honestly so

`yardsPerRun` reads 5.6 against a 4-5 target, and `gainsOfThreeOrFewer` 45%
against 35%. Neither target has a source, and the second is hard to square with
a 61% completion rate on its own: every incompletion is a nought-yard play, so
~39% of pass plays are in that bucket before a single short completion joins
them. `playsPerGame` at 45-60 likewise sits just under what two 20-minute halves
on a running clock actually produce. **Find the number before tuning the game to
it** — that is the whole lesson of this release.

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

### A10. The chains after a turnover past midfield — *fixed in v3.5.0*

Four downs to cross midfield, three to score once you have (A6). Both turnover
paths — the interception and the turnover on downs — set `crossedMid = false`
unconditionally, which asserts that the chains are still at midfield and this
offence has to go and reach them.

But the takeover spot is `50 - yardsToGoal`, so whenever the team giving the
ball up was in its own half, the new offence starts **past** midfield and that
line sits *behind* the ball. Everything downstream then reads off a line nobody
has to reach: `_advanceDown` tests `reachedMid = spotX >= MIDFIELD`, which a
team starting past it satisfies on any snap at all, so the very next play
awarded "First down — past midfield!" however it went. **A one-yard loss bought
a fresh set of downs.** The HUD showed "1ST & 0" and the renderer drew the
yellow line-to-gain behind the offence.

Measured over 8 games: **19.5% of possession changes take over past midfield**,
24 of those 25 left the chains unset, and **23 free first downs** came out of it
— roughly one turnover in five handing over an extra set. Removing them costs
about one play per game (61.9 → 60.8 plays/game over five seeds); touchdown rate
moves within noise.

There is no line to gain left when you start past midfield: the only thing left
to reach is the goal line, which is precisely what `crossedMid` means. Both
paths now go through one `_takeOver`, so they cannot drift apart again — having
the same three lines written twice is how one of them came to be wrong.

### D4. Nobody chased the runner — *fixed in v3.7.0*

Reported by a player: *"defending players often just back up in front of a ball
carrying attacker."* They do, and it is one question asked in two places with
two different answers.

"Is the man with the ball a runner, or a passer still working the pocket?"
`_aiQBOrCarrier` asks it correctly — a passer is in the pocket only until the
handoff resolves, `p === s.passer && !s.handoffDone`. `_aiDefender` asked the
shorter, plausible, wrong version: `s.carrier !== s.passer`.

Those two agree on every play but one. `_doHandoff` on a play whose designed
carrier is *already* the quarterback — **Flea Flicker**, the only one left since
QB Keeper was deleted for being illegal — hands the ball to nobody and simply
sets `handoffDone`. The carrier IS the passer, and he is running. The carrier AI
knew that and sent him downfield; the defence, asking its own version, concluded
there was no runner at all and left all five men in coverage for the whole play.

What that looks like from behind the ball is exactly the report. A zone defender
holds a landmark that slides off `losX` and lerps at most 0.7 of the way toward
the nearest receiver, so he tracks the runner without ever arriving; a man
defender mirrors his receiver 0.6 yards goal-side, which downfield of a runner
is a man walking backwards in front of him. Traced: a defender **0.9 yards** in
front of the ball, moving downfield at 3.5 yd/s, for four seconds and twenty
yards, never once turning to make the play.

`tools/pursuitstats.mjs` is the instrument, and it exists because the box score
could not see this. It classifies every defender-frame within 15 yards of a live
runner by where he is and which way he is going — goal-side, backpedalling,
closing — and reports which branch of `_aiDefender` he was in.

| with a live runner on the field | before | after |
| --- | --- | --- |
| frames with nobody in pursuit | 21.7% | 0% |
| goal-side defenders backpedalling | 35.7% | 22.7% |
| defenders closing the range | 68.4% | 77.2% |
| — of those in coverage, backpedalling | 64.7% | *(no such frames)* |

The residual 22.7% is real football: a defender taking a pursuit angle across
the field is goal-side and gaining ground downfield while the gap shrinks at
2.97 yd/s. Restricted to defenders actually *in the running lane* — more than
1.5 yards goal-side, within 3 yards laterally — backpedalling is 3.0%.

The question is asked once now, in `Engine.prototype._isRunner`, and the three
places that need it read it — including the rush branch, which had the same
wrong test and so chased a Flea Flicker runner's current position instead of
solving the intercept B3 exists to solve.

The box score moved further than the fix was aimed at, because those runs were
unopposed and therefore enormous:

| 8 games, pro, seed 1 | before | after | target |
| --- | --- | --- | --- |
| Yards per run | 8.75 | **4.33** | ~4–5 |
| Yards per pass play | 6.09 | **7.04** | ~7–9 |
| Completion % | 47.8% | 51.6% | ~55–65% |
| Interception rate | 3.0% | 3.5% | ~3–5% |
| Pull rate given contact | 71.3% | **75.7%** | ~75–90% |
| Time to pull, p90 | 3.48s | **2.68s** | ~1.5s |

**Still open, and adjacent:** Flea Flicker never flicks. `_doHandoff` short-cuts
`op.carrier === 'QB'` to a bare `handoffDone = true`, which both skips the pass
the play is named for and — because A3's past-the-line check is written
`c === passer && !s.handoffDone` — lets the original passer legally advance the
ball. That is a designed quarterback run, which is the exact thing QB Keeper was
deleted for being. The defence chases him now; the rule still does not.

### E6. The ball was not in his hands — *fixed in v3.10.0*

Reported as "check the ball holding by players", and it took an instrument to
see, because every way of getting this wrong still leaves a clean console and a
football somewhere on the screen. The engine only knows who has *possession*;
whether the ball is being drawn in that man's hands is a fact about the scene
graph — a parent and a local offset — and no headless box score can reach it.
`tools/ballcheck.mjs` drives a real game in headless Chromium and reads back off
the renderer (`field3d.ballHold`) what the ball is actually parented to and how
far, in world yards, it is from the nearest hand of the man carrying it.

It measured **0.33 yards** — a foot — on the running carry, and 0.06 on the
quarterback's ready position. That split is the diagnosis. The ready grip hangs
off `Socket_Hand_R`, a frame the two rigs share; the carry grip hangs off
`LowerArm_*`, and they do not.

This is the `restAlign` lesson a second time. The carry offsets in `field3d.js`
are authored against the game's own player, whose arm bones run straight down
their own −Y — the comment says so out loud, "the bone runs 0.27 down its own
−Y to the wrist". The character the game actually loads is the Studio Ochi
athlete, which rests in an A-pose: its `LowerArm_R → Hand_R` is
`[-0.207, -0.126, 0.019]`, mostly down its own −X. So `[0, -0.27, -0.08]`
pointed 0.27 in a direction that forearm does not go, and the ball hung below
the elbow, held by nothing, for every carried frame of every play.

The arm itself was already correct: `poseArm` post-multiplies an authored pose
by `restAlign`, the per-bone constant `tools/glb-rerig.mjs` measures at build
time. Nothing was carrying the *ball* offsets through the same constant. A
vector authored in the game's frame comes back the other way — `A⁻¹ · v`,
because `A` maps the model's rest direction onto the game's — and the ball's
rotation takes the same constant pre-multiplied. On the game's own rig there is
no `restAlign` at all and it is a no-op, which is why nothing moves there.

| 90 s of live game | before | after |
| --- | --- | --- |
| Ball to nearest hand, median | 0.348 yd | **0.087 yd** |
| Ball to nearest hand, worst | 0.355 yd | **0.114 yd** |
| Parented to nothing while carried | 0% | 0% |

`ballcheck` asserts on both bars now: a ball more than 0.55 yd from a hand is
not in one at all, and a ball more than 0.25 yd from one is being carried at
arm's length — which is what the structural test could not see, since the ball
was parented to exactly the right limb the whole time.

### E5. An arm inside a head, and nothing was looking — *fixed in v3.6.0*

Reported by a player watching the landing screen, which is the second time that
has been the instrument.

**Lasso** sweeps `horiz` a full turn with `elev` held at 132, which traces a cone
about the *vertical through the shoulder*. The shoulder is 0.200m to the side of
the skull centre and the humerus is 0.335m long, so on the inboard half of every
turn the elbow arrived at x=+0.049 against a skull centre at x=0 — **61mm inside
a sphere of radius 105mm**. Raising the arm cannot rescue it: clearing the top of
the skull needs the elbow above 1.89m and a vertical humerus reaches 1.835m, so
there is no elevation at which a full turn passes over the head. What a real
twirl does is tilt the circle away from the body, which is elevation modulated by
`horiz` rather than held — 118 outboard, 178 as it comes across. Closest approach
−61mm → **+63mm**.

**FlagPulled** was the last clip in the file still hand-typing euler triples at
the shoulder, the one thing the rig notes forbid. `[-1.30, 0, -0.55]` solves to 75°
of elevation with 58° of horizontal adduction on a near-straight elbow; measured,
that clears the skull, but one joint down Spine −0.22, Chest −0.14 and Head −0.28
stack into a **19.8° backward arch**. It also skated a planted foot at 2.52 m/s
with a sole 13mm under the turf — both already reported by `measure-clip`, both
unread. Re-authored through `armQ()` in the same anatomical form as FlagGrab:
lean never negative, skate 0.07 m/s, no foot through the ground.

And the landing screen's green defender was playing `flagPull`, which the alias
table maps to **FlagPulled** — the reaction of the man who just *lost* his flag.
The driver beside it has always faced an imagined carrier and thrown a loose flag
into the air at the rip. The one figure whose job is making the play was
performing the reaction to having it made on him; it plays `FlagGrab` now.

The instrument was the gap. Every check in `measure-clip` asked about the ground,
so a limb inside the body passed silently. It reports arm-vs-skull clearance now
— closest approach of the upper-arm and forearm *segments* to the skull sphere,
because a forearm can pass through a head with both ends outside it — and the
skull is defined once in `rig-def.mjs` alongside the soles. All 22 clips clear.

### E4. The HUD named every spot on the field "OPP" — *fixed in v3.5.0*

`ballOnText` in `ui.js` was the NFL's 100-yard convention applied to a 50-yard
field: `ytg > 50 ? OWN : OPP`. There are only 50 yards between the goal lines
here, so `yardsToGoal` never exceeds 50, the OWN branch could not fire, and
every spot printed as "OPP" — your own 5 read **"OPP 45"** and midfield read
**"OPP 25"**.

The engine has always named spots correctly for its own announcements
(`_spotName`: over 25 is your own half, under 25 is theirs), so the BALL ON
panel and the flash message sitting on top of it disagreed about where the ball
was, and the panel was the wrong one. Found while checking A10.

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

### D6. The quarterback read the wrong instant — *fixed in v3.10.0*

Reported as "the QB should pass and hand off more to open players, he risks
interceptions". Both halves of that are measurable, and `tools/qbstats.mjs`
exists to measure them: it freezes the field at the moment a CPU quarterback
commits to a throw and asks how open the man he chose really was, how open the
best man available was, and whether a defender was sitting in the lane.

**He was reading the wrong instant.** `_aiThrow` ranked receivers by the
distance to the nearest defender *right then*, and the ball does not arrive
right then: the wind-up runs 374 ms and the flight is another 0.7 s on an
average throw, through which every defender is closing at up to nine yards a
second. Measured over eight games at Pro, the quarterback read **4.62 yards** of
separation and the ball landed in **1.87**. Nearly four in ten throws arrived
with under a yard of it, which is a contested ball by definition.

**And the read order was the whole decision.** The loop walked WR1, WR2, RB, C
and threw to the first man over the bar, so nobody after him was ever looked
at. That is not a progression, it is a priority list, and it showed in who got
the ball:

| Target share, 8 games, pro | before | after |
| --- | --- | --- |
| WR1 | 69.3% | 31.2% |
| WR2 | 1.5% | 9.7% |
| RB | 29.2% | 24.3% |
| C | **0.0%** | 34.9% |

The centre never caught a pass in his life. He is read four; nothing ever got
past read one with anybody standing near him.

The fix is one function, `_readReceiver`, which runs the same lead solve
`_releaseThrow` runs and then measures separation **at the arrival point**,
giving each defender the flight time — less the beat it takes to read the
release — to close on it at his own top speed. Every read is then scored in
those units, and the progression survives as what it really is: a yard of
separation on read one, a quarter of one on read four.

Two things had to be priced in beside openness, and the first attempt got both
wrong. Handing defenders the wind-up as well as the flight made every downfield
throw look covered, and the quarterback threw the ball an average of **0.06
yards behind the line of scrimmage** — a checkdown on every down. And
separation stops being worth anything once there is enough of it: a man three
yards clear and a man eight yards clear are the same catch, and ranking them
apart is why the flat always won, because nobody covers the place the play is
not going. Capped at four yards, with depth priced at 0.16 yards of separation
per yard downfield, the throw is decided by what it is *worth*.

| 8 games, pro, seeds 1–3 | before | after | target |
| --- | --- | --- | --- |
| Separation on arrival | 1.82 yd | **3.58 yd** | — |
| Threw into coverage (< 1 yd on arrival) | 41.5% | **9.7%** | — |
| Threw into the lane (defender in front) | 73.7% | **35.8%** | — |
| Threw to the most open man | 27.8% | **40.1%** | — |
| Completion % | 50.2% | **60.5%** | ~55–65% |
| Yards per pass play | 7.25 | **7.39** | ~7–9 |
| Interception rate | 3.1% | 2.0% | ~3–5% |
| Time to throw | 2.00 s | **2.41 s** | ~2.5–3.5 s |

**Interceptions went under their band, and that is the trade, not a bug.**
v2.15.0's note said completion sat below its band *on purpose* — "the
quarterback forces throws under pressure now, which is what pays for the
interceptions". This is that entry reversed: he stops forcing them, so
completions come up into band and the picks he was paying with go away. If the
band matters more than the read does, the honest knob is the catch model
(`DEF_READ`, `CATCH_NEED`, the undercut) rather than making the quarterback
throw badly again.

**The outlet is not one, and this is worth recording.** A CPU version of
`pitch()` — the backwards flick to a trailing team-mate, which is legal
anywhere on the field and cannot be intercepted — was written and then
measured out of the build: over 471 CPU-vs-CPU plays there was a man behind the
passer on **zero** of the 5,721 frames the quarterback was reading from. He
drops five yards behind the line and every route in the playbook goes forward;
the deepest start is `swing`, at x = −1. An outlet needs somebody to stay home,
which is a playbook change and not an AI one.

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
