/* ============================================================================
   FLAGSTER — POSING AND SKINNING A GLB, ONCE

   Not a tool. The shared half of everything here that has to know WHERE A
   VERTEX ACTUALLY IS in a pose: `glb-gait.mjs` measures how fast a sole sweeps,
   `glb-ground.mjs` puts that sole on the turf, and `glb-rerig.mjs` proves a
   rebuilt rig moved nothing. Three copies of a skinning evaluator is three
   chances for one to drift, which is the mistake `rig-def.mjs` exists to
   prevent one level up.

   glTF skinning, in one line: a vertex lands at the weighted sum over its
   joints of jointWorld * inverseBind * v. The mesh node's own transform plays
   no part — the spec says to ignore it — which is why a skinned model can
   carry a unit wrapper that appears to shrink it a hundredfold and render at
   the right size anyway.
   ============================================================================ */
import { accessor, nodeIndex, sampleTrack, quatSlerp } from './glb-read.mjs';

export const mul4 = (a, b) => {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
};
export const trsMat = (t, q, s) => {
  const [X, Y, Z, W] = q, x2 = X + X, y2 = Y + Y, z2 = Z + Z;
  const sc = s || [1, 1, 1];
  return [
    (1 - (Y * y2 + Z * z2)) * sc[0], (X * y2 + W * z2) * sc[0], (X * z2 - W * y2) * sc[0], 0,
    (X * y2 - W * z2) * sc[1], (1 - (X * x2 + Z * z2)) * sc[1], (Y * z2 + W * x2) * sc[1], 0,
    (X * z2 + W * y2) * sc[2], (Y * z2 - W * x2) * sc[2], (1 - (X * x2 + Y * y2)) * sc[2], 0,
    t[0], t[1], t[2], 1];
};
export const xf4 = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

/* Everything a caller needs to pose and skin one document. */
export function skinnedRig(g) {
  const J = g.json;
  const { nodes, parent, byName } = nodeIndex(g);
  if (!J.skins || !J.skins.length) throw new Error('not a skinned model');
  const skin = J.skins[0];
  const IBM = accessor(g, skin.inverseBindMatrices);
  const jointOfNode = new Map(skin.joints.map((n, j) => [n, j]));

  const verts = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.mesh == null || n.skin == null) continue;
    for (const prim of J.meshes[n.mesh].primitives) {
      if (prim.attributes.JOINTS_0 == null) continue;
      const P = accessor(g, prim.attributes.POSITION);
      const JO = accessor(g, prim.attributes.JOINTS_0);
      const WE = accessor(g, prim.attributes.WEIGHTS_0);
      const sc = WE instanceof Float32Array ? 1 : 1 / (WE instanceof Uint8Array ? 255 : 65535);
      for (let v = 0; v < P.length / 3; v++) {
        verts.push({
          p: [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]],
          j: [JO[v * 4], JO[v * 4 + 1], JO[v * 4 + 2], JO[v * 4 + 3]],
          w: [WE[v * 4] * sc, WE[v * 4 + 1] * sc, WE[v * 4 + 2] * sc, WE[v * 4 + 3] * sc]
        });
      }
    }
  }

  const rest = nodes.map(n => ({
    t: (n.translation || [0, 0, 0]).slice(),
    q: (n.rotation || [0, 0, 0, 1]).slice(),
    s: (n.scale || [1, 1, 1]).slice()
  }));

  const api = {
    json: J, nodes, parent, byName, skin, verts, rest,

    /* Local TRS with one clip applied at time t. */
    localsOf(clip, t) {
      const L = rest.map(r => ({ t: r.t.slice(), q: r.q.slice(), s: r.s }));
      for (const tr of clip.tracks) {
        const v = sampleTrack(tr.times, tr.values, t, tr.path === 'rotation');
        if (tr.path === 'rotation') L[tr.node].q = v;
        else if (tr.path === 'translation') L[tr.node].t = v;
      }
      return L;
    },
    /* And with two, mixed exactly the way the AnimationMixer will. */
    localsMixed(a, ta, b, tb, w) {
      const A = api.localsOf(a, ta), B = api.localsOf(b, tb);
      return A.map((la, i) => ({
        t: la.t.map((v, k) => v + (B[i].t[k] - v) * w),
        q: quatSlerp(la.q, B[i].q, w),
        s: la.s
      }));
    },
    jointMats(local) {
      const W = new Array(nodes.length).fill(null);
      const solve = i => {
        if (W[i]) return W[i];
        const m = trsMat(local[i].t, local[i].q, local[i].s);
        W[i] = parent[i] >= 0 ? mul4(solve(parent[i]), m) : m;
        return W[i];
      };
      return skin.joints.map((n, j) => mul4(solve(n), Array.from(IBM.subarray(j * 16, j * 16 + 16))));
    },
    point(JM, v) {
      const o = [0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const w = v.w[k];
        if (!w) continue;
        const q = xf4(JM[v.j[k]], v.p);
        o[0] += w * q[0]; o[1] += w * q[1]; o[2] += w * q[2];
      }
      return o;
    },

    /* Which joints belong to a foot: the named ones and everything hanging off
       them, so a rig with heel and ball helpers is included without naming
       them one by one. */
    footJoints(side) {
      const seed = ['Foot_' + side, 'Toe_' + side].map(n => byName[n]).filter(n => n != null);
      if (!seed.length) return null;
      const set = new Set();
      const walk = i => { set.add(i); for (const c of nodes[i].children || []) walk(c); };
      seed.forEach(walk);
      return new Set([...set].map(i => jointOfNode.get(i)).filter(j => j != null));
    },

    /* THE SOLE IS THREE POINTS, TAKEN FROM THE MESH.

       `rig-def.mjs` declares three for the game's own rig — heel, ball, tip —
       and every ground solve in the repo takes the lowest of them. A bought
       character has no such table, so the same three are DERIVED: the vertices
       each foot owns, the lowest `band` metres of them at bind, split fore-and-
       aft into thirds, one centroid each.

       Not "all the low vertices". Ochi's boot has a score of separate cleat
       studs along its sole, and tracking whichever happens to be lowest hops
       between studs from frame to frame — which is motion the foot is not
       making. It read as a walk whose stance sweep varied by 63% and came out
       a quarter slow. Three centroids are stable, they roll heel-to-toe the
       way a foot does, and they are the same three the rest of this repo
       already reasons about. */
    soles({ band = 0.03 } = {}) {
      const restJM = api.jointMats(rest);
      const out = {};
      for (const side of ['L', 'R']) {
        const fj = api.footJoints(side);
        if (!fj) continue;
        const owned = [];
        for (const v of verts) {
          let w = 0;
          for (let k = 0; k < 4; k++) if (fj.has(v.j[k])) w += v.w[k];
          if (w >= 0.5) owned.push({ v, p: api.point(restJM, v) });
        }
        if (!owned.length) continue;
        const floor = Math.min(...owned.map(o => o.p[1]));
        const low = owned.filter(o => o.p[1] <= floor + band);
        if (!low.length) continue;
        const z0 = Math.min(...low.map(o => o.p[2])), z1 = Math.max(...low.map(o => o.p[2]));
        const span = (z1 - z0) || 1;
        const bins = [[], [], []];
        for (const o of low) bins[Math.min(2, Math.floor(((o.p[2] - z0) / span) * 3))].push(o.v);
        /* A bin can come up empty on a short foot; the ones that do not are
           still three points' worth of roll. */
        out[side] = bins.filter(b => b.length).map(b => ({ group: b }));
      }
      return out;
    },

    /* Where each of a foot's sole points is in one pose, lowest first is NOT
       guaranteed — callers take the min, because which point is lowest changes
       as the foot rolls and that is the whole reason there are three. */
    solePoints(JM, soles, side) {
      return soles[side].map(g => {
        const o = [0, 0, 0];
        for (const v of g.group) { const p = api.point(JM, v); o[0] += p[0]; o[1] += p[1]; o[2] += p[2]; }
        return [o[0] / g.group.length, o[1] / g.group.length, o[2] / g.group.length];
      });
    },
    soleFloor(JM, soles) {
      const o = {};
      for (const side in soles) {
        const pts = api.solePoints(JM, soles, side);
        let lo = pts[0];
        for (const p of pts) if (p[1] < lo[1]) lo = p;
        o[side] = { y: lo[1], p: lo };
      }
      return o;
    }
  };
  return api;
}
