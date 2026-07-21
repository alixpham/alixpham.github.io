/* ============================================================================
   FLAGSTER — HERO 3D  (Three.js)
   A delightful top-down animated scene showcasing three REALISTIC rigged
   flag-football players (see player3d.js — a real AnimationMixer driving
   authored clips). Each player cycles through a distinct list of moves,
   switching every few seconds, driven entirely through the Player3D API:
     CARTER (blue)  — run / juke / highstep, weaving downfield
     RIVERA (red)   — celebrate / throw / dive (owns the ball prop)
     MÜLLER (green) — flagpull / run / highstep (owns the loose-flag prop)
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

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b3d1e, 16, 34);

    // Top-down-ish camera (tilted so the 3D forms read nicely).
    // WORLD AXES / DIRECTION CONVENTION for this scene:
    //   - The camera sits at +Z and looks toward -Z (and down).
    //   - "DOWNFIELD" is -Z (into the screen, away from the camera). Passes are
    //     thrown toward -Z and the diving catch pass arrives from -Z.
    //   - +X is screen-right, -X is screen-left. +Y is up.
    //   Player3D forward is local +X and P.setYaw(yaw) sets root.rotation.y = -yaw.
    //   Yaw meaning here (matches the primitive scene it replaces): 0 = downfield
    //   (-Z), +PI = toward camera (+Z), +PI/2 = screen-left (-X), -PI/2 =
    //   screen-right (+X).  (Local +X rotated by -yaw about Y: yaw 0 -> +X? no —
    //   we adopt the scene convention below via YAW_* and it's tuned by eye.)
    var camera = new THREE.PerspectiveCamera(38, 2, 0.1, 100);
    camera.position.set(0, 13.5, 6.2);
    camera.lookAt(0, 0.7, -0.2);

    // Lights
    scene.add(new THREE.HemisphereLight(0xdfffe8, 0x1b4a2a, 0.95));
    var sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(-4, 12, 6);
    scene.add(sun);

    // ---- Field patch -------------------------------------------------------
    scene.add(makeField(THREE));

    // ---- Three realistic players ------------------------------------------
    // Player3D model is ~2.1 units tall; the field patch is ~26x12. Scale so a
    // player reads at a good size for the tilted top-down cam (tuned by eye).
    var PSCALE = 1.6;

    // IMPORTANT: several Player3D clips animate root.position (an authored
    // vertical bounce), so the mixer overwrites P.root.position every frame.
    // We therefore translate an OUTER "carrier" group for field movement and
    // let the mixer own the inner root's local bounce. Facing (P.setYaw/face)
    // sets the inner root's rotation.y and survives for every clip except the
    // brief 'dive' (which authors its own forward pitch — acceptable).
    function makeP3D(cfg, name, number, x, z) {
      var P = P3D.build(THREE, {
        jersey: cfg.jersey, trim: cfg.trim, skin: cfg.skin, number: number, name: name
      });
      var carrier = new THREE.Group();
      carrier.scale.setScalar(PSCALE);
      carrier.position.set(x, 0, z);   // feet on the turf (rig origin is at the feet)
      carrier.add(P.root);
      scene.add(carrier);
      return { P: P, carrier: carrier };
    }

    var COL = {
      blue:  { jersey: '#2b5cff', trim: '#ffffff', skin: '#e8b98f' },
      red:   { jersey: '#d80621', trim: '#ffdf00', skin: '#c68a5e' },
      green: { jersey: '#2ec77a', trim: '#08331d', skin: '#f2d3b3' }
    };

    var runner   = makeP3D(COL.blue,  'CARTER', 24, -5.0, 1.8);
    var star     = makeP3D(COL.red,   'RIVERA',  7,  0.0, 1.8);
    var defender = makeP3D(COL.green, 'MÜLLER', 55,  5.0, 1.8);   // {P, carrier} each

    var ball = makeBall(THREE);
    scene.add(ball);

    var looseFlag = makeFlagRibbon(THREE, 0xffd23f);
    looseFlag.visible = false;
    scene.add(looseFlag);

    // Confetti pool for the celebration
    var confetti = makeConfetti(THREE);
    scene.add(confetti.group);

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
    var ctx = { ball: ballCtrl, looseFlag: looseFlag, confetti: confetti, THREE: THREE };

    var players = [
      setupRotation(runner,   ['run', 'juke', 'highstep', 'run'],          { x: -5.0, z: 1.8 }, 0.0),
      setupRotation(star,     ['celebrate', 'throw', 'celebrate', 'dive'], { x: 0.0,  z: 1.8 }, 1.5),
      setupRotation(defender, ['flagpull', 'run', 'highstep', 'flagpull'], { x: 5.0,  z: 1.8 }, 3.0)
    ];   // each takes a {P, carrier} from makeP3D

    // ---- Animation state ---------------------------------------------------
    var raf = null, t0 = null, lastT = null, running = true;

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
      confetti.update(dt);

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
    var geo = new THREE.SphereGeometry(0.2, 16, 12);
    geo.scale(1.5, 1, 1);
    var ball = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x7a4a20 }));
    ball.position.set(0, 1.4, 0.4);
    ball.visible = false;
    return ball;
  }

  function makeConfetti(THREE) {
    var group = new THREE.Group();
    var cols = [0x2ec77a, 0xffd23f, 0x3c82ff, 0xff5a5a, 0xffffff];
    var pieces = [];
    for (var i = 0; i < 40; i++) {
      var m = new THREE.Mesh(
        new THREE.PlaneGeometry(0.1, 0.1),
        new THREE.MeshBasicMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide })
      );
      m.visible = false; group.add(m);
      pieces.push({ mesh: m, vy: 0, vx: 0, vz: 0, life: 0, spin: 0 });
    }
    function burst(x, y, z) {
      pieces.forEach(function (p) {
        p.mesh.visible = true; p.mesh.position.set(x, y, z);
        p.vx = (Math.random() - 0.5) * 3; p.vy = 2 + Math.random() * 3; p.vz = (Math.random() - 0.5) * 2;
        p.life = 1.4; p.spin = (Math.random() - 0.5) * 12;
      });
    }
    function update(dt) {
      pieces.forEach(function (p) {
        if (p.life <= 0) { p.mesh.visible = false; return; }
        p.life -= dt; p.vy -= 9 * dt;
        p.mesh.position.x += p.vx * dt; p.mesh.position.y += p.vy * dt; p.mesh.position.z += p.vz * dt;
        p.mesh.rotation.z += p.spin * dt; p.mesh.rotation.x += p.spin * dt;
        if (p.mesh.position.y < 0.05) { p.mesh.position.y = 0.05; p.vy = 0; p.vx *= 0.7; }
      });
    }
    return { group: group, burst: burst, update: update };
  }

  /* --------------------- MOVE ROTATION / STATE MACHINE ------------------- */
  // How long (seconds) each kind of move plays before rotating to the next.
  var MOVE_DUR = {
    run: 5.0, juke: 4.5, highstep: 4.5,
    throw: 5.5, dive: 4.2, celebrate: 5.0, flagpull: 5.0
  };

  // Yaw each move wants the body to face. Player3D: setYaw(y) => root.rotation.y
  // = -y, model forward = local +X. Tuned so "downfield" = into the screen (-Z).
  // With rotation.y = -y, local +X maps to world dir (cos(-y), 0, -sin(y))...
  // we simply choose values that LOOK right in the tilted cam (verified by shot):
  //   DOWNFIELD faces away from camera (into screen), CAMERA faces the viewer.
  var YAW = {
    DOWNFIELD: -Math.PI / 2,   // face into the screen (-Z)
    CAMERA:     Math.PI / 2,   // face the viewer (+Z)
    LEFT:       Math.PI,       // screen-left (-X)
    RIGHT:      0              // screen-right (+X)
  };
  function moveBaseYaw(name) {
    switch (name) {
      case 'celebrate': return YAW.CAMERA;        // show off toward the crowd
      case 'flagpull':  return YAW.DOWNFIELD + 0.5; // face down-and-toward carrier
      case 'throw':     return YAW.DOWNFIELD - 0.25; // face the downfield target
      default:          return YAW.DOWNFIELD;     // run/juke/highstep/dive downfield
    }
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
        P.setSpeed(2.1); P.play('walk', 0.25);   // lively, exaggerated strut
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
      case 'flagpull':
        P.oneShot('flagPull', 'idle', 0.2);
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
    flagpull: driveFlagPull
  };

  // Sprint downfield with a gentle weave; bank the facing into the weave.
  function driveRun(st, t, dt, ctx) {
    var P = st.P, b = st.base, c = st.carrier;
    var travel = Math.min(t * 1.1, 3.4);                 // ease downfield, capped
    c.position.x = b.x + Math.sin(t * 1.2) * 0.6;        // gentle weave
    c.position.z = b.z - travel;
    P.face(moveBaseYaw('run') + Math.sin(t * 1.2) * 0.18, dt);
  }

  // Juke: jog downfield with a lateral hop; the mixer plays the spin one-shot.
  function driveJuke(st, t, dt, ctx) {
    var P = st.P, b = st.base, c = st.carrier;
    var travel = Math.min(t * 0.9, 2.6);
    c.position.x = b.x + Math.sin(t * 1.6) * 0.8;        // cut side to side
    c.position.z = b.z - travel;
    c.position.y = Math.max(0, Math.sin(t * 3.0)) * 0.12; // little lateral hop
    P.face(moveBaseYaw('juke'), dt);
  }

  // High-step strut downfield — lively walk cadence, slow drift.
  function driveHighStep(st, t, dt, ctx) {
    var P = st.P, b = st.base, c = st.carrier;
    var travel = Math.min(t * 0.7, 2.6);
    c.position.x = b.x + Math.sin(t * 0.7) * 0.4;
    c.position.z = b.z - travel;
    P.face(moveBaseYaw('highstep') + Math.sin(t * 0.7) * 0.2, dt);
  }

  // QB throw — face the target; release the real ball near the whip point.
  function driveThrow(st, t, dt, ctx) {
    var P = st.P, b = st.base, ball = ctx.ball;
    P.face(moveBaseYaw('throw'), dt);
    st.carrier.position.set(b.x, 0, b.z);
    // 'throw' clip is 1.1s: windup ~0.4, release ~0.55. Hold ball by the ear,
    // then launch downfield (-Z) at the release moment.
    if (t < 0.55) {
      ball.hold(b.x - 0.1, 2.0, b.z + 0.2);   // cradled high
      st.flags.thrown = false;
    } else if (!st.flags.thrown) {
      st.flags.thrown = true;
      ball.launch(b.x, 2.15, b.z,
        (Math.random() - 0.5) * 1.0, 4.7, -4.2);   // arc downfield
    }
  }

  // Diving catch — face the ball, translate forward through the dive; confetti pop.
  function driveDive(st, t, dt, ctx) {
    var P = st.P, b = st.base, c = st.carrier, ball = ctx.ball;
    P.face(moveBaseYaw('dive'), dt);
    // 'dive' clip is 1.2s: launch ~0.35, peak ~0.7. Translate carrier downfield.
    var travel = Math.min(t, 1.2) / 1.2;
    c.position.x = b.x;
    c.position.z = b.z - travel * 1.6;
    if (t < 0.5) { ball.hold(b.x, 1.5, b.z - 1.2 + travel); st.flags.caught = false; }
    else if (t < 1.1) { ball.hold(c.position.x, 1.0, c.position.z - 0.4); }
    else { ball.hide(); }
    if (!st.flags.caught && t > 0.6) {
      ctx.confetti.burst(c.position.x, 1.2, c.position.z - 0.4);
      st.flags.caught = true;
    }
  }

  // Celebrate — face the camera; confetti burst on entry; loop the celebrate clip.
  function driveCelebrate(st, t, dt, ctx) {
    var P = st.P, b = st.base, ball = ctx.ball, confetti = ctx.confetti;
    P.face(moveBaseYaw('celebrate') + Math.sin(t * 2) * 0.15, dt);
    st.carrier.position.set(b.x, 0, b.z);
    if (!st.flags.burst && t > 0.15) {
      confetti.burst(b.x, 2.6, b.z);
      st.flags.burst = true;
    }
    // occasional re-burst to keep it festive over the ~5s move
    if (t > 2.6 && !st.flags.burst2) { confetti.burst(b.x, 2.6, b.z); st.flags.burst2 = true; }
    ball.hide();
  }

  // Flag-pull — face the imagined carrier; pop the loose flag at the rip moment.
  function driveFlagPull(st, t, dt, ctx) {
    var P = st.P, b = st.base, looseFlag = ctx.looseFlag;
    P.face(moveBaseYaw('flagpull'), dt);
    st.carrier.position.set(b.x, 0, b.z);
    // 'flagPull' clip is 1.0s: reach ~0.4, rip ~0.6.
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
