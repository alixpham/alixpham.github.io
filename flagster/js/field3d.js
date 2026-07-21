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

  // Field constants (yards) — mirror engine.js
  var F = (global.FLAGSTER && global.FLAGSTER.Engine && global.FLAGSTER.Engine.FIELD) ||
          { LEN: 70, WID: 25, EZ: 10, GOAL_L: 10, GOAL_R: 60, MID: 35 };
  var LEN = F.LEN, WID = F.WID, EZ = F.EZ, GOAL_L = F.GOAL_L, GOAL_R = F.GOAL_R, MID = F.MID;

  // Field(yards) -> world(units). Field centered on origin, ground plane y=0.
  function wx(fx) { return fx - LEN / 2; }   // -35 .. +35   (offense attacks +x)
  function wz(fy) { return fy - WID / 2; }   // -12.5 .. +12.5

  function toColor(THREE, hex) { try { return new THREE.Color(hex); } catch (e) { return new THREE.Color(0x888888); } }

  /* =============================== MOUNT ================================= */
  function mount(canvas, engine) {
    if (!global.THREE || !canvas) return null;
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
    renderer.setClearColor(0x06180c, 1);

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a2013, 55, 105);

    var camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 300);

    // Lights
    scene.add(new THREE.HemisphereLight(0xdfffe8, 0x1b4a2a, 0.72));
    var sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(-18, 40, 18);
    scene.add(sun);

    // Jersey colors from the current game.
    var st0 = engine && engine.state ? engine.state : {};
    var homeCols = (st0.homeJersey && st0.homeJersey.colors) || ['#2b5cff', '#ffffff'];
    var awayCols = (st0.awayJersey && st0.awayJersey.colors) || ['#d80621', '#ffffff'];

    // ---- Field --------------------------------------------------------------
    scene.add(makeGrass(THREE));
    // End zones tinted by each team's primary. In 2D: left zone = away, right = home.
    scene.add(makeEndZone(THREE, awayCols[0], -30));   // fieldX 0..10 -> center -30
    scene.add(makeEndZone(THREE, homeCols[0], 30));    // fieldX 60..70 -> center +30

    // Dynamic markers: line of scrimmage (blue), line-to-gain (yellow)
    var losLine = makeYardMarker(THREE, 0x3c82ff);
    var ltgLine = makeYardMarker(THREE, 0xffdc28);
    losLine.visible = false; ltgLine.visible = false;
    scene.add(losLine); scene.add(ltgLine);

    // Football
    var ball = makeBall(THREE);
    ball.visible = false;
    scene.add(ball);

    // Flying-flag effect pool (spawned on flag pulls)
    var flags = makeFlagPool(THREE, 10);
    scene.add(flags.group);

    // Touchdown flash sprite (full-scene tint via a big plane facing camera)
    var tdFx = { t: 0, dur: 0 };

    // Player meshes are (re)built whenever the roster array changes.
    var pMeshes = [];          // parallel to state.players
    var playersRef = null;

    var camFx = MID;           // smoothed camera focus (field X)
    var prevInAir = false;

    function rebuildPlayers(players) {
      pMeshes.forEach(function (m) { disposeObj(THREE, m); scene.remove(m); });
      pMeshes = [];
      (players || []).forEach(function (gp) {
        var cols = gp.team === 'home' ? homeCols : awayCols;
        var isOff = engine.offenseTeam ? (gp.team === engine.offenseTeam()) : true;
        var m = makePlayer(THREE, cols[0], cols[1], (gp.last || '').toUpperCase());
        scene.add(m);
        pMeshes.push(m);
      });
      playersRef = players;
    }

    function syncPlayer(m, gp, dt, state) {
      var ud = m.userData;
      m.position.x = wx(gp.x);
      m.position.z = wz(gp.y);
      m.rotation.y = -(gp.ang || 0);

      var speed = Math.hypot(gp.vx || 0, gp.vy || 0);
      var amp = clamp(speed / 9, 0, 1);
      ud.phase += dt * (6 + speed * 0.9);
      var swing = Math.sin(ud.phase) * (0.25 + amp * 0.95);

      // Throw motion timer (QB whip)
      var throwing = ud.throwT > 0;
      if (throwing) ud.throwT = Math.max(0, ud.throwT - dt);
      // Catch reach: this player is the target of a ball in the air
      var reaching = state.ball && state.ball.inAir && state.thrownTo === gp;

      if (throwing) {
        var k = 1 - (ud.throwT / 0.45);            // 0..1
        ud.rArm.rotation.x = -2.6 + k * 3.4;       // wind back -> whip forward
        ud.rArm.rotation.z = -0.3 * (1 - k);
        ud.lArm.rotation.x = -0.6;
        ud.lLeg.rotation.x = 0.3; ud.rLeg.rotation.x = -0.2;
        m.position.y = 0;
      } else if (reaching) {
        ud.lArm.rotation.x = -2.5; ud.rArm.rotation.x = -2.5;
        ud.lArm.rotation.z = 0.2; ud.rArm.rotation.z = -0.2;
        ud.lLeg.rotation.x = swing * 0.6; ud.rLeg.rotation.x = -swing * 0.6;
        m.position.y = 0.15;
      } else {
        ud.lLeg.rotation.x = swing; ud.rLeg.rotation.x = -swing;
        ud.lArm.rotation.x = -swing; ud.rArm.rotation.x = swing;
        ud.lArm.rotation.z = 0; ud.rArm.rotation.z = 0;
        m.position.y = Math.abs(Math.sin(ud.phase)) * 0.09 * amp;
      }

      // Flag ribbons: swing while running, hidden once pulled.
      var showFlags = !gp.flagPulled;
      ud.lFlag.visible = showFlags; ud.rFlag.visible = showFlags;
      if (showFlags) { ud.lFlag.rotation.x = -swing * 0.6; ud.rFlag.rotation.x = swing * 0.6; }

      // Flag-pull effect on the transition to pulled.
      if (gp.flagPulled && !ud._wasPulled) {
        flags.burst(m.position.x, 0.9, m.position.z, cols0(gp));
        ud._wasPulled = true;
      }
      if (!gp.flagPulled) ud._wasPulled = false;

      // Highlight ring on the user-controlled player.
      ud.ring.visible = (state.userControlled === gp);
    }
    function cols0(gp) { return gp.team === 'home' ? homeCols[0] : awayCols[0]; }

    function updateCamera(state, dt) {
      var focusFx = MID;
      if (state.carrier) focusFx = state.carrier.x;
      else if (state.ball && state.ball.inAir) focusFx = state.ball.x;
      else if (state.losX != null) focusFx = state.losX + 4;
      focusFx = clamp(focusFx, GOAL_L + 2, GOAL_R + 2);
      camFx = lerp(camFx, focusFx, clamp(dt * 2.2, 0, 1));

      var fxw = wx(camFx);
      camera.position.set(fxw - 13, 27, 21);
      camera.lookAt(fxw + 5, 0.5, 0);
    }

    // ---------------------------- RESIZE -----------------------------------
    function resize() {
      var w = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 800;
      var h = canvas.clientHeight || (canvas.parentElement && canvas.parentElement.clientHeight) || 480;
      if (w < 2 || h < 2) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    var ro = ('ResizeObserver' in global) ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(canvas); else global.addEventListener('resize', resize);
    resize();

    // ---------------------------- RENDER -----------------------------------
    function render(state) {
      if (!state) { renderer.render(scene, camera); return; }
      var dt = (engine && engine._dt) || 0.016;
      if (dt > 0.05) dt = 0.05;

      // Rebuild player meshes if the roster array was replaced (new down).
      if (state.players !== playersRef) rebuildPlayers(state.players);

      // Detect a throw starting this frame -> trigger the thrower's whip.
      var inAir = !!(state.ball && state.ball.inAir);
      if (inAir && !prevInAir) {
        var thrower = state.ball.thrower;
        for (var i = 0; i < pMeshes.length; i++) {
          if (state.players[i] === thrower) { pMeshes[i].userData.throwT = 0.45; break; }
        }
      }
      prevInAir = inAir;

      // Players
      for (var j = 0; j < pMeshes.length; j++) {
        if (state.players[j]) syncPlayer(pMeshes[j], state.players[j], dt, state);
      }

      // Line of scrimmage & line-to-gain
      if (state.losX != null && state.phase !== 'final') {
        losLine.visible = true; losLine.position.x = wx(state.losX);
        var ltg = state.crossedMid ? GOAL_R : MID;
        ltgLine.visible = true; ltgLine.position.x = wx(ltg);
      } else { losLine.visible = false; ltgLine.visible = false; }

      // Football
      if (state.ball) {
        ball.visible = true;
        if (state.ball.inAir) {
          ball.position.set(wx(state.ball.x), 1.0 + (state.ball.z || 0), wz(state.ball.y));
          ball.rotation.z += 0.5; ball.rotation.x += 0.2;
        } else if (state.carrier) {
          // tuck near the carrier's near hip
          var c = state.carrier;
          ball.position.set(wx(c.x) + Math.cos(-(c.ang || 0)) * 0.1, 1.15, wz(c.y) + 0.35);
          ball.rotation.set(0, -(c.ang || 0), 0.4);
        } else {
          ball.position.set(wx(state.ball.x), 1.0, wz(state.ball.y));
        }
      } else { ball.visible = false; }

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

      updateCamera(state, dt);
      renderer.render(scene, camera);
    }

    function stop() {
      if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
      scene.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
          if (m.map) m.map.dispose(); m.dispose();
        });
      });
      renderer.dispose();
    }

    return { render: render, resize: resize, stop: stop };
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

  /* =============================== PLAYER ================================ */
  function limb(THREE, w, h, d, color) {
    var pivot = new THREE.Group();
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color: color }));
    m.position.y = -h / 2;                 // hang from the pivot
    pivot.add(m);
    return pivot;
  }

  function makePlayer(THREE, primaryHex, secondaryHex, name) {
    var p = new THREE.Group();
    var primary = toColor(THREE, primaryHex);
    var secondary = toColor(THREE, secondaryHex);
    var skin = 0xe8b98f;

    // soft shadow disc
    var shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 18),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 })
    );
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02;
    p.add(shadow);

    // highlight ring (user-controlled)
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.92, 26),
      new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; ring.visible = false;
    p.add(ring);

    var jerseyMat = new THREE.MeshLambertMaterial({ color: primary });
    var skinMat = new THREE.MeshLambertMaterial({ color: skin });

    var torso = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.92, 0.42), jerseyMat);
    torso.position.y = 1.28; p.add(torso);
    var collar = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.14, 0.44), new THREE.MeshLambertMaterial({ color: secondary }));
    collar.position.y = 1.68; p.add(collar);

    var head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), skinMat);
    head.position.y = 2.02; p.add(head);

    var lArm = limb(THREE, 0.2, 0.82, 0.2, skin); lArm.position.set(-0.46, 1.66, 0);
    var rArm = limb(THREE, 0.2, 0.82, 0.2, skin); rArm.position.set(0.46, 1.66, 0);
    p.add(lArm); p.add(rArm);

    var lLeg = limb(THREE, 0.24, 0.92, 0.24, 0x222831); lLeg.position.set(-0.2, 0.86, 0);
    var rLeg = limb(THREE, 0.24, 0.92, 0.24, 0x222831); rLeg.position.set(0.2, 0.86, 0);
    p.add(lLeg); p.add(rLeg);

    var lFlag = makeFlagRibbon(THREE, 0xffd23f); lFlag.position.set(-0.4, 0.9, 0.18); lFlag.scale.setScalar(0.85);
    var rFlag = makeFlagRibbon(THREE, 0xffd23f); rFlag.position.set(0.4, 0.9, 0.18); rFlag.scale.setScalar(0.85);
    p.add(lFlag); p.add(rFlag);

    if (name) p.add(makeNameplate(THREE, name));

    // Nudge the whole player up so feet sit on the ground.
    p.scale.setScalar(1.05);

    p.userData = {
      torso: torso, head: head, lArm: lArm, rArm: rArm, lLeg: lLeg, rLeg: rLeg,
      lFlag: lFlag, rFlag: rFlag, ring: ring, phase: Math.random() * 6,
      throwT: 0, _wasPulled: false
    };
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
    var geo = new THREE.SphereGeometry(0.19, 14, 10);
    geo.scale(1.6, 1, 1);
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x7a4a20 }));
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
    spr.scale.set(2.4, 0.6, 1);
    spr.position.set(0, 2.75, 0);
    return spr;
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
