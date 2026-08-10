/* ============================================================================
   FLAGSTER — FIELD 3D  (Three.js)
   A delightful top-down 3D renderer for LIVE 5v5 gameplay. It is driven
   entirely by the existing simulation: mount(canvas, engine) returns an
   object whose render(state) is called once per engine frame. It reads
   engine.state (players, ball, losX, jerseys, phase, ...) and draws a tilted
   top-down field with low-poly players, a football, and a camera that gently
   follows the action.

   This module NEVER touches game logic. If THREE or WebGL is unavailable,
   mount() returns null and the caller falls back to the 2D canvas renderer.
   ============================================================================ */
(function (global) {
  'use strict';

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // Interpolate an angle along the shortest path (radians).
  function lerpAngle(a, b, t) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // Field constants (yards) — mirror engine.js
  var F = (global.FLAGSTER && global.FLAGSTER.Engine && global.FLAGSTER.Engine.FIELD) ||
          { LEN: 70, WID: 25, EZ: 10, GOAL_L: 10, GOAL_R: 60, MID: 35 };
  var LEN = F.LEN, WID = F.WID, EZ = F.EZ, GOAL_L = F.GOAL_L, GOAL_R = F.GOAL_R, MID = F.MID;

  /* Face where you're going — or where you're coming FROM. Never square across it.

     The rig's legs swing in the sagittal plane: fore and aft, along whatever
     way the body is pointing. That covers running forward and it covers
     backpedalling, which is why there's a Backpedal clip. What it cannot cover
     is travelling SIDEWAYS, because then the legs pump fore/aft while the body
     slides across — both legs drifting laterally together, which is exactly
     what a skater looks like and nothing like football.

     The old rule was a single cone that widened as you slowed: `PI*(1-t) +
     slack*t` with t reaching 1 only at 6yd/s, and slack as loose as 1.15rad.
     A defender at a 3yd/s jog was therefore allowed 135 degrees off their line
     of travel, and at a sprint still 66 — where sin(66) = 0.91, so nine tenths
     of the motion was sideways to the stride. Measured across every play and
     coverage, 29% of moving samples sat at 45 degrees or worse.

     So permit two bands and forbid what's between them: close to the line of
     travel (run), or close to its reverse (backpedal). A facing that wants to
     sit across the line gets pushed to whichever edge is nearer, which turns
     the player's hips into the run instead of skating them across it. */
  var BACK_SLACK = 0.62;                 // radians either side of straight back
  function alongMotion(yawWant, vx, vy, speed, slack) {
    if (speed <= 0.8) return yawWant;    // standing still: look wherever you like
    var yawMove = Math.atan2(vy, vx);
    var d = yawWant - yawMove;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    /* Reaches full strictness almost as soon as they're moving. It only has
       to be gradual enough not to snap, and it doesn't even need that much:
       this constrains the TARGET yaw and P.face() eases toward it, so the
       easing absorbs the step. Below ~1yd/s the renderer plays idle anyway,
       so there is no stride to disagree with. */
    var t = clamp((speed - 0.8) / 0.5, 0, 1);
    var fwd = Math.PI * (1 - t) + slack * t;
    var back = Math.PI * (1 - t) + BACK_SLACK * t;
    var sgn = d < 0 ? -1 : 1, a = Math.abs(d);
    if (a <= fwd) return yawWant;                       // running into it
    if (a >= Math.PI - back) return yawWant;            // backpedalling out of it
    var toFwd = a - fwd, toBack = (Math.PI - back) - a; // stuck across it: pick a side
    return yawMove + sgn * (toFwd <= toBack ? fwd : Math.PI - back);
  }

  // Field(yards) -> world(units). Field centered on origin, ground plane y=0.
  function wx(fx) { return fx - LEN / 2; }   // -35 .. +35   (offense attacks +x)
  function wz(fy) { return fy - WID / 2; }   // -12.5 .. +12.5

  function toColor(THREE, hex) { try { return new THREE.Color(hex); } catch (e) { return new THREE.Color(0x888888); } }

  /* =============================== MOUNT ================================= */
  function mount(canvas, engine) {
    if (!global.THREE || !canvas) return null;
    if (!global.FLAGSTER || !global.FLAGSTER.Player3D) return null;  // need rigged model
    var THREE = global.THREE;
    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
      // If the context could not be created, bail to 2D fallback.
      if (!renderer.getContext || !renderer.getContext()) { renderer.dispose && renderer.dispose(); return null; }
    } catch (e) {
      return null;
    }
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x86b6de, 1);          // sky, never a black void
    // Broadcast-quality output: soft shadows, filmic tone mapping, sRGB.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Colour space: modern Three uses `outputColorSpace`; r1xx used `outputEncoding`.
    if (THREE.SRGBColorSpace !== undefined && 'outputColorSpace' in renderer) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else if (THREE.sRGBEncoding !== undefined) {
      renderer.outputEncoding = THREE.sRGBEncoding;
    }
    if (THREE.ACESFilmicToneMapping !== undefined) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.02;
    }

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x9fc4e4, 150, 420);   // haze toward the sky, not black

    // Wide-ish lens: looking down the field end-on, a wide FOV spreads the near
    // yardage across the screen and lets the far end zone converge — the
    // dramatic Madden perspective, instead of a flat telephoto strip.
    var camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1200);

    // ---- Lights (stadium daylight) ----
    // NOTE: r155+ uses physically-correct light units — intensities that looked
    // right on r128 render ~PI times too dark, so these are scaled accordingly.
    scene.add(new THREE.HemisphereLight(0xe8f4ff, 0x5d8a52, 2.05));
    var sun = new THREE.DirectionalLight(0xfff6e6, 2.70);
    sun.position.set(-40, 82, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.left = -46; sun.shadow.camera.right = 46;
    sun.shadow.camera.top = 46; sun.shadow.camera.bottom = -46;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    scene.add(sun.target);
    var fill = new THREE.DirectionalLight(0xbfd8ff, 0.55);
    fill.position.set(30, 40, -30);
    scene.add(fill);

    // Jersey colors from the current game.
    var st0 = engine && engine.state ? engine.state : {};
    var homeCols = (st0.homeJersey && st0.homeJersey.colors) || ['#2b5cff', '#ffffff'];
    var awayCols = (st0.awayJersey && st0.awayJersey.colors) || ['#d80621', '#ffffff'];

    // ---- Stadium + field ----------------------------------------------------
    // A full stadium (sky, stands, crowd, lights) plus a broadcast-quality turf
    // with yard numbers, hash marks and lettered end zones. Falls back to the
    // simple grass/end-zone primitives if the stadium module isn't present.
    var STADIUM = global.FLAGSTER && global.FLAGSTER.Stadium3D;
    var stadiumGroup = null;
    var turfOpts = {
      awayColor: awayCols[0], homeColor: homeCols[0],
      awayName: (st0.away && (st0.away.name || st0.away.id)) || '',
      homeName: (st0.home && (st0.home.name || st0.home.id)) || ''
    };
    if (STADIUM) {
      try {
        stadiumGroup = STADIUM.build(THREE, turfOpts);
        if (stadiumGroup) scene.add(stadiumGroup);
        var turf = STADIUM.makeTurf(THREE, turfOpts);
        if (turf) { turf.receiveShadow = true; scene.add(turf); }
      } catch (e) { stadiumGroup = null; }
    }
    if (!stadiumGroup) {
      scene.add(makeGrass(THREE));
      scene.add(makeEndZone(THREE, awayCols[0], -30));
      scene.add(makeEndZone(THREE, homeCols[0], 30));
    }

    /* E3 — the field had no ball spot and no down marker: two of the things
       you would see in any photograph of a game. Cheap, and they make the
       yardage legible. */
    var spotMark = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.42, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false }));
    spotMark.rotation.x = -Math.PI / 2; spotMark.position.y = 0.03;
    spotMark.visible = false; scene.add(spotMark);

    var downMark = new THREE.Group();
    (function () {
      var post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.7, 8),
        new THREE.MeshLambertMaterial({ color: 0xd8d8d8 }));
      post.position.y = 0.85;
      var board = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.62, 0.07),
        new THREE.MeshLambertMaterial({ color: 0xff8c1a }));
      board.position.y = 1.85;
      downMark.add(post); downMark.add(board);
      downMark.visible = false;
      scene.add(downMark);
    })();

    // Dynamic markers: line of scrimmage (blue), line-to-gain (yellow)
    var losLine = makeYardMarker(THREE, 0x3c82ff);
    var ltgLine = makeYardMarker(THREE, 0xffdc28);
    losLine.visible = false; ltgLine.visible = false;
    scene.add(losLine); scene.add(ltgLine);

    var PLAYER_SCALE = 0.87;   // players render at 0.87 of the rig's authored height

    // Football
    var ball = makeBall(THREE);
    ball.visible = false;
    scene.add(ball);

    /* C3 — the ball's shadow. Players cast one and the ball did not, and a
       ball in flight over flat green with nothing under it is genuinely hard
       to judge. This is a painted blob rather than a real shadow caster: it
       costs nothing, and it works from any camera angle. */
    var ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.16, 16),
      new THREE.MeshBasicMaterial({ color: 0x0d2b12, transparent: true, opacity: 0.34, depthWrite: false })
    );
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.renderOrder = 2;
    ballShadow.visible = false;
    scene.add(ballShadow);

    /* The ball is one shared mesh, re-parented to whoever has it. Anything
       under a player inherits the 0.87 the renderer scales them by, so the
       ball is scaled back up to keep the regulation size it is drawn at. */
    var ballHost = null;
    var spin = 0;
    var GRAV_R = 10.73;      // mirrors engine.js GRAVITY, for the nose angle

    /* THE BALL NEVER CUTS FROM ONE PAIR OF HANDS TO THE NEXT.

       Possession changes in the engine are instantaneous — a hand-off swaps a
       flag on two players, and a catch moves the ball to the receiver's own
       coordinates, which can be a couple of yards from where it arrived. The
       renderer used to follow that literally, so the ball teleported on every
       exchange.

       Rather than special-case each one, this tweens on the only thing they
       have in common: the ball changing host. The old grip is remembered in
       the OLD host's local space, not as a frozen world point, so a hand-off
       leaves a quarterback's hands that are themselves still moving. */
    var XFER = 0.16;                     // seconds for an exchange to complete
    var xfer = { t: 0, dur: 0, node: null, local: new THREE.Vector3(), world: new THREE.Vector3() };
    var xferPending = false;
    var _wp = new THREE.Vector3(), _from = new THREE.Vector3();

    function hostBall(node) {
      if (ballHost === node) return;
      // Remember where the ball is right now, so the new grip can be reached
      // from here instead of jumped to.
      ball.updateWorldMatrix(true, false);
      xfer.world.setFromMatrixPosition(ball.matrixWorld);
      xfer.node = ballHost;
      if (ballHost) { xfer.local.copy(xfer.world); ballHost.worldToLocal(xfer.local); }
      xferPending = true;
      if (node) node.add(ball); else scene.add(ball);
      /* Undo whatever the host is scaled by, so the ball stays regulation size
         in the world. Players are no longer uniformly scaled (E1), so this has
         to read the actual world scale rather than assume PLAYER_SCALE. */
      if (node) {
        node.updateWorldMatrix(true, false);
        var ws = new THREE.Vector3();
        node.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), ws);
        ball.scale.set(1 / (ws.x || 1), 1 / (ws.y || 1), 1 / (ws.z || 1));
      } else {
        ball.scale.setScalar(1);
      }
      ballHost = node;
    }
    /* Blend the ball from the grip it just left to the one it has now. Runs
       after the frame has placed the ball wherever it belongs, and rewrites
       that placement for the length of the exchange.

       Nothing tweens a pass: a throw is a real flight solved by the engine and
       must not be slowed by a quarter of a second of easing at the front of
       it. A new down doesn't tween either — that is the ball being spotted,
       not passed. */
    function applyTransfer(state, dt) {
      var live = (state.phase === 'live') && !(state.ball && state.ball.inAir);
      if (xferPending) { xferPending = false; xfer.t = 0; xfer.dur = live ? XFER : 0; }
      if (xfer.dur <= 0) return;
      if (!live) { xfer.dur = 0; return; }
      xfer.t += dt;
      var k = xfer.t / xfer.dur;
      if (k >= 1) { xfer.dur = 0; return; }
      // Where the ball would be this frame, in the world.
      ball.updateWorldMatrix(true, false);
      _wp.setFromMatrixPosition(ball.matrixWorld);
      // Where it came from — still tracking the old holder if they're moving.
      if (xfer.node && xfer.node.parent) {
        _from.copy(xfer.local); xfer.node.localToWorld(_from);
      } else {
        _from.copy(xfer.world);
      }
      var e = k * k * (3 - 2 * k);                 // smoothstep: ease both ends
      _from.lerp(_wp, e);
      if (ball.parent) { ball.parent.updateWorldMatrix(true, false); ball.parent.worldToLocal(_from); }
      ball.position.copy(_from);
    }

    // A named bone or socket on the player holding the ball, if the rigged
    // model is the one in play (the procedural fallback has neither).
    function entryOf(gp) {
      if (!gp || !playersRef) return null;
      var i = playersRef.indexOf(gp);
      return (i < 0) ? null : (pMeshes[i] || null);
    }
    function carryNode(gp, name) {
      var e = entryOf(gp);
      var P = e && e.P;
      if (!P) return null;
      return (P.sockets && P.sockets[name]) || (P.nodes && P.nodes[name]) || null;
    }

    /* ---- CARRYING THE BALL ------------------------------------------------

       THE BALL HANGS OFF THE LIMB THAT HOLDS IT. That is the whole idea here,
       and it is what was wrong before: the ball was parented to the Chest bone
       and the arm was a separate thing that happened to be nearby, so the two
       could disagree — and did. The arm on that side went on swinging through
       the ball with the run cycle, and the ball rode at 74% of the distance
       from foot to head, which is the armpit. Nothing was holding it.

       Parented to the FOREARM it cannot come apart, whatever the arm is doing
       and whatever clip is playing. The offsets below lay the ball along that
       forearm — back point in the crook of the elbow, body along the bone,
       nose out past the hand — and the arm pose then puts that whole assembly
       where a runner actually carries it: upper arm hanging close to the body,
       elbow bent to about a right angle, forearm level and across the front.

       That last part is why the arm pose and the ball offsets have to be tuned
       together and are written together. Sampled every frame across a full
       stride in the running game, the ball holds 0.17yd from the elbow joint
       and 0.29yd from the hand with a spread of ZERO on both — which is the
       whole point of hanging it off the limb, and is what the chest could
       never give. It rides 0.21yd below the chest bone, against 0.09 before,
       so it also finally sits down at the waist where it belongs.

       Ball offsets are FOREARM-local; arm rotations are the bone's own. Both
       mirror with `side`: +1 carries on the player's LEFT. The rotation about
       Z is what turns the ball to lie along the bone: the ball's long axis is
       its local X, the forearm runs down its own local -Y, and -PI/2 about Z
       maps one onto the other, nose toward the hand. */
    var HALF_PI = Math.PI / 2;
    var CARRY = {
      host:     'LowerArm',                          // the forearm bone
      ball:     { pos: [0.055, -0.13, -0.05], rot: [0, 0.18, -HALF_PI] },
      upperArm: [0.12, -0.28, 0.13],                 // hangs, turned slightly in
      lowerArm: [-1.69, 0, 0.05]                     // ~97 degrees: forearm level
    };
    /* A passer still holding it has it IN THE THROWING HAND, at the near
       shoulder, with the off hand brought across onto it — which is both what
       a quarterback does and the only honest way to draw a ball that is about
       to be thrown. It used to be offset +0.13 ABOVE the chest joint and out
       to one side, i.e. resting on the shoulder, held by nothing. */
    var READY = {
      host:     'Socket_Hand_R',                     // the throwing hand itself
      ball:     { pos: [0, -0.02, 0.05], rot: [0, 0, -HALF_PI] },
      upperArm: [0.34, -0.30, 0.16],
      lowerArm: [-1.95, 0, 0.05],
      // The off hand comes across onto the ball rather than mirroring.
      offUpperArm: [0.22, -0.95, 0.10],
      offLowerArm: [-2.05, 0, 0.05]
    };

    /* WHICH ARM. Away from the nearest defender — the ball is carried on the
       arm furthest from the hit, which is both the coaching point and the side
       you can actually see it on from a camera sitting behind the play.

       Chosen ONCE, when the player takes possession, and then held. It used to
       be re-evaluated every frame, which was harmless while the ball was a
       floating offset and is not now that an arm is wrapped around it: a
       defender crossing the runner's face would have swapped the ball and the
       whole arm to the other side of the body between one frame and the next.
       A real carrier does switch arms, but that is a move with a body in it,
       and doing it without one looks worse than not doing it. */
    function carrySide(state, c) {
      var side = (c.y < WID / 2) ? -1 : 1;         // default: away from midfield
      var nd = 1e9, near = null;
      for (var i = 0; i < state.players.length; i++) {
        var o = state.players[i];
        if (o.team === c.team || o.flagPulled) continue;
        var od = Math.hypot(o.x - c.x, o.y - c.y);
        if (od < nd) { nd = od; near = o; }
      }
      if (near && nd < 8) side = (near.y > c.y) ? -1 : 1;
      return side;
    }

    /* A carry key is the grip plus the side it is on ('carry1', 'ready-1'), so
       the arm pose in syncPlayer and the ball placement in render() can never
       read it differently. */
    function gripFor(key) { return key.slice(0, 5) === 'ready' ? READY : CARRY; }
    function sideFor(key) { return key.slice(5) === '-1' ? -1 : 1; }
    function hostFor(key) {
      var g = gripFor(key);
      return g.host === 'LowerArm' ? ('LowerArm_' + (sideFor(key) > 0 ? 'L' : 'R')) : g.host;
    }

    var _q = new THREE.Quaternion(), _e = new THREE.Euler();
    /* Blend one arm toward a posed rotation. Weight 0 leaves the clip alone and
       1 takes it over completely, so a pose can fade in and out instead of
       snapping — and slerping the bone means it composes with whatever the
       mixer just wrote rather than fighting it. */
    function poseArm(P, suffix, sign, upper, lower, w) {
      if (!P.nodes || w <= 0.001) return;
      var up = P.nodes['UpperArm_' + suffix], lo = P.nodes['LowerArm_' + suffix];
      if (!up || !lo) return;
      _q.setFromEuler(_e.set(upper[0], upper[1] * sign, upper[2] * sign));
      up.quaternion.slerp(_q, w);
      _q.setFromEuler(_e.set(lower[0], lower[1] * sign, lower[2] * sign));
      lo.quaternion.slerp(_q, w);
    }
    /* Apply a whole grip: the arm the ball is in, plus — for the two-handed
       ready position — the off arm reaching across onto it. */
    function poseGrip(P, grip, side, w) {
      var main = side > 0 ? 'L' : 'R', off = side > 0 ? 'R' : 'L';
      poseArm(P, main, side, grip.upperArm, grip.lowerArm, w);
      if (grip.offUpperArm) poseArm(P, off, -side, grip.offUpperArm, grip.offLowerArm, w);
    }

    // Flying-flag effect pool (spawned on flag pulls)
    var flags = makeFlagPool(THREE, 10);
    scene.add(flags.group);

    // Slash route: the line you drew, painted on the turf and eaten away as the
    // player runs it, so you can always see how much of the order is left.
    var slashInk = makeSlashInk(THREE);
    scene.add(slashInk.group);

    // Touchdown flash sprite (full-scene tint via a big plane facing camera)
    var tdFx = { t: 0, dur: 0 };

    // Realistic rigged players (FLAGSTER.Player3D) are (re)built whenever the
    // roster array changes. Each entry: { P, ring, ud }.
    var PLAYER3D = global.FLAGSTER && global.FLAGSTER.Player3D;
    // Human scale: the rig is ~2.39yd tall, so 0.87 puts players at ~6'2".
    // (It was 1.45 — which rendered ~10ft-tall giants.)

    /* STRIDE MATCHING — why the players used to skate.

       A clip with no root motion only looks planted if the support foot sweeps
       backward at exactly the speed the ground moves under it. That rate is set
       by the STANCE phase, not by the whole cycle:

           natural speed = stanceSweep / (stanceFraction * clipDuration)

       Measured off the built rig at the 0.87 scale this renderer applies — the
       fore-aft travel of the planted foot relative to the root:

           run   1.075 units, stance 30% of a 0.62s cycle -> 5.78 yd/s at 1x
           walk  0.690 units, stance 50% of a 1.00s cycle -> 1.38 yd/s at 1x

       The walk is the check on the arithmetic: a walk has no flight phase, so
       stance is half the cycle and "sweep rate" and "distance per cycle" have
       to give the same answer — and both give 1.38. A run does have a flight
       phase, so distance per cycle is NOT the right basis: the body keeps
       travelling while neither foot is down, and matching per-cycle distance
       would cycle the legs about 1.7x too fast.

       Playback used to be `clamp(speed / 6, 0.6, 1.8)`. The divisor was in the
       right area for the stride the rig has NOW, but the rig's stride was 32%
       shorter then (natural 4.4), so every stride slid forward, and the 0.6
       floor did the same thing in reverse at walking pace — legs cycling for
       1.6yd/s under a player barely moving. Keep these numbers in step with the
       gait tables in tools/build-player-glb.mjs.

       One honest limitation: a real runner's stance fraction shrinks as they
       speed up, and a baked clip's cannot, so no single constant is right
       everywhere. These are set for where the running actually happens —
       6-7yd/s, where the run clip lands at ~1.1x and 3.6 steps/second. Below
       ~4.3yd/s the run would drop under 0.75x and read as slow motion, so it
       is held there and takes a little slip instead; slip is far less visible
       at a jog than moon-walking is. */
    var RUN_NATURAL = 5.78, WALK_NATURAL = 1.38;
    var WALK_MAX = 2.4;              // hand over to the run cycle above this
    var PLAYER_LIFT = 0.10;    // rig dips slightly below its origin; sit feet on turf
    // A few skin tones rotated through by roster index for visual variety.
    var SKINS = ['#f2c9a0', '#e8b98f', '#d59a6a', '#a9714a', '#8a5a38', '#6f4526'];

    var pMeshes = [];          // parallel to state.players (entry objects)
    var playersRef = null;

    var camFx = MID;           // smoothed camera focus (field X)
    var camFz = null;          // smoothed camera lateral follow (world Z)
    var chaseW = 0;            // 0..1: how much the look-at is on a ball in flight
    var viewAspect = 16 / 9;   // current canvas aspect (w/h); drives FOV + framing
    var prevInAir = false;

    function makeRing() {
      var ring = new THREE.Mesh(
        new THREE.RingGeometry(1.0, 1.45, 32),
        new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05; ring.visible = false;
      return ring;
    }

    /* Height/build per player. Deterministic in the player's own id, so a
       given athlete is the same size every time you see them. */
    var BUILD = {
      WR:   { h:  0.030, w: -0.035 },
      CB:   { h:  0.022, w: -0.030 },
      S:    { h:  0.018, w: -0.018 },
      QB:   { h:  0.010, w:  0.000 },
      MLB:  { h: -0.005, w:  0.035 },
      RB:   { h: -0.018, w:  0.030 },
      RUSH: { h: -0.010, w:  0.055 },
      C:    { h: -0.028, w:  0.070 }
    };
    function bodyOf(gp, idx) {
      var key = gp.pos || gp.slot || 'QB';
      var d = BUILD[key] || BUILD.QB;
      var spd = (gp.data && gp.data.speed) || 70;
      // Faster players carry less: a little taller, a little leaner.
      var lean = (spd - 70) / 60;                    // roughly -0.5 .. +0.5
      // A stable per-player wobble so a squad isn't ten clones of two moulds.
      var seed = 0, id = String((gp.data && gp.data.id) || gp.last || idx);
      for (var i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) & 0xffff;
      var jitter = ((seed % 1000) / 1000 - 0.5) * 0.030;
      var h = PLAYER_SCALE * (1 + d.h + lean * 0.020 + jitter);
      var w = PLAYER_SCALE * (1 + d.w - lean * 0.030 - jitter * 0.5);
      return { h: h, w: w };
    }

    function rebuildPlayers(players) {
      // Dispose old Player3D instances + their holders/rings.
      pMeshes.forEach(function (e) {
        if (e.P) e.P.dispose();
        if (e.holder) scene.remove(e.holder);
        if (e.ring) { disposeObj(THREE, e.ring); scene.remove(e.ring); }
      });
      pMeshes = [];
      (players || []).forEach(function (gp, idx) {
        var cols = gp.team === 'home' ? homeCols : awayCols;
        var isOff = engine.offenseTeam ? (gp.team === engine.offenseTeam()) : true;
        var P = PLAYER3D.build(THREE, {
          jersey: cols[0], trim: cols[1] || '#ffffff',
          skin: SKINS[idx % SKINS.length],
          // The jersey number — NOT gp.ovr, which is what used to be painted
          // here and is why every 80-rated receiver wore 80.
          number: (gp.num != null ? gp.num : ''),
          name: (gp.last || '')
        });
        /* E1 — NOT EVERY PLAYER IS THE SAME PERSON. One rig, one height, one
           build, for all ten on the field: a 99-speed receiver and a centre
           were identical silhouettes, because PLAYER_SCALE was a single
           constant applied to everybody.

           Height comes off the position and the speed rating — receivers and
           defensive backs run tall and light, the centre and the rusher are
           shorter and thicker — with a small deterministic wobble per player
           so no two are stamped from the same die. Width is scaled against
           height so the taller ones read lean rather than merely bigger. */
        var b = bodyOf(gp, idx);
        P.root.scale.set(b.w, b.h, b.w);
        // Players cast shadows onto the turf so they sit ON the field.
        P.root.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
        if (P.setPlateScale) P.setPlateScale(0.55);   // small, broadcast-style tag
        // The rig's clips animate root.position (bob), so the mixer clobbers any
        // world position we set on root. Place the model on the field via an
        // outer holder Group; the mixer bobs root locally inside it.
        var holder = new THREE.Group();
        holder.add(P.root);
        // Seed facing: offense looks downfield (+x), defense looks at offense (-x).
        var seedYaw = isOff ? 0 : Math.PI;
        P.setYaw(seedYaw);
        scene.add(holder);
        var ring = makeRing(); scene.add(ring);
        pMeshes.push({
          P: P, holder: holder, ring: ring,
          ud: { yaw: seedYaw, celebT: 0, _wasPulled: false, _threw: false, _caught: false, _juked: false,
                clip: 'idle', carryKey: '', carrySide: 0, carryW: 0 }
        });
      });
      playersRef = players;
    }

    // Advance one player's Player3D: position, facing, clip selection, one-shots.
    function syncPlayer(entry, gp, dt, state) {
      var P = entry.P, ud = entry.ud, holder = entry.holder;
      holder.position.set(wx(gp.x), PLAYER_LIFT, wz(gp.y));

      /* Animate what the body actually DID, not what it meant to do. The
         engine publishes rvx/rvy — real displacement over the frame — and
         falls back to intent before the first step. Facing, stride rate and
         the run/walk/backpedal choice all read from it, so a player who gets
         moved by anything other than their own steering turns and strides
         into that too, instead of sliding across the turf under a forward
         run cycle. */
      var vx = (gp.rvx != null ? gp.rvx : (gp.vx || 0));
      var vy = (gp.rvy != null ? gp.rvy : (gp.vy || 0));
      var speed = Math.hypot(vx, vy);
      // Only treat players as "moving" while the ball is live — between plays
      // (playcall/presnap/dead/final) residual velocity must NOT keep them running.
      var live = (state.phase === 'live');
      var moving = live && speed > 1.0;
      var isOff = (gp.team === state.possession);
      var carrier = state.carrier;
      var ballInAir = !!(state.ball && state.ball.inAir);
      var reaching = !!(ballInAir && state.thrownTo === gp);
      /* The throw animation now starts on the WIND-UP, not on the ball going
         airborne — the engine holds the ball in hand for the first third of
         the clip so the pass leaves as the arm comes through. */
      var winding = !!(state.pendingThrow && state.pendingThrow.thrower === gp);
      var throwing = winding || !!(ballInAir && state.ball.thrower === gp);

      if (ud.celebT > 0) ud.celebT = Math.max(0, ud.celebT - dt);

      var juking = (gp.jukeFx || 0) > 0;

      // ---- FACING: pick a target yaw (field-angle space) by role ----------
      var yawT = ud.yaw;
      if (throwing) {
        var to = (state.ball && state.ball.to) || state.thrownTo;
        if (to) yawT = Math.atan2(to.y - gp.y, to.x - gp.x);
      } else if (reaching) {
        // Turn to the ball, but a receiver at full stride can only look so far
        // off their own line before they'd be running sideways.
        yawT = alongMotion(Math.atan2(state.ball.y - gp.y, state.ball.x - gp.x), vx, vy, speed, 0.50);
      } else if (carrier === gp) {
        /* Face where you are actually going, INCLUDING through a juke. Holding
           the line through the cut looked right in a still frame and wrong in
           motion: the juke drives real lateral momentum now (Phase 2), and a
           body pointing downfield while travelling sideways is the skate.
           Measured at 17.5% of juke frames more than 25 degrees off. The Juke
           clip's own weight shift still plays over the top; the turn rate just
           below is doubled through the cut so the hips snap into it. */
        if (moving) yawT = Math.atan2(vy, vx);   // ball carrier faces motion
      } else if (isOff) {
        if (moving) yawT = Math.atan2(vy, vx);        // receivers/QB face motion
      } else {
        // DEFENSE: play what you're covering (carrier -> ball target -> receiver),
        // but only as far as your feet allow — see alongMotion().
        var chase = carrier ||
                    (ballInAir && state.ball.to ? state.ball.to : null) ||
                    state.thrownTo;
        if (chase) yawT = alongMotion(Math.atan2(chase.y - gp.y, chase.x - gp.x), vx, vy, speed, 0.55);
        else if (moving) yawT = Math.atan2(vy, vx);
      }
      ud.yaw = yawT;
      // A juke is a sidestep: the body deliberately leaves the line of travel
      // for a beat, so snap through it instead of easing.
      P.face(yawT, juking ? dt * 2.2 : dt);

      /* Backpedal = actual facing roughly opposite to velocity. This was gated
         to the defence, but it isn't a defensive motion, it's a direction of
         travel: a receiver coming back to an underthrown ball faces it and
         moves away from where they're pointing, and with the run clip on top
         of that they moonwalked. Anyone travelling backwards backpedals. */
      var face = P._yaw;
      /* Publish the facing the player is ACTUALLY rendered at (P.face eases
         toward yawT, so the target is not the answer). Nothing in the game
         reads it; it is here so the headless sweep can measure the angle
         between where a body points and where it travels — the definition of
         skating — from outside, instead of re-deriving it and grading the
         renderer against a copy of the renderer. */
      gp.faceYaw = face;
      var fwdDot = moving ? (Math.cos(face) * vx + Math.sin(face) * vy) : 0;
      var backpedal = moving && fwdDot < -0.4;

      // ---- ONE-SHOT events (fire once per event) ---------------------------
      // Throw: QB releasing the ball.
      if (throwing && !ud._threw) { P.oneShot('throw', 'idle'); ud._threw = true; }
      if (!throwing) ud._threw = false;

      // Juke: the carrier breaks a grip with a sidestep.
      if (juking && !ud._juked) { P.oneShot('juke', 'run'); ud._juked = true; }
      if (!juking) ud._juked = false;

      // Catch: targeted receiver secures the ball as it arrives.
      if (reaching) ud._caught = false;                 // re-arm while ball inbound
      if (!ud._caught && state.thrownTo === gp && !ballInAir && carrier === gp) {
        P.oneShot('catch', 'run'); ud._caught = true;
      }

      // Flag pull: the carrier whose flag just got pulled + puller celebrates.
      if (gp.flagPulled && !ud._wasPulled) {
        P.oneShot('flagPull', 'idle');
        flags.burst(holder.position.x, 0.9, holder.position.z, cols0(gp));
        ud._wasPulled = true;
        // tag nearest defender to celebrate
        var nd = 1e9, ne = null;
        for (var pi = 0; pi < pMeshes.length; pi++) {
          var op = state.players[pi];
          if (!op || op.team === gp.team) continue;     // defenders only
          var ddx = op.x - gp.x, ddy = op.y - gp.y, dd = ddx * ddx + ddy * ddy;
          if (dd < nd) { nd = dd; ne = pMeshes[pi]; }
        }
        if (ne) ne.ud.celebT = 1.0;
      }
      if (!gp.flagPulled) ud._wasPulled = false;

      // ---- LOOP clip selection (skip while a one-shot is running) ----------
      if (!P._oneShot) {
        if (ud.celebT > 0) {
          P.play('celebrate');
        } else if (live && backpedal) {
          P.play('backpedal'); P.setSpeed(clamp(speed / RUN_NATURAL, 0.75, 2.4));
        } else if (live && moving) {
          // Walk the slow stuff and run the rest, each matched to its own clip.
          if (speed < WALK_MAX) { P.play('walk'); P.setSpeed(clamp(speed / WALK_NATURAL, 0.5, 1.9)); }
          else { P.play('run'); P.setSpeed(clamp(speed / RUN_NATURAL, 0.75, 2.4)); }
        } else {
          P.play('idle');                       // stand down between/at end of plays
        }
      }

      P.update(dt);

      /* ---- CARRY POSE (after the mixer, so it overrides the clip) ---------
         The clip has already written every bone for this frame; the arm around
         the ball is layered on top of it by slerping the two shoulder joints
         part of the way toward the carry pose. `carryW` is what makes that a
         blend rather than a switch — it fades out under any one-shot (the
         throw, the catch, the juke all own the arms while they run) and back
         in afterwards, and it fades through zero to change pose so a passer
         tucking the ball and running doesn't snap between the two. */
      var holdingIt = (carrier === gp && !gp.flagPulled);
      var readying = holdingIt && gp === state.passer && !state.handoffDone && !state.pendingThrow;
      // The ready position lives in the THROWING hand, which is the right one —
      // the same hand the wind-up hands the ball to — so it is not sided by the
      // nearest defender the way a runner's tuck is.
      if (holdingIt && !ud.carrySide) ud.carrySide = carrySide(state, gp);
      if (!holdingIt) ud.carrySide = 0;
      var wantKey = holdingIt ? (readying ? 'ready-1' : 'carry' + ud.carrySide) : '';
      // A one-shot is driving the arms itself; give way to it and come back.
      var wantW = (holdingIt && !P._oneShot && wantKey === ud.carryKey) ? 1 : 0;
      ud.carryW += (wantW - ud.carryW) * Math.min(1, dt * 9);
      if (ud.carryW < 0.02 && wantKey !== ud.carryKey) { ud.carryKey = wantKey; ud.carryW = 0; }
      if (ud.carryW > 0.001 && ud.carryKey) {
        poseGrip(P, gripFor(ud.carryKey), sideFor(ud.carryKey), ud.carryW);
      }

      /* No floating nameplates during play. They were a world-space Sprite
         with depthTest off, which under the old distant camera was a harmless
         speck but under the chase cam is a label painted across whichever
         player happens to be nearer the lens. The jersey number reads clearly
         at this range and the user's player carries a highlight ring, so the
         tag was covering the very thing that identifies him. */
      if (P.setPlateVisible) P.setPlateVisible(false);

      // Highlight ring under the user-controlled player.
      entry.ring.visible = (state.userControlled === gp);
      if (entry.ring.visible) { entry.ring.position.set(holder.position.x, 0.05, holder.position.z); }
    }
    function cols0(gp) { return gp.team === 'home' ? homeCols[0] : awayCols[0]; }

    /* ---- CHASE CAMERA -----------------------------------------------------
       A low, over-the-shoulder camera that rides a few yards behind the player
       we're following, roughly at head height, looking downfield.

       This replaces an earlier solver that framed the WHOLE field at once. It
       was honest about the geometry and useless to look at: fitting 70 yards
       into the frame puts the lens ~60 yards back, which renders the players
       four pixels tall and fills two thirds of the screen with crowd. Football
       on a screen reads from behind the ball carrier, close enough that you can
       see the jersey number and the flags on their hips.

       Everything is expressed as an offset from a FOCUS point (the carrier, or
       the ball in flight, or the line of scrimmage pre-snap):

           camera  = focus - forward*BACK + up*HEIGHT   (+ lateral follow)
           look-at = focus + forward*AHEAD

       `s` flips with possession so the camera is always behind the side we're
       playing as and the opponent's end zone is the thing we're driving at. */
    var _target = new THREE.Vector3(0, 1.6, 0);
    // Portrait phones get a slightly higher, slightly further camera: the frame
    // is narrow, so a lower one would hide the whole width of the play behind
    // the carrier's shoulders. Wide screens keep the low, dramatic sightline.
    var CAM = {
      wide: { back: 11.0, height: 4.2, ahead: 17.0, lookY: 1.5, fov: 52 },
      // Portrait runs a NARROWER lens, not a wider one. The stands are 30
      // units tall and only ~60 yards away, so they subtend ~27 degrees above
      // the true horizon — a wide vertical FOV on a tall screen fills the top
      // half of the phone with crowd. Tightening the lens and pitching further
      // down crops the bowl out and gives the turf the frame instead.
      // Pulled back from an earlier 8.5/4.8: on a phone that sat ~10yd off the
      // carrier, which crops the play down to the one player you're driving.
      // Height rises with the distance so the pitch stays steep enough to keep
      // the bowl out of the top of the frame.
      tall: { back: 12.5, height: 6.6, ahead: 11.5, lookY: 0.85, fov: 54 }
    };

    /* THE HARD GUARANTEE THAT THE BALL IS IN SHOT.

       Every other part of this camera is a lag filter — the focus, the lateral
       follow, the look-at, all eased toward where they should be. That is what
       makes it feel like a camera operator rather than a spreadsheet, and it is
       also why none of it can promise anything: a ball leaves the hand at 22
       yards a second and every filter is, by construction, behind it. Measured
       with the eased follow alone, a throw still spent 15 to 33 frames outside
       the frame, reaching 1.86 in normalised device coords when 1.0 is the
       edge.

       So the smoothing runs first and proposes a shot, and then this checks it.
       Project the ball; if it is inside the safe box, change nothing at all and
       the camera stays exactly as cinematic as it was. If it is outside, walk
       the look-at toward the ball until it isn't — no further. Each step moves
       a third of the way and re-tests, so the correction applied is the
       smallest one that works, and the result is a camera that follows the
       pass loosely when it can and tightens onto it only when it must.

       Writing the correction back into _target (rather than applying it after
       the fact) means the next frame eases from the corrected shot, so a hard
       chase settles into a smooth one instead of fighting the filter. */
    var SAFE = 0.72;                     // keep the ball inside 72% of the frame
    // (_bndc, not _ndc — the screen picker already owns that name in this scope.)
    var _ballW = new THREE.Vector3(), _bndc = new THREE.Vector3();
    function keepBallInFrame(state) {
      _ballW.set(wx(state.ball.x), state.ball.z || 0, wz(state.ball.y));
      for (var i = 0; i < 6; i++) {
        camera.updateMatrixWorld();
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        _bndc.copy(_ballW).project(camera);
        // Behind the lens (w < 0 flips the projection) counts as out of frame.
        var out = _bndc.z > 1 || Math.abs(_bndc.x) > SAFE || Math.abs(_bndc.y) > SAFE;
        if (!out) return;
        _target.lerp(_ballW, 0.34);
        camera.lookAt(_target);
      }
    }

    function updateCamera(state, dt) {
      var userSide = (engine && engine.userSide) || 'home';
      var userOff = (state.possession === userSide);
      var s = userOff ? 1 : -1;                    // we attack toward +x on offense
      var C = (viewAspect < 1.0) ? CAM.tall : CAM.wide;

      if (camera.fov !== C.fov) { camera.fov = C.fov; camera.updateProjectionMatrix(); }

      /* FOCUS — whoever the eye should be on. Pre-snap that's the line of
         scrimmage; once the ball is live it's the carrier, and a throw hands
         the focus to the ball so the camera leads the receiver into the catch
         instead of staying home with the quarterback. */
      var hasLos = (state.losX != null && isFinite(state.losX));
      var focusFx = hasLos ? state.losX : MID;
      var focusFy = WID / 2;
      if (state.carrier) { focusFx = state.carrier.x; focusFy = state.carrier.y; }
      else if (state.ball && state.ball.inAir) { focusFx = state.ball.x; focusFy = state.ball.y; }
      else if (hasLos && (state.phase === 'presnap' || state.phase === 'playcall')) {
        // Pre-snap, sit back off the line so the whole formation is in frame.
        focusFx = state.losX - s * 3;
      }
      // A single NaN here poisons the camera matrix and the scene renders as
      // bare clear-colour, so refuse to feed anything non-finite forward.
      if (!isFinite(focusFx)) focusFx = MID;
      if (!isFinite(focusFy)) focusFy = WID / 2;

      /* Keep the camera inside the bowl. Behind our own end line there is only
         apron and seating, and a camera that drifts back there looks through
         the stand at the back of the end zone. */
      var minFx = GOAL_L - EZ + 2, maxFx = GOAL_R + EZ - 2;
      focusFx = clamp(focusFx, minFx, maxFx);

      /* Lateral follow is damped hard — matching the carrier's sideways cuts
         yard-for-yard swings the whole world sideways and reads as a camera
         fault rather than a juke. Half-weight, and clamped near the hashes.

         A ball in the air is the exception. Those constants are tuned for a
         runner, and a ball crossing the field at 22yd/s outran them: measured,
         a throw toward a sideline put the ball 217 pixels outside a 1280-wide
         frame. While it's airborne the camera tracks it properly — more of the
         offset, further out, and eased twice as fast — because the one thing
         the frame must always contain is the ball. */
      var chasing = !!(state.ball && state.ball.inAir);
      var latW = chasing ? 0.90 : 0.55, latMax = chasing ? 9.0 : 5.0;
      var latTarget = clamp((focusFy - WID / 2) * latW, -latMax, latMax);
      if (camFz == null) camFz = latTarget;
      camFz = lerp(camFz, latTarget, clamp(dt * (chasing ? 6.0 : 2.4), 0, 1));

      camFx = lerp(camFx, focusFx, clamp(dt * (chasing ? 7.0 : 4.5), 0, 1));
      var anchorX = wx(camFx);

      /* Keep the LENS inside the bowl, not just the focus. Backed up near your
         own goal line, focus - back lands behind the end line, and the camera
         ends up outside the stadium shooting the play through the back wall
         and the stand behind it — a grey slab across the bottom of the frame.
         Clamping here means the camera stops at the wall and rides closer to
         the carrier instead, which is what a real touchline camera does. */
      var camLimit = LEN / 2 - 1.5;
      var camX = clamp(anchorX - s * C.back, -camLimit, camLimit);
      var lookX = anchorX + s * C.ahead;

      // Ease so possession changes swing smoothly instead of snapping.
      var k = clamp(dt * 3.2, 0, 1);
      camera.position.set(
        lerp(camera.position.x, camX, k),
        lerp(camera.position.y, C.height, k),
        lerp(camera.position.z, camFz, k)
      );

      /* FOLLOW THE PASS. Where the camera looks was a fixed point C.ahead down
         the field, and the ball stayed in shot only insofar as the lateral
         follow constants happened to suit — which they did not: a throw toward
         a sideline was measured 217 pixels outside a 1280-wide frame. */
      chaseW += ((chasing ? 1 : 0) - chaseW) * clamp(dt * 4.5, 0, 1);
      var tx = lookX, ty = C.lookY, tz = camFz * 0.65;
      if (chaseW > 0.001 && state.ball) {
        var w = chaseW * 0.78;
        tx = lerp(tx, wx(state.ball.x), w);
        ty = lerp(ty, Math.max(0.6, state.ball.z || 0), w);
        tz = lerp(tz, wz(state.ball.y), w);
      }
      _target.set(
        lerp(_target.x, tx, k),
        lerp(_target.y, ty, k),
        lerp(_target.z, tz, k)
      );
      camera.lookAt(_target);
      if (chasing && state.ball) keepBallInFrame(state);
      // Sun target stays at the origin: its shadow box already spans the whole
      // field, and swinging the target while the light's position is fixed
      // would rotate the sun's direction as the play moves.
      if (sun.target) sun.target.position.set(0, 0, 0);
    }

    /* Screen-space picking so a tap can select a player. Returns the index into
       state.players under the given client coords, or -1. */
    var _ray = new THREE.Raycaster();
    var _ndc = new THREE.Vector2();
    function pick(clientX, clientY) {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return -1;
      _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
      _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
      _ray.setFromCamera(_ndc, camera);
      var holders = [];
      for (var i = 0; i < pMeshes.length; i++) if (pMeshes[i].holder) holders.push(pMeshes[i].holder);
      var hits = _ray.intersectObjects(holders, true);
      if (!hits.length) return -1;
      var o = hits[0].object;
      while (o && holders.indexOf(o) === -1) o = o.parent;
      var hi = holders.indexOf(o);
      if (hi < 0) return -1;
      // holders array is dense over pMeshes, so map back to the player index
      var seen = -1;
      for (var j = 0; j < pMeshes.length; j++) {
        if (pMeshes[j].holder) { seen++; if (seen === hi) return j; }
      }
      return -1;
    }

    /* Same ray, but against the turf instead of the players: converts a screen
       point into FIELD coordinates (yards). This is what turns a finger-stroke
       into a route — field space is camera-independent, so a drawn line stays
       pinned to the yardage you drew it on even when possession flips the
       camera end-for-end. Returns null if the ray misses the ground. */
    var _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    var _hit = new THREE.Vector3();
    function pickGround(clientX, clientY) {
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      _ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
      _ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
      _ray.setFromCamera(_ndc, camera);
      if (!_ray.ray.intersectPlane(_plane, _hit)) return null;
      return { x: clamp(_hit.x + LEN / 2, 0, LEN), y: clamp(_hit.z + WID / 2, 0, WID) };
    }

    // ---------------------------- RESIZE -----------------------------------
    function resize() {
      var w = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 800;
      var h = canvas.clientHeight || (canvas.parentElement && canvas.parentElement.clientHeight) || 480;
      if (w < 2 || h < 2) return;
      renderer.setSize(w, h, false);
      if (fx) fx.setSize(w, h);
      camera.aspect = w / h; viewAspect = w / h;
      // updateCamera() picks the FOV for this aspect (portrait runs wider so a
      // narrow frame still shows the play either side of the carrier).
      camera.updateProjectionMatrix();
    }
    // Optional post-processing (subtle bloom + SMAA). null => render direct.
    var fx = (global.FLAGSTER && global.FLAGSTER.FX)
      ? global.FLAGSTER.FX.create(THREE, renderer, scene, camera, {})
      : null;

    var ro = ('ResizeObserver' in global) ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(canvas); else global.addEventListener('resize', resize);
    resize();

    /* ---- JUMBOTRON --------------------------------------------------------
       Repaints the in-world scoreboards from live game state. Each repaint is
       a full 1024x512 canvas redraw plus a texture upload, so it runs on a
       ~4Hz timer and only when something on the board actually changed — at
       frame rate it would cost more than the rest of the scene combined. */
    var boardT = 0, boardKey = '';
    function updateJumbotron(state, dt) {
      if (!stadiumGroup || !stadiumGroup.userData.updateBoards) return;
      boardT += dt;
      if (boardT < 0.25) return;
      boardT = 0;

      var mm = Math.floor(Math.max(0, state.clock || 0) / 60);
      var ss = Math.max(0, Math.round((state.clock || 0) % 60));
      var info = {
        awayAbbr: (st0.away && st0.away.id) || 'AWAY',
        homeAbbr: (st0.home && st0.home.id) || 'HOME',
        awayScore: (state.score && state.score.away) || 0,
        homeScore: (state.score && state.score.home) || 0,
        period: state.overtime ? 'OT' : ('Q' + (state.quarter || 1)),
        clock: mm + ':' + (ss < 10 ? '0' : '') + ss,
        awayColor: awayCols[0], homeColor: homeCols[0],
        footer: 'FLAGSTER'
      };
      var key = [info.awayScore, info.homeScore, info.period, info.clock].join('|');
      if (key === boardKey) return;
      boardKey = key;
      stadiumGroup.userData.updateBoards(info);
    }

    // ---------------------------- RENDER -----------------------------------
    function render(state) {
      if (!state) { if (fx) fx.render(); else renderer.render(scene, camera); return; }
      var dt = (engine && engine._dt) || 0.016;
      if (dt > 0.05) dt = 0.05;

      // Rebuild player meshes if the roster array was replaced (new down).
      if (state.players !== playersRef) { hostBall(null); rebuildPlayers(state.players); }

      var inAir = !!(state.ball && state.ball.inAir);
      prevInAir = inAir;

      // Players (each Player3D advances its own mixer + one-shots).
      for (var j = 0; j < pMeshes.length; j++) {
        if (state.players[j]) syncPlayer(pMeshes[j], state.players[j], dt, state);
      }

      // Drawn route: from the player's own feet through the waypoints left.
      var sl = engine && engine.slash;
      slashInk.set(sl && sl.owner ? [sl.owner].concat(sl.pts) : null, dt);

      // Ball spot + down marker on the sideline, level with the spot.
      if (state.losX != null && state.phase !== 'final') {
        spotMark.visible = true;
        spotMark.position.set(wx(state.ballSpot ? state.ballSpot.x : state.losX), 0.03,
                              wz(state.ballSpot ? state.ballSpot.y : WID / 2));
        downMark.visible = true;
        downMark.position.set(wx(state.losX), 0, wz(WID) + 1.4);
      } else { spotMark.visible = false; downMark.visible = false; }

      // Line of scrimmage & line-to-gain
      if (state.losX != null && state.phase !== 'final') {
        losLine.visible = true; losLine.position.x = wx(state.losX);
        var ltg = state.crossedMid ? GOAL_R : MID;
        ltgLine.visible = true; ltgLine.position.x = wx(ltg);
      } else { losLine.visible = false; ltgLine.visible = false; }

      // Football
      if (state.ball) {
        ball.visible = true;
        ballShadow.visible = false;      // only the in-air branch turns it on
        if (state.ball.inAir) {
          hostBall(null);
          /* The engine now solves the flight between the height of the hand it
             left and the height it gets caught at, so `z` is the real altitude
             and is drawn as-is. It used to be a ground-to-ground parabola that
             this line lifted by a flat 1.0 yards, which is why the ball dropped
             out of the quarterback's hand the moment it was released. */
          var bz = state.ball.z || 0;
          ball.position.set(wx(state.ball.x), bz, wz(state.ball.y));
          /* Spin about the axis of FLIGHT, at a rate per SECOND. It used to be
             `rotation.z += 0.5; rotation.x += 0.2` every frame — frame-rate
             dependent, and a tumble rather than a spiral. A thrown ball points
             where it is going and rotates around that line. */
          var vz = (state.ball.vz || 0) - GRAV_R * (state.ball.t || 0);
          var hv = state.ball.hv || 0;
          var yaw = Math.atan2(-(state.ball.diry || 0), (state.ball.dirx || 1));
          var pitch = Math.atan2(vz, hv || 1);
          ball.rotation.set(0, yaw, 0);
          ball.rotateZ(pitch);                    // nose follows the trajectory
          spin = (spin + dt * 22) % (Math.PI * 2);
          /* A pass spirals about the line of flight; a pitch is flicked
             underhand and turns end over end. Same axis convention, different
             axis — the tumble is about the ball's short axis. */
          if (state.ball.lateral) ball.rotateY(spin); else ball.rotateX(spin);
          // Shadow tracks the ground point and fades/grows with height.
          ballShadow.visible = true;
          ballShadow.position.set(wx(state.ball.x), 0.02, wz(state.ball.y));
          var k = clamp(bz / 6, 0, 1);
          ballShadow.scale.setScalar(1 + k * 1.6);
          ballShadow.material.opacity = 0.34 * (1 - 0.6 * k);
        } else if (state.pendingThrow && carryNode(state.pendingThrow.thrower, READY.host)) {
          /* Winding up: the ball rides the throwing hand, so it comes forward
             with the arm and leaves from where the hand actually is. Same hand
             and same grip as the ready position it came out of, so the wind-up
             changes nothing about how the ball is held — the arm moves and the
             ball, being part of it, moves too. */
          hostBall(carryNode(state.pendingThrow.thrower, READY.host));
          ball.position.set(READY.ball.pos[0], READY.ball.pos[1], READY.ball.pos[2]);
          ball.rotation.set(READY.ball.rot[0], READY.ball.rot[1], READY.ball.rot[2]);
        } else if (state.snapFly && state.carrier) {
          // Mid-snap: the ball is on its way from the turf to the hands.
          hostBall(null);
          var k = clamp(state.snapFly.t / state.snapFly.dur, 0, 1);
          var sf = state.snapFly.from;
          ball.position.set(
            wx(sf.x + (state.carrier.x - sf.x) * k), 0.12 + 0.9 * k,
            wz(sf.y + (state.carrier.y - sf.y) * k));
          ball.rotation.set(0, Math.atan2(-(state.carrier.y - sf.y), (state.carrier.x - sf.x)), 0.5);
        } else if (state.ball.onGround) {
          // E2 — sitting on the spot, waiting to be snapped.
          hostBall(null);
          ball.position.set(wx(state.ball.x), 0.11, wz(state.ball.y));
          ball.rotation.set(0, 0, Math.PI / 2);       // resting on its side
        } else if (state.carrier) {
          /* CARRIED — on the limb that holds it. This was a world-space guess
             once (a fixed 1.15 altitude while the player bobbed underneath it),
             then the chest bone, which at least moved with the body but left
             the ball and the arm as two separate things free to disagree.

             It hangs off the forearm (or, for a passer, the throwing hand). The
             grip and the side come from the same carryKey that syncPlayer used
             to pose the arm, so the ball and the arm that holds it are reading
             one number and cannot come apart. */
          var c = state.carrier;
          var ce = entryOf(c);
          var key = ce && ce.ud.carryKey;
          var limb = key ? carryNode(c, hostFor(key)) : null;
          if (limb) {
            hostBall(limb);
            var grip = gripFor(key), side = sideFor(key);
            ball.position.set(grip.ball.pos[0] * side, grip.ball.pos[1], grip.ball.pos[2]);
            ball.rotation.set(grip.ball.rot[0], grip.ball.rot[1] * side, grip.ball.rot[2]);
          } else {
            /* Procedural fallback rig: no bones to hang it off, so approximate.
               Kept at rib height rather than the old 1.15, which put it level
               with the shoulders of a 1.76yd player. */
            hostBall(null);
            ball.position.set(wx(c.x) + Math.cos(-(c.ang || 0)) * 0.1, 1.05, wz(c.y) + 0.35);
            ball.rotation.set(0, -(c.ang || 0), 0.4);
          }
        } else {
          hostBall(null);
          ball.position.set(wx(state.ball.x), 1.0, wz(state.ball.y));
        }
        applyTransfer(state, dt);
      } else { ball.visible = false; ballShadow.visible = false; }

      // Consume engine transient anims (flag/td/incomplete) so they don't leak
      // (the 2D renderer normally advances/clears these; we skip 2D).
      if (engine && engine.anim && engine.anim.length) {
        engine.anim.forEach(function (a) {
          if (a.type === 'td') tdFx.t = 0, tdFx.dur = 1.0;
        });
        engine.anim.length = 0;
      }

      flags.update(dt);
      if (tdFx.dur > 0) { tdFx.t += dt; if (tdFx.t >= tdFx.dur) tdFx.dur = 0; }

      updateJumbotron(state, dt);
      updateCamera(state, dt);
      if (fx) fx.render(); else renderer.render(scene, camera);
    }

    function stop() {
      if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
      // Put the ball back in the scene first: parented to a player's bone it
      // would leave with that player's holder and miss the disposal sweep.
      hostBall(null);
      slashInk.dispose();
      // Dispose Player3D instances (mixer + geometry/materials) and their rings.
      pMeshes.forEach(function (e) {
        if (e.P) e.P.dispose();
        if (e.holder) scene.remove(e.holder);
        if (e.ring) { disposeObj(THREE, e.ring); scene.remove(e.ring); }
      });
      pMeshes = [];
      scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
          if (m.map) m.map.dispose(); m.dispose();
        });
      });
      if (fx) { try { fx.dispose(); } catch (e) {} }
      renderer.dispose();
    }

    return {
      pick: pick, pickGround: pickGround,
      /* Exposed for the headless verification sweep only: with the camera it can
         project a world point to the screen and check the thing it is asserting
         about is actually where it says, instead of re-deriving updateCamera()
         and grading the renderer against a copy of the renderer. */
      camera: camera, ball: ball,
      render: render, resize: resize, stop: stop };
  }

  /* Route ink. A ribbon of small quads laid flat on the turf rather than a
     THREE.Line, because line width is capped at 1px on almost every WebGL
     implementation and a hairline is invisible from the broadcast camera.
     The pool is fixed-size and reused, so drawing a route allocates nothing. */
  function makeSlashInk(THREE) {
    var MAX = 96, W = 0.8;
    var group = new THREE.Group();
    group.visible = false;
    var geo = new THREE.PlaneGeometry(1, W);
    geo.rotateX(-Math.PI / 2);                       // lie flat on the ground
    var mat = new THREE.MeshBasicMaterial({
      // Cyan, deliberately: yellow is already the line-to-gain and blue the
      // line of scrimmage, and a route must not read as either.
      color: 0x35e0ff, transparent: true, opacity: 0.85,
      depthWrite: false, toneMapped: false
    });
    var mesh = new THREE.InstancedMesh(geo, mat, MAX);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    group.add(mesh);
    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    var pos = new THREE.Vector3(), scl = new THREE.Vector3(1, 1, 1);
    var pulse = 0;

    /* pts: [{x, y}, ...] in field yards, starting at the player. */
    function set(pts, dt) {
      if (!pts || pts.length < 2) { group.visible = false; return; }
      group.visible = true;
      pulse = (pulse + (dt || 0.016) * 2.2) % 1;
      mat.opacity = 0.70 + 0.22 * Math.sin(pulse * Math.PI * 2);
      var n = 0;
      for (var i = 0; i < pts.length - 1 && n < MAX; i++) {
        var a = pts[i], b = pts[i + 1];
        var ax = wx(a.x), az = wz(a.y), bx = wx(b.x), bz = wz(b.y);
        var dx = bx - ax, dz = bz - az;
        var len = Math.hypot(dx, dz);
        if (len < 0.01) continue;
        pos.set((ax + bx) / 2, 0.05, (az + bz) / 2);
        q.setFromAxisAngle(up, -Math.atan2(dz, dx));   // +X quad onto the segment
        scl.set(len, 1, 1);
        m4.compose(pos, q, scl);
        mesh.setMatrixAt(n++, m4);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (!n) group.visible = false;
    }
    // InstancedMesh holds its own instance buffers; the scene-wide geometry
    // and material sweep in stop() doesn't reach those.
    function dispose() { mesh.dispose(); }
    return { group: group, set: set, dispose: dispose };
  }

  /* =============================== FIELD ================================= */
  function makeGrass(THREE) {
    var c = document.createElement('canvas'); c.width = 1400; c.height = 500;
    var x = c.getContext('2d');
    var px = function (fx) { return fx / LEN * c.width; };
    var py = function (fy) { return fy / WID * c.height; };
    // mowed stripes every 5 yards
    for (var i = 0; i < LEN; i += 5) {
      x.fillStyle = ((i / 5) % 2 === 0) ? '#2f8f3f' : '#2b8339';
      x.fillRect(px(i), 0, px(i + 5) - px(i), c.height);
    }
    // yard lines every 5 yards
    x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 4;
    for (var y = GOAL_L; y <= GOAL_R; y += 5) {
      x.beginPath(); x.moveTo(px(y), 0); x.lineTo(px(y), c.height); x.stroke();
    }
    // goal lines & midfield emphasized
    [GOAL_L, GOAL_R, MID].forEach(function (gx, k) {
      x.strokeStyle = (k === 2) ? 'rgba(255,230,120,0.9)' : 'rgba(255,255,255,0.95)';
      x.lineWidth = (k === 2) ? 6 : 8;
      x.beginPath(); x.moveTo(px(gx), 0); x.lineTo(px(gx), c.height); x.stroke();
    });
    // sideline borders
    x.strokeStyle = 'rgba(255,255,255,0.8)'; x.lineWidth = 6;
    x.strokeRect(2, 2, c.width - 4, c.height - 4);

    var tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    var plane = new THREE.Mesh(
      new THREE.PlaneGeometry(LEN, WID),
      new THREE.MeshLambertMaterial({ map: tex })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = 0;
    return plane;
  }

  function makeEndZone(THREE, colorHex, centerWX) {
    var m = new THREE.Mesh(
      new THREE.PlaneGeometry(EZ, WID),
      new THREE.MeshLambertMaterial({ color: toColor(THREE, colorHex), transparent: true, opacity: 0.62 })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(centerWX, 0.015, 0);
    return m;
  }

  function makeYardMarker(THREE, colorHex) {
    var m = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.05, WID),
      new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.9 })
    );
    m.position.y = 0.05;
    return m;
  }

  /* The painted leather: two white nose stripes and a lace panel. Measured
     from the broadcast camera the ball is only 16-24 pixels long, and a plain
     dark-brown ellipse that size disappears against turf and against dark
     jerseys. The white is what a real ball has for exactly the same reason —
     it is what makes the shape read as a football at a distance rather than a
     smudge, and it turns the spiral into something you can see spinning. */
  function ballTexture(THREE) {
    var c = document.createElement('canvas'); c.width = 128; c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = '#8a4f22'; x.fillRect(0, 0, 128, 64);
    // v runs pole-to-pole along the long axis, so the stripes are rows.
    x.fillStyle = '#f4f0e6';
    x.fillRect(0, 9, 128, 4);
    x.fillRect(0, 51, 128, 4);
    // Laces: a short run of ticks along one meridian, across the middle.
    for (var i = 0; i < 6; i++) x.fillRect(30, 23 + i * 3.2, 9, 1.8);
    x.fillRect(33, 22, 3, 21);
    var tex = new THREE.CanvasTexture(c);
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function makeBall(THREE) {
    /* Regulation, near enough. 1 unit = 1 yard, and an American football is
       11in long by 6.7in through the middle — 0.306 x 0.186 units. This was
       0.19r scaled 1.6, i.e. 0.61 x 0.38: dead on twice the size in every
       direction, which is why it read as a rugby ball.

       rotateZ before the stretch puts the sphere's poles on the LONG axis, so
       the points of the ball are the poles and the texture's v runs nose to
       nose — which is what lets the stripes sit where they do on a real one. */
    var geo = new THREE.SphereGeometry(0.095, 18, 12);
    geo.rotateZ(Math.PI / 2);
    geo.scale(1.62, 1, 1);
    var ball = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
      map: ballTexture(THREE),
      // A little emissive so the ball never goes to black silhouette in the
      // shadow of the stand, which is where half the field is.
      emissive: 0x2a1a0c
    }));

    /* THE GHOST — the ball you can see through a body.

       Measured over a live drive, the carrier's own torso or a team-mate is
       between the lens and the ball in five frames out of eight: the chase
       camera sits behind the player carrying it, which is precisely the angle
       that hides it. Everything else here is a real object lit by real lights,
       and this is the one deliberate cheat.

       It is a second copy of the ball drawn with depthFunc GreaterDepth, so it
       renders ONLY on the fragments that FAIL the ordinary depth test — the
       part of the ball something is in front of. Where the ball is in clear
       view its own front faces are already at exactly that depth, the test is
       "greater", equal is not greater, and the ghost draws nothing at all. It
       costs one draw call and it cannot be seen when it isn't needed. */
    var ghost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      // Warm and light: it has to separate from green turf and from a jersey
      // in any of the nations' colours, at twenty pixels across.
      color: 0xffd9a0, transparent: true, opacity: 0.78,
      depthFunc: THREE.GreaterDepth, depthWrite: false, toneMapped: false
    }));
    ghost.renderOrder = 8;
    ball.add(ghost);
    return ball;
  }


  /* ============================ FLAG EFFECT ============================= */
  function makeFlagPool(THREE, n) {
    var group = new THREE.Group();
    var pieces = [];
    for (var i = 0; i < n; i++) {
      var m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.22, 0.7),
        new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide, transparent: true })
      );
      m.visible = false; group.add(m);
      pieces.push({ mesh: m, life: 0, vy: 0, spin: 0 });
    }
    var idx = 0;
    function burst(x, y, z, colorHex) {
      var p = pieces[idx % pieces.length]; idx++;
      p.mesh.visible = true; p.mesh.position.set(x, y, z);
      if (colorHex != null) { try { p.mesh.material.color.set(colorHex); } catch (e) {} }
      p.mesh.material.opacity = 1;
      p.vy = 5.5; p.spin = (Math.random() - 0.5) * 16; p.life = 0.9;
    }
    function update(dt) {
      pieces.forEach(function (p) {
        if (p.life <= 0) { if (p.mesh.visible) p.mesh.visible = false; return; }
        p.life -= dt; p.vy -= 9 * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.rotation.z += p.spin * dt; p.mesh.rotation.x += p.spin * 0.5 * dt;
        p.mesh.material.opacity = clamp(p.life / 0.9, 0, 1);
      });
    }
    return { group: group, burst: burst, update: update };
  }

  /* ============================== UTILS ================================= */
  function disposeObj(THREE, root) {
    root.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
        if (m.map) m.map.dispose(); m.dispose();
      });
    });
  }
  function roundRect(x, rx, ry, w, h, r) {
    x.beginPath(); x.moveTo(rx + r, ry);
    x.arcTo(rx + w, ry, rx + w, ry + h, r); x.arcTo(rx + w, ry + h, rx, ry + h, r);
    x.arcTo(rx, ry + h, rx, ry, r); x.arcTo(rx, ry, rx + w, ry, r); x.closePath();
  }

  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.Field3D = { mount: mount };
})(window);
