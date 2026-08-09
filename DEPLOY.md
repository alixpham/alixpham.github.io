# Deploy log

Flagster is served by GitHub Pages from the `master` branch at
**https://alixpham.github.io/**. This file records the commit id behind each
notable live deploy (newest first).

Version tags (see `VERSION`): **v2.5.0** = `629f643ab2e4ec96e42e003cf3eb9c39e67598db`,
**v2.4.0** = `1f26722c7c368f849d1ec74f9a1f0ad83164b476`,
**v2.3.0** = `243074430c9bc2db549b82f9576abc015f5e60d5`,
**v2.2.0** = `ee8883d78e5fb19ca925c7332cf351fc88bd5194`,
**v2.1.1** = `d44e50d5f9a89b7ed15c49193b6700bd3232397c`,
**v2.1.0** = `8f8804f57a644dcea6ba8b997aee2a77d0d9c1d0`,
**v2.0.0** = `323d1906391a50cdc257d1ed746f04994e6751df`,
**v1.9.1** = `badcf47c09151d8f2d797b5f2971c819898d3dd5`,
**v1.9.0** = `bedc17d4f761528f9f3a5c0b34684d925efed50d`,
**v1.8.0** = `ee9ff9211e7eda1a8571ec634e1affc570cc560f`,
**v1.7.0** = `bddb3464388181f4aa13aaa8f97d5985f0da30c3`,
**v1.6.0** = `2dcd368a81cfa1c4490f6fd655085a36fd890a24`,
**v1.5.1** = `6df11a364453db54a6255a4ad9addeaa2062978f`,
**v1.5.0** = `d11b13ecd1ce6782b0200c8be38764b2a5b5e429`,
**v1.4.1** = `bf76d1ab6c6b239709ca936323a2acd854d0e0c9`,
**v1.4.0** = `6447c6a990f53d0e95ae17b75949cfa2ce17b4cf`,
**v1.3.0** = `037017902a4b22e829fa7d2e862196258e8f8d6e`,
**v1.2.0** = `c72c2d1aa16bf43f0dfb85e76bfddc2458899fe8`,
**v1.1.0** = `e8b079ae1412b079b5411b086b86f033345f7fec`,
**v1.0.0** = `024f9a6b5c652ded9617add74bf5d54008ffda7d`. (Git tags exist locally but the
git proxy blocks tag pushes, so these are the authoritative version→commit records.)

| Date (UTC) | Commit | What shipped |
| --- | --- | --- |
| 2026-08-09 | `629f643ab2e4ec96e42e003cf3eb9c39e67598db` | **v2.5.0** — real jersey numbers by position (the renderer had been painting each player's OVR rating on their chest) and a safety only when your flag is pulled behind your own goal line, never for standing there |
| 2026-08-09 | `1f26722c7c368f849d1ec74f9a1f0ad83164b476` | **v2.4.0** — athletic player build (square shoulders, real neck, thicker arms and calves) and a portrait camera pulled back off the carrier, with the lens clamped inside the bowl |
| 2026-08-09 | `243074430c9bc2db549b82f9576abc015f5e60d5` | **v2.3.0** — broadcast presentation across the demo AND every played mode: a low over-the-shoulder chase camera in place of the fit-the-whole-field view, a scorebug/play-clock/situation HUD with procedural team crests and a field map, daylight relight with live jumbotrons, a real play clock and working stamina, and control hints, thumb-button clutter and floating nameplates taken off the field |
| 2026-08-08 | `ee8883d78e5fb19ca925c7332cf351fc88bd5194` | **v2.2.0** — slash to direct: draw a line across the field and your player runs the whole route hands-off, with the route painted on the turf |
| 2026-08-08 | `d44e50d5f9a89b7ed15c49193b6700bd3232397c` | **v2.1.1** — landing screen turned around: the cast now runs, cuts and throws toward the viewer, so you see faces and jersey fronts instead of three backs jogging away |
| 2026-08-08 | `8f8804f57a644dcea6ba8b997aee2a77d0d9c1d0` | **v2.1.0** — real running gait: knees and elbows bend the right way (they were inverted, which folded the foot behind the shin — the "ostrich run"), six-phase run/walk cycles, pelvis height solved by forward kinematics so feet plant instead of skating, landing screen waits for the rigged players, everyone faces the way they're running |
| 2026-08-08 | `323d1906391a50cdc257d1ed746f04994e6751df` | **v2.0.0** — real rigged/skinned/team-skinnable flag football player (glTF SkinnedMesh, 27 joints, 10 clips, 9 tintable regions) + reproducible generator; drops the 2.8MB Xbot (#34) |
| 2026-08-07 | `badcf47c09151d8f2d797b5f2971c819898d3dd5` | **v1.9.1** — fixed rotated control axes (right no longer goes down), tap a player to switch / throw, swipe to move (#32) |
| 2026-08-07 | `bedc17d4f761528f9f3a5c0b34684d925efed50d` | **v1.9.0** — Rookie/Pro/All-Pro difficulty (Rookie default), CPU-vs-CPU Watch Demo, contested flag pull with juke mechanic + grab meter (#30) |
| 2026-08-07 | `ee9ff9211e7eda1a8571ec634e1affc570cc560f` | **v1.8.0** — human-scale players (~6'2" instead of ~15ft), rig reoriented so limbs swing fore/aft (natural arms + stride), refreshed landing screen on the real stadium (#28) |
| 2026-08-07 | `bddb3464388181f4aa13aaa8f97d5985f0da30c3` | **v1.7.0** — Three.js r128→r185 via import map + guarded ESM bootstrap (2D fallback preserved), bloom/SMAA post-processing, colorSpace migration, lighting re-tuned for physically-correct units (#26) |
| 2026-08-07 | `2dcd368a81cfa1c4490f6fd655085a36fd890a24` | **v1.6.0** — Madden-style camera: always behind the team you play as, anchored behind the action, field width fills the frame (#24) |
| 2026-08-07 | `6df11a364453db54a6255a4ad9addeaa2062978f` | **v1.5.1** — crisper turf markings (mipmapped textures) (#22) |
| 2026-08-07 | `d11b13ecd1ce6782b0200c8be38764b2a5b5e429` | **v1.5.0** — professional broadcast presentation: procedural stadium (sky, crowd, floodlights), broadcast turf (yard numbers, hashes, lettered end zones), whole-field camera on any aspect, soft shadows + ACES tone mapping (#20) |
| 2026-07-21 | `bf76d1ab6c6b239709ca936323a2acd854d0e0c9` | **v1.4.1** — mobile swipe-to-move controls + centered (un-skewed) mobile camera (#18) |
| 2026-07-21 | `6447c6a990f53d0e95ae17b75949cfa2ce17b4cf` | **v1.4.0** — portrait field framing (fits horizontal field on tall screens) + men's flag-football player look (headband, broad shoulders, flag belt) (#16) |
| 2026-07-21 | `037017902a4b22e829fa7d2e862196258e8f8d6e` | **v1.3.0** — load a real rigged glTF character (GLTFLoader + Xbot), tinted per team, skeletal idle/walk/run in-game (#14) |
| 2026-07-21 | `c72c2d1aa16bf43f0dfb85e76bfddc2458899fe8` | **v1.2.0** — Madden behind-our-side camera + players idle between plays (#12) |
| 2026-07-21 | `e8b079ae1412b079b5411b086b86f033345f7fec` | **v1.1.0** — realistic rigged players + Three.js AnimationMixer/AnimationClip system (menu + in-game) (#10) |
| 2026-07-21 | `984ad93121f84de4b01d120b37eccc29e21888ce` | **v1.0.0** — football-like player stance & direction — jointed limbs, athletic poses, action-based facing (menu + in-game) (#8) |
| 2026-07-21 | `8be4df35bc3136c7206c5dc246400629dadc8479` | 3D in-game field (Three.js) + richer menu hero animations (#6) |
| 2026-07-21 | `c7204a8fb6f7074e18a0a976ab19ea7b4ec67626` | Three.js top-down 3D player animations on the menu + this deploy doc (#4) |
| 2026-07-21 | `d4cf30a30b46e2dd7d0249efb5a1cd2dda09ad87` | Replace Israel with Spain in the nations roster (#3) |
| 2026-07-20 | `58436bfbf73f1c5ab459f49eedda01cc3d58e11b` | Remove CNAME — site serves at alixpham.github.io (#2) |
| 2026-07-20 | `ae33742080bd49014bc0edeaf08a69b0ca5612e4` | Make Flagster the homepage (#1) |

> To find the current live commit at any time:
> `git rev-parse origin/master`
