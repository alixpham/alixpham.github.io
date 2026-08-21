/* ============================================================================
   FLAGSTER — GENERAL FORWARD KINEMATICS ON THE RIG

   The builder's own ground solve is SAGITTAL: it takes four angles per leg and
   works in the plane, because every clip in the game was authored that way and
   plane geometry is far easier to reason about while you are hand-writing a
   stride table. Retargeted motion capture is not planar — a real femur abducts
   and rotates about its own axis on every step — so it needs the general case:
   quaternions all the way down, and the sole found by transforming three points
   through whatever the pose happens to be.

   Same rig, same three sole points, same 4mm contact tolerance as
   gaitMetrics() in the builder, so a mocap clip's `extras` mean exactly what an
   authored clip's do and the two can share one blend ladder.
   ============================================================================ */

import { BONES, BONE_MAP, SOLE_POINTS } from './rig-def.mjs';
import { qMul, qRot } from './mocap/asf.mjs';

/* World transform of every bone, from local rotations plus a pelvis position.
   `local` is { boneName: quat }; anything missing is taken as unrotated. */
export function fk(local, hips) {
  const q = {}, p = {};
  for (const [name, parent, off] of BONES) {
    const lq = local[name] || [0, 0, 0, 1];
    if (!parent) {
      q[name] = lq;
      p[name] = hips ? hips.slice() : off.slice();
    } else {
      q[name] = qMul(q[parent], lq);
      const d = qRot(q[parent], off);
      p[name] = [p[parent][0] + d[0], p[parent][1] + d[1], p[parent][2] + d[2]];
    }
  }
  return { q, p };
}

/* The three sole points of one foot in world space, lowest first is NOT
   guaranteed — callers take the min, because which point is lowest changes as
   the foot rolls and that is the whole reason there are three. */
export function sole(W, side) {
  return SOLE_POINTS(side).map(s => {
    const d = qRot(W.q[s.bone], s.p);
    const o = W.p[s.bone];
    return [o[0] + d[0], o[1] + d[1], o[2] + d[2]];
  });
}

export const lowestSole = (W, side) => {
  const pts = sole(W, side);
  let lo = pts[0];
  for (const q of pts) if (q[1] < lo[1]) lo = q;
  return lo;
};

/* HOW FAST THE GROUND GOES BY, for a clip that is not planar.

   The rule is the builder's, verbatim: a sole point within 4mm of the turf (or
   of the closest this cycle ever gets to it) is carrying weight, and the speed
   the ground moves is how fast that point travels backwards under the player.
   Everything else here is bookkeeping so the returned object is the same shape
   the authored gaits bake, since playermodel.js reads them through one path. */
export function metrics(frames, dur) {
  const N = frames.length;
  const dt = dur / N;
  const lowOf = (i, side) => lowestSole(frames[i], side);

  let floor = Infinity;
  for (let i = 0; i < N; i++) for (const s of ['L', 'R']) floor = Math.min(floor, lowOf(i, s)[1]);
  const ON = 0.004 + Math.max(0, floor);

  let sum = 0, n = 0, stanceL = 0, anyDown = 0;
  const rates = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    let down = 0;
    for (const side of ['L', 'R']) {
      const now = sole(frames[i], side), nxt = sole(frames[j], side);
      let k = 0;
      for (let m = 1; m < 3; m++) if (now[m][1] < now[k][1]) k = m;
      if (now[k][1] > ON) continue;
      down = 1;
      if (side === 'L') stanceL++;
      sum += -(nxt[k][2] - now[k][2]) / dt;
      rates.push(-(nxt[k][2] - now[k][2]) / dt);
      n++;
    }
    anyDown += down;
  }
  const sorted = rates.slice().sort((a, b) => a - b);
  const at = q => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
  const mean = n ? sum / n : 0;
  return {
    gait: 1,
    groundSpeed: mean,
    steady: at(0.5),
    even: mean ? (at(0.75) - at(0.25)) / mean : 0,
    stance: stanceL / N,
    flight: 1 - anyDown / N,
    cycle: dur
  };
}
