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
    function hostBall(node) {
      if (ballHost === node) return;
      if (node) node.add(ball); else scene.add(ball);
      ball.scale.setScalar(node ? 1 / PLAYER_SCALE : 1);
      ballHost = node;
    }
    // A named bone or socket on the player holding the ball, if the rigged
    // model is the one in play (the procedural fallback has neither).
    function carryNode(gp, name) {
      if (!gp || !playersRef) return null;
      var i = playersRef.indexOf(gp);
      if (i < 0 || !pMeshes[i]) return null;
      var P = pMeshes[i].P;
      if (!P) return null;
      return (P.sockets && P.sockets[name]) || (P.nodes && P.nodes[name]) || null;
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
        P.root.scale.setScalar(PLAYER_SCALE);
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
          ud: { yaw: seedYaw, celebT: 0, _wasPulled: false, _threw: false, _caught: false, _juked: false, clip: 'idle' }
        });
      });
      playersRef = players;
    }

    // Advance one player's Player3D: position, facing, clip selection, one-shots.
    function syncPlayer(entry, gp, dt, state) {
      var P = entry.P, ud = entry.ud, holder = entry.holder;
      holder.position.set(wx(gp.x), PLAYER_LIFT, wz(gp.y));

      var vx = gp.vx || 0, vy = gp.vy || 0;
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
        /* ...but not mid-juke. The sidestep drives the carrier hard across
           their own line for a fifth of a second, and facing into it would
           spin the body square to the cut. The Juke clip already carries the
           lateral weight shift — hips rotating about Z, the trail leg
           abducting — so the body holds its line and the clip does the step,
           which is what a juke actually is. */
        if (moving && !juking) yawT = Math.atan2(vy, vx);   // ball carrier faces motion
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

      // Lateral follow is damped hard — matching the carrier's sideways cuts
      // yard-for-yard swings the whole world sideways and reads as a camera
      // fault rather than a juke. Half-weight, and clamped near the hashes.
      var latTarget = clamp((focusFy - WID / 2) * 0.55, -5.0, 5.0);
      if (camFz == null) camFz = latTarget;
      camFz = lerp(camFz, latTarget, clamp(dt * 2.4, 0, 1));

      camFx = lerp(camFx, focusFx, clamp(dt * 4.5, 0, 1));
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
      _target.set(
        lerp(_target.x, lookX, k),
        lerp(_target.y, C.lookY, k),
        lerp(_target.z, camFz * 0.65, k)
      );
      camera.lookAt(_target);
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
          var bz = state.ball.z || 0;
          ball.position.set(wx(state.ball.x), 1.0 + bz, wz(state.ball.y));
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
          ball.rotateX(spin);                     // spiral about that axis
          // Shadow tracks the ground point and fades/grows with height.
          ballShadow.visible = true;
          ballShadow.position.set(wx(state.ball.x), 0.02, wz(state.ball.y));
          var k = clamp(bz / 6, 0, 1);
          ballShadow.scale.setScalar(1 + k * 1.6);
          ballShadow.material.opacity = 0.34 * (1 - 0.6 * k);
        } else if (state.pendingThrow && carryNode(state.pendingThrow.thrower, 'Socket_Hand_R')) {
          // Winding up: the ball rides the throwing hand, so it comes forward
          // with the arm and leaves from where the hand actually is.
          hostBall(carryNode(state.pendingThrow.thrower, 'Socket_Hand_R'));
          ball.position.set(0, 0, 0.02);
          ball.rotation.set(0, Math.PI / 2, 0.25);
        } else if (state.carrier) {
          /* CARRIED. This used to be a world-space guess — a fixed height of
             1.15 with an offset along fixed world axes — so the ball hung at a
             constant altitude while the player bobbed underneath it, and sat
             on a fixed compass side no matter which way they were facing. Park
             it on the chest bone instead and it inherits the whole body for
             free: the bob of the stride, the lean, the turn, the juke.

             High and tight: nose up, tucked on the diagonal between the upper
             arm and the ribs, on the OUTSIDE arm — away from the middle of the
             field, which is the side a carrier actually keeps it and the side
             the defenders aren't on. */
          var c = state.carrier;
          var chest = carryNode(c, 'Chest');
          if (chest) {
            var side = (c.y < WID / 2) ? -1 : 1;
            hostBall(chest);
            ball.position.set(side * 0.145, -0.06, 0.045);
            ball.rotation.set(0, side * 0.30, side * 1.05);
          } else {
            // Procedural fallback rig: no bones to hang it off, so approximate.
            hostBall(null);
            ball.position.set(wx(c.x) + Math.cos(-(c.ang || 0)) * 0.1, 1.15, wz(c.y) + 0.35);
            ball.rotation.set(0, -(c.ang || 0), 0.4);
          }
        } else {
          hostBall(null);
          ball.position.set(wx(state.ball.x), 1.0, wz(state.ball.y));
        }
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

  function makeBall(THREE) {
    /* Regulation, near enough. 1 unit = 1 yard, and an American football is
       11in long by 6.7in through the middle — 0.306 x 0.186 units. This was
       0.19r scaled 1.6, i.e. 0.61 x 0.38: dead on twice the size in every
       direction, which is why it read as a rugby ball. */
    var geo = new THREE.SphereGeometry(0.095, 14, 10);
    geo.scale(1.62, 1, 1);
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x7a4a20 }));
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
