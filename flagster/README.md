# 🏈 Flagster

An Olympic-style **5v5 flag football** game built for LA 2028, playable in the
browser on both **Mac/desktop** (keyboard) and **mobile** (touch). No build step,
no dependencies — pure HTML5 Canvas + vanilla JS.

Live at **/flagster/** (e.g. `alixpham.com/flagster/`).

## Modes

- **🌍 World** — Madden-style quick play. Pick any two of the 14 nations expected
  to contend at the 2028 Olympics, choose your jerseys (home / away / alternate),
  set the quarter length, and play a full game. Short/medium/deep passes, runs,
  and trick plays (reverse, RB option pass, flea flicker). Real field proportions,
  route previews, and a flag-pull animation.
- **🏗️ Team Builder** — Franchise mode. Create a coach (name + look + team accent),
  choose a country, play/sim a full season, trade players, and chase a
  championship. The **top 6 nations** make the playoffs (top 2 get byes) →
  quarterfinals → semifinals → championship. Run as many seasons as you like.
- **⭐ Road to Glory** — Superstar mode. Create a player at any position — QB, RB,
  WR, **Center** (can catch, cannot block), Rusher, Middle Linebacker, or
  Cornerback — pick an archetype, and start at **65 OVR**. Complete in-game
  challenges to earn XP, level up, and grind all the way to 99.

## Controls

A **🎮 Controls** button is available on the main menu and inside every game.

**Mac / Keyboard**
| Action | Key |
| --- | --- |
| Move | W A S D or Arrow Keys |
| Sprint | Hold Shift |
| Snap | Space / Enter |
| Throw WR1 / WR2 / RB / Center | 1 / 2 / 3 / 4 |
| Switch defender | Q |
| Pull the flag (on defense) | E |

**Mobile / Touch** — left-thumb joystick to move, on-screen SNAP / receiver /
SPRINT / SWITCH / PULL buttons.

## Rules (IFAF-style)

- Field: 70 yd × 25 yd (two 10-yard end zones, 50 yards between goal lines).
- 4 downs to cross **midfield** for a fresh set, then 4 downs to score.
- TD = 6 (+1 auto extra point), Safety = 2. Ties go to overtime.

## Files

```
flagster/
  index.html          entry point
  css/flagster.css    all styles (responsive)
  js/data.js          nations, rosters, plays, routes, archetypes, jerseys
  js/storage.js       localStorage save/load
  js/engine.js        canvas game engine (field, physics, AI, flag pulls)
  js/ui.js            UI toolkit + shared GameShell (HUD, play-call, controls)
  js/world.js         World (quick play)
  js/teambuilder.js   Team Builder (franchise)
  js/roadtoglory.js   Road to Glory (superstar)
  js/main.js          main menu + bootstrap
```

### A note on realism

The 2028 rosters have not been named and real athlete likenesses/"face scans"
are not licensable for a fan project, so Flagster ships stylized player avatars
with **Madden-style last-name plates** and representative, nation-flavored
rosters generated deterministically per country.
