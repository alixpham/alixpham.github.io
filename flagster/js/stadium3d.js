/* ============================================================================
   FLAGSTER — STADIUM 3D  (Three.js r128)

   Purely additive, self-contained scenery module. It knows nothing about the
   simulation: it just builds STATIC geometry that surrounds the playing field
   so the 3D view reads like a broadcast football game instead of a green
   rectangle in a black void.

     FLAGSTER.Stadium3D.build(THREE, opts)    -> THREE.Group  (sky, apron,
                                                 bowl, crowd, pylons, board)
     FLAGSTER.Stadium3D.makeTurf(THREE, opts) -> THREE.Mesh   (the field)
     FLAGSTER.Stadium3D.dispose(obj)          -> frees geo/mat/textures

   WORLD CONTRACT (must match field3d.js):
     1 unit = 1 yard, ground plane y = 0, field CENTERED on the origin.
     length X: -35 .. +35     width Z: -15 .. +15
     end zones: x in [-35,-25] (away/left) and [+25,+35] (home/right)
     playing area x in [-25,+25], midfield x = 0, offense attacks +x.

   Everything here is built once and never updated per frame. No lights are
   created (the scene owns lighting). Nothing casts shadows.
   ============================================================================ */
(function (global) {
  'use strict';

  /* ------------------------------ constants ------------------------------ */
  var LEN = 70;              // total field length (incl. both end zones)
  var WID = 30;              // field width (NFL Flag: 70 x 30)
  var EZ = 10;               // end zone depth
  var HALF_L = LEN / 2;      // 35
  var HALF_W = WID / 2;      // 15
  var GOAL = HALF_L - EZ;    // 25  -> goal lines at x = +/-25

  var DEF = {
    awayColor: '#d80621',
    homeColor: '#2b5cff',
    awayName: 'AWAY',
    homeName: 'HOME'
  };

  function opt(o, k) { return (o && o[k] != null && o[k] !== '') ? o[k] : DEF[k]; }

  // Whether stadium scenery participates in the scene's fog (see build()).
  var FOG = false;
  // MeshStandardMaterial with the current fog policy applied.
  function std(THREE, p) { p = p || {}; p.fog = FOG; return new THREE.MeshStandardMaterial(p); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------------------------- color helpers ---------------------------- */
  // Parse '#rgb' / '#rrggbb' -> {r,g,b} 0..255. Falls back to mid grey.
  function parseHex(hex) {
    var h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return { r: 128, g: 128, b: 128 };
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function rgbStr(c, a) {
    return 'rgba(' + (c.r | 0) + ',' + (c.g | 0) + ',' + (c.b | 0) + ',' + (a == null ? 1 : a) + ')';
  }
  function shade(hex, k) {                       // k<1 darkens, k>1 lightens
    var c = parseHex(hex);
    return {
      r: clamp(Math.round(c.r * k), 0, 255),
      g: clamp(Math.round(c.g * k), 0, 255),
      b: clamp(Math.round(c.b * k), 0, 255)
    };
  }
  function luma(c) { return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255; }
  // Pick black or white lettering so team names stay readable on any end zone.
  function inkFor(hex) { return luma(parseHex(hex)) > 0.62 ? '#101418' : '#ffffff'; }

  /* ============================== TURF ================================== */
  /**
   * makeTurf(THREE, opts) -> THREE.Mesh
   * opts: { awayColor, homeColor, awayName, homeName }
   * A 70x30 PlaneGeometry rotated flat at y=0 with a procedurally painted
   * CanvasTexture (mow stripes, yard lines, hashes, numbers, end zones).
   */
  function makeTurf(THREE, opts) {
    opts = opts || {};
    var awayColor = opt(opts, 'awayColor');
    var homeColor = opt(opts, 'homeColor');
    var awayName = String(opt(opts, 'awayName')).toUpperCase();
    var homeName = String(opt(opts, 'homeName')).toUpperCase();

    /* The canvas has to carry the field's own aspect or everything painted on
       it is stretched: at 2048x768 on a 70x30 field a yard is 29px across and
       26px down, so the numbers lean and the yard lines come out thicker one
       way than the other. 2048/(70/30) = 878. */
    var W = 2048, H = Math.round(W / (LEN / WID));
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');

    // world(yards, origin-centered) -> canvas px
    function px(x) { return (x + HALF_L) / LEN * W; }
    function pz(z) { return (z + HALF_W) / WID * H; }
    var UX = W / LEN;                            // px per yard along X
    var UZ = H / WID;                            // px per yard along Z

    /* --- mowed stripes: 5-yard bands running ACROSS the field ----------- */
    for (var sx = -HALF_L; sx < HALF_L; sx += 5) {
      var alt = (Math.round((sx + HALF_L) / 5) % 2) === 0;
      g.fillStyle = alt ? '#35993f' : '#297f34';
      g.fillRect(px(sx) - 1, 0, 5 * UX + 2, H);
    }
    // subtle blotchy wear so the turf isn't flat vector-green
    for (var b = 0; b < 1400; b++) {
      var bx = Math.random() * W, bz = Math.random() * H;
      var br = 4 + Math.random() * 18;
      g.fillStyle = (Math.random() < 0.5) ? 'rgba(255,255,255,0.014)' : 'rgba(0,40,8,0.022)';
      g.beginPath(); g.arc(bx, bz, br, 0, Math.PI * 2); g.fill();
    }

    /* --- END ZONES ------------------------------------------------------ */
    drawEndZone(-HALF_L, -GOAL, awayColor, awayName, false);
    drawEndZone(GOAL, HALF_L, homeColor, homeName, true);

    function drawEndZone(x0, x1, hex, name, flip) {
      var base = shade(hex, 0.9), dark = shade(hex, 0.68);
      var X0 = px(x0), X1 = px(x1);
      g.fillStyle = rgbStr(base);
      g.fillRect(X0, 0, X1 - X0, H);
      // mow stripes inside the zone too (keeps the eye reading depth)
      for (var i = 0; i < 5; i++) {
        if (i % 2) continue;
        var sxx = px(x0 + i * 2);
        g.fillStyle = rgbStr(dark, 0.45);
        g.fillRect(sxx, 0, 2 * UX, H);
      }
      // lettering, rotated to read along the length of the field
      var cx = (X0 + X1) / 2, cz = H / 2;
      g.save();
      g.translate(cx, cz);
      g.rotate(flip ? -Math.PI / 2 : Math.PI / 2);
      var fit = (X1 - X0) * 0.62;                // available "height" of glyphs
      g.font = 'bold ' + Math.round(fit) + 'px Impact, "Arial Black", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      // squeeze long names to fit the field's width
      var maxW = H * 0.88;
      var m = g.measureText(name).width;
      if (m > maxW) g.scale(maxW / m, 1);
      g.lineWidth = Math.max(4, fit * 0.07);
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.strokeText(name, 0, 0);
      g.fillStyle = inkFor(hex);
      g.fillText(name, 0, 0);
      g.restore();
    }

    /* --- YARD LINES every 5 yards --------------------------------------- */
    g.strokeStyle = 'rgba(255,255,255,0.90)';
    g.lineWidth = Math.max(2, 0.16 * UX);
    for (var yx = -GOAL + 5; yx <= GOAL - 5; yx += 5) {
      g.beginPath(); g.moveTo(px(yx), 0); g.lineTo(px(yx), H); g.stroke();
    }

    /* --- HASH MARKS: 1-yard ticks in two inboard rows -------------------- */
    var hashZ = HALF_W * 0.42;                   // ~5.25 yd off center each way
    var tickLen = 0.75 * UZ;                     // ~0.75 yd tall tick
    g.strokeStyle = 'rgba(255,255,255,0.82)';
    g.lineWidth = Math.max(2, 0.13 * UX);
    for (var hx = -GOAL + 1; hx <= GOAL - 1; hx += 1) {
      if (hx % 5 === 0) continue;                // 5s already have full lines
      var X = px(hx);
      g.beginPath(); g.moveTo(X, pz(-hashZ) - tickLen / 2); g.lineTo(X, pz(-hashZ) + tickLen / 2); g.stroke();
      g.beginPath(); g.moveTo(X, pz(hashZ) - tickLen / 2); g.lineTo(X, pz(hashZ) + tickLen / 2); g.stroke();
    }
    // sideline ticks (short, just inboard of the boundary)
    g.lineWidth = Math.max(2, 0.12 * UX);
    for (var sx2 = -GOAL + 1; sx2 <= GOAL - 1; sx2 += 1) {
      if (sx2 % 5 === 0) continue;
      var X2 = px(sx2);
      g.beginPath(); g.moveTo(X2, pz(-HALF_W) + 2); g.lineTo(X2, pz(-HALF_W) + 2 + tickLen * 0.8); g.stroke();
      g.beginPath(); g.moveTo(X2, pz(HALF_W) - 2); g.lineTo(X2, pz(HALF_W) - 2 - tickLen * 0.8); g.stroke();
    }

    /* --- YARD NUMBERS ---------------------------------------------------- */
    // Playing area is 50 yards; label 10/20/30/40/50/40/30/20/10 at each 5-yard
    // line, mirrored about midfield. Numbers face IN from each sideline.
    var numFit = Math.round(2.6 * UZ);
    g.font = 'bold ' + numFit + 'px Impact, "Arial Black", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    var numZ = HALF_W * 0.74;                    // ~9.25 yd off center
    for (var nx = -20; nx <= 20; nx += 5) {
      if (nx === 0) continue;                    // midfield gets the logo
      var yards = 50 - Math.abs(nx) * 2;         // x=+/-20 -> 10 ... x=+/-5 -> 40
      if (yards <= 0) continue;
      var label = String(yards);
      drawNumber(label, nx, -numZ, false);
      drawNumber(label, nx, numZ, true);
    }
    // the 50 sits on midfield, offset off the logo
    drawNumber('50', 0, -numZ, false);
    drawNumber('50', 0, numZ, true);

    function drawNumber(txt, wxx, wzz, top) {
      g.save();
      g.translate(px(wxx), pz(wzz));
      // rotate so digits read correctly when standing on that sideline
      g.rotate(top ? -Math.PI / 2 : Math.PI / 2);
      g.fillStyle = 'rgba(255,255,255,0.92)';
      g.lineWidth = Math.max(2, numFit * 0.06);
      g.strokeStyle = 'rgba(0,0,0,0.22)';
      g.strokeText(txt, 0, 0);
      g.fillText(txt, 0, 0);
      g.restore();
    }

    /* --- MIDFIELD EMBLEM ------------------------------------------------- */
    (function () {
      var cx = px(0), cz = H / 2, r = 3.6 * UZ;
      g.save();
      g.globalAlpha = 0.35;
      g.lineWidth = Math.max(3, 0.22 * UX);
      g.strokeStyle = '#ffffff';
      g.beginPath(); g.arc(cx, cz, r, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(cx, cz, r * 0.78, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 0.5;
      g.translate(cx, cz); g.rotate(Math.PI / 2);
      g.font = 'bold ' + Math.round(r * 0.46) + 'px Impact, "Arial Black", Arial, sans-serif';
      g.fillStyle = '#ffffff';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('FLAGSTER', 0, 0);
      g.restore();
    })();

    /* --- GOAL LINES (thick + bright) ------------------------------------- */
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = Math.max(4, 0.34 * UX);
    [-GOAL, GOAL].forEach(function (gx) {
      g.beginPath(); g.moveTo(px(gx), 0); g.lineTo(px(gx), H); g.stroke();
    });
    // midfield stripe, slightly warmer so it reads as "the 50"
    g.strokeStyle = 'rgba(255,246,214,0.95)';
    g.lineWidth = Math.max(3, 0.24 * UX);
    g.beginPath(); g.moveTo(px(0), 0); g.lineTo(px(0), H); g.stroke();

    /* --- SIDELINE / BOUNDARY STRIPES ------------------------------------- */
    var sw = Math.max(4, 0.4 * UZ);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, sw);
    g.fillRect(0, H - sw, W, sw);
    g.fillRect(0, 0, sw * (UX / UZ), H);
    g.fillRect(W - sw * (UX / UZ), 0, sw * (UX / UZ), H);

    /* --- texture + mesh -------------------------------------------------- */
    var tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 8;                          // renderer caps unknown here
    tex.magFilter = THREE.LinearFilter;
    // Mipmaps matter: without them the yard lines/numbers alias into mush the
    // moment the camera pulls back. Trilinear + anisotropy keeps them legible.
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    if (THREE.SRGBColorSpace !== undefined && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding !== undefined && 'encoding' in tex) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;

    var mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(LEN, WID),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'turf';
    mesh.renderOrder = 0;
    return mesh;
  }

  /* ============================== STADIUM =============================== */
  /**
   * build(THREE, opts) -> THREE.Group
   * opts: { awayColor, homeColor }
   * Static scenery: sky dome, out-of-bounds apron, four-sided raked bowl,
   * instanced crowd, corner light towers, one scoreboard.
   */
  function build(THREE, opts) {
    opts = opts || {};
    var awayColor = opt(opts, 'awayColor');
    var homeColor = opt(opts, 'homeColor');
    // Scenery ignores the scene's gameplay fog by default: that fog is tuned
    // for a small field and would swallow the stands. Pass opts.fog === true
    // to let the stands fade with the scene fog instead.
    FOG = (opts.fog === true);
    // Sky radius. Kept well inside a 300-unit camera far plane on purpose —
    // a larger dome gets frustum-clipped and the void comes back.
    var skyR = (typeof opts.skyRadius === 'number' && opts.skyRadius > 0) ? opts.skyRadius : 250;

    var root = new THREE.Group();
    root.name = 'stadium';

    /* ---------------------------- 1. SKY -------------------------------- */
    root.add(makeSky(THREE, skyR));

    /* --------------------- 2. APRON / OUT OF BOUNDS ---------------------- */
    var APRON = 11;                              // yards of surround on all sides
    var aW = LEN + APRON * 2, aD = WID + APRON * 2;
    // Built as a FRAME with a field-sized hole rather than a full plane: a
    // plane tucked under the turf z-fights badly at distance and the apron
    // punches through the far half of the field.
    var apron = new THREE.Mesh(
      apronFrame(THREE, LEN, WID, aW, aD),
      std(THREE, { map: makeApronTex(THREE), roughness: 1, metalness: 0 })
    );
    apron.position.y = -0.01;
    apron.receiveShadow = true;
    apron.castShadow = false;
    apron.name = 'apron';
    root.add(apron);

    /* ------------------------- 3. STADIUM BOWL --------------------------- */
    // Three raked seating decks. Each deck is a true STAIRCASE: N nested
    // rectangular rings, each one step taller and one step further out, all
    // merged into a single geometry (one draw call per deck).
    var innerX = aW / 2, innerZ = aD / 2;        // = 46, 23.5

    var wallH = 2.4;
    root.add(ring(THREE, innerX, innerZ, 1.2, 0, wallH, 0x33414d, true));       // front wall
    // Team-colored padding along the two end walls.
    root.add(padWall(THREE, -(innerX + 0.6), awayColor, aD));
    root.add(padWall(THREE, (innerX + 0.6), homeColor, aD));

    var decks = [
      { n: 13, sw: 0.95, rise: 0.60, c: 0x99a4ad },
      { n: 13, sw: 1.00, rise: 0.70, c: 0x8c97a0 },
      { n: 11, sw: 1.05, rise: 0.78, c: 0x7f8a93 }
    ];
    var inX = innerX + 1.2, inZ = innerZ + 1.2;
    var y = wallH;
    var seatRows = [];                           // one array of rows per deck
    for (var d = 0; d < decks.length; d++) {
      var dk = decks[d];
      var built = stepDeck(THREE, inX, inZ, dk.n, dk.sw, dk.rise, y, dk.c);
      root.add(built.mesh);
      seatRows.push(built.rows);
      inX += dk.n * dk.sw; inZ += dk.n * dk.sw;
      y += dk.n * dk.rise;
      // concourse fascia / back wall between decks (and a rim above the last)
      var fw = (d < decks.length - 1) ? 1.8 : 2.4;
      var fh = (d < decks.length - 1) ? 1.9 : 1.4;
      root.add(ring(THREE, inX, inZ, fw, y - 0.6, fh, 0x1b2229, false));
      inX += fw; inZ += fw;
      y += (d < decks.length - 1) ? 1.3 : 0;
    }
    var rimTop = y;

    /* ---------------------------- 4. CROWD ------------------------------- */
    // One InstancedMesh per deck (3 extra draw calls, ~6000 people total).
    var perDeck = [2200, 2200, 1800];
    for (var ci = 0; ci < seatRows.length; ci++) {
      var im = makeCrowd(THREE, seatRows[ci], perDeck[ci]);
      if (im) root.add(im);
    }

    /* ------------------------ 5. LIGHT TOWERS ---------------------------- */
    var towerX = inX * 0.9, towerZ = inZ * 0.92;
    root.add(lightTower(THREE, -towerX, -towerZ, rimTop));
    root.add(lightTower(THREE, -towerX, towerZ, rimTop));
    root.add(lightTower(THREE, towerX, -towerZ, rimTop));
    root.add(lightTower(THREE, towerX, towerZ, rimTop));

    /* ------------------------- 6. JUMBOTRONS ----------------------------- */
    // One behind each end zone. The gameplay camera flips end-for-end with
    // possession, so a single board would be behind the lens for half the
    // game; a pair means there is always a live score in shot.
    var boards = [
      scoreboard(THREE, innerX + 14, false),
      scoreboard(THREE, -(innerX + 14), true)
    ];
    boards.forEach(function (b) { root.add(b); });
    // Hand the caller a single updater that drives both faces.
    root.userData.updateBoards = function (info) {
      for (var i = 0; i < boards.length; i++) boards[i].userData.updateBoard(info);
    };

    // Nothing in the stadium casts shadows; keep the shadow map cheap.
    root.traverse(function (o) { o.castShadow = false; o.frustumCulled = true; });
    return root;
  }

  /* ------------------------------- SKY ---------------------------------- */
  /* A bright afternoon sky. This used to be a dusk gradient, which looked
     handsome on the menu but rendered gameplay in permanent twilight — jersey
     colours went muddy and the turf read grey. Daylight instead, with a band
     of fair-weather cumulus scattered across the middle of the dome so the sky
     isn't a flat wash of blue above the rim. */
  function makeSky(THREE, radius) {
    var cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 512;
    var g = cv.getContext('2d');
    var grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0.00, '#2f74c8');           // zenith: deep summer blue
    grd.addColorStop(0.30, '#4e93da');
    grd.addColorStop(0.55, '#79b3e8');
    grd.addColorStop(0.74, '#a8cef0');
    grd.addColorStop(0.86, '#d3e6f6');           // pale haze at the horizon
    grd.addColorStop(1.00, '#8fa48c');           // below horizon: distant ground
    g.fillStyle = grd;
    g.fillRect(0, 0, 1024, 512);

    /* Clouds: each is a clump of soft overlapping blobs. Seeded from a fixed
       integer sequence rather than Math.random so the sky is identical on
       every load and screenshots stay comparable between runs. */
    var seed = 20280714;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    g.globalAlpha = 1;
    for (var c = 0; c < 26; c++) {
      var cx = rnd() * 1024;
      var cy = 150 + rnd() * 210;                // keep them off the zenith/horizon
      var scale = 0.55 + rnd() * 0.9;
      // Higher clouds are smaller and fainter, so the band reads as depth.
      var fade = 0.30 + 0.55 * ((cy - 150) / 210);
      for (var b = 0; b < 7; b++) {
        var bx = cx + (rnd() - 0.5) * 150 * scale;
        var by = cy + (rnd() - 0.5) * 32 * scale;
        var br = (16 + rnd() * 30) * scale;
        var blob = g.createRadialGradient(bx, by, 0, bx, by, br);
        blob.addColorStop(0, 'rgba(255,255,255,' + (0.85 * fade).toFixed(3) + ')');
        blob.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = blob;
        g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
      }
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    if (THREE.SRGBColorSpace !== undefined && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding !== undefined && 'encoding' in tex) tex.encoding = THREE.sRGBEncoding;

    var sky = new THREE.Mesh(
      new THREE.SphereGeometry(radius || 250, 32, 20),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
    );
    sky.name = 'sky';
    sky.renderOrder = -1;
    sky.castShadow = false; sky.receiveShadow = false;
    return sky;
  }

  /* ------------------------------ APRON --------------------------------- */
  // Four coplanar quads forming a rectangular ring in the XZ plane with a
  // fieldW x fieldD hole in the middle. UVs are mapped from world position so
  // the apron texture spans the whole outer rectangle continuously.
  function apronFrame(THREE, fieldW, fieldD, outW, outD) {
    var fx = fieldW / 2, fz = fieldD / 2, ox = outW / 2, oz = outD / 2;
    var pos = [], nor = [], uv = [];
    function quad(x0, z0, x1, z1) {              // axis-aligned, wound to face +Y
      var c = [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]];
      for (var i = 0; i < 6; i++) {
        pos.push(c[i][0], 0, c[i][1]);
        nor.push(0, 1, 0);
        uv.push((c[i][0] + ox) / outW, 1 - (c[i][1] + oz) / outD);
      }
    }
    quad(-ox, fz, ox, oz);                       // beyond +Z sideline
    quad(-ox, -oz, ox, -fz);                     // beyond -Z sideline
    quad(fx, -fz, ox, fz);                       // behind +X end zone
    quad(-ox, -fz, -fx, fz);                     // behind -X end zone
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeBoundingSphere();
    return g;
  }


  function makeApronTex(THREE) {
    var cv = document.createElement('canvas');
    cv.width = 512; cv.height = 256;
    var g = cv.getContext('2d');
    g.fillStyle = '#1c3a22';                     // dark out-of-bounds turf
    g.fillRect(0, 0, 512, 256);
    // a red running-track style band around the outside
    g.strokeStyle = '#6d3226'; g.lineWidth = 26;
    g.strokeRect(13, 13, 512 - 26, 256 - 26);
    g.strokeStyle = '#3a4a3d'; g.lineWidth = 6;
    g.strokeRect(30, 30, 512 - 60, 256 - 60);
    for (var i = 0; i < 500; i++) {
      g.fillStyle = 'rgba(255,255,255,' + (0.012 + Math.random() * 0.03) + ')';
      g.fillRect(Math.random() * 512, Math.random() * 256, 2 + Math.random() * 5, 2);
    }
    var tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 8;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    if (THREE.SRGBColorSpace !== undefined && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding !== undefined && 'encoding' in tex) tex.encoding = THREE.sRGBEncoding;
    return tex;
  }

  /* ------------------------- RECTANGULAR RING ---------------------------- */
  // A hollow rectangular slab built from 4 boxes merged into one Group-free
  // BufferGeometry-lite approach: we just use 4 boxes in one Group (4 meshes)
  // -> too many draw calls, so instead we build ONE geometry by translating
  // box geometries and merging their attributes manually.
  function ring(THREE, inX, inZ, width, y0, h, color, receive) {
    var parts = [];
    var oX = inX + width, oZ = inZ + width;
    // +Z and -Z sides span the full outer X extent so corners are filled once.
    parts.push(boxAt(THREE, oX * 2, h, width, 0, y0 + h / 2, inZ + width / 2));
    parts.push(boxAt(THREE, oX * 2, h, width, 0, y0 + h / 2, -(inZ + width / 2)));
    parts.push(boxAt(THREE, width, h, inZ * 2, inX + width / 2, y0 + h / 2, 0));
    parts.push(boxAt(THREE, width, h, inZ * 2, -(inX + width / 2), y0 + h / 2, 0));
    var geo = mergeGeos(THREE, parts);
    var m = new THREE.Mesh(geo, std(THREE, {
      color: color, roughness: 0.94, metalness: 0.02
    }));
    m.receiveShadow = !!receive;
    m.castShadow = false;
    return m;
  }

  /* --------------------------- RAKED DECK -------------------------------- */
  // A staircase of `n` nested rectangular rings rising outward from
  // (inX,inZ) at height y0. Step i is `sw` wide and its tread sits at
  // y0 + (i+1)*rise. Every ring is drawn full-height from y0 so the profile
  // is solid (no gaps under the treads). Returns one merged mesh plus the
  // list of seat rows for crowd placement.
  function stepDeck(THREE, inX, inZ, n, sw, rise, y0, color) {
    var parts = [], rows = [];
    for (var i = 0; i < n; i++) {
      var rx = inX + i * sw, rz = inZ + i * sw;
      var h = (i + 1) * rise;
      var oX = rx + sw, oZ = rz + sw;
      // long sides span the full outer X so corners are filled exactly once
      parts.push(boxAt(THREE, oX * 2, h, sw, 0, y0 + h / 2, rz + sw / 2));
      parts.push(boxAt(THREE, oX * 2, h, sw, 0, y0 + h / 2, -(rz + sw / 2)));
      parts.push(boxAt(THREE, sw, h, rz * 2, rx + sw / 2, y0 + h / 2, 0));
      parts.push(boxAt(THREE, sw, h, rz * 2, -(rx + sw / 2), y0 + h / 2, 0));
      rows.push({ x: rx + sw * 0.5, z: rz + sw * 0.5, y: y0 + h });
    }
    var mesh = new THREE.Mesh(mergeGeos(THREE, parts), std(THREE, {
      color: color, roughness: 0.96, metalness: 0.0
    }));
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.name = 'deck';
    return { mesh: mesh, rows: rows };
  }

  function boxAt(THREE, w, h, d, x, y, z) {
    var g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  }

  // Minimal non-indexed merge (r128 BufferGeometryUtils isn't loaded here).
  function mergeGeos(THREE, geos) {
    var pos = [], nor = [], total = 0, i, j;
    for (i = 0; i < geos.length; i++) {
      var g = geos[i];
      var gg = g.index ? g.toNonIndexed() : g;
      var p = gg.attributes.position.array, n = gg.attributes.normal.array;
      for (j = 0; j < p.length; j++) pos.push(p[j]);
      for (j = 0; j < n.length; j++) nor.push(n[j]);
      total += p.length / 3;
      if (gg !== g) gg.dispose();
      g.dispose();
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.computeBoundingSphere();
    return out;
  }

  /* --------------------- END-ZONE WALL PADDING --------------------------- */
  function padWall(THREE, x, hex, depth) {
    var m = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 2.2, depth * 0.9),
      std(THREE, { color: new THREE.Color(hex), roughness: 0.8, metalness: 0 })
    );
    m.position.set(x, 1.2, 0);
    m.castShadow = false;
    return m;
  }

  /* ------------------------------ CROWD ---------------------------------- */
  // One InstancedMesh per deck. Spectators are seeded along the seat ROWS
  // produced by stepDeck(), sampled uniformly around each row's rectangle,
  // so the crowd hugs the rake instead of floating on a flat slab.
  function makeCrowd(THREE, rows, count) {
    if (!THREE.InstancedMesh || !rows || !rows.length) return null;
    var geo = new THREE.BoxGeometry(0.5, 0.8, 0.5);
    var mat = std(THREE, { roughness: 1, metalness: 0 });
    var im = new THREE.InstancedMesh(geo, mat, count);
    im.name = 'crowd';
    im.castShadow = false; im.receiveShadow = false;
    im.frustumCulled = true;

    var dummy = new THREE.Object3D();
    var col = new THREE.Color();
    // Weight rows by perimeter so density is even across the bowl.
    var peri = [], tot = 0, i;
    for (i = 0; i < rows.length; i++) {
      peri.push(4 * (rows[i].x + rows[i].z));
      tot += peri[i];
    }

    for (i = 0; i < count; i++) {
      // pick a row
      var pick = Math.random() * tot, ri = 0, acc = 0;
      for (var k = 0; k < rows.length; k++) { acc += peri[k]; if (pick <= acc) { ri = k; break; } }
      var row = rows[ri];
      var hx = row.x, hz = row.z;
      // sample a point on that row's rectangle perimeter
      var lenX = hx * 2, lenZ = hz * 2, half = lenX + lenZ;
      var s = Math.random() * (half * 2);
      var x, z, yaw;
      if (s < lenX) { x = s - hx; z = hz; yaw = Math.PI; }
      else if (s < half) { z = (s - lenX) - hz; x = hx; yaw = -Math.PI / 2; }
      else if (s < half + lenX) { x = (s - half) - hx; z = -hz; yaw = 0; }
      else { z = (s - half - lenX) - hz; x = -hx; yaw = Math.PI / 2; }
      // jitter along the row + a little across it so rows aren't razor-straight
      var jit = 0.25;
      if (Math.abs(z) === hz) x += (Math.random() - 0.5) * 0.5; else z += (Math.random() - 0.5) * 0.5;
      x += (Math.random() - 0.5) * jit; z += (Math.random() - 0.5) * jit;

      // ~8% of seats empty so the stands aren't a solid wall of confetti
      if (Math.random() < 0.08) { dummy.scale.set(0.0001, 0.0001, 0.0001); }
      else {
        var sc = 0.85 + Math.random() * 0.4;
        dummy.scale.set(sc, sc * (0.85 + Math.random() * 0.45), sc);
      }
      dummy.position.set(x, row.y + 0.34, z);
      dummy.rotation.set(0, yaw + (Math.random() - 0.5) * 0.5, 0);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);

      // Mostly dark/muted clothing so the stands read as PEOPLE, not confetti;
      // a minority of saturated pops and warm skin tones give it life.
      var h2 = Math.random();
      if (h2 < 0.62) col.setHSL(Math.random(), 0.05 + Math.random() * 0.16, 0.09 + Math.random() * 0.24);
      else if (h2 < 0.86) col.setHSL(Math.random(), 0.45 + Math.random() * 0.4, 0.24 + Math.random() * 0.18);
      else col.setHSL(0.06 + Math.random() * 0.05, 0.34, 0.34 + Math.random() * 0.2);
      if (im.setColorAt) im.setColorAt(i, col);
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    return im;
  }

  /* --------------------------- LIGHT TOWER ------------------------------- */
  function lightTower(THREE, x, z, baseTop) {
    var grp = new THREE.Group();
    var steel = std(THREE, { color: 0x2c343a, roughness: 0.8, metalness: 0.3 });
    var H = (baseTop || 24) + 12;
    var mast = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.8, H, 8), steel);
    mast.position.y = H / 2;
    grp.add(mast);

    // Two stacked light panels of small emissive-ish boxes (one merged mesh).
    var boxes = [];
    for (var r = 0; r < 2; r++) {
      for (var c = 0; c < 6; c++) {
        boxes.push(boxAt(THREE, 1.05, 0.75, 0.35, (c - 2.5) * 1.25, H + 1.4 + r * 0.95, 0));
      }
    }
    var panel = new THREE.Mesh(mergeGeos(THREE, boxes), std(THREE, {
      color: 0xfff3cf, emissive: 0xffe6a0, emissiveIntensity: 0.85, roughness: 0.5, metalness: 0
    }));
    grp.add(panel);
    // frame behind the panels
    var frame = new THREE.Mesh(new THREE.BoxGeometry(8.4, 2.9, 0.5), steel);
    frame.position.set(0, H + 1.9, -0.45);
    grp.add(frame);

    grp.position.set(x, 0, z);
    grp.rotation.y = Math.atan2(-x, -z);          // yaw the panel toward midfield
    grp.traverse(function (o) { o.castShadow = false; });
    return grp;
  }

  /* --------------------------- SCOREBOARD -------------------------------- */
  /* A live jumbotron behind an end zone. `flip` faces it the other way so the
     pair at opposite ends both point in at the field.

     The board hangs at y=17 rather than up on the rim: the gameplay camera is
     a low chase cam about four yards off the turf, and anything much higher
     than this sits above the top of its frustum — a scoreboard you can only
     see by pausing is decoration, not information. Returned with
     userData.updateBoard(info) so the renderer can repaint the score. */
  var BOARD_W = 17, BOARD_H = 8.5, BOARD_Y = 21;

  function scoreboard(THREE, x, flip) {
    var grp = new THREE.Group();
    var H = BOARD_Y - BOARD_H / 2;
    var steel = std(THREE, { color: 0x232a30, roughness: 0.85, metalness: 0.2 });
    var legs = new THREE.Mesh(mergeGeos(THREE, [
      boxAt(THREE, 1.2, H, 1.2, -9, H / 2, 0),
      boxAt(THREE, 1.2, H, 1.2, 9, H / 2, 0)
    ]), steel);
    grp.add(legs);

    var cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 512;
    var g = cv.getContext('2d');

    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    if (THREE.SRGBColorSpace !== undefined && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding !== undefined && 'encoding' in tex) tex.encoding = THREE.sRGBEncoding;

    function paint(info) {
      info = info || {};
      var away = info.awayAbbr || 'AWAY', home = info.homeAbbr || 'HOME';
      var as = (info.awayScore != null) ? String(info.awayScore) : '0';
      var hs = (info.homeScore != null) ? String(info.homeScore) : '0';
      var period = info.period || 'Q1';
      var clock = info.clock || '0:00';
      var aCol = info.awayColor || '#e8443a', hCol = info.homeColor || '#3f7fe0';

      g.fillStyle = '#05080d'; g.fillRect(0, 0, 1024, 512);
      g.fillStyle = '#0c131d'; g.fillRect(12, 12, 1000, 488);

      // Team colour flashes down the outer edges so the board is identifiably
      // this fixture even at the distance the chase cam sees it from.
      g.fillStyle = aCol; g.fillRect(12, 12, 26, 488);
      g.fillStyle = hCol; g.fillRect(986, 12, 26, 488);

      g.textAlign = 'center'; g.textBaseline = 'middle';

      // Team names
      g.fillStyle = '#9fb3c8';
      g.font = 'bold 62px Impact, "Arial Black", Arial, sans-serif';
      g.fillText(away, 240, 96);
      g.fillText(home, 784, 96);

      // Scores — the thing you read from 80 yards away.
      g.fillStyle = '#ffffff';
      g.font = 'bold 190px Impact, "Arial Black", Arial, sans-serif';
      g.fillText(as, 240, 250);
      g.fillText(hs, 784, 250);

      // Centre column: period over clock.
      g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(512, 60); g.lineTo(512, 330); g.stroke();
      g.fillStyle = '#ffb61e';
      g.font = 'bold 58px Impact, "Arial Black", Arial, sans-serif';
      g.fillText(period, 512, 120);
      g.fillStyle = '#7fe0a0';
      g.font = 'bold 92px Impact, "Arial Black", Arial, sans-serif';
      g.fillText(clock, 512, 218);

      // Footer ribbon
      g.fillStyle = '#141c28'; g.fillRect(40, 372, 944, 104);
      g.fillStyle = '#ffb61e';
      g.font = 'bold 66px Impact, "Arial Black", Arial, sans-serif';
      g.fillText(info.footer || 'FLAGSTER', 512, 426);

      // Faint scanlines so it reads as an LED wall rather than a flat decal.
      g.fillStyle = 'rgba(0,0,0,0.22)';
      for (var i = 0; i < 512; i += 4) g.fillRect(0, i, 1024, 1);
      tex.needsUpdate = true;
    }
    paint(null);

    var screen = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_W, BOARD_H, 1.4),
      [
        steel, steel, steel, steel,
        new THREE.MeshBasicMaterial({ map: tex, fog: FOG }),   // +Z face (toward field side)
        steel
      ]
    );
    screen.position.y = BOARD_Y;
    grp.add(screen);

    grp.position.set(x, 0, 0);
    grp.rotation.y = flip ? Math.PI / 2 : -Math.PI / 2;   // face in toward the field
    grp.traverse(function (o) { o.castShadow = false; });
    grp.userData.updateBoard = paint;
    return grp;
  }

  /* ------------------------------ DISPOSE -------------------------------- */
  function dispose(obj) {
    if (!obj) return;
    var seenG = [], seenM = [];
    function killMat(m) {
      if (!m || seenM.indexOf(m) >= 0) return;
      seenM.push(m);
      ['map', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap',
       'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap',
       'envMap', 'specularMap'].forEach(function (k) {
        if (m[k] && m[k].dispose) { try { m[k].dispose(); } catch (e) {} }
      });
      if (m.dispose) { try { m.dispose(); } catch (e) {} }
    }
    var walk = obj.traverse ? function (fn) { obj.traverse(fn); } : function (fn) { fn(obj); };
    walk(function (o) {
      if (o.geometry && seenG.indexOf(o.geometry) < 0) {
        seenG.push(o.geometry);
        try { o.geometry.dispose(); } catch (e) {}
      }
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(killMat);
      }
      if (o.dispose && o.isInstancedMesh) { try { o.dispose(); } catch (e) {} }
    });
    if (obj.parent) obj.parent.remove(obj);
  }

  /* ------------------------------ EXPORT --------------------------------- */
  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.Stadium3D = {
    build: build,
    makeTurf: makeTurf,
    dispose: dispose
  };
})(window);
