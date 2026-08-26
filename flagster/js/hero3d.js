/* ============================================================================
   FLAGSTER — HERO 3D  (Three.js)
   A delightful top-down animated scene showcasing three REALISTIC rigged
   flag-football players (see player3d.js — a real AnimationMixer driving
   authored clips). Each player cycles through a distinct list of moves,
   switching every few seconds, driven entirely through the Player3D API:
     CARTER (blue)  — run / juke / highstep, weaving toward the camera
     RIVERA (red)   — celebrate / throw / dive (owns the ball prop)
     MÜLLER (green) — flaggrab / run / highstep (owns the loose-flag prop)
   Self-cleans (and disposes the Player3D instances + their mixers) when its
   canvas leaves the DOM, so it never leaks when you navigate away from the menu.
   ============================================================================ */
(function (global) {
  'use strict';

  function mount(canvas, opts) {
    if (!global.THREE || !canvas) return null;
    var THREE = global.THREE;
    var P3D = global.FLAGSTER && global.FLAGSTER.Player3D;
    if (!P3D) return null;
    opts = opts || {};

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    if (THREE.SRGBColorSpace !== undefined && 'outputColorSpace' in renderer) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else if (THREE.sRGBEncoding !== undefined) { renderer.outputEncoding = THREE.sRGBEncoding; }
    if (THREE.ACESFilmicToneMapping !== undefined) {
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.95;
    }
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b3d1e, 16, 34);

    // Top-down-ish camera (tilted so the 3D forms read nicely).
    // WORLD AXES / DIRECTION CONVENTION for this scene:
    //   - The camera sits at +Z and looks toward -Z (and down).
    //   - The cast plays TOWARD the viewer: they run, cut and lay out along +Z
    //     and the passes are thrown out at the camera, so you see faces and
    //     jersey fronts rather than three backs jogging away.
    //   - +X is screen-right, -X is screen-left. +Y is up.
    //   The rig faces local +Z and P.setYaw(yaw) sets root.rotation.y =
    //   PI/2 - yaw, so yaw 0 points the player at world +X (screen-right).
    //   The scene's named headings live in YAW below.
    var camera = new THREE.PerspectiveCamera(34, 2, 0.1, 1200);
    camera.position.set(0, 2.9, 8.4);
    camera.lookAt(0, 1.35, 0.6);

    // Lights
    // NOTE: r155+ uses physically-correct light units, so the r128-era values
    // rendered far too dark. Scaled to match the in-game stadium lighting.
    scene.add(new THREE.HemisphereLight(0xdff0ff, 0x4a7a4a, 2.0));
    var sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sun.position.set(-14, 26, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 1024; sun.shadow.mapSize.height = 1024;
    sun.shadow.camera.left = -18; sun.shadow.camera.right = 18;
    sun.shadow.camera.top = 18; sun.shadow.camera.bottom = -18;
    sun.shadow.bias = -0.0006;
    scene.add(sun);
    var heroFill = new THREE.DirectionalLight(0xbfd8ff, 0.5);
    heroFill.position.set(12, 16, -10); scene.add(heroFill);

    // ---- Stadium backdrop --------------------------------------------------
    // Reuse the in-game stadium + broadcast turf so the landing screen shows
    // the same world you actually play in. Falls back to the simple patch.
    var heroStadium = null;
    var ST = global.FLAGSTER && global.FLAGSTER.Stadium3D;
    if (ST) {
      try {
        var opt = { awayColor: '#0b5d3b', homeColor: '#1b2a6b', awayName: 'FLAGSTER', homeName: 'LA 2028' };
        heroStadium = ST.build(THREE, opt);
        if (heroStadium) scene.add(heroStadium);
        var heroTurf = ST.makeTurf(THREE, opt);
        if (heroTurf) { heroTurf.receiveShadow = true; scene.add(heroTurf); }
      } catch (e) { heroStadium = null; }
    }
    if (!heroStadium) scene.add(makeField(THREE));

    // ---- Three realistic players ------------------------------------------
    // Player3D model is ~2.1 units tall; the field patch is ~26x12. Scale so a
    // player reads at a good size for the tilted top-down cam (tuned by eye).
    var PSCALE = 0.87;      // ~6'2" at 1 unit = 1 yard (was a 3.8yd giant)

    // IMPORTANT: several Player3D clips animate root.position (an authored
    // vertical bounce), so the mixer overwrites P.root.position every frame.
    // We therefore translate an OUTER "carrier" group for field movement and
    // let the mixer own the inner root's local bounce. Facing (P.setYaw/face)
    // sets the inner root's rotation.y and survives for every clip except the
    // brief 'dive' (which authors its own forward pitch — acceptable).
    function makeP3D(cfg, name, number, x, z) {
      /* Three players stood on the menu with one face between them. They get
         the same seeded appearance the field does, keyed on the name, so the
         landing screen shows three different people — which is the first thing
         anyone sees of the roster. */
      var PMod = global.FLAGSTER && global.FLAGSTER.PlayerModel;
      var look = (PMod && PMod.appearanceOf) ? PMod.appearanceOf('hero:' + name) : {};
      var P = P3D.build(THREE, {
        jersey: cfg.jersey, trim: cfg.trim, number: number, name: name,
        skin: cfg.skin || look.skin, hair: look.hair, hairStyle: look.hairStyle,
        facialHair: look.facialHair, headband: look.headband,
        headScale: look.headScale, gender: look.gender, face: look.face
      });
      var carrier = new THREE.Group();
      carrier.scale.setScalar(PSCALE);
      carrier.position.set(x, 0, z);   // feet on the turf (rig origin is at the feet)
      P.root.traverse(function (o) { if (o.isMesh) o.castShadow = true; });
      if (P.setPlateScale) P.setPlateScale(0.6);
      carrier.add(P.root);
      scene.add(carrier);
      return { P: P, carrier: carrier };
    }

    var COL = {
      blue:  { jersey: '#2b5cff', trim: '#ffffff' },
      red:   { jersey: '#d80621', trim: '#ffdf00' },
      green: { jersey: '#2ec77a', trim: '#08331d' }
    };

    var ball = makeBall(THREE);
    scene.add(ball);

    var looseFlag = makeFlagRibbon(THREE, 0xffd23f);
    looseFlag.visible = false;
    scene.add(looseFlag);

    // ---- Ball controller (shared prop; owned by whichever move holds it) ---
    var ballCtrl = {
      mesh: ball,
      mode: 'idle',
      vx: 0, vy: 0, vz: 0,
      hold: function (x, y, z) { this.mode = 'held'; this.mesh.visible = true; this.mesh.position.set(x, y, z); },
      hide: function () { this.mode = 'idle'; this.mesh.visible = false; },
      launch: function (x, y, z, vx, vy, vz) {
        this.mesh.position.set(x, y, z);
        this.vx = vx; this.vy = vy; this.vz = vz;
        this.mode = 'flight'; this.mesh.visible = true;
      },
      update: function (dt) {
        if (this.mode !== 'flight') return;
        this.vy -= 9 * dt;
        this.mesh.position.x += this.vx * dt;
        this.mesh.position.y += this.vy * dt;
        this.mesh.position.z += this.vz * dt;
        this.mesh.rotation.x += 8 * dt; this.mesh.rotation.z += 3 * dt;
        if (this.mesh.position.y < 0.2) this.hide();
      }
    };

    // ---- Move rotation -----------------------------------------------------
    // Each player cycles a list of moves, switching every few seconds. Moves are
    // driven through the Player3D API (play/oneShot/setSpeed/setYaw/face). The
    // ball is only touched by the "star" (red) rotation, and the loose flag only
    // by the defender (green) rotation, so props never fight.
    var ctx = { ball: ballCtrl, looseFlag: looseFlag, THREE: THREE };

    // The landing screen must show the SAME rigged, skinned players you play
    // with, not the procedural stand-in. The .glb is still in flight when the
    // menu first paints, so hold the cast back until it lands (the stadium is
    // already on screen meanwhile) and only fall back to the procedural rig if
    // the model genuinely fails to load.
    // ---- Animation state ---------------------------------------------------
    var raf = null, t0 = null, lastT = null, running = true;

    var players = [];
    function spawnCast() {
      if (!running || players.length) return;
      players = [
        setupRotation(makeP3D(COL.blue, 'CARTER', 24, -5.0, 1.8),
          ['run', 'juke', 'griddy', 'run'], { x: -3.1, z: 1.8 }, 0.0),
        setupRotation(makeP3D(COL.red, 'RIVERA', 7, 0.0, 1.8),
          ['lasso', 'throw', 'celebrate', 'dive'], { x: 0.0, z: 1.8 }, 1.5),
        setupRotation(makeP3D(COL.green, 'MÜLLER', 55, 5.0, 1.8),
          ['flaggrab', 'run', 'highstep', 'flaggrab'], { x: 5.0, z: 1.8 }, 3.0)
      ];   // each takes a {P, carrier} from makeP3D
    }
    var PM = global.FLAGSTER && global.FLAGSTER.PlayerModel;
    if (PM && !PM.isReady() && !PM.isFailed()) PM.whenReady(spawnCast);
    else spawnCast();

    function resize() {
      var w = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
      var h = canvas.clientHeight || 180;
      if (w < 2 || h < 2) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    var ro = ('ResizeObserver' in global) ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(canvas);
    else global.addEventListener('resize', resize);
    resize();

    function cleanup() {
      running = false;
      if (raf) global.cancelAnimationFrame(raf);
      if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
      // Dispose the rigged players (mixers + their geometry/materials/textures).
      players.forEach(function (st) { try { st.P.dispose(); } catch (e) {} });
      scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); }); }
      });
      renderer.dispose();
    }

    function frame(t) {
      if (!running) return;
      if (!canvas.isConnected) { cleanup(); return; } // self-clean on navigation
      if (t0 == null) { t0 = t; lastT = t; }
      var time = (t - t0) / 1000;
      var dt = Math.min((t - lastT) / 1000, 0.05); // clamp for tab-switch jumps
      lastT = t;

      camera.position.x = Math.sin(time * 0.25) * 0.5; // gentle sway
      camera.lookAt(0, 0.7, -0.2);

      for (var i = 0; i < players.length; i++) {
        updatePlayer(players[i], time, dt, ctx);
        players[i].P.update(dt);   // MUST advance every mixer every frame
      }

      ballCtrl.update(dt);

      renderer.render(scene, camera);
      raf = global.requestAnimationFrame(frame);
    }
    raf = global.requestAnimationFrame(frame);

    return { stop: cleanup };
  }

  /* ------------------------------ FIELD ---------------------------------- */
  function makeField(THREE) {
    var g = new THREE.Group();
    var c = document.createElement('canvas'); c.width = 512; c.height = 256;
    var x = c.getContext('2d');
    for (var i = 0; i < 16; i++) { x.fillStyle = (i % 2 ? '#2b8339' : '#2f8f3f'); x.fillRect(i * 32, 0, 32, 256); }
    x.strokeStyle = 'rgba(255,255,255,0.7)'; x.lineWidth = 3;
    for (var j = 0; j <= 16; j += 2) { x.beginPath(); x.moveTo(j * 32, 0); x.lineTo(j * 32, 256); x.stroke(); }
    var tex = new THREE.CanvasTexture(c);
    var plane = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 12),
      new THREE.MeshLambertMaterial({ map: tex })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.01;
    g.add(plane);
    return g;
  }

  /* ------------------------------ PROPS ---------------------------------- */
  function makeFlagRibbon(THREE, color) {
    var m = new THREE.Mesh(
      new THREE.PlaneGeometry(0.12, 0.5),
      new THREE.MeshLambertMaterial({ color: color, side: THREE.DoubleSide })
    );
    m.position.y = -0.25;
    var g = new THREE.Group(); g.add(m);
    return g;
  }

  function makeBall(THREE) {
    // Regulation at 1 unit = 1 yard: 11in x 6.7in -> 0.306 x 0.186 units.
    // Was 0.2r scaled 1.5 (0.60 x 0.40) — twice size, same as the field ball.
    var geo = new THREE.SphereGeometry(0.095, 16, 12);
    geo.scale(1.62, 1, 1);
    var ball = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x7a4a20 }));
    ball.position.set(0, 1.4, 0.4);
    ball.visible = false;
    return ball;
  }

  /* --------------------- MOVE ROTATION / STATE MACHINE ------------------- */
  // How long (seconds) each kind of move plays before rotating to the next.
  var MOVE_DUR = {
    run: 5.0, juke: 4.5, highstep: 4.5,
    throw: 5.5, dive: 4.2, celebrate: 5.0, flaggrab: 5.0,
    griddy: 4.6, lasso: 5.0
  };

  // Yaw each move wants the body to face. setYaw(y) => rotation.y = PI/2 - y
  // and the rig faces local +Z, so yaw 0 aims the player at world +X. That
  // makes -PI/2 "downfield" (into the screen, -Z) in this scene's camera.
  var YAW = {
    DOWNFIELD: -Math.PI / 2,   // face into the screen (-Z)
    CAMERA:     Math.PI / 2,   // face the viewer (+Z)
    LEFT:       Math.PI,       // screen-left (-X)
    RIGHT:      0              // screen-right (+X)
  };
  function moveBaseYaw(name) {
    switch (name) {
      case 'flaggrab': return YAW.CAMERA - 0.5;   // turned out to rip a passing flag
      case 'throw':    return YAW.CAMERA - 0.25;  // squared up on the target
      default:         return YAW.CAMERA;         // everyone plays toward the viewer
    }
  }

  /* The cast plays TOWARD the camera, so a move ends at its base mark rather
     than starting there: back the player up by the full travel and let them
     arrive. Framing stays exactly where it was tuned, and facing still matches
     the direction of travel — the whole point of turning them round. */
  function approachZ(baseZ, travel, maxTravel) {
    return baseZ - maxTravel + travel;
  }

  // Create per-player rotation state. Returns the state object (holds the
  // Player3D instance as .P). startOffset advances a player into its first move
  // so the three players are out of phase from frame one.
  function setupRotation(inst, moves, base, startOffset) {
    var st = {
      P: inst.P,
      carrier: inst.carrier,
      moves: moves,
      base: base,
      moveIdx: 0,
      moveStart: -(startOffset || 0),
      entered: false,        // has the current move been "entered" (one-shot fired / play set)
      yaw: moveBaseYaw(moves[0]),
      flags: {}              // per-move one-shot latches
    };
    inst.P.setYaw(st.yaw);
    inst.carrier.position.set(base.x, 0, base.z);
    return st;
  }

  // Does this rig carry the clip? Actions are keyed by the .glb's capitalised
  // name, and play() also accepts the game's lower-camel one, so check both.
  function hasClip(P, name) {
    if (!P.actions) return false;
    return !!(P.actions[name] || P.actions[name.charAt(0).toUpperCase() + name.slice(1)]);
  }

  function enterMove(st, name, ctx) {
    var P = st.P;
    st.entered = true;
    st.flags = {};
    // reset carrier position at the start of each move (weave/dive translate it)
    st.carrier.position.set(st.base.x, 0, st.base.z);
    switch (name) {
      case 'run':
        P.setSpeed(1.35); P.play('run', 0.25);
        break;
      case 'juke':
        P.setSpeed(1.35);
        P.play('run', 0.2);
        P.oneShot('juke', 'run', 0.15);   // plant + spin, auto-return to run
        break;
      case 'highstep':
        // There is a real HighStep clip now (knees to the chest, on the spot).
        // This used to be the walk cycle run at 2.1x, which is a man hurrying,
        // not a man showing off. Fall back to that if the rig predates it.
        if (hasClip(P, 'highstep')) P.play('highstep', 0.25);
        else { P.setSpeed(2.1); P.play('walk', 0.25); }
        break;
      case 'throw':
        P.oneShot('throw', 'idle', 0.2);
        break;
      case 'dive':
        P.oneShot('dive', 'idle', 0.2);
        break;
      case 'celebrate':
        P.play('celebrate', 0.25);
        break;
      // The end-zone repertoire, on the landing screen. Same guard the
      // HighStep case carries: an older .glb simply doesn't have these, and
      // the menu must still animate rather than freeze on a T-pose.
      case 'griddy':
      case 'lasso':
        P.play(hasClip(P, name) ? name : 'celebrate', 0.25);
        break;
      case 'flaggrab':
        /* THE DEFENDER'S CLIP, NOT THE CARRIER'S. This asked for 'flagPull',
           which the alias table maps to FlagPulled — the reaction of the man
           who just LOST his flag. The driver below has always been the other
           half of that play: it faces an imagined carrier and throws a loose
           flag into the air at the rip. So the one figure on the landing
           screen whose whole job is making the play was performing the
           reaction to having it made on him. FlagGrab is the reach and the
           rip, and its beats are the ones the driver already assumes. */
        P.oneShot('flagGrab', 'idle', 0.2);
        break;
    }
  }

  function updatePlayer(st, time, dt, ctx) {
    var P = st.P;
    var name = st.moves[st.moveIdx];
    var dur = MOVE_DUR[name] || 5;

    if (!st.entered && time - st.moveStart >= 0) {
      enterMove(st, name, ctx);
    }
    if (time - st.moveStart >= dur) {
      st.moveIdx = (st.moveIdx + 1) % st.moves.length;
      st.moveStart = time;
      st.entered = false;
      name = st.moves[st.moveIdx];
      if (time - st.moveStart >= 0) enterMove(st, name, ctx);
    }

    var lt = time - st.moveStart;   // local time within this move
    if (lt < 0) lt = 0;
    (ANIMS[name] || ANIMS.run)(st, lt, dt, ctx);
  }

  /* --------------------------- MOVE DRIVERS ------------------------------ */
  // These layer scene-level motion (root translation, facing, props) on top of
  // the Player3D clip that enterMove() started. Limb motion comes from the mixer.
  var ANIMS = {
    run: driveRun,
    juke: driveJuke,
    highstep: driveHighStep,
    throw: driveThrow,
    dive: driveDive,
    celebrate: driveCelebrate,
    griddy: driveCelebrate,
    lasso: driveCelebrate,
    flaggrab: driveFlagPull
  };

  // Sprint downfield with a gentle weave; bank the facing into the weave.
  function driveRun(st, t, dt, ctx) {
    var P = st.P, b = st.base, c = st.carrier;
    var travel = Math.min(t * 1.1, 3.4);                 // ease toward camera, capped
    c.position.x = b.x + Math.sin(t * 1.2) * 0.6;        // gentle weave
    c.position.z = approachZ(b.z, travel, 3.4);
    P.face(moveBaseYaw('run') + Math.sin(t * 1.2) * 0.18, dt);
  }

  // Juke: jog downfield with a lateral hop; the mixer plays the spin one-shot.
  function driveJuke(st, t, dt, ctx) {
    var P = st.P, b = st.base, c = st.carrier;
    var travel = Math.min(t * 0.9, 2.6);
    c.position.x = b.x + Math.sin(t * 1.6) * 0.8;        // cut side to side
    c.position.z = approachZ(b.z, travel, 2.6);
    c.position.y = Math.max(0, Math.sin(t * 3.0)) * 0.12; // little lateral hop
    P.face(moveBaseYaw('juke'), dt);
  }

  // High-step strut downfield — lively walk cadence, slow drift.
  function driveHighStep(st, t, dt, ctx) {
    var P = st.P, b = st.base, c = st.carrier;
    var travel = Math.min(t * 0.7, 2.6);
    c.position.x = b.x + Math.sin(t * 0.7) * 0.4;
    c.position.z = approachZ(b.z, travel, 2.6);
    P.face(moveBaseYaw('highstep') + Math.sin(t * 0.7) * 0.2, dt);
  }

  // QB throw — face the target; release the real ball near the whip point.
  function driveThrow(st, t, dt, ctx) {
    var P = st.P, b = st.base, ball = ctx.ball;
    P.face(moveBaseYaw('throw'), dt);
    st.carrier.position.set(b.x, 0, b.z);
    // 'throw' clip is 1.1s: windup ~0.4, release ~0.55. Hold ball by the ear,
    // then launch toward the viewer (+Z) at the release moment.
    if (t < 0.55) {
      ball.hold(b.x - 0.1, 2.0, b.z - 0.2);   // cradled high, behind the ear
      st.flags.thrown = false;
    } else if (!st.flags.thrown) {
      st.flags.thrown = true;
      ball.launch(b.x, 2.15, b.z,
        (Math.random() - 0.5) * 1.0, 4.7, 4.2);   // arc out toward the camera
    }
  }

  // Diving catch — face the ball, translate forward through the dive.
  function driveDive(st, t, dt, ctx) {
    var P = st.P, b = st.base, c = st.carrier, ball = ctx.ball;
    P.face(moveBaseYaw('dive'), dt);
    // 'dive' clip is 1.2s: launch ~0.35, peak ~0.7. The receiver lays out toward
    // the camera, so the ball hangs just ahead of him at +Z.
    var travel = Math.min(t, 1.2) / 1.2;
    c.position.x = b.x;
    c.position.z = approachZ(b.z, travel * 1.6, 1.6);
    if (t < 0.5) ball.hold(b.x, 1.5, c.position.z + 1.2);
    else if (t < 1.1) ball.hold(c.position.x, 1.0, c.position.z + 0.4);
    else ball.hide();
  }

  /* Celebrate — face the camera and loop the celebration. No confetti: the
     celebration belongs to the player, not to paper over the lens. Drives every
     looping celebration in the cast, which is why the yaw is read off the move
     being played rather than hard-coded to this one. */
  function driveCelebrate(st, t, dt, ctx) {
    var P = st.P, b = st.base, ball = ctx.ball;
    P.face(moveBaseYaw(st.moves[st.moveIdx]) + Math.sin(t * 2) * 0.15, dt);
    st.carrier.position.set(b.x, 0, b.z);
    ball.hide();
  }

  // Flag-pull — face the imagined carrier; pop the loose flag at the rip moment.
  function driveFlagPull(st, t, dt, ctx) {
    var P = st.P, b = st.base, looseFlag = ctx.looseFlag;
    P.face(moveBaseYaw('flaggrab'), dt);
    st.carrier.position.set(b.x, 0, b.z);
    // 'FlagGrab' is 0.90s: reach ~0.28, rip ~0.55.
    if (t < 0.55) { looseFlag.visible = false; st.flags.pulled = false; }
    else {
      if (!st.flags.pulled) {
        looseFlag.visible = true;
        looseFlag.position.set(b.x + 0.4, 1.0, b.z + 0.2);
        st.flags.pulled = true;
      }
      looseFlag.position.y += 1.4 * dt;
      looseFlag.rotation.z += 6 * dt;
      looseFlag.rotation.x += 4 * dt;
      if (looseFlag.position.y > 3.2) looseFlag.visible = false;
    }
  }

  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.hero3d = { mount: mount };
})(window);
