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
      renderer.toneMappingExposure = 0.86;
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
    scene.add(new THREE.HemisphereLight(0xdff0ff, 0x4a7a4a, 1.55));
    var sun = new THREE.DirectionalLight(0xfff4e0, 1.95);
    sun.position.set(-40, 70, 40);
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

    // Football
    var ball = makeBall(THREE);
    ball.visible = false;
    scene.add(ball);

    // Flying-flag effect pool (spawned on flag pulls)
    var flags = makeFlagPool(THREE, 10);
    scene.add(flags.group);

    // Touchdown flash sprite (full-scene tint via a big plane facing camera)
    var tdFx = { t: 0, dur: 0 };

    // Realistic rigged players (FLAGSTER.Player3D) are (re)built whenever the
    // roster array changes. Each entry: { P, ring, ud }.
    var PLAYER3D = global.FLAGSTER && global.FLAGSTER.Player3D;
    // Human scale: the rig is ~2.39yd tall, so 0.87 puts players at ~6'2".
    // (It was 1.45 — which rendered ~10ft-tall giants.)
    var PLAYER_SCALE = 0.87;
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
          number: (gp.ovr != null ? gp.ovr : idx),
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
          ud: { yaw: seedYaw, celebT: 0, _wasPulled: false, _threw: false, _caught: false, clip: 'idle' }
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
      var throwing = !!(ballInAir && state.ball.thrower === gp);

      if (ud.celebT > 0) ud.celebT = Math.max(0, ud.celebT - dt);

      // ---- FACING: pick a target yaw (field-angle space) by role ----------
      var yawT = ud.yaw;
      if (throwing) {
        var to = (state.ball && state.ball.to) || state.thrownTo;
        if (to) yawT = Math.atan2(to.y - gp.y, to.x - gp.x);
      } else if (reaching) {
        yawT = Math.atan2(state.ball.y - gp.y, state.ball.x - gp.x);
      } else if (carrier === gp) {
        if (moving) yawT = Math.atan2(vy, vx);        // ball carrier faces motion
      } else if (isOff) {
        if (moving) yawT = Math.atan2(vy, vx);        // receivers/QB face motion
      } else {
        // DEFENSE: face what they're playing (carrier -> ball target -> receiver).
        var chase = carrier ||
                    (ballInAir && state.ball.to ? state.ball.to : null) ||
                    state.thrownTo;
        if (chase) yawT = Math.atan2(chase.y - gp.y, chase.x - gp.x);
        else if (moving) yawT = Math.atan2(vy, vx);
      }
      ud.yaw = yawT;
      P.face(yawT, dt);                    // smooth turn; sets root.rotation.y = -yaw

      // Backpedal = actual facing roughly opposite to velocity (coverage).
      var face = P._yaw;
      var fwdDot = moving ? (Math.cos(face) * vx + Math.sin(face) * vy) : 0;
      var backpedal = !isOff && moving && fwdDot < -0.4;

      // ---- ONE-SHOT events (fire once per event) ---------------------------
      // Throw: QB releasing the ball.
      if (throwing && !ud._threw) { P.oneShot('throw', 'idle'); ud._threw = true; }
      if (!ballInAir) ud._threw = false;

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
        var sp = clamp(speed / 6, 0.6, 1.8);
        if (ud.celebT > 0) {
          P.play('celebrate');
        } else if (live && backpedal) {
          P.play('backpedal'); P.setSpeed(sp);
        } else if (live && moving) {
          P.play('run'); P.setSpeed(sp);
        } else {
          P.play('idle');                       // stand down between/at end of plays
        }
      }

      P.update(dt);

      // Nameplates only on the players that matter — the one you control and
      // whoever has the ball — so the full-field view stays clean.
      if (P.setPlateVisible) P.setPlateVisible(state.userControlled === gp || carrier === gp);

      // Highlight ring under the user-controlled player.
      entry.ring.visible = (state.userControlled === gp);
      if (entry.ring.visible) { entry.ring.position.set(holder.position.x, 0.05, holder.position.z); }
    }
    function cols0(gp) { return gp.team === 'home' ? homeCols[0] : awayCols[0]; }

    /* ---- BROADCAST CAMERA -------------------------------------------------
       Always frames the ENTIRE field. We solve for the camera distance at
       which every corner of the field's bounding box sits inside the frustum
       (both horizontally and vertically), so the whole pitch stays visible on
       any screen shape — portrait phone or wide desktop. The view sits behind
       the user's end zone looking downfield, so "our" side is nearest.       */
    var _fitPts = [];
    (function () {
      var xs = [-35.5, 35.5], ys = [0, 2.5], zs = [-13, 13];
      for (var i = 0; i < 2; i++) for (var j = 0; j < 2; j++) for (var k = 0; k < 2; k++)
        _fitPts.push(new THREE.Vector3(xs[i], ys[j], zs[k]));
    })();
    var _target = new THREE.Vector3(0, 1.2, 0);
    var _dir = new THREE.Vector3(), _fwd = new THREE.Vector3(),
        _rgt = new THREE.Vector3(), _upv = new THREE.Vector3(),
        _v = new THREE.Vector3(), _UPY = new THREE.Vector3(0, 1, 0);
    var camDist = 95;

    function updateCamera(state, dt) {
      var userSide = (engine && engine.userSide) || 'home';
      var userOff = (state.possession === userSide);
      var s = userOff ? 1 : -1;                    // we attack toward +x on offense

      /* MADDEN-STYLE FRAMING — always behind the team we're playing as.
         `s` flips with possession, so our players are always in the foreground
         and we look downfield at the opponent's end zone.

         Rather than forcing our own back line into frame (which shoves the
         camera miles back and shrinks the field to a strip), we anchor on OUR
         GOAL LINE and pull back exactly far enough that the field's full WIDTH
         spans the screen. Because we're looking straight down the field, the
         entire length — all the way to the opposite end zone — stays in view
         as it converges toward the horizon. */
      var halfW = 13.2;                            // field half-width + margin
      var vt = Math.tan(camera.fov * Math.PI / 360);
      var ht = vt * Math.max(0.22, viewAspect);

      // Horizontal pull-back so the width just fills the frame.
      var back = clamp(halfW / ht * 1.06, 15, 78);
      // Tall screens sit higher and aim shorter, so the frame is filled with
      // FIELD rather than sky; wide screens keep the low, dramatic sightline.
      var tall = (viewAspect < 1.0);
      var height = clamp(back * (tall ? 0.95 : 0.60), 9, 52);
      var ahead = clamp(back * (tall ? 0.80 : 1.50), 22, 62);

      // Anchor a few yards behind the ACTION (like a broadcast/Madden cam) so
      // players stay readable, clamped so we never drift past our own end line.
      var focusFx = (state.losX != null) ? state.losX : MID;
      if (state.carrier) focusFx = state.carrier.x;
      else if (state.ball && state.ball.inAir) focusFx = state.ball.x;
      var anchorFx = focusFx - s * 7;
      anchorFx = (s > 0) ? Math.max(anchorFx, GOAL_L - 3) : Math.min(anchorFx, GOAL_R + 3);
      camFx = lerp(camFx, anchorFx, clamp(dt * 2.2, 0, 1));
      var anchorX = wx(camFx);

      var camX = anchorX - s * back;
      var lookX = anchorX + s * ahead;

      // Ease so possession changes swing smoothly instead of snapping.
      var k = clamp(dt * 2.6, 0, 1);
      camera.position.set(
        lerp(camera.position.x, camX, k),
        lerp(camera.position.y, height, k),
        0
      );
      _target.set(lerp(_target.x, lookX, k), 1.6, 0);
      camera.lookAt(_target);
      if (sun.target) sun.target.position.set(0, 0, 0);
    }

    // ---------------------------- RESIZE -----------------------------------
    function resize() {
      var w = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 800;
      var h = canvas.clientHeight || (canvas.parentElement && canvas.parentElement.clientHeight) || 480;
      if (w < 2 || h < 2) return;
      renderer.setSize(w, h, false);
      if (fx) fx.setSize(w, h);
      camera.aspect = w / h; viewAspect = w / h;
      // FOV stays fixed — updateCamera() solves the distance that fits the
      // whole field for this aspect, so nothing is ever cropped.
      camera.updateProjectionMatrix();
    }
    // Optional post-processing (subtle bloom + SMAA). null => render direct.
    var fx = (global.FLAGSTER && global.FLAGSTER.FX)
      ? global.FLAGSTER.FX.create(THREE, renderer, scene, camera, {})
      : null;

    var ro = ('ResizeObserver' in global) ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(canvas); else global.addEventListener('resize', resize);
    resize();

    // ---------------------------- RENDER -----------------------------------
    function render(state) {
      if (!state) { if (fx) fx.render(); else renderer.render(scene, camera); return; }
      var dt = (engine && engine._dt) || 0.016;
      if (dt > 0.05) dt = 0.05;

      // Rebuild player meshes if the roster array was replaced (new down).
      if (state.players !== playersRef) rebuildPlayers(state.players);

      var inAir = !!(state.ball && state.ball.inAir);
      prevInAir = inAir;

      // Players (each Player3D advances its own mixer + one-shots).
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
      if (fx) fx.render(); else renderer.render(scene, camera);
    }

    function stop() {
      if (ro) ro.disconnect(); else global.removeEventListener('resize', resize);
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

  function makeBall(THREE) {
    var geo = new THREE.SphereGeometry(0.19, 14, 10);
    geo.scale(1.6, 1, 1);
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
