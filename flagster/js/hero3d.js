/* ============================================================================
   FLAGSTER — HERO 3D  (Three.js)
   A delightful top-down animated scene: three low-poly flag-football players,
   each running a distinct looping animation:
     1. RUN     — a weaving juke down the field (arms/legs pumping, body bob)
     2. CELEBRATE — leap, catch the ball, spike it, confetti burst
     3. FLAG-PULL — a defender lunges and rips a flag that spins into the air
   Built from primitives (no external models). Self-cleans when its canvas
   leaves the DOM, so it never leaks when you navigate away from the menu.
   ============================================================================ */
(function (global) {
  'use strict';

  function mount(canvas, opts) {
    if (!global.THREE || !canvas) return null;
    var THREE = global.THREE;
    opts = opts || {};

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b3d1e, 16, 34);

    // Top-down-ish camera (tilted so the 3D forms read nicely)
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

    // ---- Three players -----------------------------------------------------
    var COL = {
      blue:   { jersey: 0x2b5cff, trim: 0xffffff, skin: 0xe8b98f },
      red:    { jersey: 0xd80621, trim: 0xffdf00, skin: 0xc68a5e },
      green:  { jersey: 0x2ec77a, trim: 0x08331d, skin: 0xf2d3b3 }
    };
    var runner = makePlayer(THREE, COL.blue, 'CARTER');
    runner.position.set(-3.4, 0, 0);
    scene.add(runner);

    var star = makePlayer(THREE, COL.red, 'RIVERA');
    star.position.set(0, 0, 0.2);
    scene.add(star);
    var ball = makeBall(THREE);
    scene.add(ball);

    var defender = makePlayer(THREE, COL.green, 'MÜLLER');
    defender.position.set(3.4, 0, 0);
    scene.add(defender);
    var looseFlag = makeFlagRibbon(THREE, 0xffd23f);
    looseFlag.visible = false;
    scene.add(looseFlag);

    // Confetti pool for the celebration
    var confetti = makeConfetti(THREE);
    scene.add(confetti.group);

    // ---- Ball controller (shared prop; owned by whichever move holds it) ---
    // Modes: 'idle' (hidden), 'held' (positioned by an animation each frame),
    // 'flight' (projectile physics — arcs downfield and lands).
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

    // ---- Move rotation --------------------------------------------------
    // Each player cycles through a list of animations, switching every few
    // seconds. Poses are reset on each switch so transitions aren't jarring.
    // The ball is only ever touched by the "star" (red) rotation, and the
    // loose flag only by the defender (green) rotation, so props never fight.
    var ctx = { ball: ballCtrl, looseFlag: looseFlag, confetti: confetti, THREE: THREE };

    setupRotation(runner,   ['run', 'juke', 'highstep', 'run'],           { x: -3.4, z: 0 },   0.0);
    setupRotation(star,     ['celebrate', 'throw', 'celebrate', 'dive'],  { x: 0,    z: 0.2 }, 1.5);
    setupRotation(defender, ['flagpull', 'run', 'highstep', 'flagpull'],  { x: 3.4,  z: 0 },   3.0);

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

      updatePlayer(runner, time, ctx);
      updatePlayer(star, time, ctx);
      updatePlayer(defender, time, ctx);

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

  /* ------------------------------ PLAYER --------------------------------- */
  function limb(THREE, w, h, d, color) {
    var pivot = new THREE.Group();
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: color }));
    m.position.y = -h / 2;                // hang from the pivot
    pivot.add(m);
    return pivot;
  }

  function makePlayer(THREE, col, name) {
    var p = new THREE.Group();

    // fake soft shadow disc
    var shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 })
    );
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.01;
    p.add(shadow);

    var jerseyMat = new THREE.MeshLambertMaterial({ color: col.jersey });
    var skinMat = new THREE.MeshLambertMaterial({ color: col.skin });

    // torso
    var torso = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.92, 0.42), jerseyMat);
    torso.position.y = 1.28; p.add(torso);
    // shoulder trim stripe
    var collar = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.14, 0.44), new THREE.MeshLambertMaterial({ color: col.trim }));
    collar.position.y = 1.68; p.add(collar);

    // head
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 18, 14), skinMat);
    head.position.y = 2.02; p.add(head);

    // arms (pivot at shoulder)
    var lArm = limb(THREE, 0.2, 0.82, 0.2, col.skin); lArm.position.set(-0.46, 1.66, 0);
    var rArm = limb(THREE, 0.2, 0.82, 0.2, col.skin); rArm.position.set(0.46, 1.66, 0);
    p.add(lArm); p.add(rArm);

    // legs (pivot at hip)
    var lLeg = limb(THREE, 0.24, 0.92, 0.24, 0x222831); lLeg.position.set(-0.2, 0.86, 0);
    var rLeg = limb(THREE, 0.24, 0.92, 0.24, 0x222831); rLeg.position.set(0.2, 0.86, 0);
    p.add(lLeg); p.add(rLeg);

    // flag ribbons at hips
    var lFlag = makeFlagRibbon(THREE, 0xffd23f); lFlag.position.set(-0.4, 0.9, 0.16); lFlag.scale.setScalar(0.8);
    var rFlag = makeFlagRibbon(THREE, 0xffd23f); rFlag.position.set(0.4, 0.9, 0.16); rFlag.scale.setScalar(0.8);
    p.add(lFlag); p.add(rFlag);

    // Madden-style nameplate sprite
    p.add(makeNameplate(THREE, name));

    p.userData = { torso: torso, head: head, lArm: lArm, rArm: rArm, lLeg: lLeg, rLeg: rLeg, lFlag: lFlag, rFlag: rFlag, baseY: 0 };
    return p;
  }

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
    return ball;
  }

  function makeNameplate(THREE, name) {
    var c = document.createElement('canvas'); c.width = 256; c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(x, 8, 12, 240, 40, 10); x.fill();
    x.font = 'bold 30px system-ui, sans-serif'; x.fillStyle = '#fff';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(name, 128, 34);
    var tex = new THREE.CanvasTexture(c);
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    spr.scale.set(1.9, 0.48, 1);
    spr.position.set(0, 2.75, 0);
    return spr;
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

  function setupRotation(p, moves, base, startOffset) {
    var d = p.userData;
    d.moves = moves;
    d.base = base;
    d.moveIdx = 0;
    // Negative moveStart advances a player into its first move so the three
    // players are out of phase with each other from frame one.
    d.moveStart = -(startOffset || 0);
    resetPose(p, base);
  }

  function resetPose(p, base) {
    var d = p.userData;
    d.torso.rotation.set(0, 0, 0);
    d.head.rotation.set(0, 0, 0);
    d.lArm.rotation.set(0, 0, 0); d.rArm.rotation.set(0, 0, 0);
    d.lLeg.rotation.set(0, 0, 0); d.rLeg.rotation.set(0, 0, 0);
    d.lFlag.rotation.set(0, 0, 0); d.rFlag.rotation.set(0, 0, 0);
    p.rotation.set(0, 0, 0);
    p.position.set(base.x, 0, base.z);
    p._spiked = p._thrown = p._dove = p._caught = p._pulled = false;
  }

  function updatePlayer(p, time, ctx) {
    var d = p.userData;
    var name = d.moves[d.moveIdx];
    var dur = MOVE_DUR[name] || 5;
    if (time - d.moveStart >= dur) {
      d.moveIdx = (d.moveIdx + 1) % d.moves.length;
      d.moveStart = time;
      resetPose(p, d.base);
      name = d.moves[d.moveIdx];
    }
    var lt = time - d.moveStart;           // local time within this move
    if (lt < 0) lt = 0;
    (ANIMS[name] || ANIMS.run)(p, lt, d.base, ctx);
  }

  /* --------------------------- ANIMATIONS -------------------------------- */
  var ANIMS = {
    run: animateRun,
    juke: animateJuke,
    highstep: animateHighStep,
    throw: animateThrow,
    dive: animateDive,
    celebrate: animateCelebrate,
    flagpull: animateFlagPull
  };

  // Weaving run — pumps limbs, bobs, and jukes side to side around home.
  function animateRun(p, t, base) {
    var d = p.userData, swing = Math.sin(t * 9) * 0.9;
    d.lLeg.rotation.x = swing; d.rLeg.rotation.x = -swing;
    d.lArm.rotation.x = -swing; d.rArm.rotation.x = swing;
    p.position.y = Math.abs(Math.sin(t * 9)) * 0.12;        // stride bob
    p.position.x = base.x + Math.sin(t * 1.3) * 1.5;        // weave/juke
    p.rotation.y = Math.cos(t * 1.3) * 0.45;                // lean into cuts
    d.lFlag.rotation.x = -swing * 0.6; d.rFlag.rotation.x = swing * 0.6;
  }

  // Juke spin — a jog that periodically breaks into a full 360 spin move.
  function animateJuke(p, t, base) {
    var d = p.userData, sw = Math.sin(t * 10) * 0.8;
    d.lLeg.rotation.x = sw; d.rLeg.rotation.x = -sw;
    d.lArm.rotation.x = -sw * 0.7; d.rArm.rotation.x = sw * 0.7;
    p.position.y = Math.abs(Math.sin(t * 10)) * 0.1;
    p.position.x = base.x + Math.sin(t * 1.1) * 1.2;
    var C = 1.9, ph = (t % C) / C, spin;
    if (ph < 0.4) spin = 0;
    else if (ph < 0.72) spin = ((ph - 0.4) / 0.32) * Math.PI * 2;  // whip around
    else spin = Math.PI * 2;
    p.rotation.y = spin;
    p.rotation.z = Math.sin(spin) * 0.16;                   // lean through the cut
  }

  // High-step strut — exaggerated knee lifts, chest puffed, showboating.
  function animateHighStep(p, t, base) {
    var d = p.userData;
    d.lLeg.rotation.x = Math.max(0, Math.sin(t * 6.5)) * 1.35;
    d.rLeg.rotation.x = Math.max(0, Math.sin(t * 6.5 + Math.PI)) * 1.35;
    d.lArm.rotation.x = -Math.sin(t * 6.5) * 0.8;
    d.rArm.rotation.x = Math.sin(t * 6.5) * 0.8;
    p.position.y = Math.abs(Math.sin(t * 6.5)) * 0.16;
    p.position.x = base.x + Math.sin(t * 0.7) * 0.8;        // slow strut drift
    p.rotation.y = Math.sin(t * 0.7) * 0.25;
    d.torso.rotation.x = -0.14;                             // chest out
    d.lFlag.rotation.x = d.lLeg.rotation.x * -0.4;
    d.rFlag.rotation.x = d.rLeg.rotation.x * -0.4;
  }

  // QB drop-back + throw — winds up and RELEASES the ball, which arcs downfield.
  function animateThrow(p, t, base, ctx) {
    var d = p.userData, ball = ctx.ball;
    var C = 2.6, ph = (t % C) / C;
    if (ph < 0.3) {
      // drop back into the pocket, ball cradled at chest
      var k = ph / 0.3;
      p.position.z = base.z + k * 0.6;
      p.position.y = Math.abs(Math.sin(t * 11)) * 0.05;
      d.lLeg.rotation.x = Math.sin(t * 11) * 0.25;
      d.rLeg.rotation.x = -Math.sin(t * 11) * 0.25;
      d.rArm.rotation.x = -0.6; d.rArm.rotation.z = -0.3;
      d.lArm.rotation.x = -1.0;
      ball.hold(base.x - 0.2, 1.55, p.position.z + 0.1);
      p._thrown = false;
    } else if (ph < 0.46) {
      // wind up — cock the arm back, rotate the torso
      var k2 = (ph - 0.3) / 0.16;
      p.position.z = base.z + 0.6;
      p.position.y = 0;
      d.rArm.rotation.x = -0.6 - k2 * 2.5;
      d.rArm.rotation.z = -0.3 - k2 * 0.3;
      d.torso.rotation.y = k2 * 0.5;
      d.lArm.rotation.x = -1.2;
      ball.hold(base.x - 0.38, 1.7 + k2 * 0.45, base.z + 0.7);
    } else if (ph < 0.54) {
      // release — whip the arm through and launch the ball downfield
      var k3 = (ph - 0.46) / 0.08;
      d.rArm.rotation.x = -3.1 + k3 * 3.7;
      d.rArm.rotation.z = -0.6 + k3 * 0.6;
      d.torso.rotation.y = 0.5 - k3 * 0.7;
      if (!p._thrown) {
        p._thrown = true;
        ball.launch(base.x - 0.1, 2.15, base.z + 0.4,
          (Math.random() - 0.5) * 1.2, 4.6, -4.2);
      }
    } else {
      // follow through + reset back toward the line
      var k4 = (ph - 0.54) / 0.46;
      p.position.z = base.z + 0.6 * (1 - k4);
      p.position.y = 0;
      d.rArm.rotation.x = 0.6 * (1 - k4);
      d.rArm.rotation.z = 0.15 * (1 - k4);
      d.torso.rotation.y = -0.18 * (1 - k4);
      d.lArm.rotation.x = -0.4 * (1 - k4);
    }
  }

  // Diving catch — runs up, launches horizontal with arms extended to snag a
  // pass, secures it on the turf, then pops up presenting the ball.
  function animateDive(p, t, base, ctx) {
    var d = p.userData, ball = ctx.ball;
    var C = 4.2, ph = (t % C) / C;
    if (ph < 0.25) {
      // sprint up while the pass sails in from downfield
      var k = ph / 0.25, sw = Math.sin(t * 11) * 0.7;
      d.lLeg.rotation.x = sw; d.rLeg.rotation.x = -sw;
      d.lArm.rotation.x = -sw; d.rArm.rotation.x = sw;
      p.position.y = Math.abs(Math.sin(t * 11)) * 0.1;
      ball.hold(base.x + (1 - k) * 1.8, 1.6 + (1 - k) * 1.4, base.z - 2.4 + k * 1.3);
      p._dove = false; p._caught = false;
    } else if (ph < 0.5) {
      // DIVE — pitch forward, body horizontal, both arms stretched out
      var k2 = (ph - 0.25) / 0.25, arc = Math.sin(k2 * Math.PI);
      p.position.z = base.z - k2 * 1.9;
      p.position.y = arc * 0.6;
      p.rotation.x = -k2 * 1.25;
      d.lArm.rotation.x = -2.7; d.rArm.rotation.x = -2.7;
      d.lArm.rotation.z = 0.3; d.rArm.rotation.z = -0.3;
      d.lLeg.rotation.x = 0.5; d.rLeg.rotation.x = 0.5;
      ball.hold(p.position.x, 1.15 + arc * 0.45, p.position.z - 0.7);
      if (!p._caught && k2 > 0.55) { ctx.confetti.burst(p.position.x, 1.2, p.position.z - 0.6); p._caught = true; }
    } else if (ph < 0.64) {
      // landed — ball tucked, sprawled on the turf
      p.position.z = base.z - 1.9;
      p.position.y = 0;
      p.rotation.x = -1.25;
      d.lArm.rotation.x = -2.2; d.rArm.rotation.x = -2.2;
      ball.hold(p.position.x, 0.5, p.position.z - 0.55);
    } else {
      // pop up and present the catch
      var k4 = (ph - 0.64) / 0.36;
      p.position.z = base.z - 1.9 * (1 - k4);
      p.position.y = 0;
      p.rotation.x = -1.25 * (1 - k4);
      d.lArm.rotation.x = -2.4 + Math.sin(t * 10) * 0.15;
      d.rArm.rotation.x = -2.4 + Math.cos(t * 10) * 0.15;
      ball.hold(p.position.x, 1.4 + k4 * 0.6, p.position.z);
      if (k4 > 0.85) ball.hide();
    }
  }

  // Catch, spike, and confetti celebration (the crowd-pleaser).
  function animateCelebrate(p, t, base, ctx) {
    var d = p.userData, ball = ctx.ball, confetti = ctx.confetti;
    var C = 3.2, ph = (t % C) / C;    // 0..1 cycle
    if (ph < 0.35) {
      // gather + leap to catch
      var k = ph / 0.35;
      p.position.y = Math.sin(k * Math.PI) * 0.7;
      d.lArm.rotation.x = -2.4 * k; d.rArm.rotation.x = -2.4 * k;
      d.lLeg.rotation.x = 0.5 * k; d.rLeg.rotation.x = -0.3 * k;
      ball.hold(base.x, 1.4 + Math.sin(k * Math.PI) * 1.4, base.z + 0.2 - k * 0.1);
      p._spiked = false;
    } else if (ph < 0.5) {
      // caught — bring ball down
      var k2 = (ph - 0.35) / 0.15;
      p.position.y = (1 - k2) * 0.2;
      d.lArm.rotation.x = -2.4 + k2 * 1.2; d.rArm.rotation.x = -2.4 + k2 * 1.2;
      ball.hold(base.x, 2.0 - k2 * 0.5, base.z + 0.15);
    } else if (ph < 0.62) {
      // spike!
      if (!p._spiked) { confetti.burst(base.x, 2.4, base.z); p._spiked = true; }
      var k3 = (ph - 0.5) / 0.12;
      d.rArm.rotation.x = -1.2 - k3 * 1.6;
      ball.hold(base.x + 0.1, 1.8 - k3 * 1.6, base.z + 0.2);
      ball.mesh.rotation.z += 0.5;
    } else {
      // celebrate: arms up, little hops
      ball.hide();
      d.lArm.rotation.x = -2.6 + Math.sin(t * 12) * 0.2;
      d.rArm.rotation.x = -2.6 + Math.cos(t * 12) * 0.2;
      d.lLeg.rotation.x = 0; d.rLeg.rotation.x = 0;
      p.position.y = Math.abs(Math.sin(t * 8)) * 0.18;
      p.rotation.y = Math.sin(t * 3) * 0.3;
    }
  }

  // Defender lunges, rips a flag, and it spins loose into the air.
  function animateFlagPull(p, t, base, ctx) {
    var d = p.userData, looseFlag = ctx.looseFlag;
    var C = 2.8, ph = (t % C) / C;
    if (ph < 0.4) {
      // jog forward toward the "ball carrier"
      var sw = Math.sin(t * 9) * 0.8;
      d.lLeg.rotation.x = sw; d.rLeg.rotation.x = -sw;
      d.lArm.rotation.x = -sw; d.rArm.rotation.x = sw;
      p.position.y = Math.abs(Math.sin(t * 9)) * 0.1;
      looseFlag.visible = false; p._pulled = false;
    } else if (ph < 0.5) {
      // lunge + reach down to grab the flag
      var k = (ph - 0.4) / 0.1;
      d.rArm.rotation.x = k * 1.6; d.rArm.rotation.z = -k * 0.4;
      p.rotation.y = -k * 0.4;
    } else if (ph < 0.6) {
      // RIP — flag flies loose
      if (!p._pulled) {
        looseFlag.visible = true;
        looseFlag.position.set(p.position.x + 0.3, 0.9, base.z + 0.2);
        p._pulled = true;
      }
      looseFlag.position.y += 0.09; looseFlag.rotation.z += 0.4; looseFlag.rotation.x += 0.3;
    } else {
      // fist pump celebration
      looseFlag.position.y += 0.04; looseFlag.rotation.z += 0.25;
      if (looseFlag.position.y > 3.2) looseFlag.visible = false;
      d.rArm.rotation.x = -2.2 + Math.sin(t * 14) * 0.5; d.rArm.rotation.z = 0;
      d.lArm.rotation.x = -0.4;
      p.rotation.y = 0;
      p.position.y = Math.abs(Math.sin(t * 7)) * 0.14;
    }
  }

  /* ----------------------------- utils ----------------------------------- */
  function roundRect(x, rx, ry, w, h, r) {
    x.beginPath(); x.moveTo(rx + r, ry);
    x.arcTo(rx + w, ry, rx + w, ry + h, r); x.arcTo(rx + w, ry + h, rx, ry + h, r);
    x.arcTo(rx, ry + h, rx, ry, r); x.arcTo(rx, ry, rx + w, ry, r); x.closePath();
  }

  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.hero3d = { mount: mount };
})(window);
