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
  /* FRAME-RATE-INDEPENDENT SMOOTHING.

     Every lag filter in here used to ease by `dt * rate`, which covers a
     fraction of the remaining distance proportional to how long the frame
     took. That makes the filter's time constant a function of the frame rate,
     so a device that hitches does not merely render late — the camera and the
     blends physically move differently on the long frames than the short ones,
     and the shot chatters.

     This is the exact fraction an exponential decay covers in dt seconds.
     Identical motion at 30fps, at 60fps, and straight through a stutter.
     Measured on the chase camera with two dt sequences of the SAME MEAN
     (steady 1/60 against alternating 8ms/25ms), the old form's median
     frame-to-frame lateral jerk went from 0.0014 to 0.0419 world units — 30x,
     and 64x in the sideline frames where the camera has a lateral target to
     track at all. At 60fps this agrees with the old form to within 3%, so
     every rate below stays tuned as it was. */
  function ease(rate, dt) { return 1 - Math.exp(-rate * dt); }
  // Interpolate an angle along the shortest path (radians).
  function lerpAngle(a, b, t) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // Field constants (yards) — mirror engine.js
  var F = (global.FLAGSTER && global.FLAGSTER.Engine && global.FLAGSTER.Engine.FIELD) ||
          { LEN: 70, WID: 30, EZ: 10, GOAL_L: 10, GOAL_R: 60, MID: 35 };
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
  function wz(fy) { return fy - WID / 2; }   // -15 .. +15

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
       together and are written together.

       BUT A HELD BALL IS NOT A STILL ONE. Hanging the ball off the forearm and
       then pinning that forearm to a constant rotation made the ball rigid and
       the arm a mannequin: nothing animates the Shoulder these two bones hang
       from, so a constant pose at full weight is literally a welded limb.
       Measured on a clean carry at running speed, the ball-side upper arm's
       own rotation moved 0.024 across a stride against the free arm's 0.549 —
       4% — and the hand travelled 0.031 in chest-local space against 0.635.
       The player ran and the arm did not move at all.

       A runner does clamp the ball, but the arm still drives: the elbow stays
       shut and the whole assembly pumps fore and aft from the shoulder, in the
       same rhythm as the free arm and roughly a third of its amplitude. So the
       pose below is a BASE plus a `swing`, sampled from the same cosine and the
       same peak phase that built the rig's own arm tracks (see armTracks in
       tools/build-player-glb.mjs — the left arm leads at 0.12 of the cycle, the
       right half a cycle behind it), which is what keeps it contralateral to
       the legs instead of reading as a second animation over the first.

       Ball offsets are FOREARM-local; arm rotations are the bone's own. Both
       mirror with `side`: +1 carries on the player's LEFT. The rotation about
       Z is what turns the ball to lie along the bone: the ball's long axis is
       its local X, the forearm runs down its own local -Y, and -PI/2 about Z
       maps one onto the other, nose toward the hand. */
    var HALF_PI = Math.PI / 2;
    var CARRY = {
      host:     'LowerArm',                          // the forearm bone
      /* The ball sits at the HAND end of the forearm (the bone runs 0.27 down
         its own -Y to the wrist), not halfway along it, so the hand is on the
         ball instead of reaching past its nose — which is what it did at
         -0.13, and it read as a ball balanced on a shelf. */
      ball:     { pos: [0, -0.27, -0.08], rot: [0, 0.50, -1.35] },
      upperArm: [-0.05, -0.42, 0.22],                // elbow in at the ribs
      lowerArm: [-2.35, 0, 0.05],                    // ~135 deg: forearm up across the chest
      /* Fore-aft drive, in radians of amplitude about the base. The free arm
         covers 26 to -46 degrees, i.e. +/-0.63rad; the elbow barely opens at
         all because the ball is clamped in it. */
      swing:    { upper: 0.24, lower: 0.05, peakL: 0.12 }
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
    // Scratch for the per-frame lean (see the LEAN block in syncPlayer).
    var _axis = new THREE.Vector3(), _qbank = new THREE.Quaternion(), _qpitch = new THREE.Quaternion();
    /* Blend one arm toward a posed rotation. Weight 0 leaves the clip alone and
       1 takes it over completely, so a pose can fade in and out instead of
       snapping — and slerping the bone means it composes with whatever the
       mixer just wrote rather than fighting it.

       `drive` is added to the fore-aft angle of both joints before the slerp:
       it is what stops a full-weight pose from being a welded limb. It is not
       a blend with the clip — blending back toward the clip would open the
       elbow and drop the ball out of the arm, which is the one thing the pose
       exists to prevent. The elbow keeps its angle and the whole closed arm
       swings from the shoulder. */
    function poseArm(P, suffix, sign, upper, lower, w, driveUp, driveLo) {
      if (!P.nodes || w <= 0.001) return;
      var up = P.nodes['UpperArm_' + suffix], lo = P.nodes['LowerArm_' + suffix];
      if (!up || !lo) return;
      _q.setFromEuler(_e.set(upper[0] + (driveUp || 0), upper[1] * sign, upper[2] * sign));
      up.quaternion.slerp(_q, w);
      _q.setFromEuler(_e.set(lower[0] + (driveLo || 0), lower[1] * sign, lower[2] * sign));
      lo.quaternion.slerp(_q, w);
    }
    /* Apply a whole grip: the arm the ball is in, plus — for the two-handed
       ready position — the off arm reaching across onto it.

       `phase` is where the legs are in the stride (null when no gait is
       running) and `amp` scales the drive down as the player slows, so a
       carrier standing still holds the ball still instead of pumping an arm
       on the spot. The cosine and the peak are the rig's own: the left arm is
       furthest forward at 0.12 of the cycle and the right half a cycle behind,
       so the ball-side arm stays contralateral to the legs. */
    function poseGrip(P, grip, side, w, phase, amp) {
      var main = side > 0 ? 'L' : 'R', off = side > 0 ? 'R' : 'L';
      var sw = grip.swing, dUp = 0, dLo = 0;
      if (sw && phase != null && amp > 0.001) {
        var peak = side > 0 ? sw.peakL : (sw.peakL + 0.5) % 1;
        var c = Math.cos(2 * Math.PI * (phase - peak));
        dUp = sw.upper * amp * c;
        dLo = sw.lower * amp * c;
      }
      poseArm(P, main, side, grip.upperArm, grip.lowerArm, w, dUp, dLo);
      // The off arm mirrors the drive, half a cycle out, so a two-handed ready
      // position doesn't leave one arm alive and the other dead.
      if (grip.offUpperArm) poseArm(P, off, -side, grip.offUpperArm, grip.offLowerArm, w, -dUp, -dLo);
    }

    /* ---- GOING FOR THE FLAG ------------------------------------------------
       A grab is a STATE, not an event: the defender has hold of the carrier
       and the meter fills for as long as they can stay there, which is
       anywhere from half a second to indefinitely if the runner is shifty
       enough. A one-shot cannot express that — so the reach is a pose layered
       over whatever the legs are doing, exactly like the ball carry, and the
       one-shot FlagGrab clip only plays for the rip at the end.

       Both arms drive out in front at the height of the other man's waist.
       The defence already faces whatever it is chasing (see the facing block
       in syncPlayer), so straight ahead IS at the flag.

       These are quaternions rather than eulers because that is the only honest
       way to write an arm that is elevated, swept across the body and rotated
       about its own axis all at once — the same solve the Throw and FlagGrab
       clips are authored through, run once:
           right arm  elevation 62, horizontal 80, ER 10, elbow 22
           left  arm  elevation 58, horizontal 78, ER  8, elbow 28
       (tools/build-player-glb.mjs, armQ). */
    var REACH = {
      R: { up: [-0.3642, 0.4917, -0.3642, 0.7022], lo: [-0.384, 0, -0.05] },
      L: { up: [-0.3306, -0.5017, 0.3546, 0.7164], lo: [-0.489, 0, 0.05] }
    };
    var _rq = new THREE.Quaternion();
    function poseReach(P, w) {
      if (!P.nodes || w <= 0.001) return;
      ['R', 'L'].forEach(function (side) {
        var up = P.nodes['UpperArm_' + side], lo = P.nodes['LowerArm_' + side];
        if (!up || !lo) return;
        var r = REACH[side];
        _rq.set(r.up[0], r.up[1], r.up[2], r.up[3]);
        up.quaternion.slerp(_rq, w);
        _q.setFromEuler(_e.set(r.lo[0], r.lo[1], r.lo[2]));
        lo.quaternion.slerp(_q, w);
      });
    }

    /* Bias the chest and the head toward the inside of a turn. The rig's spine
       bones point +Y with the character's LEFT at +X, so a positive rotation
       about the bone's own Y turns the nose to the player's left — the same
       sense as `lead`. Multiplied onto what the clip wrote rather than slerped
       toward a pose: this is an offset, not a destination, and the gait's own
       counter-rotation underneath it has to survive. */
    var _leadQ = new THREE.Quaternion(), _leadAx = new THREE.Vector3(0, 1, 0);
    function leadTrunk(P, lead) {
      if (!P.nodes) return;
      var chest = P.nodes.Chest, head = P.nodes.Head;
      if (chest) { _leadQ.setFromAxisAngle(_leadAx, lead * 0.55); chest.quaternion.multiply(_leadQ); }
      // The head goes furthest and gets there first — it is looking at where
      // the player has decided to be, which is the whole reason the rest turns.
      if (head) { _leadQ.setFromAxisAngle(_leadAx, lead * 0.85); head.quaternion.multiply(_leadQ); }
    }

    // Flying-flag effect pool (spawned on flag pulls)
    var flags = makeFlagPool(THREE, 10);
    scene.add(flags.group);

    // Slash route: the line you drew, painted on the turf and eaten away as the
    // player runs it, so you can always see how much of the order is left.
    var slashInk = makeSlashInk(THREE);
    scene.add(slashInk.group);

    /* ========================== CELEBRATIONS ============================
       A touchdown and a first down are both good news and they are not the
       same news, so they must not look the same. The engine says WHICH
       happened, WHERE, and to which side (engine._celebrate); everything about
       how big it looks lives here.

           td         the whole scoring side, for nearly three seconds: high
                      jumps, the scorer spins to the camera, and a seven-yard
                      shockwave opening under the scorer.
           firstdown  the carrier and anyone standing within eight yards, for a
                      beat: a bounce, a turn toward the man who moved the
                      chains, and a ring a third the size.

       NO CONFETTI. It used to bury the shot in paper — five waves of 130
       pieces at a touchdown, drifting through the frame for six seconds. The
       celebration is what the players do; the paper was in front of it.

       HOP_RATE is 2*PI on purpose: the baked Celebrate clip hops twice a second
       (tools/build-player-glb.mjs, HOP) and its action is reset when the
       celebration starts, so a hop added at that rate lands WITH the clip's own
       instead of beating against it.

       Nobody is TRANSLATED by any of this. The engine stops moving players the
       moment the ball is dead (_update returns unless phase is 'live'), so a
       renderer-side mob would be five bodies sliding across the turf under a
       stationary clip — the exact skate the stride matching above exists to
       kill. Celebrations are performed on the spot. */
    var CELEB = {
      td:        { dur: 2.5,  hop: 0.34, radius: Infinity, stagger: 0.13, spin: 0.85,
                   ring: { r: 7.0, dur: 0.75 }, star: 1.35 },
      firstdown: { dur: 1.25, hop: 0.14, radius: 8,        stagger: 0.05, spin: 0,
                   ring: { r: 2.6, dur: 0.40 }, star: 1.15 },
      /* A takeaway is the defence's touchdown. It gets the whole side, like a
         score, but a beat shorter and without the spin: the man holding the
         ball has just turned upfield out of habit and the celebration is the
         other four arriving at him, not a pose for the camera. */
      takeaway:  { dur: 2.1,  hop: 0.30, radius: Infinity, stagger: 0.10, spin: 0.35,
                   ring: { r: 5.5, dur: 0.65 }, star: 1.30 }
    };
    var HOP_RATE = Math.PI * 2;

    /* WHO DOES WHAT IN THE END ZONE.

       The scorer spikes the ball — once, because a spike is an event — and then
       dances. Everyone else picks one of the four looping celebrations off
       their own roster index, so a group is four different silhouettes rather
       than one clip played ten times in unison. Deterministic in the index, so
       the same player celebrates the same way all game and it reads as
       character instead of noise.

       Only a touchdown gets the full range: a first down is a beat, not a
       party, so it keeps the hop everyone already knows. */
    var CELEB_LOOPS = ['dance', 'highstep', 'flex', 'celebrate'];
    function celebClipFor(ud, cel) {
      if (cel.cfg.radius !== Infinity) return 'celebrate';
      if (cel.star) return 'dance';
      return CELEB_LOOPS[(ud.idx * 3 + 1) % CELEB_LOOPS.length];
    }
    var celeb = { kind: '', cfg: null, t: 0, dur: 0, team: null, x: MID, y: WID / 2 };

    // The shockwave on the turf — the only thing the celebration draws that
    // isn't a player.
    var shock = makeShockRing(THREE);
    scene.add(shock.mesh);

    function startCeleb(kind, a) {
      var cfg = CELEB[kind];
      if (!cfg) return;
      celeb.kind = kind; celeb.cfg = cfg;
      celeb.t = 0; celeb.dur = cfg.dur;
      celeb.team = a.team || null;
      celeb.x = (a.x != null && isFinite(a.x)) ? a.x : MID;
      celeb.y = (a.y != null && isFinite(a.y)) ? a.y : WID / 2;
      shock.fire(wx(celeb.x), wz(celeb.y), cfg.ring.r, cfg.ring.dur);
    }

    /* Advance the celebration clock. Called once per frame, before the players
       are synced, so a celebration that starts this frame is already running
       when they read it. */
    function updateCeleb(dt) {
      if (celeb.dur <= 0) return;
      celeb.t += dt;
      if (celeb.t >= celeb.dur) { celeb.dur = 0; celeb.kind = ''; celeb.cfg = null; }
    }

    function stopCeleb() { celeb.dur = 0; celeb.kind = ''; celeb.cfg = null; }

    /* Is this player celebrating, and how hard? null when they are not.
       Membership is re-derived every frame rather than captured, which is only
       sound because nothing moves while the ball is dead — and the one thing
       that WOULD move everybody, a new formation, stops the celebration
       outright (rebuildPlayers). */
    function celebFor(gp, ud, state) {
      var cfg = celeb.cfg;
      if (!cfg || celeb.dur <= 0 || !celeb.team || gp.team !== celeb.team) return null;
      if (isFinite(cfg.radius) && Math.hypot(gp.x - celeb.x, gp.y - celeb.y) > cfg.radius) return null;
      var age = celeb.t - (ud.idx % 5) * cfg.stagger;
      if (age <= 0) return null;
      // Ease in so the first frame isn't a pop, and out so the last isn't.
      var w = Math.min(1, age / 0.18, Math.max(0, celeb.dur - celeb.t) / 0.35);
      return { cfg: cfg, age: age, w: w, star: (state.carrier === gp) };
    }

    // Realistic rigged players (FLAGSTER.Player3D) are (re)built whenever the
    // roster array changes. Each entry: { P, ring, ud }.
    var PLAYER3D = global.FLAGSTER && global.FLAGSTER.Player3D;
    var PM = global.FLAGSTER && global.FLAGSTER.PlayerModel;
    // Human scale: the rig is ~2.39yd tall, so 0.87 puts players at ~6'2".
    // (It was 1.45 — which rendered ~10ft-tall giants.)

    /* STRIDE MATCHING — why the players used to skate, and why they used to
       whir.

       A clip with no root motion only looks planted if the support foot sweeps
       backward at exactly the speed the ground moves under it. That rate is a
       property of the CLIP, and it used to be a pair of constants measured by
       hand and copied in here under a comment asking whoever edits the gait
       tables to keep them in step. That is a promise no comment can keep, and
       it was broken twice — once when the run's stride grew 32% and the divisor
       didn't, and once, invisibly and for the whole life of the clip, for the
       BACKPEDAL, which had no constant of its own and borrowed the RUN's.

       So nobody measures it here any more: tools/build-player-glb.mjs computes
       each gait's ground speed from the same kinematics it builds the clip from
       and bakes it into the .glb, and playermodel.js reads it back.

       That fixed the skating and left the OTHER half of the problem, which is
       that a clip can only be played faster. Playback rate changes cadence and
       nothing else — the baked stride stays exactly as long as it was authored
       — so a receiver at 8.5yd/s was taking a jogger's steps 45% more often
       than a runner does, and the whole squad read as wind-up toys. Speed is
       stride length times stride frequency and both of them rise.

       So locomotion now goes through P.gait(kind, speed), which blends the two
       authored strides that bracket that speed out of a four-rung ladder
       (Walk / Jog / Run / Sprint). See playermodel.js for how the weight is
       chosen; the short version is that stride length and cadence both come out
       at the values authored for that speed, and the playback rate stays at
       1.0. The fallback rigs in player3d.js have no ladder to blend and keep
       the old behaviour behind the same call — see gaitShim() there. */
    var WALK_MAX = 2.4;              // "running" for the ball-carry arm drive
    var PLAYER_LIFT = 0.10;    // rig dips slightly below its origin; sit feet on turf

    var pMeshes = [];          // parallel to state.players (entry objects)
    var playersRef = null;

    var camFx = MID;           // smoothed camera focus (field X)
    var camFz = null;          // smoothed camera lateral follow (world Z)
    var chaseW = 0;            // 0..1: how much the look-at is on a ball in flight
    var holdW = 0;             // 0..1: ...and how much of it is on a ball carrier
                               // (not ud.carryW, which is the carry-POSE blend)
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
    /* One identity per player, and the SAME one everywhere. Build and
       appearance both hang off this, so a player's height and their face are
       two views of the same person — and neither changes when the lineup
       reorders, which is exactly what keying on the roster index did. */
    function seedOf(gp, idx) {
      return String((gp.data && gp.data.id) || gp.last || ('slot-' + idx));
    }
    function bodyOf(gp, idx) {
      var key = gp.pos || gp.slot || 'QB';
      var d = BUILD[key] || BUILD.QB;
      var spd = (gp.data && gp.data.speed) || 70;
      // Faster players carry less: a little taller, a little leaner.
      var lean = (spd - 70) / 60;                    // roughly -0.5 .. +0.5
      // A stable per-player wobble so a squad isn't ten clones of two moulds.
      var seed = 0, id = seedOf(gp, idx);
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
        /* Who this player looks like. Skin tone used to be
           SKINS[idx % SKINS.length] — keyed on where they stood in the lineup,
           so a complexion changed when the lineup reordered and slot 0 on both
           teams always matched — and hair colour was never passed at all, so
           all ten wore the same near-black. */
        var look = (PM && PM.appearanceOf)
          ? PM.appearanceOf(seedOf(gp, idx), gp.data && gp.data.gender)
          : {};
        var P = PLAYER3D.build(THREE, {
          jersey: cols[0], trim: cols[1] || '#ffffff',
          skin: look.skin, hair: look.hair, hairStyle: look.hairStyle,
          facialHair: look.facialHair, headband: look.headband,
          headScale: look.headScale, gender: look.gender, face: look.face,
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
        /* A taller athlete's stride really does cover more ground, so the gait
           ladder's rungs are scaled by this player's own build before anything
           is bracketed against them. */
        if (P.setBuildScale) P.setBuildScale(b.h);
        /* TEN MEN, NOT ONE MAN TEN TIMES.

           Every clip in this game starts at time zero, so a formation breaking
           on the snap used to put ten players into the run cycle within a few
           frames of each other and then hold them there: identical stride,
           identical cadence, left feet landing together for the whole play.
           Nothing else on the field says "animation" as loudly as that.

           A stride phase is the cheapest possible fix and an honest one — real
           players are not in step either. Deterministic in the player's own id
           so a given athlete is not re-rolled every formation. */
        var pseed = 0, pid = String((gp.data && gp.data.id) || gp.last || idx) + ':' + idx;
        for (var pi = 0; pi < pid.length; pi++) pseed = (pseed * 131 + pid.charCodeAt(pi)) & 0x7fff;
        if (P.setPhaseOffset) P.setPhaseOffset((pseed % 997) / 997);
        pMeshes.push({
          P: P, holder: holder, ring: ring,
          ud: { idx: idx, yaw: seedYaw, celebT: 0, _wasPulled: false, _pulled: false, _threw: false,
                _caught: false, _juked: false, _spiked: false, clip: 'idle',
                carryKey: '', carrySide: 0, carryW: 0, carryAmp: 0, grabW: 0,
                pvx: 0, pvy: 0, fLat: 0, fTan: 0, bank: 0, pitch: 0, lead: 0 }
        });
      });
      playersRef = players;
      /* A new formation is ten new bodies at ten new spots: whatever they were
         celebrating, these are not the men who did it. */
      stopCeleb();
    }

    // Advance one player's Player3D: position, facing, clip selection, one-shots.
    function syncPlayer(entry, gp, dt, state) {
      var P = entry.P, ud = entry.ud, holder = entry.holder;

      /* Celebrating? Then this player jumps, and how high is the whole
         difference between "we scored" and "we moved the chains". The hop is
         added to the HOLDER, not the rig: the mixer owns root.position (the
         clip's own little hop lives there) and would overwrite anything
         written to it. */
      var cel = celebFor(gp, ud, state);
      var hop = 0;
      if (cel) {
        hop = cel.cfg.hop * cel.w * (cel.star ? cel.cfg.star : 1) *
              Math.abs(Math.sin(cel.age * HOP_RATE));
      }
      holder.position.set(wx(gp.x), PLAYER_LIFT + hop, wz(gp.y));

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

      /* ---- WHAT THE BODY IS DOING TO ITS OWN MOMENTUM --------------------
         Everything about a change of direction that reads at chase-camera
         distance comes out of two numbers, and neither of them is in the
         clips: how hard this player is turning, and how hard they are
         speeding up or slowing down. So differentiate the velocity the engine
         publishes and split the result along the line of travel and across it.

         A body that turns without leaning is the single most robotic thing a
         runner can do — a real one has no choice, because the only way to
         produce a sideways force is to put the feet outside the centre of mass
         and fall inward. The lean angle is not a style parameter either; it is
         atan(lateral acceleration / gravity), which is why it is computed
         rather than tuned. Same for the fore/aft lean under acceleration and
         braking: lean forward and the ground reaction pushes you along.

         Both are eased, hard, because a raw frame-to-frame difference of a
         velocity that the engine itself steers is noisy enough to jitter. */
      var ax = 0, ay = 0;
      if (dt > 0.0005) { ax = (vx - ud.pvx) / dt; ay = (vy - ud.pvy) / dt; }
      ud.pvx = vx; ud.pvy = vy;
      var ux = speed > 0.2 ? vx / speed : Math.cos(ud.yaw);
      var uy = speed > 0.2 ? vy / speed : Math.sin(ud.yaw);
      var aTan = ax * ux + ay * uy;                 // + = speeding up
      var aLat = ay * ux - ax * uy;                 // + = turning to their LEFT
      /* Below a walking pace there is no momentum to lean on, and a player
         standing still differentiating engine noise would wobble. Nor is a
         celebration locomotion: a man spiking a ball is allowed to throw his
         weight around without the physics of running commenting on it. */
      var leanOn = cel ? 0 : clamp((speed - 0.8) / 1.6, 0, 1);
      var G = 10.73;                                // 9.81 m/s^2, in yards

      /* FILTER THE FORCE, NOT JUST THE ANGLE. atan(lateral acceleration / g)
         is the right formula and the wrong input to feed it raw: what comes
         out of differentiating the engine's velocity is a steering controller
         riding its own cross-acceleration limit, plus the separation nudges
         that keep bodies apart, and neither is a cut. Measured, that put the
         median player at a 12.6-degree bank with a THIRD of all running frames
         past 20 and the peak pinned to the clamp — ten men leaning like
         motorcycles for most of every play.

         A lean is the body's answer to a force it has to hold for long enough
         to fall into, so the acceleration is low-passed first (~0.28s) and
         only what survives that leans anybody. Spikes that last a frame or two
         now produce almost nothing, and a genuine sustained cut still produces
         the full angle. */
      ud.fLat += (aLat - ud.fLat) * ease(3.6, dt);
      ud.fTan += (aTan - ud.fTan) * ease(3.6, dt);
      /* And a ceiling a running human actually reaches. 0.46rad is 26 degrees,
         which is tan = 0.49g held through the whole turn — a speed skater, not
         a flag footballer changing direction on grass in trainers. */
      var bankT = clamp(Math.atan2(ud.fLat, G), -0.27, 0.27) * leanOn;
      var pitchT = clamp(Math.atan2(ud.fTan, G), -0.20, 0.24) * leanOn;
      /* Attack fast, release slow. A cut is an event — the lean has to be there
         on the step that makes it, not a beat later — but coming out of one is
         a recovery and settles over a longer count. */
      ud.bank += (bankT - ud.bank) * ease(Math.abs(bankT) > Math.abs(ud.bank) ? 13 : 6, dt);
      ud.pitch += (pitchT - ud.pitch) * ease(7, dt);
      ud.lead += (clamp(ud.fLat / 24, -0.30, 0.30) * leanOn - ud.lead) * ease(9, dt);

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
      if (cel) {
        /* A celebration is PLAYED TO somebody or it is a man waving at grass.
           The scorer turns to the camera — which is always behind the offence,
           so that is yaw PI, always — and spins once on the way round; every
           team-mate turns to face them. */
        if (cel.star) {
          var spin = cel.cfg.spin;
          // One full turn over `spin` seconds, ending exactly back at PI so
          // there is no jump when it finishes.
          yawT = Math.PI - (spin && cel.age < spin ? (cel.age / spin) * Math.PI * 2 : 0);
          yawT += Math.sin(cel.age * 3.1) * 0.18;             // never quite still
        } else {
          yawT = Math.atan2(celeb.y - gp.y, celeb.x - gp.x) + Math.sin(cel.age * 2.7 + ud.idx) * 0.16;
        }
      } else if (throwing) {
        /* TURN AND THROW, IN THAT ORDER. This used to read only ball.to and
           state.thrownTo, and neither of those exists until the ball is
           already airborne — so through the entire wind-up the quarterback
           kept whatever facing the dropback left him with (usually pointing
           back at his own goal line, because a backpedal faces its direction
           of travel), and only began turning downfield AFTER the pass had
           left. The whole clip — the coil, the stride, the release — played
           at ninety degrees to where the ball was going.

           pendingThrow.target is known the instant the wind-up starts, which
           is what makes the throw a throw at somebody. */
        var to = (state.pendingThrow && state.pendingThrow.target) ||
                 (state.ball && state.ball.to) || state.thrownTo;
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
      /* A juke is a sidestep and a throw is a turn-and-fire; both have to beat
         the default easing or the body arrives after the event it belongs to.
         The wind-up is 374ms long and a quarterback coming out of a dropback
         can be most of a half-turn away from his receiver. */
      /* A juke is a sidestep and a throw is a turn-and-fire; both have to beat
         the default easing. So does a hard cut, and for the same reason: the
         hips arriving a beat after the change of direction is exactly the lag
         that reads as a body being dragged along behind its own feet. The boost
         is proportional to how hard the turn actually is, so a gentle drift is
         still eased and a plant-and-go snaps. */
      var turnBoost = 1 + clamp(Math.abs(aLat) / 13, 0, 1.3);
      P.face(yawT, (juking || throwing) ? dt * 2.2 : dt * turnBoost);

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
      /* The Throw clip's first frame IS the READY grip, bone for bone, so the
         carry pose has nothing left to contribute and every frame it survives
         it drags the wind-up back toward a static hold. It used to fade over
         ~0.3s, which is four fifths of the way to the release. Drop it. */
      if (throwing && !ud._threw) { P.oneShot('throw', 'idle'); ud._threw = true; ud.carryW = 0; }
      if (!throwing) ud._threw = false;

      // Juke: the carrier breaks a grip with a sidestep.
      if (juking && !ud._juked) { P.oneShot('juke', 'run'); ud._juked = true; }
      if (!juking) ud._juked = false;

      // Catch: targeted receiver secures the ball as it arrives.
      if (reaching) ud._caught = false;                 // re-arm while ball inbound
      if (!ud._caught && state.thrownTo === gp && !ballInAir && carrier === gp) {
        P.oneShot('catch', 'run'); ud._caught = true;
      }

      // Flag pull, the carrier's half: jerked to a stop, hands up, flag gone.
      if (gp.flagPulled && !ud._wasPulled) {
        P.oneShot('flagPull', 'idle');            // -> FlagPulled, the reaction
        flags.burst(holder.position.x, 0.9, holder.position.z, cols0(gp));
        ud._wasPulled = true;
        ud.carryW = 0;
      }
      if (!gp.flagPulled) ud._wasPulled = false;

      /* Flag pull, the defender's half: the rip. Who made the play used to be
         guessed here by scanning for the nearest opponent to the man who went
         down; the engine names them (pullFx), so take the name. */
      if ((gp.pullFx || 0) > 0 && !ud._pulled) {
        P.oneShot('flagGrab', 'celebrate');
        ud._pulled = true;
        ud.celebT = 1.6;                          // hold the celebration after it
      }
      if (!(gp.pullFx > 0)) ud._pulled = false;

      // ---- LOOP clip selection (skip while a one-shot is running) ----------
      /* THE SPIKE, fired once when a scorer starts celebrating. It is a
         one-shot rather than part of the loop selection below because it is an
         event with a beginning and an end, and because its last pose is the
         arms-wide finish the Dance it hands over to begins from — which is what
         keeps the crossfade out of it from swinging both arms down and straight
         back up again. */
      if (cel && cel.star && cel.cfg.radius === Infinity && celeb.kind === 'td' && !ud._spiked) {
        P.oneShot('spike', 'dance'); ud._spiked = true;
      }
      if (!cel) ud._spiked = false;

      if (!P._oneShot) {
        if (cel) {
          P.play(celebClipFor(ud, cel));
        } else if (ud.celebT > 0) {
          P.play('celebrate');
        } else if (live && moving) {
          /* One call for every speed and both directions. The ladder inside
             picks the two authored strides that bracket this player and blends
             them, so a walk becomes a jog becomes a run becomes a sprint
             without a threshold anywhere in here to cross and hitch on. */
          if (P.gait) P.gait(backpedal ? 'backward' : 'forward', speed);
        } else {
          P.play('idle');                       // stand down between/at end of plays
        }
      }

      /* ---- LEAN --------------------------------------------------------
         Applied to the HOLDER, not to the rig, and that is the whole trick:
         the holder's origin sits on the turf between the player's feet, so
         rotating it pivots the body about its contact patch. The feet stay
         where they were planted and the head swings; rotate the rig instead
         and the pivot is the pelvis, which drives the inside foot through the
         ground and lifts the outside one off it.

         Axes are built from the direction of TRAVEL rather than from the
         facing, because banking is a property of the momentum. Roll about the
         line of travel is the turn; pitch about the axis across it is the
         acceleration. */
      if (Math.abs(ud.bank) > 1e-4 || Math.abs(ud.pitch) > 1e-4) {
        var dirx = ux, dirz = uy;                       // field y is world z
        _axis.set(dirx, 0, dirz);
        _qbank.setFromAxisAngle(_axis, ud.bank);        // + rolls onto their left
        _axis.set(dirz, 0, -dirx);
        _qpitch.setFromAxisAngle(_axis, ud.pitch);      // + tips the chest forward
        holder.quaternion.copy(_qpitch).multiply(_qbank);
      } else if (holder.quaternion.w !== 1) {
        holder.quaternion.identity();
      }

      P.update(dt);

      /* ---- THE SHOULDERS GO FIRST ---------------------------------------
         Watch anyone cut and the order is head, then shoulders, then hips,
         then feet — the top of the body commits to the new direction before
         there is any way for the bottom of it to follow. Rotating the whole
         player as one rigid heading is the thing that makes a turn read as a
         turret. This gives the chest and the head a few degrees of yaw toward
         the inside of the turn, over the top of whatever the gait wrote, which
         puts that ordering back for the price of two slerps.

         It is layered after the mixer for the same reason the ball carry is:
         the clip has already written these bones this frame, and the point is
         to bias what it wrote rather than to replace it. */
      if (Math.abs(ud.lead) > 0.004 && !P._oneShot) leadTrunk(P, ud.lead);

      /* ---- CARRY POSE (after the mixer, so it overrides the clip) ---------
         The clip has already written every bone for this frame; the arm around
         the ball is layered on top of it by slerping the two shoulder joints
         part of the way toward the carry pose. `carryW` is what makes that a
         blend rather than a switch — it fades out under any one-shot (the
         throw, the catch, the juke all own the arms while they run) and back
         in afterwards, and it fades through zero to change pose so a passer
         tucking the ball and running doesn't snap between the two. */
      /* `state.carrier` IS who has the ball, so that is the whole test. The
         `&& !gp.flagPulled` that used to be here was dead — nothing ever set
         flagPulled — and the moment the engine started setting it, it became
         wrong: it dropped the carry grip on the same frame the flag came off,
         which unparents the ball from the hand and pops it to a world-space
         fallback position beside the player. Losing your flag does not make
         the ball leave your hands; the whistle does, a beat later. */
      var holdingIt = (carrier === gp);
      var readying = holdingIt && gp === state.passer && !state.handoffDone && !state.pendingThrow;
      // The ready position lives in the THROWING hand, which is the right one —
      // the same hand the wind-up hands the ball to — so it is not sided by the
      // nearest defender the way a runner's tuck is.
      if (holdingIt && !ud.carrySide) ud.carrySide = carrySide(state, gp);
      if (!holdingIt) ud.carrySide = 0;
      var wantKey = holdingIt ? (readying ? 'ready-1' : 'carry' + ud.carrySide) : '';
      /* A one-shot is driving the arms itself; give way to it and come back.
         So is a celebration, and for the same reason: the Celebrate clip puts
         both arms over the head, and blending a ball-tuck into one shoulder
         while it does that leaves a man who has just scored standing there with
         his arm down. Only the POSE is dropped — carryKey survives, so the ball
         stays parented to the forearm and goes up with it, which is what a
         scorer holding it aloft actually is. */
      var wantW = (holdingIt && !P._oneShot && !cel && wantKey === ud.carryKey) ? 1 : 0;
      ud.carryW += (wantW - ud.carryW) * ease(9, dt);
      if (ud.carryW < 0.02 && wantKey !== ud.carryKey) { ud.carryKey = wantKey; ud.carryW = 0; }
      if (ud.carryW > 0.001 && ud.carryKey) {
        /* How hard the arm drives. Off at a standstill, full by the time the
           run clip has taken over, so the pump arrives with the running rather
           than switching on. Eased frame to frame as well, because the clip
           itself crossfades and a step change in amplitude across that would
           show as a hitch in the one limb that is holding the ball. */
        var wantAmp = P.stridePhase ? clamp((speed - 1.2) / (WALK_MAX - 0.6), 0, 1) : 0;
        ud.carryAmp += (wantAmp - ud.carryAmp) * ease(6, dt);
        poseGrip(P, gripFor(ud.carryKey), sideFor(ud.carryKey), ud.carryW,
                 P.stridePhase ? P.stridePhase() : null, ud.carryAmp);
      }

      /* ---- REACHING FOR THE FLAG -----------------------------------------
         Same idea as the carry pose and applied the same way: after the mixer,
         over the top of the run cycle, faded in and out so the arms come up
         into the reach and drop back out of it when the engagement breaks. The
         legs keep running underneath, which is right — a defender chasing
         somebody down does not stop to reach. */
      var grabbing = (state.grabbedBy === gp && !gp.flagPulled && !P._oneShot);
      ud.grabW += ((grabbing ? 1 : 0) - ud.grabW) * ease(11, dt);
      if (ud.grabW > 0.001) poseReach(P, ud.grabW);

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
       the look-at toward the ball until it isn't — no further.

       "No further" has to mean it exactly, and for a long time it did not.

       THE SIDELINE SHUDDER. This used to step a THIRD of the way toward the
       ball and re-test, up to six times, which makes the correction a staircase
       rather than a function: nought, or a third, or five ninths, with nothing
       in between. Put that inside a loop whose other half is an ease pulling
       the shot back toward the middle of the field and you have a bang-bang
       controller. The equilibrium is not a fixed point but a limit cycle: the
       ease creeps the carrier out past the safe edge over three or four frames,
       one 34% step slams him back well inside it, and the whole thing repeats
       several times a second. It only bites when the correction is needed at
       all, which is exactly when the ball carrier is near a touchline — worst
       on a phone, whose lens is much narrower across.

       Simulated against a runner cutting to the touchline in portrait, the old
       staircase moved the look-at by up to 1.36 world units of frame-to-frame
       acceleration (mean 0.48). Solving instead for the SMALLEST lerp that puts
       the ball exactly on the safe boundary — by bisection, so the correction
       is a continuous function of where the ball is — leaves the same shot with
       a peak of 0.0027 and a mean of 0.00028, and turns the limit cycle into a
       genuine fixed point: the target settles ON the boundary and tracks it.

       Writing the correction back into _target (rather than applying it after
       the fact) means the next frame eases from the corrected shot, so a hard
       chase settles into a smooth one instead of fighting the filter. */
    var SAFE = 0.72;                     // keep the ball inside 72% of the frame
    // (_bndc, not _ndc — the screen picker already owns that name in this scope.)
    var _ballW = new THREE.Vector3(), _bndc = new THREE.Vector3(), _keep = new THREE.Vector3();
    // Is the world point outside the safe box, for the camera as it stands?
    // Behind the lens (w < 0 flips the projection) counts as out of frame.
    function outOfFrame(pt) {
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      _bndc.copy(pt).project(camera);
      return _bndc.z > 1 || Math.abs(_bndc.x) > SAFE || Math.abs(_bndc.y) > SAFE;
    }
    /* Takes WORLD coords rather than reading the ball out of state, because the
       guarantee is not about the ball object — it is about whatever the shot is
       currently required to contain. In flight that is the ball; the rest of
       the time it is the player holding it. */
    function keepInFrame(px, py, pz) {
      _ballW.set(px, py, pz);
      if (!outOfFrame(_ballW)) return;
      _keep.copy(_target);                       // the cinematic shot, to move from
      var aim = function (t) { _target.copy(_keep).lerp(_ballW, t); camera.lookAt(_target); };
      // Aiming dead at it is the most this can do. If even that leaves the ball
      // outside (it is behind the lens, or the safe box is tighter than the
      // lens is wide), stay there rather than searching for a t that isn't
      // there — and, critically, don't fall back to the uncorrected shot.
      aim(1);
      if (outOfFrame(_ballW)) return;
      var lo = 0, hi = 1;                        // out at lo, in at hi
      for (var i = 0; i < 11; i++) {
        var mid = (lo + hi) / 2;
        aim(mid);
        if (outOfFrame(_ballW)) lo = mid; else hi = mid;
      }
      aim(hi);
    }

    /* ===================== WHERE THE BALL IS ABOUT TO BE ==================
       Everything downstream of this is a lag filter, so a camera aimed at where
       the ball IS is always behind it by its own settling time — speed divided
       by ease rate, about two yards behind a runner and three behind a pass.
       Aiming slightly AHEAD cancels that, and costs nothing when the ball
       changes direction because keepInFrame() is still underneath as the
       guarantee.

           carried    lead by the carrier's own velocity. rvx/rvy is what the
                      body actually did last frame (the engine publishes it),
                      not what it intended, so this leads a real cut rather than
                      an input. Only while the ball is live: the engine stops
                      updating players the moment it's dead, and leading a
                      standing man would just park the shot four yards past him.
           in flight  the engine solved the catch point the instant the ball
                      left the hand (ball.to). Aim between the ball and that
                      point, weighted further toward it as the flight runs down,
                      and the camera is at the catch before the ball is.
           loose      the ball itself, wherever it is — bouncing after an
                      incompletion, in the snap, sitting on the spot.

       LOS is the last resort only, for the frames before a ball exists at all. */
    var CARRY_LEAD = 0.38;               // seconds of the carrier's velocity
    var _focus = { x: MID, y: WID / 2 };
    function ballFocus(state) {
      var f = _focus, c = state.carrier, b = state.ball;
      if (c) {
        var lead = (state.phase === 'live') ? CARRY_LEAD : 0;
        f.x = c.x + (c.rvx != null ? c.rvx : (c.vx || 0)) * lead;
        f.y = c.y + (c.rvy != null ? c.rvy : (c.vy || 0)) * lead;
      } else if (b && b.inAir) {
        var k = (b.dur > 0) ? clamp((b.t || 0) / b.dur, 0, 1) : 1;
        if (b.to) {
          var w = 0.45 + 0.55 * k;       // 45% of the way there at the release
          f.x = lerp(b.x, b.to.x, w); f.y = lerp(b.y, b.to.y, w);
        } else { f.x = b.x; f.y = b.y; }
      } else if (b && b.x != null && isFinite(b.x)) {
        f.x = b.x; f.y = b.y;
      } else if (state.losX != null && isFinite(state.losX)) {
        f.x = state.losX; f.y = WID / 2;
      } else { f.x = MID; f.y = WID / 2; }
      if (!isFinite(f.x)) f.x = MID;
      if (!isFinite(f.y)) f.y = WID / 2;
      return f;
    }

    function updateCamera(state, dt) {
      /* BEHIND WHOEVER HAS THE BALL.

         This used to be behind whichever side the USER was playing, flipping
         end-for-end with possession so that on defence you watched the offence
         run at the lens. The offence always attacks +x, whichever team it is,
         so "behind the ball" is not a variable at all — it is one side of the
         field, always, and an interception simply hands the shot to the other
         eleven without the camera going anywhere.

         `s` is kept rather than folded away because it is the whole geometry of
         this camera (back one way, look-at the other) and every use of it
         downstream still wants to say which way is downfield. */
      var s = 1;                                   // the offence attacks toward +x
      var C = (viewAspect < 1.0) ? CAM.tall : CAM.wide;

      if (camera.fov !== C.fov) { camera.fov = C.fov; camera.updateProjectionMatrix(); }

      /* FOCUS — the ball, at every moment of the game, and never anything else
         while there is a ball to have. It used to be "the carrier, else a ball
         in flight, else the line of scrimmage", and that last clause is a hole:
         an incomplete pass clears the carrier and lands the ball twenty yards
         downfield, and the shot cut straight back to the old spot while the
         ball was still bouncing. ballFocus() has no such fallback. */
      var fo = ballFocus(state);
      var focusFx = fo.x, focusFy = fo.y;
      if (!state.carrier && (state.phase === 'presnap' || state.phase === 'playcall')) {
        // Pre-snap, sit back off the ball so the whole formation is in frame.
        focusFx -= s * 3;
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
      camFz = lerp(camFz, latTarget, ease(chasing ? 6.0 : 2.4, dt));

      /* SETTLE BETWEEN PLAYS, EASE DURING THEM. A turnover or a new drive can
         move the ball thirty yards up the field while nothing is happening,
         and easing across that at 4.5/s takes about a second — which the
         playcall and the snap can both happen inside, so the ball is live
         again while the lens is still travelling and is briefly DOWNFIELD of
         the man carrying it. Measured over a demo: 10% of live frames, all of
         them in the second after a change of possession.

         A long jump while the ball is dead is not a camera move, it is a
         camera being repositioned, so just put it there. Anything the eye is
         meant to follow — the play itself — still eases exactly as before.

         The live threshold is deliberately far above anything a play can
         produce: an eased follower's steady-state lag is speed/rate, which is
         2 yards behind a 9yd/s runner and 3 behind a 22yd/s pass. A gap of
         fourteen is not a camera following something, it is a camera that has
         been left at the other end of the field. */
      var live3d = (state.phase === 'live');
      var jumped = Math.abs(focusFx - camFx) > (live3d ? 14 : 8);
      if (jumped) camFx = focusFx;
      else camFx = lerp(camFx, focusFx, ease(chasing ? 7.0 : 4.5, dt));
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

      /* Ease, except when the shot was just repositioned. Snapping the FOCUS
         alone does nothing on its own — the lens has a second, slower filter of
         its own (3.2/s) and goes on gliding across the field for another
         second regardless, which is exactly the interval the camera was
         measured downfield of the man carrying the ball. Both have to move
         together or neither has. */
      var k = jumped ? 1 : ease(3.2, dt);
      camera.position.set(
        lerp(camera.position.x, camX, k),
        lerp(camera.position.y, C.height, k),
        lerp(camera.position.z, camFz, k)
      );

      /* FOLLOW THE PASS. Where the camera looks was a fixed point C.ahead down
         the field, and the ball stayed in shot only insofar as the lateral
         follow constants happened to suit — which they did not: a throw toward
         a sideline was measured 217 pixels outside a 1280-wide frame. */
      /* The look-at chases a ball in flight hard, and a CARRIER softly. The
         carrier half is new: the shot used to aim at a fixed point C.ahead down
         the field whenever nothing was airborne, so a runner breaking wide was
         held in frame only by the lateral follow, and on a phone (a narrow lens
         and a tall frame) that is not enough — he drifted to the edge while the
         lens went on staring at the middle of the field. */
      chaseW += ((chasing ? 1 : 0) - chaseW) * ease(4.5, dt);
      holdW += ((!chasing && state.carrier ? 1 : 0) - holdW) * ease(3.0, dt);
      var tx = lookX, ty = C.lookY, tz = camFz * 0.65;
      if (holdW > 0.001 && state.carrier) {
        var cw = holdW * 0.45;          // partial: keep some of the downfield lead
        tx = lerp(tx, wx(state.carrier.x), cw);
        tz = lerp(tz, wz(state.carrier.y), cw);
      }
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
      /* THE GUARANTEE, and it now covers the whole game rather than just the
         throws: whatever the ball is currently in — the air, or a pair of hands
         — is inside the safe box when this returns. Chest height for a carrier,
         because his feet are what the frame edge would clip first. */
      if (chasing && state.ball) keepInFrame(wx(state.ball.x), state.ball.z || 0, wz(state.ball.y));
      else if (state.carrier) keepInFrame(wx(state.carrier.x), 1.0, wz(state.carrier.y));
      else if (state.ball && state.ball.x != null && isFinite(state.ball.x)) {
        keepInFrame(wx(state.ball.x), state.ball.z || 0, wz(state.ball.y));
      }
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
        // The game is played in halves; only the jumbotron still said quarters.
        period: state.overtime ? 'OT' : ((state.halves ? 'H' : 'Q') + (state.quarter || 1)),
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

      /* Consume the engine's transient anims (flag/td/firstdown/incomplete) so
         they don't leak — the 2D renderer normally advances and clears these,
         and we skip 2D entirely. Done BEFORE the players are synced, and after
         the rebuild above, so a celebration triggered this frame is live on the
         same frame and a new formation can't be handed one. */
      if (engine && engine.anim && engine.anim.length) {
        for (var ai = 0; ai < engine.anim.length; ai++) {
          var av = engine.anim[ai];
          if (av.type === 'td' || av.type === 'firstdown' || av.type === 'takeaway') startCeleb(av.type, av);
        }
        engine.anim.length = 0;
      }
      updateCeleb(dt);

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
          /* LOOSE — nobody has it. Drawn at the height the engine says it is,
             which is the whole point: this used to be a hard-coded 1.0, so an
             incompletion left a football hovering a yard off the turf over an
             empty patch of grass until the next snap. The engine keeps it
             falling and bouncing now (Engine._updateLoose), and it lies where
             it stops. */
          hostBall(null);
          var lz = state.ball.z || 0;
          ball.position.set(wx(state.ball.x), Math.max(0.11, lz), wz(state.ball.y));
          // Tumbling while it falls, flat on its side once it has stopped.
          if (state.ball.loose) {
            spin = (spin + dt * 9) % (Math.PI * 2);
            ball.rotation.set(spin * 0.7, spin, Math.PI / 2 - spin * 0.25);
            ballShadow.visible = true;
            ballShadow.position.set(wx(state.ball.x), 0.02, wz(state.ball.y));
            var lk = clamp(lz / 3, 0, 1);
            ballShadow.scale.setScalar(1 + lk * 1.2);
            ballShadow.material.opacity = 0.34 * (1 - 0.6 * lk);
          } else {
            ball.rotation.set(0, 0, Math.PI / 2);
          }
        }
        applyTransfer(state, dt);
      } else { ball.visible = false; ballShadow.visible = false; }

      flags.update(dt);
      shock.update(dt);

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
      /* Same bargain for the celebrations: what the system thinks is running,
         and the height every body is ACTUALLY being drawn at, so the sweep can
         assert that players left the ground rather than assert that a function
         was called. */
      celebState: function () {
        return {
          kind: celeb.kind, t: celeb.t, dur: celeb.dur, team: celeb.team,
          lift: PLAYER_LIFT,
          y: pMeshes.map(function (e) { return e.holder.position.y; }),
          teams: (playersRef || []).map(function (p) { return p.team; })
        };
      },
      /* And the same bargain again for locomotion. Every number here is read
         back OFF the renderer rather than recomputed from the engine: which
         two rungs of the gait ladder are mounted and at what weight, the
         playback rate they are actually running at, the stride phase each body
         is at, how far this player's rendered facing is from their line of
         travel (the definition of skating), and how far they are leaning.
         A headless sweep can then assert that the squad is not in lockstep and
         that nobody is running sideways, instead of asserting that a function
         was called. */
      debugPlayers: function () {
        var frame = _dbgFrame++;
        var out = [];
        for (var i = 0; i < pMeshes.length; i++) {
          var e = pMeshes[i], gp = (playersRef || [])[i];
          if (!gp) continue;
          var g = e.P.gaitInfo ? e.P.gaitInfo() : null;
          var vx = gp.rvx != null ? gp.rvx : (gp.vx || 0);
          var vy = gp.rvy != null ? gp.rvy : (gp.vy || 0);
          var sp = Math.hypot(vx, vy);
          var skew = 0;
          if (sp > 0.4 && gp.faceYaw != null) {
            skew = Math.atan2(vy, vx) - gp.faceYaw;
            while (skew > Math.PI) skew -= Math.PI * 2;
            while (skew < -Math.PI) skew += Math.PI * 2;
            // Travelling backwards on purpose is a backpedal, not a skate.
            if (Math.abs(skew) > Math.PI / 2) skew = (skew > 0 ? Math.PI : -Math.PI) - skew;
          }
          out.push({ f: frame, i: i, speed: sp, skew: skew,
                     bank: e.ud.bank, pitch: e.ud.pitch, lead: e.ud.lead,
                     a: g ? g.a : '-', b: g ? g.b : '-', blend: g ? g.blend : 0,
                     rate: g ? g.rate : 0, phase: g ? g.phase : 0, w: g ? g.weight : 0 });
        }
        return out;
      },
      render: render, resize: resize, stop: stop };
  }
  var _dbgFrame = 0;

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

  /* ============================= SHOCKWAVE ============================== */
  /* A gold ring opening on the turf under whoever just did something, sized to
     the size of the thing they did. It is the same punctuation the flat
     renderer draws for a first down (engine._drawAnims), which is deliberate:
     one event, one visual language, in both renderers.

     It replaced a full-frame tint that was tried first and looked wrong for a
     reason worth recording: the composer's bloom threshold is 0.86, and washing
     the whole frame gold lifts EVERY pixel over it, so the entire scene blooms
     and the shot goes milky — including the celebration you were trying to draw
     attention to. Anything that covers the frame fights the grade. This does
     not: it is small, it is on the ground, and it is over in half a second. */
  function makeShockRing(THREE) {
    var geo = new THREE.RingGeometry(0.86, 1.0, 64);
    geo.rotateX(-Math.PI / 2);                       // lie flat on the turf
    var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffd23f, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false
    }));
    mesh.renderOrder = 3;
    mesh.visible = false;
    var t = 0, dur = 0, maxR = 1;

    function fire(x, z, r, seconds) {
      maxR = r || 4; dur = seconds || 0.5; t = dur;
      mesh.position.set(x, 0.06, z);
    }
    function update(dt) {
      if (t <= 0) { if (mesh.visible) mesh.visible = false; return; }
      t -= dt;
      if (t <= 0) { mesh.visible = false; return; }
      var k = 1 - t / dur;                           // 0 at the strike, 1 at the end
      mesh.visible = true;
      var r = 0.5 + (maxR - 0.5) * (1 - (1 - k) * (1 - k));   // fast, then easing out
      mesh.scale.set(r, 1, r);
      mesh.material.opacity = 0.85 * (1 - k) * (1 - k);
    }
    return { mesh: mesh, fire: fire, update: update };
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
