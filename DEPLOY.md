# Deploy log

Flagster is served by GitHub Pages from the `master` branch at
**https://alixpham.github.io/**. This file records the commit id behind each
notable live deploy (newest first).

Version tags (see `VERSION`): **v1.2.0** = `c72c2d1aa16bf43f0dfb85e76bfddc2458899fe8`,
**v1.1.0** = `e8b079ae1412b079b5411b086b86f033345f7fec`,
**v1.0.0** = `024f9a6b5c652ded9617add74bf5d54008ffda7d`. (Git tags exist locally but the
git proxy blocks tag pushes, so these are the authoritative version→commit records.)

| Date (UTC) | Commit | What shipped |
| --- | --- | --- |
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
