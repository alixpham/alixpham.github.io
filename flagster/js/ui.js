/* ============================================================================
   FLAGSTER — UI TOOLKIT + GAME SHELL
   DOM helpers, screen router, in-game HUD, play-call panel, on-screen touch
   controls, and the shared "Controls" help overlay (works on Mac & mobile).
   ============================================================================ */
(function (global) {
  'use strict';
  var D = global.FLAGSTER.data;

  /* --------------------------- DOM helpers ------------------------------- */
  function h(tag, props, children) {
    var e = document.createElement(tag);
    props = props || {};
    Object.keys(props).forEach(function (k) {
      if (k === 'class') e.className = props[k];
      else if (k === 'html') e.innerHTML = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k.slice(0, 2) === 'on' && typeof props[k] === 'function') e.addEventListener(k.slice(2).toLowerCase(), props[k]);
      else if (k === 'style' && typeof props[k] === 'object') Object.assign(e.style, props[k]);
      else if (props[k] != null) e.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) {
      if (c == null) return;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return e;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  /* --------------------------- Screen router ----------------------------- */
  var root;
  function mount(el) { root = el; }
  function show(node) { clear(root); root.appendChild(node); global.scrollTo(0, 0); }

  /* ------------------------------ CRESTS ---------------------------------
     A shield badge per team, drawn from that nation's own two kit colours and
     its three-letter code. The HUD used to show the flag emoji, which renders
     at a different size, weight and baseline on every platform — and on the
     several that ship no flag glyphs at all it degrades to two letters in a
     box. A crest we draw ourselves looks the same everywhere and sits properly
     against the scorebug.

     Returned as an SVG data URI and memoised, since the scorebug re-renders
     several times a second and these never change within a game. */
  var _crestCache = {};
  function crestFor(team) {
    if (!team) return '';
    var id = team.id || '??';
    var cols = team.colors || ['#26467f', '#ffffff'];
    var key = id + '|' + cols[0] + '|' + cols[1];
    if (_crestCache[key]) return _crestCache[key];

    var base = cols[0], trim = cols[1];
    // A near-white primary would vanish against the dark scorebug, so in that
    // case swap the roles and let the trim carry the shield.
    if (luma(base) > 0.80 && luma(trim) < 0.80) { base = cols[1]; trim = cols[0]; }
    var ink = luma(base) > 0.60 ? '#12181f' : '#ffffff';

    var shield = 'M32 3 L60 12 L60 34 Q60 54 32 65 Q4 54 4 34 L4 12 Z';
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 68" width="64" height="68">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="' + shade(base, 1.35) + '"/>' +
          '<stop offset="1" stop-color="' + shade(base, 0.72) + '"/>' +
        '</linearGradient></defs>' +
        '<path d="' + shield + '" fill="url(#g)" stroke="' + trim + '" stroke-width="4"/>' +
        // A chevron band across the shield so it reads as a crest, not a blob.
        '<path d="M6 30 L32 40 L58 30 L58 37 L32 47 L6 37 Z" fill="' + trim + '" opacity="0.55"/>' +
        '<text x="32" y="27" text-anchor="middle" font-family="Impact, \'Arial Black\', sans-serif" ' +
          'font-size="20" fill="' + ink + '">' + esc(id) + '</text>' +
      '</svg>';
    _crestCache[key] = 'data:image/svg+xml,' + encodeURIComponent(svg);
    return _crestCache[key];
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c];
    });
  }
  function hex2rgb(h) {
    h = String(h || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return { r: 128, g: 128, b: 128 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function luma(h) {
    var c = hex2rgb(h);
    return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  }
  function shade(h, k) {
    var c = hex2rgb(h);
    function f(v) { return Math.max(0, Math.min(255, Math.round(v * k))); }
    return 'rgb(' + f(c.r) + ',' + f(c.g) + ',' + f(c.b) + ')';
  }

  /* ----------------------- Platform detection ---------------------------- */
  var IS_TOUCH = ('ontouchstart' in global) || navigator.maxTouchPoints > 0;
  function isMobile() { return IS_TOUCH && Math.min(global.innerWidth, global.innerHeight) < 820; }

  /* --------------------------- Controls help ----------------------------- */
  function controlsOverlay() {
    var mac = [
      ['Move', 'W A S D  or  Arrow Keys'],
      ['Sprint', 'Hold Shift'],
      ['Direct a player', 'Drag a line on the field — they run the whole route'],
      ['Snap the ball', 'Space / Enter'],
      ['Throw to WR1 / WR2', '1  /  2'],
      ['Throw to RB / Center', '3  /  4'],
      ['Juke (break a grab)', 'F'],
      ['Pitch back (lateral)', 'L'],
      ['Switch defender', 'Q'],
      ['Pull the flag (on D)', 'E']
    ];
    var mobile = [
      ['Move', 'Swipe / drag anywhere on the field'],
      ['Direct a player', 'Slash a line — they run the whole route'],
      ['Snap the ball', 'SNAP button'],
      ['Throw', 'Tap a receiver on the field, or the WR1/WR2/RB/C button'],
      ['Juke (break a grab)', 'JUKE button'],
      ['Pitch back (lateral)', 'PITCH button'],
      ['Sprint', 'Hold the ⚡ button'],
      ['Switch defender', 'Tap a team-mate (or SWITCH)'],
      ['Pull the flag (on D)', 'PULL button']
    ];
    function tbl(rows) {
      return h('table', { class: 'ctrl-table' }, rows.map(function (r) {
        return h('tr', {}, [h('td', { class: 'ctrl-act', text: r[0] }), h('td', { class: 'ctrl-key', text: r[1] })]);
      }));
    }
    var ov = h('div', { class: 'overlay' }, [
      h('div', { class: 'overlay-card' }, [
        h('h2', { text: '🎮 Controls' }),
        h('div', { class: 'ctrl-cols' }, [
          h('div', {}, [h('h3', { html: '💻 Mac / Keyboard' }), tbl(mac)]),
          h('div', {}, [h('h3', { html: '📱 Mobile / Touch' }), tbl(mobile)])
        ]),
        h('p', { class: 'muted', text: 'Tip: on offense you control the ball carrier; on defense you control the highlighted player and pursue the runner to pull their flag.' }),
        h('button', { class: 'btn primary', text: 'Got it', onClick: function () { ov.remove(); } })
      ])
    ]);
    return ov;
  }
  function openControls() { document.body.appendChild(controlsOverlay()); }

  function controlsButton() {
    return h('button', { class: 'controls-btn', title: 'Controls', onClick: openControls, html: '🎮 Controls' });
  }

  /* ============================== GAME SHELL ============================== */
  // Wraps an Engine: builds field + HUD + play-call + touch controls, and
  // fires cfg.onGameOver(result) when the game ends.
  function GameShell(cfg) {
    this.cfg = cfg;             // { home, away, homeJersey, awayJersey, userSide, quarters, quarterLen, rtg, title, onGameOver, onEvent }
    this.el = null;
    this.engine = null;
    this._lastPhase = null;
    this._rtgProgress = cfg.rtgProgress || null;
  }

  GameShell.prototype.build = function () {
    var self = this, cfg = this.cfg;
    var canvas = h('canvas', { class: 'field-canvas', id: 'flag-field' });
    this.canvas = canvas;

    this.hud = h('div', { class: 'hud' });
    this.playcallEl = h('div', { class: 'playcall hidden' });
    this.touch = h('div', { class: 'touch-controls hidden' });
    this.banner = h('div', { class: 'game-banner hidden' });

    this.grab = h('div', { class: 'grab-wrap hidden' }, [
      h('div', { class: 'grab-label', text: 'HELD — JUKE!' }),
      h('div', { class: 'grab-bar' }, [h('div', { class: 'grab-fill' })])
    ]);
    this.grabFill = this.grab.querySelector('.grab-fill');

    var wrap = h('div', { class: 'game-screen' }, [
      canvas, this.hud, this.playcallEl, this.touch, this.banner, this.grab,
      // Only the pause button lives on the game screen. The controls sheet is
      // one tap further in, from the pause menu — a permanent "🎮 Controls"
      // chip over the field is a tutorial that never ends.
      h('div', { class: 'game-top-btns' }, [
        h('button', { class: 'mini-btn', html: '⏸', title: 'Menu', onClick: function () { self.pauseMenu(); } })
      ])
    ]);
    this.el = wrap;
    // The running game, reachable from the console (and from the headless
    // harness that drives it) without threading a handle through the router.
    global.FLAGSTER.activeShell = this;

    var eng = new global.FLAGSTER.Engine(canvas, {
      onEvent: function (ev) { self._onEngineEvent(ev); }
    });
    this.engine = eng;
    eng.newGame({
      home: cfg.home, away: cfg.away,
      homeJersey: cfg.homeJersey, awayJersey: cfg.awayJersey,
      userSide: cfg.userSide, quarters: cfg.quarters, quarterLen: cfg.quarterLen,
      halves: cfg.halves, halfLen: cfg.halfLen,
      startPossession: cfg.startPossession || 'away', rtg: cfg.rtg,
      difficulty: cfg.difficulty, demo: cfg.demo
    });

    // --- Optional 3D field renderer (Three.js). Falls back to 2D canvas if
    // THREE / WebGL is unavailable, or if the 3D renderer errors mid-game. ---
    this.field3d = null;
    if (global.THREE && global.FLAGSTER.Field3D) {
      var gl3d = h('canvas', { class: 'field-canvas field-canvas-3d', id: 'flag-field-3d' });
      if (canvas.nextSibling) wrap.insertBefore(gl3d, canvas.nextSibling);
      else wrap.appendChild(gl3d);
      try {
        var f3 = global.FLAGSTER.Field3D.mount(gl3d, eng);
        if (f3) {
          this.field3d = f3;
          this.canvas3d = gl3d;
          canvas.style.display = 'none';              // hide the 2D canvas
          eng.externalRender = function (state) { f3.render(state); };
          eng.onExternalFail = function () {           // hard fallback to 2D
            try { f3.stop(); } catch (e) {}
            gl3d.remove(); self.field3d = null;
            canvas.style.display = '';
          };
        } else {
          gl3d.remove();
        }
      } catch (e) {
        gl3d.remove();
        if (global.console) console.warn('Flagster: 3D field unavailable, using 2D renderer.', e);
      }
    }
    // team abbreviations for HUD
    cfg.home.abbr = cfg.home.id; cfg.away.abbr = cfg.away.id;

    // Drive UI updates off the same clock via a light interval
    this._tick = setInterval(function () { self._syncUI(); }, 90);
    setTimeout(function () { eng._resize(); eng.start(); self._syncUI(); }, 30);
    this._buildTouch();
    return wrap;
  };

  GameShell.prototype.destroy = function () {
    if (global.FLAGSTER.activeShell === this) global.FLAGSTER.activeShell = null;
    clearTimeout(this._demoT); clearTimeout(this._demoSnapT);
    if (this._tick) clearInterval(this._tick);
    if (this.engine) this.engine.stop();
    if (this.field3d) { try { this.field3d.stop(); } catch (e) {} this.field3d = null; }
  };

  GameShell.prototype._onEngineEvent = function (ev) {
    if (this.cfg.onEvent) this.cfg.onEvent(ev, this.engine.state);
    if (ev.type === 'gameover') {
      this.destroy();
      var s = this.engine.state;
      var res = {
        winner: ev.winner, score: ev.score,
        homeId: this.cfg.home.id, awayId: this.cfg.away.id,
        userSide: this.cfg.userSide, stats: s.stats
      };
      if (this.cfg.onGameOver) this.cfg.onGameOver(res);
    }
  };

  /* ------------------------------- HUD -----------------------------------
     A broadcast-style overlay: scorebug, play clock, down & distance with a
     field position map, and stamina bars.

     Built ONCE into a stable tree; _syncUI only writes the values that
     changed. The previous version tore the whole HUD down and rebuilt every
     node eleven times a second, which churned the DOM continuously and made
     the text impossible to select or animate.                              */
  GameShell.prototype._buildHud = function () {
    var cfg = this.cfg;
    function team(side) {
      var t = cfg[side];
      return h('div', { class: 'sb-team sb-' + side }, [
        h('img', { class: 'sb-crest', src: crestFor(t), alt: '' }),
        h('span', { class: 'sb-abbr', text: t.id }),
        h('span', { class: 'sb-score', text: '0' })
      ]);
    }
    var away = team('away'), home = team('home');
    var clockBox = h('div', { class: 'sb-clock' }, [
      h('div', { class: 'sb-time', text: '0:00' }),
      h('div', { class: 'sb-dd', text: '1ST & 10' })
    ]);
    var scorebug = h('div', { class: 'sb' }, [away, clockBox, home]);

    // Play clock — landscape only; portrait has no room for it.
    var playClock = h('div', { class: 'pc' }, [
      h('div', { class: 'pc-label', text: 'PLAY CLOCK' }),
      h('div', { class: 'pc-num', text: '25' })
    ]);

    // Right-hand stack: situation + a field map + stamina.
    var map = h('canvas', { class: 'mini-map', width: 132, height: 56 });
    var situation = h('div', { class: 'sit' }, [
      h('div', { class: 'sit-row' }, [
        h('span', { class: 'sit-label', text: 'DOWN & DISTANCE' }),
        h('span', { class: 'sit-val js-dd', text: '1ST & 10' })
      ]),
      h('div', { class: 'sit-row' }, [
        h('span', { class: 'sit-label', text: 'BALL ON' }),
        h('span', { class: 'sit-val js-ballon', text: '—' })
      ]),
      // The 7-second pass clock. It decides every passing down in this sport,
      // so it belongs on the screen, not just in the engine.
      h('div', { class: 'sit-row js-pass-row hidden' }, [
        h('span', { class: 'sit-label', text: 'PASS CLOCK' }),
        h('span', { class: 'sit-val js-passclock', text: '7.0' })
      ]),
      map
    ]);
    var bars = [];
    for (var i = 0; i < 3; i++) {
      var fill = h('div', { class: 'stam-fill' });
      bars.push(fill);
      situation.appendChild(h('div', { class: 'stam-bar' }, [fill]));
    }
    situation.insertBefore(h('div', { class: 'sit-label stam-head', text: 'STAMINA' }),
                           situation.querySelector('.stam-bar'));

    // Portrait strip under the scorebug.
    var strip = h('div', { class: 'sb-strip' }, [
      h('span', {}, [h('em', { text: 'BALL ON ' }), h('b', { class: 'js-strip-ballon', text: '—' })]),
      h('span', {}, [h('em', { text: 'YDS TO GO: ' }), h('b', { class: 'js-strip-togo', text: '—' })])
    ]);

    clear(this.hud);
    this.hud.appendChild(scorebug);
    this.hud.appendChild(strip);
    this.hud.appendChild(playClock);
    this.hud.appendChild(situation);

    this._hudRefs = {
      awayScore: away.querySelector('.sb-score'),
      homeScore: home.querySelector('.sb-score'),
      awayTeam: away, homeTeam: home,
      time: clockBox.querySelector('.sb-time'),
      dd: clockBox.querySelector('.sb-dd'),
      pc: playClock, pcNum: playClock.querySelector('.pc-num'),
      sitDd: situation.querySelector('.js-dd'),
      sitBallOn: situation.querySelector('.js-ballon'),
      passRow: situation.querySelector('.js-pass-row'),
      passClock: situation.querySelector('.js-passclock'),
      stripBallOn: strip.querySelector('.js-strip-ballon'),
      stripToGo: strip.querySelector('.js-strip-togo'),
      map: map, bars: bars, last: {}
    };
  };

  var ORD = ['1ST', '2ND', '3RD', '4TH'];

  /* Field position in broadcast shorthand: "OWN 34" / "OPP 27" / "50".
     `yardsToGoal` counts down to the offense's target end zone, so anything
     past 50 is still in their own half. */
  function ballOnText(s) {
    var ytg = Math.round(s.yardsToGoal);
    if (ytg === 50) return '50';
    return (ytg > 50) ? ('OWN ' + (100 - ytg)) : ('OPP ' + ytg);
  }

  // Yards needed for a new set of downs: to midfield, or to the goal line.
  function yardsToGo(s) {
    return s.crossedMid
      ? Math.max(0, Math.round(s.yardsToGoal))
      : Math.max(0, Math.round(s.yardsToGoal - 25));
  }

  /* The little field map. Drawn only when the ball actually moves — this is a
     canvas repaint inside a 11Hz interval, and redrawing an unchanged picture
     is pure waste. */
  GameShell.prototype._drawMiniMap = function (s) {
    var r = this._hudRefs, cv = r.map;
    if (!cv) return;
    var g = cv.getContext('2d');
    if (!g) return;
    var W = cv.width, H = cv.height, pad = 4;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#1c5c30'; g.fillRect(pad, pad, W - pad * 2, H - pad * 2);

    var fw = W - pad * 2;
    // End zones
    g.fillStyle = 'rgba(255,255,255,0.20)';
    g.fillRect(pad, pad, fw * 0.14, H - pad * 2);
    g.fillRect(W - pad - fw * 0.14, pad, fw * 0.14, H - pad * 2);
    // Yard lines
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
    for (var i = 1; i < 8; i++) {
      var x = pad + fw * (0.14 + (0.72 * i / 8));
      g.beginPath(); g.moveTo(x, pad); g.lineTo(x, H - pad); g.stroke();
    }
    // Ball spot. The offense attacks +x, so yardsToGoal maps right-to-left.
    var t = 1 - (Math.max(0, Math.min(100, s.yardsToGoal)) / 100);
    var bx = pad + fw * (0.14 + 0.72 * t);
    g.fillStyle = '#ffd23f';
    g.beginPath(); g.arc(bx, H / 2, 3.6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#ffd23f'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(bx, pad + 1); g.lineTo(bx, H - pad - 1); g.stroke();
  };

  GameShell.prototype._syncUI = function () {
    var eng = this.engine, s = eng && eng.state;
    if (!s) return;
    if (!this._hudRefs) this._buildHud();
    var r = this._hudRefs, last = r.last;

    function set(el, key, val) {
      if (last[key] === val) return;
      last[key] = val; el.textContent = val;
    }

    var mm = Math.floor(Math.max(0, s.clock) / 60), ss = Math.max(0, Math.round(s.clock % 60));
    var clk = mm + ':' + (ss < 10 ? '0' : '') + ss;
    var down = ORD[Math.min(Math.max(s.down, 1) - 1, 3)];
    var ddTxt = down + ' & ' + (s.crossedMid && s.yardsToGoal <= 10 ? 'GOAL' : yardsToGo(s));
    var period = s.overtime ? ('OT' + (s.otRound || 1)) : ((s.halves ? 'H' : 'Q') + s.quarter);

    set(r.awayScore, 'as', String(s.score.away));
    set(r.homeScore, 'hs', String(s.score.home));
    set(r.time, 'clk', period + ' ' + clk);
    set(r.dd, 'dd', ddTxt);
    set(r.sitDd, 'dd2', ddTxt);
    set(r.sitBallOn, 'bo', ballOnText(s));
    set(r.stripBallOn, 'bo2', ballOnText(s));
    set(r.stripToGo, 'tg', String(yardsToGo(s)));

    /* Pass clock: only while the original passer still has it, which is
       exactly when the rule is live. */
    var passLive = (s.phase === 'live' && s.carrier && s.carrier === s.passer && !s.handoffDone);
    if (last.passLive !== passLive) {
      last.passLive = passLive;
      r.passRow.classList.toggle('hidden', !passLive);
    }
    if (passLive) {
      var left = Math.max(0, 7 - (s.snapT || 0));
      var txt = left.toFixed(1);
      set(r.passClock, 'pcl', txt);
      r.passClock.classList.toggle('urgent', left <= 2.5);
    }

    // Possession highlight
    var awayBall = (s.possession === 'away');
    if (last.poss !== awayBall) {
      last.poss = awayBall;
      r.awayTeam.classList.toggle('has-ball', awayBall);
      r.homeTeam.classList.toggle('has-ball', !awayBall);
    }

    // Play clock: only meaningful pre-snap, and it turns red in the last five.
    var pcOn = (s.phase === 'presnap');
    if (last.pcOn !== pcOn) { last.pcOn = pcOn; r.pc.classList.toggle('hidden', !pcOn); }
    if (pcOn) {
      var left = Math.ceil(s.playClockLeft == null ? 25 : s.playClockLeft);
      set(r.pcNum, 'pc', String(left));
      var hot = left <= 5;
      if (last.pcHot !== hot) { last.pcHot = hot; r.pc.classList.toggle('hot', hot); }
    }

    // Stamina for the three skill players on the side we're watching.
    var watch = this.cfg.demo ? s.possession : this.cfg.userSide;
    var mine = (s.players || []).filter(function (p) {
      return p.team === watch && p.slot !== 'C' && p.slot !== 'RUSH';
    }).slice(0, 3);
    for (var i = 0; i < r.bars.length; i++) {
      var p = mine[i];
      var v = p && p.stam != null ? p.stam : 1;
      var pct = Math.round(v * 100);
      if (last['st' + i] !== pct) {
        last['st' + i] = pct;
        r.bars[i].style.width = pct + '%';
        r.bars[i].className = 'stam-fill' + (v < 0.35 ? ' low' : (v < 0.7 ? ' mid' : ''));
      }
    }

    // Field map — repaint only when the spot actually changed.
    var spot = Math.round(s.yardsToGoal);
    if (last.spot !== spot) { last.spot = spot; this._drawMiniMap(s); }

    // Contested flag-pull meter — shows a grab filling so you know to juke.
    var gp = s.grabProgress || 0;
    if (gp > 0.02 && s.phase === 'live') {
      this.grab.classList.remove('hidden');
      this.grabFill.style.width = Math.round(gp * 100) + '%';
      this.grab.classList.toggle('danger', gp > 0.6);
    } else {
      this.grab.classList.add('hidden');
    }

    // Phase-driven panels
    if (s.phase !== this._lastPhase) {
      this._lastPhase = s.phase;
      if (s.phase === 'playcall') this._showPlaycall();
      else if (s.phase === 'patchoice') this._showPATChoice();
      else this.playcallEl.classList.add('hidden');
      if (s.phase === 'presnap' || s.phase === 'live') this._showTouch();
      else if (s.phase !== 'playcall') this.touch.classList.add('hidden');
    }
    // Snap prompt on presnap
    if (s.phase === 'presnap') this._presnapHint();

    // Flash message: the 2D renderer paints this onto its canvas, but the 3D
    // renderer does not, so surface it via the DOM banner when 3D is active.
    if (this.field3d && this.banner) {
      if (s.message && eng._t < s.flashUntil) {
        this.banner.textContent = s.message;
        this.banner.classList.remove('hidden');
      } else {
        this.banner.classList.add('hidden');
      }
    }
  };

  GameShell.prototype._presnapHint = function () {
    if (this._hintShown) return; this._hintShown = true;
  };

  /* After a touchdown: one point from the 5, or two from the 10. There is no
     kicking in flag football, so both are a real snap against a real defence —
     which makes this the first genuine risk decision the game asks for. */
  GameShell.prototype._showPATChoice = function () {
    var self = this, eng = this.engine;
    var el = this.playcallEl;
    clear(el); el.classList.remove('hidden');
    function pick(points) {
      el.classList.add('hidden');
      eng.choosePAT(points);
    }
    el.appendChild(h('div', { class: 'playcall-inner' }, [
      h('div', { class: 'playcall-title', text: '🏈 Touchdown — go for how many?' }),
      h('div', { class: 'play-grid pat' }, [
        h('button', { class: 'play-card', onClick: function () { pick(1); } }, [
          h('span', { class: 'play-icon', text: '1️⃣' }),
          h('span', { class: 'play-name', text: '1 point — from the 5' })
        ]),
        h('button', { class: 'play-card', onClick: function () { pick(2); } }, [
          h('span', { class: 'play-icon', text: '2️⃣' }),
          h('span', { class: 'play-name', text: '2 points — from the 10' })
        ])
      ])
    ]));
  };

  GameShell.prototype._showPlaycall = function () {
    var self = this, eng = this.engine, s = eng.state;
    if (this.cfg.demo) {
      // CPU vs CPU: pick a play, then snap it — no UI, no input.
      this.playcallEl.classList.add('hidden');
      this.touch.classList.add('hidden');
      clearTimeout(this._demoT);
      /* 700ms once, which is less time than a celebration takes. Calling the
         play builds the next formation, and a new formation ends whatever the
         renderer was celebrating (field3d, rebuildPlayers) — so in attract mode
         a first down was cut off about half way through. A CPU side is allowed
         to enjoy it for as long as the celebration lasts. */
      this._demoT = setTimeout(function () {
        eng.autoCall();
        clearTimeout(self._demoSnapT);
        self._demoSnapT = setTimeout(function () { eng.snap(); }, 900);
      }, 1400);
      return;
    }
    this._hintShown = false;
    this.touch.classList.add('hidden');
    var userOff = (s.possession === this.cfg.userSide);
    var el = this.playcallEl;
    clear(el); el.classList.remove('hidden');

    if (userOff) {
      var groups = [
        { key: 'pass-short', label: 'Short Pass' },
        { key: 'pass-med', label: 'Medium Pass' },
        { key: 'pass-long', label: 'Deep Pass' },
        { key: 'run', label: 'Run' },
        { key: 'trick', label: 'Trick' }
      ];
      var grid = h('div', { class: 'play-grid' });
      groups.forEach(function (g) {
        // No-run zones: running is illegal inside 5 of a goal line or
        // midfield, so those plays must not be offerable, not merely unwise.
        var legal = eng.legalPlays ? eng.legalPlays() : D.PLAYS;
        var plays = legal.filter(function (p) { return p.type === g.key; });
        var col = h('div', { class: 'play-col' }, [h('div', { class: 'play-col-h', text: g.label })]);
        plays.forEach(function (p) {
          col.appendChild(h('button', { class: 'play-card', onClick: function () {
            el.classList.add('hidden'); eng.callOffense(p);
          } }, [
            h('span', { class: 'play-icon', text: p.icon }),
            h('span', { class: 'play-name', text: p.name })
          ]));
        });
        grid.appendChild(col);
      });
      el.appendChild(h('div', { class: 'playcall-inner' }, [
        h('div', { class: 'playcall-title', text: '📋 Choose your play — OFFENSE' }),
        grid
      ]));
    } else {
      var dgrid = h('div', { class: 'play-grid def' });
      D.DEF_PLAYS.forEach(function (p) {
        dgrid.appendChild(h('button', { class: 'play-card def', onClick: function () {
          el.classList.add('hidden'); eng.callDefense(p);
        } }, [
          h('span', { class: 'play-icon', text: p.icon }),
          h('span', { class: 'play-name', text: p.name })
        ]));
      });
      el.appendChild(h('div', { class: 'playcall-inner' }, [
        h('div', { class: 'playcall-title', text: '🛡 Choose your coverage — DEFENSE' }),
        dgrid
      ]));
    }
  };

  GameShell.prototype._showTouch = function () {
    var s = this.engine.state;
    if (this.cfg.demo) { this.touch.classList.add('hidden'); return; }
    this.touch.classList.remove('hidden');
    var userOff = (s.possession === this.cfg.userSide);
    // toggle button set
    this._offBtns.style.display = userOff ? '' : 'none';
    this._defBtns.style.display = userOff ? 'none' : '';
    // snap button visibility
    this._snapBtn.style.display = (s.phase === 'presnap') ? '' : 'none';
  };

  GameShell.prototype._buildTouch = function () {
    var self = this, eng = this.engine;

    // --- Swipe-to-move: a full-field floating joystick. Touch/drag ANYWHERE on
    // the field (not on a button) to steer your player; a base+knob appears at
    // the touch point. Action buttons sit on top and capture their own touches,
    // so you can move with one thumb and press buttons with the other. ---
    var base = h('div', { class: 'float-base' }, [h('div', { class: 'float-knob' })]);
    base.style.display = 'none';
    var fknob = base.firstChild;
    var swipe = h('div', { class: 'swipe-pad' }, [base]);
    var moveId = null, ox = 0, oy = 0, tapT = 0, moved = 0;
    // A short, near-stationary press is a TAP (select a defender / throw to a
    // receiver); anything with real travel is a swipe that steers the player.
    function tryTap(x, y) {
      if (!self.field3d || !self.field3d.pick) return;
      var idx = self.field3d.pick(x, y);
      if (idx >= 0) eng.selectPlayerIndex(idx);
    }

    /* SLASH-TO-DIRECT. One gesture, two meanings, decided by how far it travels:

         short drag  -> the floating joystick, exactly as before
         long stroke -> a SLASH: the line you draw becomes a route the player
                        runs on their own, so you can commit to a cut around a
                        defender and take your thumb off the glass instead of
                        hand-flying every yard.

       The switch happens mid-gesture, the moment the stroke passes SLASH_MIN.
       At that point the stick is released — leaving it live would steer the
       player the whole time you were drawing, which is how you end up on the
       sideline before the route even exists — and each new point is fed
       straight to the engine, so they set off along the line while you're
       still drawing the rest of it.

       Touching the field again cancels the route and hands the stick back. */
    var SLASH_MIN = 64;        // px of travel before a drag becomes a slash
    var SLASH_STEP = 12;       // px between sampled points along the stroke
    var trail = [], slashing = false;

    function trailPush(x, y) {
      var last = trail[trail.length - 1];
      if (last && Math.hypot(x - last.x, y - last.y) < SLASH_STEP) return false;
      trail.push({ x: x, y: y });
      return true;
    }
    function canSlash() { return !!(self.field3d && self.field3d.pickGround); }
    function inkPoint(x, y) {
      var g = self.field3d.pickGround(x, y);
      if (g) eng.appendSlash(g);
    }
    function beginSlash() {
      slashing = true;
      eng.setStick(0, 0, false);          // hands off — the line is in charge now
      base.style.display = 'none';
      eng.clearSlash();
      for (var i = 0; i < trail.length; i++) inkPoint(trail[i].x, trail[i].y);
    }

    function sStart(x, y, id) {
      moveId = id; ox = x; oy = y; moved = 0; tapT = Date.now();
      trail = [{ x: x, y: y }]; slashing = false;
      base.style.display = 'block'; base.style.left = x + 'px'; base.style.top = y + 'px';
      fknob.style.transform = 'translate(-50%,-50%)';
    }
    function sMove(x, y) {
      var dx = x - ox, dy = y - oy, m = Math.hypot(dx, dy), max = 52;
      if (m > moved) moved = m;
      var fresh = trailPush(x, y);
      if (!slashing && moved >= SLASH_MIN && canSlash()) beginSlash();
      else if (slashing && fresh) inkPoint(x, y);
      if (slashing) return;
      var nx = m ? dx / m : 0, ny = m ? dy / m : 0, cl = Math.min(m, max);
      fknob.style.transform = 'translate(-50%,-50%) translate(' + (nx * cl) + 'px,' + (ny * cl) + 'px)';
      eng.setStick(nx, ny, m > 7);
    }
    function sEnd(x, y) {
      var wasTap = !slashing && (moved < 12) && (Date.now() - tapT < 320);
      if (slashing && x != null && trailPush(x, y)) inkPoint(x, y);
      moveId = null; base.style.display = 'none';
      if (!slashing) eng.setStick(0, 0, false);   // a slash already released it
      if (wasTap && x != null) tryTap(x, y);
      trail = []; slashing = false;
    }
    swipe.addEventListener('touchstart', function (e) {
      if (moveId !== null) return;
      var t = e.changedTouches[0]; sStart(t.clientX, t.clientY, t.identifier); e.preventDefault();
    });
    swipe.addEventListener('touchmove', function (e) {
      for (var i = 0; i < e.changedTouches.length; i++) { var t = e.changedTouches[i]; if (t.identifier === moveId) { sMove(t.clientX, t.clientY); e.preventDefault(); } }
    });
    function touchEnd(e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier === moveId) sEnd(t.clientX, t.clientY);
      }
    }
    swipe.addEventListener('touchend', touchEnd);
    swipe.addEventListener('touchcancel', touchEnd);
    // mouse fallback (desktop testing)
    swipe.addEventListener('mousedown', function (e) { sStart(e.clientX, e.clientY, 'mouse'); });
    global.addEventListener('mousemove', function (e) { if (moveId === 'mouse') sMove(e.clientX, e.clientY); });
    global.addEventListener('mouseup', function (e) { if (moveId === 'mouse') sEnd(e.clientX, e.clientY); });

    function actBtn(label, cls, act) {
      var b = h('button', { class: 'act-btn ' + cls, html: label });
      var fire = function (e) { e.preventDefault(); eng.action(act); };
      b.addEventListener('touchstart', fire);
      b.addEventListener('click', function (e) { if (!IS_TOUCH) fire(e); });
      return b;
    }
    // sprint is a hold button
    var sprint = h('button', { class: 'act-btn sprint', html: '⚡' });
    function sprintOn(e) { e.preventDefault(); eng.input.sprint = true; sprint.classList.add('on'); }
    function sprintOff(e) { e.preventDefault(); eng.input.sprint = false; sprint.classList.remove('on'); }
    sprint.addEventListener('touchstart', sprintOn); sprint.addEventListener('touchend', sprintOff);
    sprint.addEventListener('mousedown', sprintOn); sprint.addEventListener('mouseup', sprintOff);

    this._snapBtn = actBtn('SNAP', 'snap', 'primary');

    this._offBtns = h('div', { class: 'btn-cluster' }, [
      actBtn('WR1', 'r1', 'r1'), actBtn('WR2', 'r2', 'r2'),
      actBtn('RB', 'r3', 'r3'), actBtn('C', 'r4', 'r4'),
      actBtn('JUKE', 'juke', 'juke'), actBtn('PITCH', 'pitch', 'pitch'), sprint
    ]);
    this._defBtns = h('div', { class: 'btn-cluster' }, [
      actBtn('SWITCH', 'sw', 'switch'), actBtn('PULL', 'pull', 'pull')
    ]);

    clear(this.touch);
    this.touch.appendChild(swipe);   // full-field swipe layer (below the buttons)
    this.touch.appendChild(h('div', { class: 'right-cluster' }, [this._snapBtn, this._offBtns, this._defBtns]));
  };

  GameShell.prototype.pauseMenu = function () {
    var self = this;
    var ov = h('div', { class: 'overlay' }, [
      h('div', { class: 'overlay-card' }, [
        h('h2', { text: '⏸ Paused' }),
        h('button', { class: 'btn primary', text: 'Resume', onClick: function () { ov.remove(); } }),
        h('button', { class: 'btn', text: 'Controls', onClick: openControls }),
        h('button', { class: 'btn danger', text: 'Quit to Menu', onClick: function () {
          ov.remove(); self.destroy();
          if (self.cfg.onQuit) self.cfg.onQuit();
        } })
      ])
    ]);
    document.body.appendChild(ov);
  };

  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.ui = {
    h: h, clear: clear, mount: mount, show: show,
    isMobile: isMobile, IS_TOUCH: IS_TOUCH,
    openControls: openControls, controlsButton: controlsButton,
    GameShell: GameShell
  };
})(window);
