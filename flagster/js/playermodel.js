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
    throw: 'Throw', catch: 'Catch', dive: 'Dive',
    // Two different clips, two different players: FlagGrab is the DEFENDER
    // reaching out and ripping the flag off; FlagPulled is the ball carrier's
    // reaction to losing it.
    flaggrab: 'FlagGrab', flagpull: 'FlagPulled', flagpulled: 'FlagPulled',
    celebrate: 'Celebrate', juke: 'Juke'
  };
  var LOOPING = { Idle: 1, Run: 1, Walk: 1, Backpedal: 1, Celebrate: 1 };

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

    api.play = function (name, fade) {
      var key = canon(name);
      var next = actions[key];
      if (!next) return;
      if (current === next && next.loop === THREE.LoopRepeat) { if (!next.isRunning()) next.play(); return; }
      next.reset(); next.enabled = true; next.setEffectiveWeight(1); next.timeScale = 1;
      if (LOOPING[key]) api._oneShot = null;
      if (current && current !== next) {
        next.play();
        current.crossFadeTo(next, fade == null ? 0.22 : fade, false);
      } else {
        next.play();
      }
      current = next;
      if (LOOPING[key]) api.setSpeed(api._speed);
    };

    api.oneShot = function (name, returnTo, fade) {
      var key = canon(name);
      var a = actions[key];
      if (!a) return;
      api._returnTo = canon(returnTo || 'Idle');
      a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.timeScale = 1;
      if (current && current !== a) { a.play(); current.crossFadeTo(a, fade == null ? 0.15 : fade, false); }
      else a.play();
      current = a; api._oneShot = a;
    };

    /* Where in the stride the legs currently are, 0..1, or null if the clip
       running isn't a gait. Anything layered on top of a walk or a run has to
       be in step with it or it reads as a second animation playing over the
       first — the carry arm is the case this exists for. Read from the action
       rather than integrated separately, because setSpeed() rescales the clip
       continuously and only the action knows where that has left it. */
    var GAITS = { Run: 1, Walk: 1, Backpedal: 1 };
    api.stridePhase = function () {
      if (!current || api._oneShot) return null;
      var clip = current.getClip && current.getClip();
      if (!clip || !GAITS[clip.name] || !current.isRunning()) return null;
      var d = clip.duration;
      if (!(d > 0)) return null;
      var p = (current.time % d) / d;
      return p < 0 ? p + 1 : p;
    };

    api.setSpeed = function (mult) {
      api._speed = mult;
      if (actions.Run) actions.Run.timeScale = mult;
      if (actions.Walk) actions.Walk.timeScale = mult;
      if (actions.Backpedal) actions.Backpedal.timeScale = mult;
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
      mixer.update(dt);
      if (api._oneShot && !api._oneShot.isRunning() && api._oneShot.loop === THREE.LoopOnce) {
        var back = actions[api._returnTo] || actions.Idle;
        if (back) {
          back.reset(); back.enabled = true; back.setEffectiveWeight(1); back.play();
          api._oneShot.crossFadeTo(back, 0.25, false);
          current = back;
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
    clipNames: ['Idle', 'Run', 'Walk', 'Backpedal', 'Throw', 'Catch', 'Dive', 'FlagGrab', 'FlagPulled', 'Celebrate', 'Juke'],
    materialNames: ['jersey', 'trim', 'skin', 'hair', 'shorts', 'socks', 'shoes', 'belt', 'flag'],
    socketNames: ['Socket_Hand_L', 'Socket_Hand_R', 'Socket_Flag_L', 'Socket_Flag_R'],
    heightMetres: AUTHOR_HEIGHT_M,
    setScale: function (s) { SCALE = s; },
    getScale: function () { return SCALE; }
  };
})(window);
