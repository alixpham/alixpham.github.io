/* ============================================================================
   FLAGSTER — PLAYER MODEL  (rigged .glb character loader / adapter)

   Drop-in alternative to FLAGSTER.Player3D.build(): loads the real skinned
   flag-football player from lib/flagplayer.glb once, then clones it per player
   with SkeletonUtils so every instance gets its own skeleton, its own
   AnimationMixer and its own materials (so team tinting is per-instance).

   The returned object exposes EXACTLY the same public surface the game already
   calls on Player3D instances:

     root, plate, mixer, actions, nodes,
     play(name), oneShot(name, returnTo), setSpeed(m),
     face(yaw, dt), setYaw(yaw), update(dt), dispose(),
     setPlateScale(k), setPlateVisible(v)

   ...plus the locomotion blend space, which is what the renderer should drive
   a moving player with instead of play('run'):

     gait(kind, speed)          'forward' | 'backward', world units/sec
     setBuildScale(k)           this athlete's height multiplier
     setPhaseOffset(p)          where in the stride this athlete starts
     stridePhase()              shared 0..1 phase, left foot contact at 0
     gaitInfo()                 which rungs, what weight — for verification

   Usage:
     FLAGSTER.PlayerModel.preload(THREE);
     ... later ...
     if (FLAGSTER.PlayerModel.isReady()) {
       var P = FLAGSTER.PlayerModel.build(THREE, {
         jersey:'#d80621', trim:'#ffdf00', skin:'#e8b98f', number:7, name:'RIVERA'
       });
       scene.add(P.root); P.play('run');
     }

   ---------------------------------------------------------------------------
   CONVENTIONS (mirrored from tools/build-player-glb.mjs and player3d.js)

   * The .glb is authored in METRES, feet on y = 0, top of head at y = 1.850,
     and the rig FACES +Z with the character's LEFT at +X.
   * The game treats 1 world unit = 1 yard = 0.9144 m, so the adapter scales the
     model by 1/0.9144 = 1.0936 -> 2.023 world units tall. Override per-instance
     with opts.scale, or globally via FLAGSTER.PlayerModel.setScale().
   * Heading: `yaw` is a WORLD heading with yaw = 0 meaning +X, exactly as in
     player3d.js. Because this rig also faces +Z, the mapping is identical:
         root.rotation.y = Math.PI / 2 - yaw
   * Clip names in the .glb are capitalised (Idle/Run/.../FlagPulled). play()
     and oneShot() accept the game's lower-camel vocabulary
     (idle/run/walk/backpedal/throw/catch/dive/flagGrab/flagPulled/celebrate/juke) as well
     as the canonical names, so no call sites need to change.
   ============================================================================ */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ constants */
  var METRES_PER_UNIT = 0.9144;                      // 1 world unit = 1 yard
  var AUTHOR_HEIGHT_M = 1.850;                       // documented model height
  var DEFAULT_SCALE = 1 / METRES_PER_UNIT;           // ≈ 1.0936 -> 2.023 units

  // Clip vocabulary: the game's names -> the names baked into the .glb.
  var CLIP_ALIAS = {
    idle: 'Idle', run: 'Run', walk: 'Walk', backpedal: 'Backpedal',
    jog: 'Jog', sprint: 'Sprint',
    throw: 'Throw', catch: 'Catch', dive: 'Dive',
    // Two different clips, two different players: FlagGrab is the DEFENDER
    // reaching out and ripping the flag off; FlagPulled is the ball carrier's
    // reaction to losing it.
    flaggrab: 'FlagGrab', flagpull: 'FlagPulled', flagpulled: 'FlagPulled',
    // Five celebrations, not one. `celebrate` is the hop the game has always
    // had; the other four are there so ten men in an end zone don't perform a
    // single animation in unison. Spike is the only one-shot of them.
    celebrate: 'Celebrate', spike: 'Spike', dance: 'Dance', flex: 'Flex',
    highstep: 'HighStep', juke: 'Juke'
  };
  var LOOPING = {
    Idle: 1, Run: 1, Walk: 1, Backpedal: 1, Jog: 1, Sprint: 1,
    Celebrate: 1, Dance: 1, Flex: 1, HighStep: 1
  };

  /* THE GAIT LADDER — which clips bracket which, and in what order.

     Two ladders, because travelling backwards is not travelling forwards with
     a minus sign: it has its own clip and no faster or slower rung to blend
     with. Names are the .glb's, and any rung the loaded file doesn't carry is
     simply dropped, so an older asset still works (it just has fewer rungs). */
  var LADDERS = {
    forward: ['Walk', 'Jog', 'Run', 'Sprint'],
    backward: ['Backpedal']
  };
  var IS_GAIT = { Walk: 1, Jog: 1, Run: 1, Sprint: 1, Backpedal: 1 };

  // Which materials each option tints. Anything not listed keeps its baked
  // colour, so setting a jersey never repaints skin, shoes or the flags.
  var TINTABLE = {
    jersey: 'jersey', trim: 'trim', skin: 'skin', hair: 'hair',
    shorts: 'shorts', socks: 'socks', shoes: 'shoes', flagColor: 'flag'
  };

  function canon(name) {
    if (!name) return 'Idle';
    if (LOOPING[name] || CLIP_ALIAS[String(name).toLowerCase()]) {
      return CLIP_ALIAS[String(name).toLowerCase()] || name;
    }
    return CLIP_ALIAS[String(name).toLowerCase()] || name;
  }

  /* ------------------------------------------------------- asset location */
  var MODEL_URL = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (!s) {
        var ss = document.getElementsByTagName('script');
        for (var i = ss.length - 1; i >= 0; i--) {
          if (/playermodel\.js/.test(ss[i].src)) { s = ss[i].src; break; }
        }
      }
      return s ? s.replace(/js\/playermodel\.js.*$/, 'lib/flagplayer.glb') : 'lib/flagplayer.glb';
    } catch (e) { return 'lib/flagplayer.glb'; }
  })();

  var MODEL = { ready: false, failed: false, loading: false, scene: null, clips: null, error: null };
  var SCALE = DEFAULT_SCALE;
  var waiters = [];

  function settle() {
    var list = waiters; waiters = [];
    list.forEach(function (fn) { try { fn(MODEL.ready ? null : (MODEL.error || new Error('load failed'))); } catch (e) { } });
  }

  function preload(THREE, url) {
    THREE = THREE || global.THREE;
    if (MODEL.ready || MODEL.loading) return;
    if (!THREE || !THREE.GLTFLoader || !THREE.SkeletonUtils) {
      MODEL.failed = true; MODEL.error = new Error('GLTFLoader/SkeletonUtils unavailable'); settle(); return;
    }
    MODEL.loading = true;
    try {
      new THREE.GLTFLoader().load(url || MODEL_URL,
        function (gltf) {
          MODEL.scene = gltf.scene;
          MODEL.clips = gltf.animations || [];
          // Skinned bounds are unreliable before the first pose, and every
          // instance is frustum-culled by its own root anyway.
          MODEL.scene.traverse(function (o) { if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false; });
          MODEL.ready = true; MODEL.loading = false; settle();
        },
        undefined,
        function (err) { MODEL.failed = true; MODEL.loading = false; MODEL.error = err || new Error('glb load error'); settle(); });
    } catch (e) {
      MODEL.failed = true; MODEL.loading = false; MODEL.error = e; settle();
    }
  }

  function whenReady(cb) {
    if (MODEL.ready) { cb(null); return; }
    if (MODEL.failed) { cb(MODEL.error || new Error('load failed')); return; }
    waiters.push(cb);
  }

  /* ------------------------------------------------------------ nameplate */
  function roundRect(x, rx, ry, w, h, r) {
    x.beginPath(); x.moveTo(rx + r, ry);
    x.arcTo(rx + w, ry, rx + w, ry + h, r); x.arcTo(rx + w, ry + h, rx, ry + h, r);
    x.arcTo(rx, ry + h, rx, ry, r); x.arcTo(rx, ry, rx + w, ry, r); x.closePath();
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

  /* ------------------------------------------------- chest/back number decal */
  function numberDecal(THREE, num, color) {
    if (num == null || num === '') return null;
    var c = document.createElement('canvas'); c.width = 128; c.height = 128;
    var x = c.getContext('2d');
    x.clearRect(0, 0, 128, 128);
    x.font = 'bold 92px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 8; x.strokeStyle = 'rgba(0,0,0,0.55)';
    x.strokeText(String(num), 64, 68);
    x.fillStyle = color || '#ffffff';
    x.fillText(String(num), 64, 68);
    var tex = new THREE.CanvasTexture(c);
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    var mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    var g = new THREE.Group(); g.name = 'number';
    // Parented to the Chest bone; the bone's rest frame is world-aligned, so
    // these offsets are plain metres relative to the chest joint at y = 1.30.
    var front = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.19), mat);
    front.position.set(0, 0.075, 0.142); g.add(front);
    var back = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), mat);
    back.position.set(0, 0.115, -0.142); back.rotation.y = Math.PI; g.add(back);
    g.userData.decalMat = mat;
    return g;
  }

  /* ---------------------------------------------------------------- build */
  function build(THREE, opts) {
    THREE = THREE || global.THREE;
    opts = opts || {};
    if (!MODEL.ready) throw new Error('FLAGSTER.PlayerModel: model not loaded yet (call preload and wait for isReady())');

    var clone = THREE.SkeletonUtils.clone(MODEL.scene);

    /* --- per-instance materials, keyed by the baked material names --------
       Every SkinnedMesh keeps the region name from the .glb ('jersey',
       'trim', 'skin', 'hair', 'shorts', 'socks', 'shoes', 'belt', 'flag'), and
       so does its material. Cloning here is what makes two players on screen
       tintable independently.                                              */
    var mats = {};
    var parts = {};
    clone.traverse(function (o) {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.frustumCulled = false;
      o.castShadow = true; o.receiveShadow = true;
      if (!o.material) return;
      var key = o.material.name || o.name;
      if (mats[key]) { o.material = mats[key]; }
      else { o.material = o.material.clone(); o.material.name = key; mats[key] = o.material; }
      parts[o.name || key] = o;
    });
    function tint(key, hex) {
      var m = mats[key];
      if (m && m.color && hex != null) m.color.set(hex);
    }
    for (var k in TINTABLE) { if (opts[k] != null) tint(TINTABLE[k], opts[k]); }
    // Sensible defaults so a bare build() still looks like a team kit.
    if (opts.jersey == null) tint('jersey', '#2b5cff');
    if (opts.trim == null) tint('trim', '#ffffff');
    if (opts.skin == null) tint('skin', '#e8b98f');
    // Shorts default to a darkened jersey so kits read as one uniform.
    if (opts.shorts == null && opts.jersey != null && mats.shorts) {
      mats.shorts.color.set(opts.jersey).multiplyScalar(0.42);
    }

    /* --- bone lookup + sockets --- */
    var nodes = {};
    var sockets = {};
    clone.traverse(function (o) {
      if (o.isBone) {
        nodes[o.name] = o;
        if (o.name.indexOf('Socket_') === 0) sockets[o.name] = o;
      }
    });

    /* --- chest / back numbers --- */
    var deco = numberDecal(THREE, opts.number, opts.trim || '#ffffff');
    if (deco && nodes.Chest) nodes.Chest.add(deco);

    /* --- scaling + root --------------------------------------------------
       `facer` carries the metres->world-units scale so the caller's root stays
       a clean, unit-scaled node whose rotation.y is the heading.           */
    var scale = opts.scale != null ? opts.scale : SCALE;
    var facer = new THREE.Group();
    facer.name = 'facer';
    facer.scale.setScalar(scale);
    facer.add(clone);

    var root = new THREE.Group();
    root.name = 'root';
    root.add(facer);

    var plate = nameplate(THREE, opts.name);
    // Matches where Player3D floats its tag (~0.5 units clear of the head), so
    // swapping the two builders doesn't shift labels around the field.
    plate.position.y = AUTHOR_HEIGHT_M * scale + 0.50;
    root.add(plate);

    /* --- animation ------------------------------------------------------- */
    var mixer = new THREE.AnimationMixer(clone);
    var actions = {};
    (MODEL.clips || []).forEach(function (cl) {
      var a = mixer.clipAction(cl);
      if (LOOPING[cl.name]) { a.loop = THREE.LoopRepeat; }
      else { a.loop = THREE.LoopOnce; a.clampWhenFinished = true; }
      actions[cl.name] = a;
      // also reachable by the game's lower-camel names
      for (var alias in CLIP_ALIAS) {
        if (CLIP_ALIAS[alias] === cl.name && !actions[alias]) actions[alias] = a;
      }
    });

    var current = null;
    var api = {
      root: root, nodes: nodes, sockets: sockets, materials: mats, parts: parts,
      mixer: mixer, actions: actions, isModel: true, scale: scale,
      _yaw: 0, _speed: 1, _oneShot: null, _returnTo: 'Idle'
    };

    /* ================= THE LOCOMOTION BLEND SPACE =========================

       WHY THIS IS NOT play('run') + setSpeed().

       Scaling one run cycle by playback rate changes cadence and nothing else.
       The stride stays exactly as long as it was baked, so the only way to make
       a player cover more ground is to make their legs go round faster: at the
       top of this game's speed range that meant playing the run at 2.4x, which
       is 465 steps a minute. Nothing alive moves like that, and it is most of
       why ten players in a formation read as clockwork rather than as athletes.

       Real speed is stride length times stride frequency and BOTH rise with it.
       So the .glb now carries four forward gaits — Walk, Jog, Run, Sprint, each
       authored at its own stride length and its own cadence, each with the left
       foot's contact at phase 0 — and this blends the two that bracket the
       player's actual speed.

       The weight is chosen so the pair's own measured ground speeds interpolate
       TO the speed asked for. That one decision is what makes the whole thing
       work: at any speed inside the ladder the blended stride length and the
       blended cadence are both the authored values for that speed, and the
       playback rate sits at 1.0 rather than being stretched. Outside the ladder
       (below a walk, above a sprint) there is nothing to blend with and the
       rate stretches again — but the ends of the ladder are outside the game's
       speed range, so that is a fallback rather than the normal case.

       PHASE IS DRIVEN HERE, NOT BY THE MIXER. Both actions run at timeScale 0
       and this writes their `.time` from one shared phase every frame. Letting
       the mixer advance two clips of different durations independently is how a
       blend ends up with one clip landing while the other is airborne, and the
       resulting pose has both feet somewhere between the turf and the air. It
       also means a transition between rungs — or between a gait and a one-shot
       and back — resumes at the phase it left, instead of restarting the cycle
       from the left foot every time; and it gives the renderer a phase offset
       to hand out, so a squad is not ten men stepping in unison. */
    var ladder = {};
    (function () {
      for (var kind in LADDERS) {
        var rungs = [];
        LADDERS[kind].forEach(function (nm) {
          var a = actions[nm], cl = a && a.getClip && a.getClip();
          var ex = cl && cl.userData;
          // A rung needs a measured ground speed to be placed on the ladder at
          // all; an older .glb without one simply has fewer rungs.
          if (!a || !cl || !ex || !ex.gait || !(ex.groundSpeed > 0)) return;
          rungs.push({ name: nm, action: a, dur: cl.duration, nat: ex.groundSpeed * scale,
                       blendUp: ex.blendUp || null });
        });
        rungs.sort(function (p, q) { return p.nat - q.nat; });
        ladder[kind] = rungs;
      }
    }());

    var gaitReq = null;        // {kind, speed} — set by gait(), consumed by update()
    var gaitW = 0;             // 0..1: how much of the body the blend space owns
    var pair = null;           // [rungA, rungB, w] currently mounted
    var phase = 0;             // the shared stride phase — left contact at 0
    var buildScale = 1;        // the renderer's per-athlete height multiplier
    var gaitRate = 1, gaitCycle = 0;

    api.setBuildScale = function (k) { buildScale = (k > 0 ? k : 1); };
    api.setPhaseOffset = function (p) { phase = ((p % 1) + 1) % 1; };
    /* Ask for locomotion this frame. It is a REQUEST, not a state change: the
       gait owns the body only for as long as something keeps asking, so the
       renderer dropping into a one-shot or a celebration needs no matching
       "stop" call — it just stops asking and the blend fades itself out. */
    api.gait = function (kind, speed) {
      gaitReq = { kind: (kind === 'backward' ? 'backward' : 'forward'), speed: speed || 0 };
    };
    api.gaitInfo = function () {
      if (!pair) return null;
      return { a: pair[0].name, b: pair[1].name, blend: pair[2], phase: phase,
               weight: gaitW, rate: gaitRate, cycle: gaitCycle };
    };

    // Which two rungs bracket this speed, and how far between them it sits.
    function pickPair(kind, speed) {
      var rungs = ladder[kind];
      if (!rungs || !rungs.length) rungs = ladder.forward;
      if (!rungs || !rungs.length) return null;
      var i = 0;
      while (i < rungs.length - 2 && speed >= rungs[i + 1].nat * buildScale) i++;
      var A = rungs[i], B = rungs[i + 1] || A;
      var lo = A.nat * buildScale, hi = B.nat * buildScale;
      var w = (B === A || hi <= lo) ? 0 : (speed - lo) / (hi - lo);
      return [A, B, w < 0 ? 0 : w > 1 ? 1 : w];
    }

    /* HOW FAST THE MIX REALLY IS, which is not the mix of how fast they are.

       A pose halfway between a jog and a run does not cover the ground at the
       average of their two speeds: the legs interpolate, the pelvis height
       interpolates as a separate translation track without ever being re-solved
       against them, and the stride that falls out is a little shorter than the
       average. Left uncorrected the support foot slides forward for the whole
       of every stance, at exactly the speeds a receiver spends a play at.

       tools/build-player-glb.mjs measures it — it can build the blended pose
       exactly, because these joints all rotate about one axis and a slerp
       between two rotations about a common axis is an interpolation of the
       angle — and bakes the ratio onto the slower clip as `blendUp`, sampled at
       quarters. This reads it back. No constant to keep in step: re-author a
       stride and the curve is rebuilt with it. */
    function blendSag(rung, w) {
      var c = rung.blendUp;
      if (!c || c.length < 5) return 1;
      var x = w * 4, i = Math.floor(x);
      if (i >= 4) return c[4];
      return c[i] + (c[i + 1] - c[i]) * (x - i);
    }

    /* `r.on` rather than action.isRunning(): three.js counts an action with
       timeScale 0 as NOT running, and these deliberately run at timeScale 0
       because the phase is written rather than integrated. Trusting isRunning()
       here re-activated both rungs on the mixer every single frame. */
    function mountRung(r, w) {
      var a = r.action;
      if (!r.on) { a.reset(); a.play(); r.on = true; }
      a.enabled = true;
      a.timeScale = 0;                       // phase is written below, not integrated
      a.setEffectiveWeight(w);
      a.time = phase * r.dur;
    }
    function unmountRung(r) {
      r.on = false;
      r.action.setEffectiveWeight(0);
      r.action.enabled = false;
      r.action.timeScale = 1;
      r.action.stop();
    }

    // Hand the body back: stop both rungs so play() and setSpeed() own them
    // again (hero3d still drives the run cycle the old way, and should).
    function dropGait() {
      if (pair) {
        unmountRung(pair[0]);
        if (pair[1] !== pair[0]) unmountRung(pair[1]);
      }
      pair = null; gaitW = 0;
    }

    function driveGait(dt) {
      var want = gaitReq ? 1 : 0;
      if (!want && !pair) return;
      // ~0.18s to hand the body over in either direction, which is about the
      // length of a footfall and short enough that a cut doesn't float.
      gaitW += (want - gaitW) * (1 - Math.exp(-dt * 11));
      if (want) {
        /* Whatever single clip was playing gives way. It has to be released
           rather than crossfaded, because from here on the weights of the two
           rungs are written every frame and three.js's own fade scheduling
           would be overwritten mid-ramp. */
        if (current) { current.fadeOut(0.18); current = null; }
        var p = pickPair(gaitReq.kind, gaitReq.speed);
        if (!p) { gaitReq = null; return; }
        var lo = p[0].nat * buildScale, hi = p[1].nat * buildScale;
        var blendNat = (lo + (hi - lo) * p[2]) * blendSag(p[0], p[2]);
        gaitRate = blendNat > 0 ? gaitReq.speed / blendNat : 1;
        // The clamp is the honest admission that the ladder has ends. Inside
        // it, this sits within a few percent of 1.0 and does nothing.
        gaitRate = gaitRate < 0.55 ? 0.55 : gaitRate > 1.9 ? 1.9 : gaitRate;
        gaitCycle = (p[0].dur + (p[1].dur - p[0].dur) * p[2]) / gaitRate;
        if (gaitCycle > 0.02) { phase += dt / gaitCycle; phase -= Math.floor(phase); }
        if (pair && (pair[0] !== p[0] || pair[1] !== p[1])) dropRungsNotIn(p);
        pair = p;
      }
      if (!pair) return;
      if (gaitW < 0.002 && !want) { dropGait(); return; }
      mountRung(pair[0], gaitW * (1 - pair[2]));
      if (pair[1] !== pair[0]) mountRung(pair[1], gaitW * pair[2]);
    }
    // Stepping from one rung of the ladder to the next leaves the rung we came
    // off still running at whatever weight it had; stop the ones that are not
    // in the new pair. The phase is shared, so the new pair picks up exactly
    // where the old one was and no foot moves.
    function dropRungsNotIn(p) {
      var keep = { };
      keep[p[0].name] = 1; keep[p[1].name] = 1;
      for (var kind in ladder) {
        ladder[kind].forEach(function (r) { if (!keep[r.name] && r.on) unmountRung(r); });
      }
    }

    api.play = function (name, fade) {
      var key = canon(name);
      var next = actions[key];
      if (!next) return;
      // An explicit play() of a gait clip (hero3d's attract-mode loop) takes
      // the old road: one clip, one playback rate.
      if (IS_GAIT[key]) dropGait();
      if (current === next && next.loop === THREE.LoopRepeat) { if (!next.isRunning()) next.play(); return; }
      var f = fade == null ? 0.22 : fade;
      next.reset(); next.enabled = true; next.timeScale = 1;
      if (LOOPING[key]) api._oneShot = null;
      if (current && current !== next) {
        next.setEffectiveWeight(1); next.play();
        current.crossFadeTo(next, f, false);
      } else if (gaitW > 0.002 && pair) {
        // Coming off the blend space. It fades itself out — this frame nothing
        // asked for a gait — so this only has to fade in against it.
        next.setEffectiveWeight(0); next.play(); next.fadeIn(f);
      } else {
        next.setEffectiveWeight(1); next.play();
      }
      current = next;
      if (LOOPING[key]) api.setSpeed(api._speed);
    };

    api.oneShot = function (name, returnTo, fade) {
      var key = canon(name);
      var a = actions[key];
      if (!a) return;
      api._returnTo = canon(returnTo || 'Idle');
      var f = fade == null ? 0.15 : fade;
      a.reset(); a.enabled = true; a.timeScale = 1;
      if (current && current !== a) { a.setEffectiveWeight(1); a.play(); current.crossFadeTo(a, f, false); }
      else if (gaitW > 0.002 && pair) { a.setEffectiveWeight(0); a.play(); a.fadeIn(f); }
      else { a.setEffectiveWeight(1); a.play(); }
      current = a; api._oneShot = a;
    };

    /* Where in the stride the legs currently are, 0..1, or null if nothing is
       striding. Anything layered on top of a walk or a run has to be in step
       with it or it reads as a second animation playing over the first — the
       carry arm is the case this exists for. While the blend space is driving,
       this is the phase it drives, which is shared by both blended rungs; the
       fallback path reads the one running clip. */
    api.stridePhase = function () {
      if (api._oneShot) return null;
      if (pair && gaitW > 0.35) return phase;
      if (!current) return null;
      var clip = current.getClip && current.getClip();
      if (!clip || !IS_GAIT[clip.name] || !current.isRunning()) return null;
      var d = clip.duration;
      if (!(d > 0)) return null;
      var p = (current.time % d) / d;
      return p < 0 ? p + 1 : p;
    };

    api.setSpeed = function (mult) {
      api._speed = mult;
      for (var nm in IS_GAIT) if (actions[nm]) actions[nm].timeScale = mult;
    };

    /* HOW FAST THIS PLAYER TRAVELS WHEN A GAIT CLIP PLAYS AT 1x, in world units
       per second. A clip with no root motion only looks planted if the support
       foot sweeps backward at exactly the speed the ground moves under it, and
       that speed is a property of the CLIP — it changes the moment anybody
       edits a stride table. tools/build-player-glb.mjs measures it off the same
       kinematics it builds the clip from and bakes it into the glTF as
       animation extras, which GLTFLoader hands back on clip.userData.

       The only thing left to do here is the units: the number in the file is
       metres per second at the model's authored height, and this instance is
       scaled twice — once from metres to yards, and again by whatever build the
       renderer gave this particular athlete. A taller player's stride really
       does cover more ground, so both belong in the answer.

       Returns null for a clip that carries no measurement (or a rig old enough
       not to have any), which is the caller's cue to fall back. */
    api.naturalSpeed = function (name, extraScale) {
      var a = actions[canon(name)];
      var cl = a && a.getClip && a.getClip();
      var g = cl && cl.userData;
      if (!g || !g.gait || !(g.groundSpeed > 0)) return null;
      return g.groundSpeed * scale * (extraScale == null ? 1 : extraScale);
    };

    // yaw = world heading, yaw 0 -> +X. Rig faces +Z, hence the PI/2 offset —
    // identical to FLAGSTER.Player3D so the two are interchangeable.
    api.face = function (yaw, dt) {
      var diff = yaw - api._yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      api._yaw += diff * Math.min(1, (dt || 0.016) * 9);
      root.rotation.y = Math.PI / 2 - api._yaw;
    };
    api.setYaw = function (yaw) { api._yaw = yaw; root.rotation.y = Math.PI / 2 - yaw; };

    api.plate = plate;
    api.setPlateScale = function (k) { if (plate) plate.scale.set(1.9 * k, 0.48 * k, 1); };
    api.setPlateVisible = function (v) { if (plate) plate.visible = !!v; };

    // Attach anything (a ball, a torn-off flag) to a named socket joint.
    api.attach = function (socketName, object3d) {
      var s = sockets[socketName] || nodes[socketName];
      if (s && object3d) { s.add(object3d); return true; }
      return false;
    };

    api.update = function (dt) {
      // Weights and phase FIRST: the mixer reads them this same frame, and a
      // gait mounted after mixer.update() would render one frame stale — which
      // at a sprint's cadence is a visible hitch on every transition.
      driveGait(dt || 0);
      gaitReq = null;                        // ask again next frame, or it lapses
      mixer.update(dt);
      if (api._oneShot && !api._oneShot.isRunning() && api._oneShot.loop === THREE.LoopOnce) {
        /* Handing back to a GAIT is not a crossfade to a clip — there is no
           single clip to fade to, and forcing one would restart the stride from
           the left foot. Fade the one-shot out and let whatever asks for a gait
           next frame fade itself in against it, from the phase the legs were
           already at. */
        if (IS_GAIT[api._returnTo]) {
          api._oneShot.fadeOut(0.25);
          current = null;
        } else {
          var back = actions[api._returnTo] || actions.Idle;
          if (back) {
            back.reset(); back.enabled = true; back.setEffectiveWeight(1); back.timeScale = 1; back.play();
            api._oneShot.crossFadeTo(back, 0.25, false);
            current = back;
          }
        }
        api._oneShot = null;
      }
    };

    api.dispose = function () {
      mixer.stopAllAction();
      mixer.uncacheRoot(clone);
      // Geometry is shared across every SkeletonUtils clone — only the
      // per-instance materials and canvas textures created here are ours.
      for (var key in mats) {
        var m = mats[key];
        if (m.map) m.map.dispose();
        m.dispose();
      }
      if (deco && deco.userData.decalMat) {
        if (deco.userData.decalMat.map) deco.userData.decalMat.map.dispose();
        deco.userData.decalMat.dispose();
        deco.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
      }
      if (plate) {
        if (plate.material.map) plate.material.map.dispose();
        plate.material.dispose();
      }
    };

    if (actions.Idle) { actions.Idle.play(); current = actions.Idle; }
    return api;
  }

  /* ---------------------------------------------------------------- api */
  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.PlayerModel = {
    preload: preload,
    whenReady: whenReady,
    isReady: function () { return !!MODEL.ready; },
    isFailed: function () { return !!MODEL.failed; },
    build: build,
    model: MODEL,
    url: MODEL_URL,
    clipNames: ['Idle', 'Run', 'Walk', 'Backpedal', 'Throw', 'Catch', 'Dive', 'FlagGrab',
      'FlagPulled', 'Celebrate', 'Spike', 'Dance', 'Flex', 'HighStep', 'Juke'],
    materialNames: ['jersey', 'trim', 'skin', 'hair', 'shorts', 'socks', 'shoes', 'belt', 'flag'],
    socketNames: ['Socket_Hand_L', 'Socket_Hand_R', 'Socket_Flag_L', 'Socket_Flag_R'],
    heightMetres: AUTHOR_HEIGHT_M,
    setScale: function (s) { SCALE = s; },
    getScale: function () { return SCALE; }
  };
})(window);
