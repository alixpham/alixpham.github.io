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
     (idle/run/walk/backpedal/throw/catch/dive/flagGrab/flagPulled/celebrate/juke,
     and the celebrations bow/lasso/salute/griddy/point) as well
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
    // TEN celebrations, not one. `celebrate` is the hop the game has always
    // had; the rest are there so ten men in an end zone don't perform a single
    // animation in unison, and so a touchdown, a first down and a takeaway are
    // not the same news told the same way. Spike and Point are the one-shots.
    celebrate: 'Celebrate', spike: 'Spike', dance: 'Dance', flex: 'Flex',
    highstep: 'HighStep', bow: 'Bow', lasso: 'Lasso', salute: 'Salute',
    griddy: 'Griddy', point: 'Point', juke: 'Juke'
  };
  var LOOPING = {
    Idle: 1, Run: 1, Walk: 1, Backpedal: 1, Jog: 1, Sprint: 1,
    Celebrate: 1, Dance: 1, Flex: 1, HighStep: 1,
    Bow: 1, Lasso: 1, Salute: 1, Griddy: 1
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
  // One key may drive several materials: the head carries the face texture and
  // so lives in its own material, but it is the same person's skin.
  var TINTABLE = {
    jersey: ['jersey'], trim: ['trim'], skin: ['skin', 'head'], hair: ['hair'],
    shorts: ['shorts'], socks: ['socks'], shoes: ['shoes'], flagColor: ['flag']
  };

  // Baked appearance variants. Exactly one of each group is shown; the rest
  // are hidden, and a hidden mesh costs no draw call.
  var HAIR_STYLES = ['buzz', 'crop', 'fade', 'afro', 'locs', 'long'];
  var FACIAL_HAIR = ['goatee', 'full'];

  function canon(name) {
    if (!name) return 'Idle';
    if (LOOPING[name] || CLIP_ALIAS[String(name).toLowerCase()]) {
      return CLIP_ALIAS[String(name).toLowerCase()] || name;
    }
    return CLIP_ALIAS[String(name).toLowerCase()] || name;
  }

  /* ------------------------------------------------------- asset location */
  /* WHICH CHARACTER. `ochi` is the Studio Ochi athlete — helmet, pads, cleats —
     converted from FBX and rebuilt onto this rig by tools/build-ochi-player.mjs,
     and it is what the game shows. `flagplayer` is the parametric one this repo
     builds from tools/build-player-glb.mjs; it stays, because it is the
     fallback when the imported asset is missing and because it carries the hair
     and face variation the helmeted athlete has no use for.

     They are interchangeable because the second was MADE to be: same bone
     names, same rest convention, same clip vocabulary, same tintable material
     regions. Nothing outside this file knows which is loaded. */
  var CHARACTERS = { flagplayer: 'lib/flagplayer.glb', ochi: 'lib/ochiplayer.glb' };
  var CHARACTER = 'ochi';

  var BASE = (function () {
    try {
      var s = document.currentScript && document.currentScript.src;
      if (!s) {
        var ss = document.getElementsByTagName('script');
        for (var i = ss.length - 1; i >= 0; i--) {
          if (/playermodel\.js/.test(ss[i].src)) { s = ss[i].src; break; }
        }
      }
      return s ? s.replace(/js\/playermodel\.js.*$/, '') : '';
    } catch (e) { return ''; }
  })();
  function urlFor(name) { return BASE + (CHARACTERS[name] || CHARACTERS.flagplayer); }
  var MODEL_URL = urlFor(CHARACTER);

  /* Choose before preload(); after it, the asset is already in flight. Unknown
     names are ignored rather than obeyed — a typo should not blank the field. */
  function setCharacter(name) {
    if (!CHARACTERS[name] || MODEL.ready || MODEL.loading) return CHARACTER;
    CHARACTER = name;
    MODEL_URL = urlFor(name);
    return CHARACTER;
  }

  var MODEL = { ready: false, failed: false, loading: false, scene: null, clips: null, error: null,
                restAlign: null, authorHeight: AUTHOR_HEIGHT_M };
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
    var want = url || MODEL_URL;
    try {
      new THREE.GLTFLoader().load(want,
        function (gltf) {
          MODEL.scene = gltf.scene;
          MODEL.clips = gltf.animations || [];
          /* WHAT AN IMPORTED CHARACTER BRINGS WITH IT. `restAlign` is the
             per-bone rotation that carries ITS rest direction onto the one the
             game's own rig has, so a pose the renderer authors by hand — a
             carried ball, a reach — means the same thing on both; it is absent
             on flagplayer, whose rest IS the reference. `authorHeight` is how
             tall this model actually is, so both characters end up the same
             size on the field. See tools/glb-rerig.mjs. */
          var ud = MODEL.scene.userData || {};
          MODEL.restAlign = ud.restAlign || null;
          MODEL.authorHeight = (ud.authorHeight > 0) ? ud.authorHeight : AUTHOR_HEIGHT_M;
          SCALE = DEFAULT_SCALE * (AUTHOR_HEIGHT_M / MODEL.authorHeight);
          // Skinned bounds are unreliable before the first pose, and every
          // instance is frustum-culled by its own root anyway.
          MODEL.scene.traverse(function (o) { if (o.isMesh || o.isSkinnedMesh) o.frustumCulled = false; });
          MODEL.ready = true; MODEL.loading = false; settle();
        },
        undefined,
        function (err) {
          /* A MISSING IMPORT FALLS BACK TO THE PLAYER THAT IS ALWAYS THERE.
             The Ochi athlete is built from licensed source assets that are not
             in the repository, so a checkout without them has no
             lib/ochiplayer.glb — and a field of invisible players is a far
             worse failure than a field of the parametric ones. */
          if (CHARACTER !== 'flagplayer' && want === MODEL_URL) {
            CHARACTER = 'flagplayer';
            MODEL_URL = urlFor(CHARACTER);
            MODEL.loading = false;
            preload(THREE, MODEL_URL);
            return;
          }
          MODEL.failed = true; MODEL.loading = false; MODEL.error = err || new Error('glb load error'); settle();
        });
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

  /* ====================================================== WHO THIS IS =======
     One appearance, derived from one stable seed.

     Skin tone used to be `SKINS[idx % SKINS.length]` — keyed on the player's
     slot in the lineup, so a complexion changed when the lineup reordered and
     index 0 on both teams always matched. Hair colour was never passed at all,
     which is why all ten players wore the same near-black.

     Hair colour is drawn from a shortlist attached to each tone rather than
     from one global list, because the combinations have to stay plausible:
     picking independently puts platinum blond on the darkest player on the
     field roughly one roster in eight.                                       */
  var TONES = [
    { skin: '#f7d9be', hair: ['#2b2018', '#59371f', '#8c5a2b', '#b98b4e', '#d9b273'], light: 1.00 },
    { skin: '#f0c8a4', hair: ['#241a12', '#4a2f1c', '#7a4b24', '#a5773c'],            light: 0.90 },
    { skin: '#e3b085', hair: ['#1d1510', '#3a2517', '#5e3a1e', '#8a5a2c'],            light: 0.74 },
    { skin: '#cf9464', hair: ['#171009', '#2e1f13', '#4a2f1a'],                       light: 0.58 },
    { skin: '#b1774a', hair: ['#140e08', '#241810', '#3a2413'],                       light: 0.44 },
    { skin: '#8f5a34', hair: ['#100b06', '#1c130c', '#2c1d11'],                       light: 0.30 },
    { skin: '#6d4226', hair: ['#0d0906', '#17100a', '#241810'],                       light: 0.18 },
    { skin: '#4e2f1b', hair: ['#0b0705', '#130d08'],                                  light: 0.08 }
  ];
  // Light eyes track fair skin in the real world; drawing them independently
  // is the other half of the implausible-combination problem.
  var IRIS_DARK = ['#4a3323', '#3b2a1d', '#5a4028', '#2e2118'];
  var IRIS_LIGHT = ['#6b7f5e', '#7a8ea6', '#8a7f5c', '#5f7c8a', '#8f9aa6'];

  function seedOf(str) {
    var s = 0, t = String(str == null ? '' : str);
    for (var i = 0; i < t.length; i++) s = (s * 31 + t.charCodeAt(i)) >>> 0;
    return s || 1;
  }
  // Small deterministic generator; each call advances it, so the draws below
  // are independent but wholly determined by the seed.
  function rngOf(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(rnd, list) { return list[Math.floor(rnd() * list.length) % list.length]; }

  /* Everything the renderer needs to make this seed a specific person.
     `gender` is honoured today only where it changes something real — style
     pool and facial hair — and is the hook a women's build hangs off later. */
  function appearanceOf(seed, gender) {
    var rnd = rngOf(seedOf(seed));
    var female = String(gender || 'M').toUpperCase().charAt(0) === 'F';
    var tone = TONES[Math.floor(rnd() * TONES.length) % TONES.length];
    var styles = female ? ['crop', 'locs', 'long', 'afro'] : HAIR_STYLES;
    var iris = rnd() < 0.22 + tone.light * 0.42 ? pick(rnd, IRIS_LIGHT) : pick(rnd, IRIS_DARK);
    var beardRoll = rnd();
    return {
      skin: tone.skin,
      hair: pick(rnd, tone.hair),
      hairStyle: pick(rnd, styles),
      facialHair: female ? null : (beardRoll < 0.17 ? 'full' : beardRoll < 0.40 ? 'goatee' : null),
      headband: rnd() < 0.38,
      // The head is weighted w1('Head') so this scales cleanly, but the top
      // neck ring carries 45% Head weight — keep it small or the seam pulls.
      headScale: 1 + (rnd() - 0.5) * 0.06,
      gender: female ? 'F' : 'M',
      face: {
        brow: +rnd().toFixed(3),
        browAngle: +(rnd() * 2 - 1).toFixed(3),
        eyeGap: +(rnd() * 2 - 1).toFixed(3),
        iris: iris,
        lip: +rnd().toFixed(3),
        stubble: female ? 0 : +(Math.max(0, rnd() - 0.35) * 1.1).toFixed(3)
      }
    };
  }

  /* ============================================================ THE FACE ====
     Brows, eyelids and lashes, irises, the lip line, nose and cheek shading
     and stubble are DRAWN, not modelled — the same trick as the nameplate and
     the number decal below, generated at runtime so nothing is baked into the
     .glb and every player can differ without the file growing.

     The head's UVs (see tools/build-player-glb.mjs) put the face in the middle
     half of the map: u = 0.25 is the character's left silhouette edge, u = 0.5
     the centre line, u = 0.75 the right edge, and the outer quarters are the
     back of the skull, left blank. v maps the head's height linearly, chin
     (y = 1.600 m) at v = 0 to crown (1.850 m) at v = 1 — so a feature's canvas
     position can be written straight from the metre height it sits at.

     Everything is drawn on WHITE, because material.color MULTIPLIES the map:
     white passes the skin tone through untouched and every feature is a value
     below it. Two consequences worth knowing:
       * eye whites are painted at ~0.95, not 1.0 — pure white reads as a blown
         highlight once the surrounding skin is darkened, not as sclera;
       * anything that must keep its own HUE rather than merely darken the skin
         (the iris, and brows that should be hair-coloured) is pre-divided by
         the tone it will be multiplied by, so the product lands on target. The
         tones are therefore part of the cache key.                           */
  /* 256 rather than 512. A head is about 40 px tall in game and a couple of
     hundred on the hero screen, so 256 resolves every feature drawn below —
     and the cache holds one texture per distinct appearance, which over a
     match is both squads' rosters. At 512 that was ~24 MB of texture for
     something nobody can see the pixels of. */
  var FACE_SIZE = 256;
  var faceCache = {};                          // key -> THREE.CanvasTexture

  function rgbOf(hex) {
    var s = String(hex).replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // target / base, clamped — draw this and the multiply lands on `target`.
  function over(target, base) {
    var t = rgbOf(target), b = rgbOf(base), o = [0, 0, 0];
    for (var i = 0; i < 3; i++) o[i] = Math.round(Math.min(255, 255 * t[i] / Math.max(8, b[i])));
    return 'rgb(' + o[0] + ',' + o[1] + ',' + o[2] + ')';
  }
  function shade(v, a) { return 'rgba(' + v + ',' + v + ',' + v + ',' + a + ')'; }

  function faceTexture(THREE, skin, hair, f) {
    f = f || {};
    var key = [skin, hair, f.brow, f.browAngle, f.eyeGap, f.iris, f.lip, f.stubble].join('|');
    if (faceCache[key]) return faceCache[key];

    var S = FACE_SIZE;
    var c = document.createElement('canvas'); c.width = S; c.height = S;
    var x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, S, S);

    // metres -> canvas. The head spans 1.600 m (v=0, bottom) to 1.850 m (v=1),
    // and a CanvasTexture is flipped, so v = 1 is the TOP row of the canvas.
    var Y = function (m) { return (1 - (m - 1.600) / 0.250) * S; };
    var U = function (u) { return u * S; };
    var CX = U(0.5);
    // u = 0.5 - 0.25 * (x / halfWidth): the face maps edge-to-edge onto
    // u 0.25..0.75 at every height, so a lateral offset is a fraction of the
    // head's own width at that height rather than an absolute distance.
    var LX = function (frac) { return U(0.5 - 0.25 * frac); };

    var gap = 0.383 + (f.eyeGap || 0) * 0.055;          // fraction of half-width
    var eyeY = Y(1.7265), eyeRX = S * 0.038, eyeRY = S * 0.020;
    var eyes = [LX(gap), LX(-gap)];

    function ellipse(cx, cy, rx, ry, rot) {
      x.beginPath(); x.ellipse(cx, cy, rx, ry, rot || 0, 0, Math.PI * 2); x.fill();
    }
    /* Shading has to be SOFT. A flat fill of 10% black is a grey oval with a
       hard rim, and on a face that is exactly what it looks like — the first
       pass of this texture put four of them on the chin, the lip and the eyes
       and they read as stickers. Every tonal mark below is a radial gradient
       falling to nothing at its edge. */
    function soft(cx, cy, rx, ry, a, rgb) {
      x.save();
      x.translate(cx, cy); x.scale(rx, ry);
      var col = rgb || '0,0,0';
      var g = x.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0.00, 'rgba(' + col + ',' + a + ')');
      g.addColorStop(0.45, 'rgba(' + col + ',' + (a * 0.72).toFixed(3) + ')');
      g.addColorStop(1.00, 'rgba(' + col + ',0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(0, 0, 1, 0, Math.PI * 2); x.fill();
      x.restore();
    }

    /* ---- broad shading first, so features sit on top ---------------------- */
    // The silhouette edges fall away from the light: a soft darkening at
    // u 0.25 / 0.75 is what stops the face reading as a flat decal.
    var g = x.createLinearGradient(U(0.22), 0, U(0.78), 0);
    g.addColorStop(0.00, 'rgba(0,0,0,0.30)'); g.addColorStop(0.16, 'rgba(0,0,0,0.05)');
    g.addColorStop(0.50, 'rgba(0,0,0,0)');
    g.addColorStop(0.84, 'rgba(0,0,0,0.05)'); g.addColorStop(1.00, 'rgba(0,0,0,0.30)');
    x.fillStyle = g; x.fillRect(U(0.22), Y(1.850), U(0.56), S);

    // Eye sockets and the shadow the brow casts into them.
    eyes.forEach(function (ex) { soft(ex, eyeY - S * 0.006, eyeRX * 1.55, eyeRY * 2.1, 0.13); });
    // Under the nose, under the lower lip, and down the sides of the bridge.
    soft(CX, Y(1.6995), S * 0.062, S * 0.018, 0.16);
    soft(CX, Y(1.6595), S * 0.062, S * 0.017, 0.13);
    soft(CX - S * 0.028, Y(1.7225), S * 0.017, S * 0.048, 0.09);
    soft(CX + S * 0.028, Y(1.7225), S * 0.017, S * 0.048, 0.09);
    // Hollow under the cheekbones, which is most of what makes a face a face.
    soft(CX - S * 0.088, Y(1.6905), S * 0.048, S * 0.038, 0.10);
    soft(CX + S * 0.088, Y(1.6905), S * 0.048, S * 0.038, 0.10);

    /* ---- eyes ------------------------------------------------------------- */
    eyes.forEach(function (ex, i) {
      var tilt = (i === 0 ? 1 : -1) * 0.10;
      // Sclera at 0.95 rather than white (see the note above).
      x.fillStyle = 'rgb(242,242,240)';
      ellipse(ex, eyeY, eyeRX, eyeRY, tilt);
      // Iris and pupil. Pre-divided so the hue survives the skin multiply.
      x.fillStyle = over(f.iris || '#4a3323', skin);
      ellipse(ex, eyeY, eyeRY * 0.92, eyeRY * 0.92);
      x.fillStyle = over('#140f0c', skin);
      ellipse(ex, eyeY, eyeRY * 0.40, eyeRY * 0.40);
      // Upper lid + lashes: a wedge that thickens toward the outer corner.
      x.strokeStyle = over('#20160f', skin);
      x.lineWidth = S * 0.011; x.lineCap = 'round';
      x.beginPath();
      x.ellipse(ex, eyeY, eyeRX, eyeRY, tilt, Math.PI * 1.06, Math.PI * 1.94);
      x.stroke();
      // Lower lid, much lighter.
      x.strokeStyle = shade(0, 0.22); x.lineWidth = S * 0.005;
      x.beginPath();
      x.ellipse(ex, eyeY, eyeRX * 0.96, eyeRY * 0.96, tilt, Math.PI * 0.10, Math.PI * 0.90);
      x.stroke();
    });

    /* ---- brows ------------------------------------------------------------ */
    var bw = 0.6 + (f.brow == null ? 0.5 : f.brow) * 0.9;      // thickness scale
    var ba = (f.browAngle || 0) * 0.16;                        // + = angrier
    x.strokeStyle = over(hair || '#1a1310', skin);
    x.lineWidth = S * 0.020 * bw; x.lineCap = 'round';
    eyes.forEach(function (ex, i) {
      var s = i === 0 ? 1 : -1;
      var inner = ex + s * eyeRX * 0.95, outer = ex - s * eyeRX * 1.05;
      var by = Y(1.7455);
      x.beginPath();
      x.moveTo(inner, by + S * 0.010 * bw + ba * S * 0.05);
      x.quadraticCurveTo(ex, by - S * 0.016 * bw, outer, by + S * 0.004);
      x.stroke();
    });

    /* ---- nose -------------------------------------------------------------
       The geometry carries the bridge and the tip; the map supplies the two
       things a 24-column loft cannot resolve at this size — the nostrils and
       the shadow the tip throws onto the lip. */
    soft(CX, Y(1.7075), S * 0.038, S * 0.012, 0.14);
    x.fillStyle = shade(0, 0.55);
    ellipse(CX - S * 0.021, Y(1.7045), S * 0.0085, S * 0.0052, -0.25);
    ellipse(CX + S * 0.021, Y(1.7045), S * 0.0085, S * 0.0052, 0.25);

    /* ---- mouth ------------------------------------------------------------ */
    var lw = S * (0.048 + (f.lip == null ? 0.5 : f.lip) * 0.022);
    soft(CX, Y(1.6755), lw * 1.15, S * 0.026, 0.09);           // lip body
    x.strokeStyle = shade(0, 0.42); x.lineWidth = S * 0.008;   // the lip line
    x.lineCap = 'round';
    x.beginPath();
    x.moveTo(CX - lw, Y(1.6742));
    x.quadraticCurveTo(CX, Y(1.6728), CX + lw, Y(1.6742));
    x.stroke();

    /* ---- stubble ----------------------------------------------------------
       Also soft: a hard-edged oval of beard shadow on the chin is a sticker,
       and it is the mark most likely to be seen because it is the largest. */
    if (f.stubble > 0.02) {
      var sc = over(hair || '#1a1310', skin).replace(/rgb\(|\)/g, '');
      var sa = 0.16 + f.stubble * 0.34;
      soft(CX, Y(1.6395), S * 0.150, S * 0.082, sa, sc);       // jaw + chin
      soft(CX, Y(1.6875), S * 0.082, S * 0.026, sa * 0.85, sc); // moustache shelf
    }

    var tex = new THREE.CanvasTexture(c);
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    /* Shared between every player who draws the same face, so dispose() must
       leave it alone — the first player torn down would otherwise blank
       everybody else's face. */
    tex.userData.shared = true;
    faceCache[key] = tex;
    return tex;
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

  /* ------------------------------------------------- procedural materials
     THE LAST FLAT THING. Every region is one base colour at one uniform
     roughness, which is why the figure still reads as injection-moulded next
     to the reference pack: those carry a full albedo/normal/roughness set and
     we carry none. An authored texture set is out — it means binary assets and
     a pipeline, and this character is a text file on purpose.

     What is not out is generating the maps at load time. Two small canvases,
     built once and SHARED by every player on the field (team colour lives in
     material.color, which multiplies over the map, so sharing costs nothing
     and one upload serves twenty players):

       cloth  a knit grid — the tiny horizontal ribbing of a football mesh
              jersey — plus low-frequency mottling so large flat panels stop
              looking like plastic under a moving light.
       skin   very low frequency tonal variation only. Skin is not patterned;
              it is uneven, and evenness is the tell.

     Both are near-white and multiply, so they add texture without shifting the
     colour a kit was tinted to. The lofts write cylindrical UVs (u around the
     ring, v along the limb), so a tiling pattern lands square on the body
     without an unwrap.                                                      */
  var TEX = null;
  function noiseCanvas(size, draw) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    return c;
  }
  /* Deterministic value noise: the same players must look the same on every
     load, and Math.random here would reshuffle the field on a refresh. */
  function vnoise(x, y, seed) {
    var n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
    return n - Math.floor(n);
  }
  function smoothNoise(ctx, size, cells, seed, amp, base) {
    var img = ctx.getImageData(0, 0, size, size), d = img.data;
    var step = size / cells;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var fx = x / step, fy = y / step;
        var x0 = Math.floor(fx), y0 = Math.floor(fy);
        var tx = fx - x0, ty = fy - y0;
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);   // smoothstep
        var w = function (i, j) { return vnoise((x0 + i) % cells, (y0 + j) % cells, seed); };
        var v = (w(0, 0) * (1 - tx) + w(1, 0) * tx) * (1 - ty) + (w(0, 1) * (1 - tx) + w(1, 1) * tx) * ty;
        var k = (base + (v - 0.5) * amp) * 255;
        var o = (y * size + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = k < 0 ? 0 : k > 255 ? 255 : k;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  function buildTextures(THREE) {
    if (TEX) return TEX;
    var SZ = 128;
    var cloth = noiseCanvas(SZ, function (x, n) {
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, n, n);
      smoothNoise(x, n, 8, 3, 0.10, 0.97);                 // panel mottling
      // Knit: fine horizontal ribs with a half-pitch offset every other row,
      // which is what a mesh jersey actually is at this distance.
      x.globalAlpha = 0.5;
      for (var y = 0; y < n; y += 3) {
        x.fillStyle = 'rgba(0,0,0,0.16)';
        x.fillRect(0, y, n, 1);
        x.fillStyle = 'rgba(255,255,255,0.18)';
        x.fillRect((y % 6) ? 1 : 0, y + 1, n, 1);
      }
      x.globalAlpha = 1;
    });
    var skin = noiseCanvas(SZ, function (x, n) {
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, n, n);
      smoothNoise(x, n, 5, 11, 0.075, 0.975);
    });
    function mk(canvas, rx, ry) {
      var t = new THREE.CanvasTexture(canvas);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(rx, ry);
      t.anisotropy = 4;
      if ('colorSpace' in t && THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }
    TEX = { cloth: mk(cloth, 3, 5), skin: mk(skin, 1.5, 2) };
    return TEX;
  }
  var TEXTURED = { jersey: 'cloth', shorts: 'cloth', socks: 'cloth', trim: 'cloth',
                   flag: 'cloth', skin: 'skin', head: 'skin' };

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
      var list = TINTABLE[key] || [key];
      for (var i = 0; i < list.length; i++) {
        var m = mats[list[i]];
        if (m && m.color && hex != null) m.color.set(hex);
      }
    }
    /* Detail maps. Shared across every player — the tint lives in
       material.color and multiplies over the map, so one texture serves the
       whole field. */
    try {
      var tx = buildTextures(THREE);
      for (var mk2 in TEXTURED) {
        var mm = mats[mk2], which = tx[TEXTURED[mk2]];
        if (mm && which && !mm.map) { mm.map = which; mm.needsUpdate = true; }
      }
    } catch (e) { /* a canvas-less environment still gets a playable figure */ }

    for (var k in TINTABLE) { if (opts[k] != null) tint(k, opts[k]); }
    // Sensible defaults so a bare build() still looks like a team kit.
    if (opts.jersey == null) tint('jersey', '#2b5cff');
    if (opts.trim == null) tint('trim', '#ffffff');
    var skinHex = opts.skin != null ? opts.skin : '#e8b98f';
    if (opts.skin == null) tint('skin', skinHex);
    var hairHex = opts.hair != null ? opts.hair : '#1a1310';
    if (opts.hair == null) tint('hair', hairHex);
    // Shorts default to a darkened jersey so kits read as one uniform.
    if (opts.shorts == null && opts.jersey != null && mats.shorts) {
      mats.shorts.color.set(opts.jersey).multiplyScalar(0.42);
    }

    /* --- the face ---------------------------------------------------------
       Shared across players with the same appearance, so ten players on the
       field cost far fewer than ten canvases. */
    var faceTex = null;
    if (mats.head && opts.face !== false) {
      try {
        faceTex = faceTexture(THREE, skinHex, hairHex, opts.face || {});
        mats.head.map = faceTex;
        mats.head.needsUpdate = true;
      } catch (e) { /* no canvas: the head keeps its flat skin tone */ }
    }

    /* --- appearance variants: show exactly one of each group --------------
       `gender` is threaded through even though every roster today is male:
       LA28 fields a women's tournament as well, and the flag is what a
       women's build hangs off later. Right now it does one concrete thing —
       nobody in the women's tournament grows a beard — rather than sitting in
       the data unused. */
    var female = String(opts.gender || 'M').toUpperCase().charAt(0) === 'F';
    function showOne(prefix, list, pick) {
      for (var i = 0; i < list.length; i++) {
        var mesh = parts[prefix + list[i]];
        if (mesh) mesh.visible = (list[i] === pick);
      }
    }
    var hairStyle = opts.hairStyle;
    if (HAIR_STYLES.indexOf(hairStyle) === -1) hairStyle = 'crop';
    showOne('hair_', HAIR_STYLES, hairStyle);
    var beard = female ? null : opts.facialHair;
    showOne('beard_', FACIAL_HAIR, FACIAL_HAIR.indexOf(beard) === -1 ? null : beard);
    if (parts.band) parts.band.visible = !!opts.headband;

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

    // A little head-size variation. Kept under a few percent: the top ring of
    // the neck carries 45% Head weight, so a big number drags the collar.
    if (opts.headScale && nodes.Head) nodes.Head.scale.setScalar(opts.headScale);

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
    plate.position.y = MODEL.authorHeight * scale + 0.50;
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
      /* Per-bone rest correction for anything the renderer poses by hand;
         null on the game's own player, whose rest is the reference. */
      restAlign: MODEL.restAlign,
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
                       blendUp: ex.blendUp || null, sweepWarp: ex.sweepWarp || null });
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
    /* One number, two jobs. It is where in the STRIDE this athlete starts, and
       it is also where in any other looping clip they start — because ten men
       standing in a formation breathing in unison is the same tell as ten men
       running in lockstep, and the Idle is what the whole squad holds between
       plays. Kept separately from `phase`, which the gait rewrites every
       frame, so it stays this athlete's own offset for the life of the body. */
    var loopOffset = 0;
    api.setPhaseOffset = function (p) {
      var f = ((p % 1) + 1) % 1;
      phase = f; loopOffset = f;
    };
    /* Ask for locomotion this frame. It is a REQUEST, not a state change: the
       gait owns the body only for as long as something keeps asking, so the
       renderer dropping into a one-shot or a celebration needs no matching
       "stop" call — it just stops asking and the blend fades itself out. */
    api.gait = function (kind, speed) {
      gaitReq = { kind: (kind === 'backward' ? 'backward' : 'forward'), speed: speed || 0 };
    };
    /* WHICH CLIP IS ON SCREEN, by name, read back off the mixer.

       The headless sweep used to answer this by wrapping play() on every rig it
       could find in the scene — which meant it answered nothing at all, for two
       reasons: nothing in the scene graph carried a back-reference to the api,
       and players are rebuilt on every formation change, so any wrap that had
       attached would have gone with them. Reading the current action back out
       survives a rebuild because there is nothing to keep. */
    api.clipInfo = function () {
      var c = api._oneShot || current;
      var cl = c && (c.getClip ? c.getClip() : c._clip);
      return { clip: cl ? cl.name : null, oneShot: !!api._oneShot };
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
    /* WHICH PART OF THE CLIP PLAYS AT THIS PHASE. See `sweepWarp` in
       tools/glb-gait.mjs, which measures it.

       A gait's `groundSpeed` is a MEAN, and the ladder matches it to a tenth
       of a percent — the stride is the right length, the cadence is right, the
       playback rate sits at 1.000. What the mean cannot say is that the
       support foot creeps through early stance and whips through toe-off, so
       it averages out correct while SLIDING for the part of it the eye
       watches. Measured off the renderer with tools/bodycheck.mjs, a planted
       foot was travelling at 31% of the player's own speed; measured offline
       at 60fps with the lean, the facing and the camera all taken away, the
       clip and the ladder on their own still did 10-35%, worst at exactly the
       two clips whose stance sweep is least even.

       So the phase advances uniformly — cadence is a real property of the gait
       — and this maps it onto the part of the clip that makes the foot sweep
       at a CONSTANT rate. Nothing else moves: the table is normalised to the
       clip's own duration and pinned at both ends, so stride length, ground
       speed, and the left foot's contact at phase 0 are all what they were.

       A clip with no table plays unwarped, which is what an older .glb does. */
    function warped(r, p) {
      var c = r.sweepWarp;
      if (!c || c.length < 2) return p;
      var x = p * (c.length - 1), i = Math.floor(x);
      if (i >= c.length - 1) return c[c.length - 1];
      return c[i] + (c[i + 1] - c[i]) * (x - i);
    }
    function mountRung(r, w) {
      var a = r.action;
      if (!r.on) { a.reset(); a.play(); r.on = true; }
      a.enabled = true;
      a.timeScale = 0;                       // phase is written below, not integrated
      a.setEffectiveWeight(w);
      a.time = warped(r, phase) * r.dur;
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
        /* Coming off the blend space. It fades itself out — this frame nothing
           asked for a gait — so this only has to fade in against it.

           The weight goes to ONE, not zero, and that is not a typo. three.js
           computes an action's effective weight as `this.weight * fade
           interpolant`, so setEffectiveWeight(0) before a fadeIn multiplies
           the ramp by zero and pins the clip at zero for good — and
           setEffectiveWeight() also calls stopFading(), so it cancels any
           ramp already scheduled. fadeIn() starts its own interpolant at 0,
           which is what actually does the fading; weight 1 is the value it
           fades TOWARD. Getting this backwards left every player stuck in the
           bind pose from the end of their first run onward: arms straight
           down, knees locked, feet together — standing to attention on a
           football field. */
        next.setEffectiveWeight(1); next.play(); next.fadeIn(f);
      } else {
        next.setEffectiveWeight(1); next.play();
      }
      current = next;
      if (LOOPING[key]) {
        // Start this athlete somewhere of their own in the cycle.
        var lc = next.getClip && next.getClip();
        if (lc && lc.duration > 0) next.time = loopOffset * lc.duration;
        api.setSpeed(api._speed);
      }
    };

    api.oneShot = function (name, returnTo, fade) {
      var key = canon(name);
      var a = actions[key];
      if (!a) return;
      api._returnTo = canon(returnTo || 'Idle');
      var f = fade == null ? 0.15 : fade;
      a.reset(); a.enabled = true; a.timeScale = 1;
      if (current && current !== a) { a.setEffectiveWeight(1); a.play(); current.crossFadeTo(a, f, false); }
      // Weight 1 then fadeIn, for the reason spelled out in play() above:
      // effective weight is weight x fade interpolant, so fading in from a
      // weight of zero never leaves zero.
      else if (gaitW > 0.002 && pair) { a.setEffectiveWeight(1); a.play(); a.fadeIn(f); }
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
      // The face texture is deliberately NOT: it is cached and shared between
      // every player wearing the same face, so disposing it with the first
      // player torn down would blank everyone else.
      for (var key in mats) {
        var m = mats[key];
        if (m.map && !(m.map.userData && m.map.userData.shared)) m.map.dispose();
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
    setCharacter: setCharacter,
    /* How tall the LOADED model actually is, in metres. A caller that wants
       every character to come out the same size on the field has to divide by
       this rather than by a constant — see the note in player3d.js. */
    authorHeight: function () { return MODEL.authorHeight; },
    character: function () { return CHARACTER; },
    characters: Object.keys(CHARACTERS),
    whenReady: whenReady,
    isReady: function () { return !!MODEL.ready; },
    isFailed: function () { return !!MODEL.failed; },
    build: build,
    appearanceOf: appearanceOf,
    // How many distinct faces are resident. Bounded by the number of distinct
    // appearances on screen, not by how often players are rebuilt — which is
    // the property the headless sweep checks.
    faceCacheSize: function () { return Object.keys(faceCache).length; },
    model: MODEL,
    url: MODEL_URL,
    clipNames: ['Idle', 'Run', 'Walk', 'Backpedal', 'Jog', 'Sprint', 'Throw', 'Catch',
      'Dive', 'FlagGrab', 'FlagPulled', 'Celebrate', 'Spike', 'Dance', 'Flex',
      'HighStep', 'Bow', 'Lasso', 'Salute', 'Griddy', 'Point', 'Juke'],
    materialNames: ['jersey', 'trim', 'skin', 'head', 'hair', 'shorts', 'socks', 'shoes', 'belt', 'flag'],
    hairStyles: HAIR_STYLES.slice(),
    facialHairStyles: FACIAL_HAIR.slice(),
    socketNames: ['Socket_Hand_L', 'Socket_Hand_R', 'Socket_Flag_L', 'Socket_Flag_R'],
    heightMetres: AUTHOR_HEIGHT_M,
    setScale: function (s) { SCALE = s; },
    getScale: function () { return SCALE; }
  };
})(window);
