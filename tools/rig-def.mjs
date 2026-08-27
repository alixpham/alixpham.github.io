/* ============================================================================
   FLAGSTER — THE RIG, DEFINED ONCE

   The bone table and the sole geometry used to live in three places: the
   builder that bakes the .glb, the measurer that reads it back, and (once
   mocap retargeting arrived) a third copy that would have had to agree with
   both. This project has already been bitten twice by a constant that was
   copied and then drifted — the gait ground speed, which is why that one now
   lives inside the .glb as measured `extras` rather than as a number anybody
   types. Same lesson, applied one level up: everything that describes the
   SHAPE of the rig is exported from here and imported everywhere else.

   Units are metres, +Y up, +X the player's LEFT, +Z the direction they face.
   Every entry is [name, parent, offset-from-parent]; no bone carries a rest
   ROTATION, which is the property the retargeter leans on (a bone's world
   rotation in a pose is therefore exactly its rotation away from rest).
   ============================================================================ */

export const BONES = [
  ['Hips',            null,             [0, 1.000, 0]],
  ['Spine',           'Hips',           [0, 0.125, 0]],
  ['Chest',           'Spine',          [0, 0.175, 0]],
  ['Neck',            'Chest',          [0, 0.250, 0]],
  ['Head',            'Neck',           [0, 0.080, 0]],

  ['Shoulder_L',      'Chest',          [ 0.050, 0.200, 0]],
  ['UpperArm_L',      'Shoulder_L',     [ 0.150, 0.000, 0]],
  ['LowerArm_L',      'UpperArm_L',     [0, -0.335, 0]],
  ['Hand_L',          'LowerArm_L',     [0, -0.270, 0]],
  ['Socket_Hand_L',   'Hand_L',         [0, -0.090, 0.035]],

  ['Shoulder_R',      'Chest',          [-0.050, 0.200, 0]],
  ['UpperArm_R',      'Shoulder_R',     [-0.150, 0.000, 0]],
  ['LowerArm_R',      'UpperArm_R',     [0, -0.335, 0]],
  ['Hand_R',          'LowerArm_R',     [0, -0.270, 0]],
  ['Socket_Hand_R',   'Hand_R',         [0, -0.090, 0.035]],

  ['UpperLeg_L',      'Hips',           [ 0.098, -0.040, 0]],
  ['LowerLeg_L',      'UpperLeg_L',     [0, -0.460, 0]],
  ['Foot_L',          'LowerLeg_L',     [0, -0.410, 0]],
  ['Toe_L',           'Foot_L',         [0, -0.055, 0.115]],

  ['UpperLeg_R',      'Hips',           [-0.098, -0.040, 0]],
  ['LowerLeg_R',      'UpperLeg_R',     [0, -0.460, 0]],
  ['Foot_R',          'LowerLeg_R',     [0, -0.410, 0]],
  ['Toe_R',           'Foot_R',         [0, -0.055, 0.115]],

  ['Socket_Flag_L',   'Hips',           [ 0.222, 0.015, -0.045]],
  ['Flag_L',          'Socket_Flag_L',  [0, 0, 0]],
  ['Socket_Flag_R',   'Hips',           [-0.222, 0.015, -0.045]],
  ['Flag_R',          'Socket_Flag_R',  [0, 0, 0]]
];

/* WHICH CHILD CONTINUES A BONE. Chest has three children and only one of them
   is the torso; a rule like "the longest offset" gets the pelvis wrong, which
   is how a rest-direction comparison came back claiming the hips were 90
   degrees out from themselves. Anything that needs to walk a LIMB rather than
   the tree — measuring a bone's rest direction, retargeting onto it — asks
   here. Tips (Head, Toe_*) continue into nothing and carry an explicit
   direction instead. */
export const CONTINUES = {
  Hips: 'Spine', Spine: 'Chest', Chest: 'Neck', Neck: 'Head',
  Shoulder_L: 'UpperArm_L', UpperArm_L: 'LowerArm_L', LowerArm_L: 'Hand_L', Hand_L: 'Socket_Hand_L',
  Shoulder_R: 'UpperArm_R', UpperArm_R: 'LowerArm_R', LowerArm_R: 'Hand_R', Hand_R: 'Socket_Hand_R',
  UpperLeg_L: 'LowerLeg_L', LowerLeg_L: 'Foot_L', Foot_L: 'Toe_L',
  UpperLeg_R: 'LowerLeg_R', LowerLeg_R: 'Foot_R', Foot_R: 'Toe_R'
};
export const TIP_DIR = { Head: [0, 1, 0], Toe_L: [0, 0, 1], Toe_R: [0, 0, 1] };

/* THE SOLE IS THREE POINTS ON TWO SEGMENTS. Heel and ball ride the Foot bone;
   the tip hangs off Toe and swings with it, so a foot can roll through toe-off
   with the forefoot flat instead of pivoting as one plank. Every ground solve
   in this repo takes the lowest of the three. */
export const SOLE = 0.090;        // ankle joint above the sole
export const HEEL_Z = -0.075;     // back of the heel, in the foot frame
export const MTP_Z = 0.115;       // ball of the foot == the Toe joint
export const MTP_DROP = 0.055;    // Toe joint above the sole under it
export const TOE_DROP = 0.035;    // sole under the toe joint
export const TOE_LEN = 0.068;     // and how far the tip reaches past it

/* Local sole points, keyed by the bone they hang from. */
export const SOLE_POINTS = side => [
  { bone: 'Foot_' + side, p: [0, -SOLE, HEEL_Z] },
  { bone: 'Foot_' + side, p: [0, -SOLE, MTP_Z] },
  { bone: 'Toe_' + side,  p: [0, -TOE_DROP, TOE_LEN] }
];

/* THE SKULL, as a sphere, in the Head bone's own frame. The head mesh is a
   blob at [0, 1.735, 0.008] world with radius 0.105 (build-player-glb.mjs), and
   the Head joint sits at y=1.630, so the centre is 0.105 up the bone from it.
   Here rather than in the measurer because the rig is defined once: a second
   copy is the same drift that put a hand-copied ground speed out of step with
   its stride table twice. */
export const SKULL = [0, 0.105, 0.008];            // centre, local to Head
export const SKULL_R = 0.105;                      // and its radius

export const HEIGHT_M = 1.850;                     // documented author height
export const THIGH = 0.460, SHIN = 0.410;
export const HIP_Y = 1.000 - 0.040;                // UpperLeg height at rest
export const HIP_HALF = 0.098;                     // UpperLeg offset from the spine

/* name -> [parent, offset], for anything that needs to walk the tree. */
export const BONE_MAP = (() => {
  const m = {};
  for (const [n, p, o] of BONES) m[n] = { parent: p, offset: o };
  return m;
})();
