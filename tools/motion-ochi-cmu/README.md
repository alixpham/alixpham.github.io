# The CMU gaits, kept but not shipped

Four clips — Walk, Jog, Run, Sprint — retargeted from the free CMU database
onto the Studio Ochi metarig by `tools/mocap/retarget-ochi.mjs`. They are real
motion capture, and as walks they are better than anything anyone hand-authors.

**They are not what the player ships with, and they cannot simply be dropped
into `tools/motion-ochi/` alongside the rest.** The gait ladder blends adjacent
rungs, and a blend is only coherent if every rung puts the LEFT foot's contact
at phase 0. The game's own four do, by construction. A retargeted capture does
not: a real person is asymmetric and very slightly non-contralateral, which is
exactly why `measure-clip.mjs` withholds its verdict from clips carrying
`extras.mocap`. Mixing the two sets gives you one clip landing while the other
is airborne.

Using them means re-phasing all four to a common contact, and then re-measuring
`groundSpeed` on the baked result — not copying files.

Kept here because the retarget itself was verified (CMU 35_21 measures 3.41 m/s
through full kinematics and reads 3.25/3.29 off the stance sweep) and throwing
that away to save 280 KB would be the expensive kind of tidy.
