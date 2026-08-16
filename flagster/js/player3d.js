/* ============================================================================
   FLAGSTER — PLAYER 3D  (shared rigged model + animation system)

   A realistic-ish articulated football player built from a NAMED bone
   hierarchy (pelvis→spine→chest→neck/head, shoulders→upper/fore-arm→hand,
   hips→thigh→shin→foot), driven by a Three.js AnimationMixer playing authored
   AnimationClips (per-bone QuaternionKeyframeTracks), with crossfaded actions.

   This is the "model the animations and load them" layer used by BOTH the menu
   hero (hero3d.js) and the in-game field (field3d.js).

   Usage:
     var P = FLAGSTER.Player3D.build(THREE, {
       jersey: '#d80621', trim: '#ffdf00', skin: '#e8b98f',
       number: 7, name: 'RIVERA'
     });
     scene.add(P.root);
     P.play('run');            // crossfade into the run cycle
     P.setSpeed(1.4);          // scale run cadence
     ... each frame ...
     P.face(yawRadians, dt);   // smooth turn toward a heading
     P.update(dt);             // advances the mixer
   ============================================================================ */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ utils */

  /* THE FALLBACK HALF OF THE LOCOMOTION CONTRACT.

     field3d drives every moving player through P.gait(kind, speed) — see the
     blend space in playermodel.js, which picks the two authored strides that
     bracket that speed and blends them so stride LENGTH changes as well as
     cadence. Neither rig in this file has a ladder to blend: the procedural one
     has a single run and a single walk, and the external-model path has
     whatever the .glb happened to ship.

     So they get the old behaviour behind the new call — one clip chosen by
     speed, playback rate carrying the rest — rather than a missing method that
     would leave a moving player standing in an idle pose. Neither of these
     paths is normally reached (the rigged flagplayer.glb is the one the game
     ships); they are what a failed asset load falls back to. */
  function gaitShim(api, natural) {
    api._buildScale = 1;
    api.setBuildScale = function (k) { api._buildScale = (k > 0 ? k : 1); };
    api.setPhaseOffset = function () {};        // no shared phase to offset
    api.gaitInfo = function () { return null; };
    api.gait = function (kind, speed) {
      var nm = kind === 'backward' ? 'backpedal' : (speed < 2.4 ? 'walk' : 'run');
      api.play(nm);
      var m = (speed || 0) / (natural[nm] * api._buildScale);
      api.setSpeed(m < 0.5 ? 0.5 : m > 2.4 ? 2.4 : m);
    };
  }

  function q(THREE, rx, ry, rz) {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0));
  }
  // Build a QuaternionKeyframeTrack for "<node>.quaternion" from euler keyframes.
  function qtrack(THREE, node, times, eulers) {
    var vals = [];
    for (var i = 0; i < eulers.length; i++) {
      var e = eulers[i];
      var qq = q(THREE, e[0], e[1], e[2]);
      vals.push(qq.x, qq.y, qq.z, qq.w);
    }
    return new THREE.QuaternionKeyframeTrack(node + '.quaternion', times, vals);
  }
  function vtrack(THREE, node, times, vecs) {
    var vals = [];
    for (var i = 0; i < vecs.length; i++) vals.push(vecs[i][0], vecs[i][1], vecs[i][2]);
    return new THREE.VectorKeyframeTrack(node + '.position', times, vals);
  }

  /* --------------------------------------------------------------- geometry */
  // A tapered limb segment (capsule-ish: cylinder + rounded ends) that hangs
  // DOWN from its pivot (origin at the top joint), so a parent rotation swings
  // it about that joint. length along -Y.
  function segment(THREE, mat, len, rTop, rBot) {
    var g = new THREE.Group();
    var cyl = new THREE.Mesh(new THREE.CylinderGeometry(rBot, rTop, len, 12), mat);
    cyl.position.y = -len / 2;
    g.add(cyl);
    var cap = new THREE.Mesh(new THREE.SphereGeometry(rTop, 12, 10), mat);
    g.add(cap);                                  // shoulder/hip cap
    var capB = new THREE.Mesh(new THREE.SphereGeometry(rBot, 12, 10), mat);
    capB.position.y = -len; g.add(capB);         // elbow/knee cap
    return g;
  }

  function mkMat(THREE, hex, opts) {
    opts = opts || {};
    var m = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: opts.rough != null ? opts.rough : 0.85, metalness: 0.0 });
    return m;
  }

  function nameplate(THREE, name) {
    var c = document.createElement('canvas'); c.width = 256; c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(x, 8, 12, 240, 40, 10); x.fill();
    x.font = 'bold 30px system-ui, sans-serif'; x.fillStyle = '#fff';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText((name || '').toUpperCase(), 128, 34);
    var tex = new THREE.CanvasTexture(c);
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(1.9, 0.48, 1); spr.position.set(0, 3.05, 0);
    spr.renderOrder = 10;
    return spr;
  }
  function roundRect(x, rx, ry, w, h, r) {
    x.beginPath(); x.moveTo(rx + r, ry);
    x.arcTo(rx + w, ry, rx + w, ry + h, r); x.arcTo(rx + w, ry + h, rx, ry + h, r);
    x.arcTo(rx, ry + h, rx, ry, r); x.arcTo(rx, ry, rx + w, ry, r); x.closePath();
  }

  /* ------------------------------------------------------------ build model */
  // Returns { root, nodes } where nodes are the named, animatable pivots.
  function buildRig(THREE, opts) {
    var jerseyMat = mkMat(THREE, opts.jersey || '#2b5cff');
    var trimMat   = mkMat(THREE, opts.trim || '#ffffff');
    var skinMat   = mkMat(THREE, opts.skin || '#e8b98f', { rough: 0.7 });
    var shortMat  = mkMat(THREE, '#20304a', { rough: 0.9 });
    var sockMat   = mkMat(THREE, '#f2f2f2', { rough: 0.9 });
    var shoeMat   = mkMat(THREE, '#141414', { rough: 0.6 });
    var hairMat   = mkMat(THREE, opts.hair || '#241a12', { rough: 0.9 });

    var root = new THREE.Group(); root.name = 'root';
    var nodes = {};
    function node(name, parent, x, y, z) {
      var g = new THREE.Group(); g.name = name;
      g.position.set(x || 0, y || 0, z || 0);
      parent.add(g); nodes[name] = g; return g;
    }

    // Forward convention: the model faces local +Z, with shoulders spanning X.
    // This matters: limb segments hang along -Y, so their animated rotation.x
    // swings them through the SAGITTAL plane — real fore/aft stride and arm
    // swing. (Facing +X put that same rotation in the frontal plane, which made
    // arms and legs splay sideways.) api.face()/setYaw() map heading -> rotation.
    // --- pelvis / spine / chest ---
    var pelvis = node('pelvis', root, 0, 1.02, 0);
    var pelvisMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.34), jerseyMat); pelvis.add(pelvisMesh);
    var spine = node('spine', pelvis, 0, 0.18, 0);
    // abdomen bridges pelvis→chest so the torso reads as one continuous body
    var abdomenMesh = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.36, 0.36), jerseyMat);
    abdomenMesh.position.y = -0.02; spine.add(abdomenMesh);
    var chest = node('chest', spine, 0, 0.16, 0);
    // broader, athletic chest for a men's build
    var chestMesh = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.46), jerseyMat); chestMesh.position.y = 0.2; chest.add(chestMesh);
    var pecs = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.16, 0.44), jerseyMat); pecs.position.y = 0.3; chest.add(pecs);
    // shoulder trim / collar
    var yoke = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.12, 0.5), trimMat); yoke.position.y = 0.42; chest.add(yoke);
    // number on the chest
    chest.add(numberPlate(THREE, opts.number, opts.trim || '#fff', 0.3));

    // --- neck / head ---
    /* --- neck / head ---
       This is the no-Three.js-addons fallback: it must boot and it must accept
       the same appearance vocabulary as the rigged rig, so a caller never has
       to ask which one answered. It does NOT try to match it detail for
       detail — there is no face texture and no baked hair variants here, so
       skin, hair colour, how much hair, facial hair and the headband are the
       parts that carry across. */
    var neck = node('neck', chest, 0, 0.46, 0);
    var head = node('head', neck, 0, 0.12, 0);
    var headScale = opts.headScale || 1;
    head.scale.setScalar(headScale);
    var skull = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 14), skinMat); skull.position.y = 0.1; head.add(skull);
    // Hair volume follows the chosen style rather than one fixed skullcap.
    var HAIR_VOL = { buzz: 0.202, crop: 0.208, fade: 0.207, afro: 0.228, locs: 0.220, long: 0.216 };
    var HAIR_ARC = { buzz: 0.55, crop: 0.60, fade: 0.52, afro: 0.66, locs: 0.72, long: 0.74 };
    var hs = HAIR_VOL[opts.hairStyle] ? opts.hairStyle : 'crop';
    var hair = new THREE.Mesh(
      new THREE.SphereGeometry(HAIR_VOL[hs], 16, 12, 0, Math.PI * 2, 0, Math.PI * HAIR_ARC[hs]), hairMat);
    hair.position.y = 0.11; head.add(hair);
    var faceNub = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), skinMat); faceNub.position.set(0, 0.08, 0.18); head.add(faceNub); // nose = forward marker (+X)
    if (opts.facialHair) {
      var beard = new THREE.Mesh(
        new THREE.SphereGeometry(opts.facialHair === 'full' ? 0.185 : 0.13, 12, 10,
          0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), hairMat);
      beard.position.set(0, 0.10, opts.facialHair === 'full' ? 0.02 : 0.06);
      head.add(beard);
    }
    if (opts.headband) {
      var band = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.028, 8, 18), mkMat(THREE, opts.trim || '#ffffff', { rough: 0.7 }));
      band.rotation.x = Math.PI / 2; band.position.y = 0.05; head.add(band);
    }

    // --- arms (shoulder → upperArm → forearm → hand) ---
    function arm(side) {
      var s = side === 'L' ? 1 : -1;                        // shoulders span Z
      var sh = node('shoulder' + side, chest, s * 0.3, 0.38, 0.02);
      var delt = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), jerseyMat); sh.add(delt);  // deltoid cap → broad shoulders
      var up = node('upperArm' + side, sh, 0, 0, 0);
      up.add(segment(THREE, skinMat, 0.4, 0.09, 0.07));
      var sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.105, 0.2, 12), jerseyMat); sleeve.position.y = -0.09; up.add(sleeve); // short jersey sleeve
      var fore = node('forearm' + side, up, 0, -0.4, 0);
      fore.add(segment(THREE, skinMat, 0.38, 0.07, 0.055));
      var hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), skinMat); hand.position.y = -0.4; fore.add(hand);
      // resting pose: arms slightly out and elbow bent handled by clips
    }
    arm('L'); arm('R');

    // --- legs (hip → thigh → shin → foot) ---
    function leg(side) {
      var s = side === 'L' ? 1 : -1;
      var hip = node('hip' + side, pelvis, s * 0.14, -0.14, 0);
      var thigh = node('thigh' + side, hip, 0, 0, 0);
      thigh.add(segment(THREE, shortMat, 0.46, 0.13, 0.1));   // shorts over thigh
      var shin = node('shin' + side, thigh, 0, -0.46, 0);
      shin.add(segment(THREE, sockMat, 0.44, 0.09, 0.06));    // sock over shin
      var foot = node('foot' + side, shin, 0, -0.44, 0);
      var shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.28), shoeMat);
      shoe.position.set(0, -0.05, 0.08); foot.add(shoe);       // cleat points +Z (forward)
    }
    leg('L'); leg('R');

    // --- flag belt + hanging flags (the flag-football signature) ---
    var beltMat = mkMat(THREE, '#17171d', { rough: 0.7 });
    var belt = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.055, 8, 22), beltMat);
    belt.rotation.x = Math.PI / 2; belt.position.y = 0.03; pelvis.add(belt);
    function ribbon(side) {
      var s = side === 'L' ? 1 : -1;
      var g = new THREE.Group(); g.name = 'flag' + side;
      var m = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.42),
        new THREE.MeshStandardMaterial({ color: 0xffd23f, side: THREE.DoubleSide, roughness: 0.8 }));
      m.position.y = -0.21; g.add(m);
      g.position.set(s * 0.27, 0.03, -0.02); pelvis.add(g); nodes['flag' + side] = g;   // hang from the belt line
    }
    ribbon('L'); ribbon('R');

    root.add(nameplate(THREE, opts.name));
    return { root: root, nodes: nodes };
  }

  function numberPlate(THREE, num, color, size) {
    var c = document.createElement('canvas'); c.width = 64; c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = color; x.font = 'bold 46px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(String(num == null ? '' : num), 32, 34);
    var tex = new THREE.CanvasTexture(c);
    var m = new THREE.Mesh(new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    m.position.set(0, 0.22, 0.3);                              // face +Z (front)
    return m;
  }

  /* -------------------------------------------------------- animation clips */
  // Base "athletic ready" pose all clips lean on (radians). Arms bent ~90°,
  // knees soft, slight forward lean. Values are quaternion euler triples.
  function clips(THREE) {
    var C = [];
    function clip(name, dur, tracks, loop) {
      var cl = new THREE.AnimationClip(name, dur, tracks);
      cl.userData = { loop: loop };
      C.push(cl);
    }
    // helper shorthands
    var T = function (node, times, eulers) { return qtrack(THREE, node, times, eulers); };
    var P = function (node, times, vecs) { return vtrack(THREE, node, times, vecs); };

    // ---------- IDLE / READY (loop) ----------
    clip('idle', 2.4, [
      P('root', [0, 1.2, 2.4], [[0, 0, 0], [0, 0.03, 0], [0, 0, 0]]),
      T('spine', [0, 1.2, 2.4], [[0.12, 0, 0], [0.15, 0.02, 0], [0.12, 0, 0]]),
      T('chest', [0, 1.2, 2.4], [[0.06, 0, 0], [0.03, -0.02, 0], [0.06, 0, 0]]),
      T('head', [0, 1.2, 2.4], [[-0.06, 0, 0], [-0.04, 0.05, 0], [-0.06, 0, 0]]),
      // Relaxed: a light ~25 deg elbow bend and a little outward clearance,
      // with a slow breathing sway — not the rigid 60 deg tuck it had before.
      T('upperArmL', [0, 1.2, 2.4], [[0.1, 0, 0.16], [0.14, 0, 0.19], [0.1, 0, 0.16]]),
      T('forearmL', [0, 1.2, 2.4], [[0.42, 0, 0.05], [0.46, 0, 0.05], [0.42, 0, 0.05]]),
      T('upperArmR', [0, 1.2, 2.4], [[0.1, 0, -0.16], [0.14, 0, -0.19], [0.1, 0, -0.16]]),
      T('forearmR', [0, 1.2, 2.4], [[0.42, 0, -0.05], [0.46, 0, -0.05], [0.42, 0, -0.05]]),
      T('thighL', [0, 2.4], [[0.12, 0, 0.02], [0.12, 0, 0.02]]),
      T('shinL', [0, 2.4], [[-0.2, 0, 0], [-0.2, 0, 0]]),
      T('thighR', [0, 2.4], [[0.12, 0, -0.02], [0.12, 0, -0.02]]),
      T('shinR', [0, 2.4], [[-0.2, 0, 0], [-0.2, 0, 0]])
    ], true);

    // ---------- RUN (loop) ---------- contralateral drive, forward lean
    clip('run', 0.62, [
      P('root', [0, 0.155, 0.31, 0.465, 0.62], [[0, 0.06, 0], [0, 0.16, 0], [0, 0.06, 0], [0, 0.16, 0], [0, 0.06, 0]]),
      T('spine', [0, 0.62], [[0.34, 0, 0], [0.34, 0, 0]]),
      T('chest', [0, 0.31, 0.62], [[0.1, 0.12, 0], [0.1, -0.12, 0], [0.1, 0.12, 0]]),
      T('head', [0, 0.62], [[-0.28, 0, 0], [-0.28, 0, 0]]),
      // legs
      T('thighL', [0, 0.31, 0.62], [[0.95, 0, 0], [-0.7, 0, 0], [0.95, 0, 0]]),
      T('shinL',  [0, 0.155, 0.31, 0.62], [[-0.5, 0, 0], [-1.5, 0, 0], [-0.2, 0, 0], [-0.5, 0, 0]]),
      T('thighR', [0, 0.31, 0.62], [[-0.7, 0, 0], [0.95, 0, 0], [-0.7, 0, 0]]),
      T('shinR',  [0, 0.155, 0.31, 0.62], [[-0.2, 0, 0], [-0.5, 0, 0], [-1.5, 0, 0], [-0.2, 0, 0]]),
      T('footL', [0, 0.62], [[0.2, 0, 0], [0.2, 0, 0]]),
      T('footR', [0, 0.62], [[0.2, 0, 0], [0.2, 0, 0]]),
      // arms (bent ~90°, pump opposite the legs)
      // Sprinter's carry: elbows locked near 90 deg, hands driving from hip to
      // chest, shoulders slightly abducted so the forearms clear the ribs.
      T('upperArmL', [0, 0.31, 0.62], [[-0.75, 0, 0.22], [0.62, 0, 0.22], [-0.75, 0, 0.22]]),
      T('forearmL',  [0, 0.31, 0.62], [[1.32, 0, 0.08], [1.05, 0, 0.08], [1.32, 0, 0.08]]),
      T('upperArmR', [0, 0.31, 0.62], [[0.62, 0, -0.22], [-0.75, 0, -0.22], [0.62, 0, -0.22]]),
      T('forearmR',  [0, 0.31, 0.62], [[1.05, 0, -0.08], [1.32, 0, -0.08], [1.05, 0, -0.08]])
    ], true);

    // ---------- WALK (loop) ----------
    clip('walk', 1.0, [
      P('root', [0, 0.25, 0.5, 0.75, 1.0], [[0, 0.02, 0], [0, 0.06, 0], [0, 0.02, 0], [0, 0.06, 0], [0, 0.02, 0]]),
      T('spine', [0, 1.0], [[0.16, 0, 0], [0.16, 0, 0]]),
      T('thighL', [0, 0.5, 1.0], [[0.5, 0, 0], [-0.4, 0, 0], [0.5, 0, 0]]),
      T('shinL',  [0, 0.25, 0.5, 1.0], [[-0.3, 0, 0], [-0.8, 0, 0], [-0.15, 0, 0], [-0.3, 0, 0]]),
      T('thighR', [0, 0.5, 1.0], [[-0.4, 0, 0], [0.5, 0, 0], [-0.4, 0, 0]]),
      T('shinR',  [0, 0.25, 0.5, 1.0], [[-0.15, 0, 0], [-0.3, 0, 0], [-0.8, 0, 0], [-0.15, 0, 0]]),
      T('upperArmL', [0, 0.5, 1.0], [[-0.34, 0, 0.17], [0.34, 0, 0.17], [-0.34, 0, 0.17]]),
      T('forearmL',  [0, 0.5, 1.0], [[0.6, 0, 0.05], [0.42, 0, 0.05], [0.6, 0, 0.05]]),
      T('upperArmR', [0, 0.5, 1.0], [[0.34, 0, -0.17], [-0.34, 0, -0.17], [0.34, 0, -0.17]]),
      T('forearmR',  [0, 0.5, 1.0], [[0.42, 0, -0.05], [0.6, 0, -0.05], [0.42, 0, -0.05]])
    ], true);

    // ---------- BACKPEDAL (loop) ---------- hips low, weight back, quick steps
    clip('backpedal', 0.5, [
      P('root', [0, 0.25, 0.5], [[0, 0.02, 0], [0, 0.08, 0], [0, 0.02, 0]]),
      T('spine', [0, 0.5], [[-0.14, 0, 0], [-0.14, 0, 0]]),          // slight backward lean
      T('thighL', [0, 0.25, 0.5], [[0.5, 0, 0], [-0.15, 0, 0], [0.5, 0, 0]]),
      T('shinL',  [0, 0.25, 0.5], [[-0.9, 0, 0], [-0.4, 0, 0], [-0.9, 0, 0]]),
      T('thighR', [0, 0.25, 0.5], [[-0.15, 0, 0], [0.5, 0, 0], [-0.15, 0, 0]]),
      T('shinR',  [0, 0.25, 0.5], [[-0.4, 0, 0], [-0.9, 0, 0], [-0.4, 0, 0]]),
      T('upperArmL', [0, 0.25, 0.5], [[-0.2, 0, 0.34], [-0.05, 0, 0.34], [-0.2, 0, 0.34]]),
      T('forearmL',  [0, 0.5], [[1.15, 0, 0.12], [1.15, 0, 0.12]]),
      T('upperArmR', [0, 0.25, 0.5], [[-0.05, 0, -0.34], [-0.2, 0, -0.34], [-0.05, 0, -0.34]]),
      T('forearmR',  [0, 0.5], [[1.15, 0, -0.12], [1.15, 0, -0.12]])
    ], true);

    // ---------- THROW (once) ---------- windup → over-the-top release → follow
    clip('throw', 1.1, [
      T('spine', [0, 0.4, 0.62, 1.1], [[0.1, -0.5, 0], [0.1, -0.7, 0], [0.15, 0.5, 0], [0.1, 0.2, 0]]),
      T('chest', [0, 0.4, 0.62, 1.1], [[0, -0.3, 0], [0, -0.5, 0], [0, 0.4, 0], [0, 0.1, 0]]),
      // right arm cocks back then whips over the top
      T('upperArmR', [0, 0.4, 0.6, 0.75, 1.1], [[0.2, 0, -0.2], [-2.4, -0.3, -0.6], [-2.6, -0.2, -0.4], [-0.4, 0.3, 0.2], [0.2, 0, -0.15]]),
      T('forearmR',  [0, 0.4, 0.62, 0.78, 1.1], [[1.2, 0, 0], [2.0, 0, 0], [0.3, 0, 0], [0.9, 0, 0], [1.2, 0, 0]]),
      // left arm points to target then tucks
      T('upperArmL', [0, 0.45, 1.1], [[-1.0, 0, 0.2], [-1.1, 0, 0.3], [0.2, 0, 0.18]]),
      T('forearmL',  [0, 1.1], [[1.0, 0, 0], [1.0, 0, 0]]),
      // plant/stride
      T('thighL', [0, 0.5, 1.1], [[0.2, 0, 0], [0.5, 0, 0], [0.2, 0, 0]]),
      T('thighR', [0, 1.1], [[0.05, 0, 0], [0.05, 0, 0]]),
      T('shinL', [0, 1.1], [[-0.4, 0, 0], [-0.35, 0, 0]]),
      T('shinR', [0, 1.1], [[-0.35, 0, 0], [-0.35, 0, 0]])
    ], false);

    // ---------- CATCH (once) ---------- reach up/out then secure
    clip('catch', 0.9, [
      T('spine', [0, 0.4, 0.9], [[0.12, 0, 0], [0.25, 0, 0], [0.12, 0, 0]]),
      T('upperArmL', [0, 0.35, 0.9], [[0.2, 0, 0.18], [-2.3, 0, 0.2], [-0.6, 0, 0.2]]),
      T('forearmL',  [0, 0.35, 0.9], [[1.1, 0, 0], [0.3, 0, 0], [1.3, 0, 0]]),
      T('upperArmR', [0, 0.35, 0.9], [[0.2, 0, -0.18], [-2.3, 0, -0.2], [-0.6, 0, -0.2]]),
      T('forearmR',  [0, 0.35, 0.9], [[1.1, 0, 0], [0.3, 0, 0], [1.3, 0, 0]]),
      T('thighL', [0, 0.9], [[0.2, 0, 0], [0.2, 0, 0]]),
      T('thighR', [0, 0.9], [[0.2, 0, 0], [0.2, 0, 0]])
    ], false);

    // ---------- DIVE (once) ---------- launch forward, arms extended, gather
    clip('dive', 1.2, [
      P('root', [0, 0.35, 0.7, 1.2], [[0, 0.3, 0], [0, 0.9, 0], [0, 0.2, 0], [0, 0.05, 0]]),
      T('root', [0, 0.35, 0.7, 1.2], [[0, 0, 0], [-0.6, 0, 0], [-0.9, 0, 0], [-0.2, 0, 0]]),  // pitch forward (about Z after yaw) via root
      T('upperArmL', [0, 0.4, 1.2], [[0.2, 0, 0.18], [-2.6, 0, 0.15], [-2.2, 0, 0.15]]),
      T('forearmL',  [0, 1.2], [[0.5, 0, 0], [0.5, 0, 0]]),
      T('upperArmR', [0, 0.4, 1.2], [[0.2, 0, -0.18], [-2.6, 0, -0.15], [-2.2, 0, -0.15]]),
      T('forearmR',  [0, 1.2], [[0.5, 0, 0], [0.5, 0, 0]]),
      T('thighL', [0, 0.4, 1.2], [[0.1, 0, 0], [-0.5, 0, 0], [0.4, 0, 0]]),
      T('thighR', [0, 0.4, 1.2], [[0.1, 0, 0], [-0.5, 0, 0], [0.4, 0, 0]]),
      T('shinL', [0, 1.2], [[-0.3, 0, 0], [-0.8, 0, 0]]),
      T('shinR', [0, 1.2], [[-0.3, 0, 0], [-0.8, 0, 0]])
    ], false);

    // ---------- FLAG PULL (once) ---------- lower hips, reach to hip, rip across
    clip('flagPull', 1.0, [
      P('root', [0, 0.4, 0.6, 1.0], [[0, 0, 0], [0, -0.12, 0], [0, -0.05, 0], [0, 0, 0]]),
      T('spine', [0, 0.4, 0.6, 1.0], [[0.15, 0, 0], [0.55, 0.1, 0], [0.4, -0.4, 0], [0.15, 0, 0]]),
      T('upperArmR', [0, 0.4, 0.6, 1.0], [[0.2, 0, -0.18], [1.5, 0, -0.5], [0.6, 0, 0.6], [-1.8, 0, -0.2]]), // reach down then rip up (celebrate)
      T('forearmR',  [0, 0.4, 0.6, 1.0], [[1.1, 0, 0], [0.4, 0, 0], [0.5, 0, 0], [1.2, 0, 0]]),
      T('upperArmL', [0, 1.0], [[0.3, 0, 0.2], [0.3, 0, 0.2]]),
      T('forearmL',  [0, 1.0], [[1.2, 0, 0], [1.2, 0, 0]]),
      T('thighL', [0, 0.5, 1.0], [[0.2, 0, 0], [0.6, 0, 0], [0.2, 0, 0]]),
      T('thighR', [0, 0.5, 1.0], [[0.2, 0, 0], [0.4, 0, 0], [0.2, 0, 0]]),
      T('shinL', [0, 1.0], [[-0.5, 0, 0], [-0.4, 0, 0]]),
      T('shinR', [0, 1.0], [[-0.5, 0, 0], [-0.4, 0, 0]])
    ], false);

    // ---------- CELEBRATE (loop) ---------- arms up, little hops
    clip('celebrate', 1.0, [
      P('root', [0, 0.25, 0.5, 0.75, 1.0], [[0, 0.05, 0], [0, 0.3, 0], [0, 0.05, 0], [0, 0.3, 0], [0, 0.05, 0]]),
      T('spine', [0, 0.5, 1.0], [[0.1, 0.15, 0], [0.1, -0.15, 0], [0.1, 0.15, 0]]),
      T('upperArmL', [0, 0.5, 1.0], [[-2.7, 0, 0.3], [-2.5, 0, 0.5], [-2.7, 0, 0.3]]),
      T('forearmL',  [0, 1.0], [[0.4, 0, 0], [0.4, 0, 0]]),
      T('upperArmR', [0, 0.5, 1.0], [[-2.7, 0, -0.3], [-2.5, 0, -0.5], [-2.7, 0, -0.3]]),
      T('forearmR',  [0, 1.0], [[0.4, 0, 0], [0.4, 0, 0]]),
      T('thighL', [0, 1.0], [[0.1, 0, 0], [0.1, 0, 0]]),
      T('thighR', [0, 1.0], [[0.1, 0, 0], [0.1, 0, 0]])
    ], true);

    // ---------- JUKE (once) ---------- plant + spin lean
    clip('juke', 0.8, [
      P('root', [0, 0.4, 0.8], [[0, 0.05, 0], [0, 0.18, 0], [0, 0.05, 0]]),
      T('spine', [0, 0.4, 0.8], [[0.3, 0, 0.3], [0.3, 0, -0.3], [0.3, 0, 0]]),
      T('thighL', [0, 0.4, 0.8], [[0.6, 0, 0], [-0.4, 0, 0], [0.6, 0, 0]]),
      T('thighR', [0, 0.4, 0.8], [[-0.4, 0, 0], [0.6, 0, 0], [-0.4, 0, 0]]),
      T('shinL', [0, 0.8], [[-0.6, 0, 0], [-0.6, 0, 0]]),
      T('shinR', [0, 0.8], [[-0.6, 0, 0], [-0.6, 0, 0]]),
      T('upperArmL', [0, 0.8], [[-0.5, 0, 0.4], [-0.5, 0, 0.4]]),
      T('forearmL', [0, 0.8], [[1.3, 0, 0], [1.3, 0, 0]]),
      T('upperArmR', [0, 0.8], [[0.5, 0, -0.4], [0.5, 0, -0.4]]),
      T('forearmR', [0, 0.8], [[1.3, 0, 0], [1.3, 0, 0]])
    ], false);

    return C;
  }

  /* ==================================================================== */
  /*  LOADED glTF MODEL PATH (real rigged character via GLTFLoader)         */
  /*  Loads a rigged humanoid once, then clones it per player (SkeletonUtils)*/
  /*  and drives its baked skeletal clips (idle/walk/run) with an           */
  /*  AnimationMixer — the "load a real model" realism path. Falls back to  */
  /*  the procedural rig above if the model/loader is unavailable.          */
  /* ==================================================================== */
  var MODEL = { ready: false, failed: false, scene: null, clips: null };
  // The plain loaded mannequin reads as a solid-color figure, not a flag-football
  // team, so it's OFF by default. The GLTFLoader pipeline stays ready for a proper
  // rigged football-player .glb — enable with FLAGSTER.Player3D.setUseModel(true).
  var USE_MODEL = false;
  // Resolve the .glb path relative to THIS script so it works from / and /flagster/.
  var MODEL_URL = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (!s) { var ss = document.getElementsByTagName('script'); for (var i = ss.length - 1; i >= 0; i--) { if (/player3d\.js/.test(ss[i].src)) { s = ss[i].src; break; } } }
      return s ? s.replace(/js\/player3d\.js.*$/, 'lib/player.glb') : null;
    } catch (e) { return null; }
  })();

  function preloadModel(THREE) {
    if (!THREE || !THREE.GLTFLoader || !THREE.SkeletonUtils || !MODEL_URL) { MODEL.failed = true; return; }
    try {
      new THREE.GLTFLoader().load(MODEL_URL,
        function (gltf) { MODEL.scene = gltf.scene; MODEL.clips = gltf.animations || []; MODEL.ready = true; },
        undefined,
        function () { MODEL.failed = true; });
    } catch (e) { MODEL.failed = true; }
  }

  function buildModelInstance(THREE, opts) {
    var clone = THREE.SkeletonUtils.clone(MODEL.scene);
    var jersey = new THREE.Color(opts.jersey || '#2b5cff');
    clone.traverse(function (o) {
      if (o.isMesh || o.isSkinnedMesh) {
        o.frustumCulled = false;
        if (o.material) {
          o.material = o.material.clone();               // per-instance so tint is unique
          if (o.material.color) o.material.color.copy(jersey);
          o.material.metalness = 0.0;
          if (o.material.roughness != null) o.material.roughness = 0.8;
        }
      }
    });
    // Orient forward = +X and scale to ~2.1u tall. NOTE: this Mixamo rig has an
    // Armature scale of 0.01, origin at the feet, ~1.8u tall, facing +Z. Skinned-
    // mesh bounding boxes are unreliable here, so use a fixed scale (not bbox).
    var facer = new THREE.Group();
    facer.add(clone);
    facer.scale.setScalar(1.15);                          // ~1.8u * 1.15 ≈ 2.1u
    facer.rotation.y = Math.PI / 2;                       // model faces +Z -> +X
    var root = new THREE.Group(); root.name = 'root';
    root.add(facer);
    var plate = nameplate(THREE, opts.name); plate.position.y = 2.55; root.add(plate);

    var mixer = new THREE.AnimationMixer(clone);
    var byName = {};
    (MODEL.clips || []).forEach(function (cl) { byName[cl.name.toLowerCase()] = cl; });
    function find() { for (var i = 0; i < arguments.length; i++) { var k = arguments[i]; for (var n in byName) { if (n.indexOf(k) >= 0) return byName[n]; } } return null; }
    var idleC = find('idle', 'stand', 'survey') || (MODEL.clips && MODEL.clips[0]);
    var runC = find('run') || idleC;
    var walkC = find('walk') || runC;
    function act(cl) { if (!cl) return null; var a = mixer.clipAction(cl); a.loop = THREE.LoopRepeat; return a; }
    var A = { idle: act(idleC), run: act(runC), walk: act(walkC) };
    var current = null;
    function crossto(a, fade) { if (!a) return; if (a === current) { if (!a.isRunning()) a.play(); return; } a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.play(); if (current) current.crossFadeTo(a, fade == null ? 0.25 : fade, false); current = a; }

    var api = { root: root, mixer: mixer, _yaw: 0, _speed: 1, _oneShot: null, isModel: true };
    api.play = function (name) {
      var a = (name === 'run') ? A.run
        : (name === 'walk' || name === 'backpedal') ? A.walk
        : A.idle;                                          // idle/celebrate/etc.
      crossto(a);
    };
    api.oneShot = function (name, returnTo) { if (returnTo) api.play(returnTo); };  // model has no football one-shots
    api.setSpeed = function (m) { api._speed = m; if (A.run) A.run.timeScale = m; if (A.walk) A.walk.timeScale = m; };
    gaitShim(api, { walk: 1.67, run: 5.78, backpedal: 3.10 });
    /* Turn rate must not depend on how long the frame took — easing by
       `dt * 9` catches up further on a long frame, so a hitching device turns
       the body in visible steps. `1 - exp(-9*dt)` is the same filter with the
       frame rate divided out (see ease() in field3d.js). */
    api.face = function (yaw, dt) { var d = yaw - api._yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; api._yaw += d * (1 - Math.exp(-9 * (dt || 0.016))); root.rotation.y = -api._yaw; };
    api.setYaw = function (yaw) { api._yaw = yaw; root.rotation.y = -yaw; };
    api.plate = plate;
    api.setPlateScale = function (k) { if (plate) plate.scale.set(1.9 * k, 0.48 * k, 1); };
    api.setPlateVisible = function (v) { if (plate) plate.visible = !!v; };
    api.update = function (dt) { mixer.update(dt); };
    api.dispose = function () {
      mixer.stopAllAction();
      // NOTE: geometry is shared across SkeletonUtils clones — dispose only the
      // per-instance materials/textures we created, never the shared geometry.
      root.traverse(function (o) {
        if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); }); }
      });
    };
    if (A.idle) { A.idle.play(); current = A.idle; }
    return api;
  }

  /* --------------------------------------------------------------- builder */
  function build(THREE, opts) {
    opts = opts || {};
    /* Prefer the purpose-built RIGGED football player (real skinned mesh,
       27-joint armature, per-region team tinting) once it has loaded. It
       exposes the same API, so every call site is unchanged. We normalise its
       height to the procedural rig's (2.385u) so the scales callers already
       apply keep landing at ~6'2". Falls back silently if it isn't ready. */
    var PM = global.FLAGSTER && global.FLAGSTER.PlayerModel;
    if (PM && PM.isReady && PM.isReady()) {
      try {
        return PM.build(THREE, {
          jersey: opts.jersey, trim: opts.trim, skin: opts.skin, hair: opts.hair,
          number: opts.number, name: opts.name,
          // Appearance: forwarded verbatim, so a caller only ever has to know
          // one vocabulary whichever rig ends up answering.
          hairStyle: opts.hairStyle, facialHair: opts.facialHair,
          headband: opts.headband, headScale: opts.headScale,
          gender: opts.gender, face: opts.face,
          scale: 2.385 / 1.850      // metres -> match the procedural rig's height
        });
      } catch (e) { /* fall through to the procedural rig */ }
    }

    // Prefer a real loaded model only when explicitly enabled AND ready.
    if (USE_MODEL && MODEL.ready && THREE.SkeletonUtils && MODEL.scene) {
      try { return buildModelInstance(THREE, opts); } catch (e) { /* fall back below */ }
    }
    var rig = buildRig(THREE, opts);
    var root = rig.root;
    // The nameplate sprite (added by buildRig) — kept so scenes can size/hide it.
    var plateSprite = null;
    for (var pi = 0; pi < root.children.length; pi++) {
      if (root.children[pi].isSprite) { plateSprite = root.children[pi]; break; }
    }

    var mixer = new THREE.AnimationMixer(root);
    var clipList = clips(THREE);
    var actions = {};
    clipList.forEach(function (cl) {
      var a = mixer.clipAction(cl);
      if (cl.userData.loop) { a.loop = THREE.LoopRepeat; }
      else { a.loop = THREE.LoopOnce; a.clampWhenFinished = true; }
      actions[cl.name] = a;
    });

    var current = null;
    var api = {
      root: root,
      nodes: rig.nodes,
      mixer: mixer,
      actions: actions,
      _yaw: 0,
      _speed: 1,
      _oneShot: null,
      _returnTo: 'idle'
    };

    api.play = function (name, fade) {
      if (!actions[name]) return;
      if (current === actions[name] && actions[name].loop === THREE.LoopRepeat) return;
      var next = actions[name];
      next.reset();
      next.enabled = true; next.setEffectiveWeight(1);
      if (current && current !== next) {
        next.play();
        current.crossFadeTo(next, fade == null ? 0.22 : fade, false);
      } else {
        next.play();
      }
      current = next;
    };

    // Play a one-shot then automatically crossfade back to a base loop.
    /* The rigged model draws a distinction the procedural rig doesn't have:
       'flagGrab' is the DEFENDER ripping the flag off, 'flagPulled' is the
       carrier's reaction. This rig has one clip for the whole event, so both
       names resolve to it rather than silently playing nothing. */
    var CLIP_ALIAS = { flagGrab: 'flagPull', flagPulled: 'flagPull' };
    api.oneShot = function (name, returnTo, fade) {
      name = (!actions[name] && CLIP_ALIAS[name]) ? CLIP_ALIAS[name] : name;
      if (!actions[name]) return;
      api._returnTo = returnTo || 'idle';
      var a = actions[name];
      a.reset(); a.enabled = true; a.setEffectiveWeight(1);
      a.timeScale = 1;
      if (current && current !== a) { a.play(); current.crossFadeTo(a, fade == null ? 0.15 : fade, false); }
      else a.play();
      current = a; api._oneShot = a;
    };

    api.setSpeed = function (mult) {           // scale run/walk cadence
      api._speed = mult;
      if (actions.run) actions.run.timeScale = mult;
      if (actions.walk) actions.walk.timeScale = mult;
      if (actions.backpedal) actions.backpedal.timeScale = mult;
    };
    gaitShim(api, { walk: 1.67, run: 5.78, backpedal: 3.10 });

    // Smoothly steer the whole body's facing toward a heading (radians).
    api.face = function (yaw, dt) {
      var diff = yaw - api._yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      api._yaw += diff * (1 - Math.exp(-9 * (dt || 0.016)));   // frame-rate independent, as above
      root.rotation.y = Math.PI / 2 - api._yaw;   // rig forward = +Z
    };
    api.setYaw = function (yaw) { api._yaw = yaw; root.rotation.y = Math.PI / 2 - yaw; };

    // Nameplate controls — broadcast views want small tags on key players only.
    api.plate = plateSprite;
    api.setPlateScale = function (k) { if (plateSprite) plateSprite.scale.set(1.9 * k, 0.48 * k, 1); };
    api.setPlateVisible = function (v) { if (plateSprite) plateSprite.visible = !!v; };

    api.update = function (dt) {
      mixer.update(dt);
      // auto-return from a finished one-shot
      if (api._oneShot && !api._oneShot.isRunning() && api._oneShot.loop === THREE.LoopOnce) {
        var back = actions[api._returnTo] || actions.idle;
        if (back) { back.reset(); back.enabled = true; back.setEffectiveWeight(1); back.play(); api._oneShot.crossFadeTo(back, 0.25, false); current = back; }
        api._oneShot = null;
      }
    };

    api.dispose = function () {
      mixer.stopAllAction();
      root.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); }); }
      });
    };

    // start in idle
    actions.idle.play(); current = actions.idle;
    return api;
  }

  // Only fetch the ~2.8 MB model if the loaded-model path is enabled.
  if (USE_MODEL) preloadModel(global.THREE);

  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.Player3D = {
    build: build, buildRig: buildRig, clips: clips, model: MODEL,
    setUseModel: function (on) { USE_MODEL = !!on; if (USE_MODEL && !MODEL.ready && !MODEL.failed) preloadModel(global.THREE); }
  };
})(window);
