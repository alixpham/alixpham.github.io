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

  /* ----------------------- Platform detection ---------------------------- */
  var IS_TOUCH = ('ontouchstart' in global) || navigator.maxTouchPoints > 0;
  function isMobile() { return IS_TOUCH && Math.min(global.innerWidth, global.innerHeight) < 820; }

  /* --------------------------- Controls help ----------------------------- */
  function controlsOverlay() {
    var mac = [
      ['Move', 'W A S D  or  Arrow Keys'],
      ['Sprint', 'Hold Shift'],
      ['Snap the ball', 'Space / Enter'],
      ['Throw to WR1 / WR2', '1  /  2'],
      ['Throw to RB / Center', '3  /  4'],
      ['Switch defender', 'Q'],
      ['Pull the flag (on D)', 'E']
    ];
    var mobile = [
      ['Move', 'Left thumb joystick'],
      ['Snap the ball', 'SNAP button'],
      ['Throw', 'Tap the receiver button (WR1/WR2/RB/C)'],
      ['Sprint', 'Hold the ⚡ button'],
      ['Switch defender', 'SWITCH button'],
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

    var wrap = h('div', { class: 'game-screen' }, [
      canvas, this.hud, this.playcallEl, this.touch, this.banner,
      h('div', { class: 'game-top-btns' }, [
        h('button', { class: 'mini-btn', html: '⏸', title: 'Menu', onClick: function () { self.pauseMenu(); } }),
        controlsButton()
      ])
    ]);
    this.el = wrap;

    var eng = new global.FLAGSTER.Engine(canvas, {
      onEvent: function (ev) { self._onEngineEvent(ev); }
    });
    this.engine = eng;
    eng.newGame({
      home: cfg.home, away: cfg.away,
      homeJersey: cfg.homeJersey, awayJersey: cfg.awayJersey,
      userSide: cfg.userSide, quarters: cfg.quarters, quarterLen: cfg.quarterLen,
      startPossession: cfg.startPossession || 'away', rtg: cfg.rtg
    });
    // team abbreviations for HUD
    cfg.home.abbr = cfg.home.id; cfg.away.abbr = cfg.away.id;

    // Drive UI updates off the same clock via a light interval
    this._tick = setInterval(function () { self._syncUI(); }, 90);
    setTimeout(function () { eng._resize(); eng.start(); self._syncUI(); }, 30);
    this._buildTouch();
    return wrap;
  };

  GameShell.prototype.destroy = function () {
    if (this._tick) clearInterval(this._tick);
    if (this.engine) this.engine.stop();
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

  GameShell.prototype._syncUI = function () {
    var eng = this.engine, s = eng && eng.state;
    if (!s) return;
    // HUD
    var offTeam = s.possession;
    var downTxt = s.down + (['st','nd','rd','th'][Math.min(s.down - 1, 3)]);
    var toGain = s.crossedMid ? ('Goal: ' + Math.round(s.yardsToGoal) + ' yд') : ('Midfield in ' + Math.max(0, Math.round(s.yardsToGoal - 25)) + ' yд');
    var mm = Math.floor(Math.max(0, s.clock) / 60), ss = Math.max(0, Math.round(s.clock % 60));
    var clk = mm + ':' + (ss < 10 ? '0' : '') + ss;
    clear(this.hud);
    this.hud.appendChild(h('div', { class: 'hud-team ' + (offTeam === 'away' ? 'has-ball' : '') }, [
      h('span', { class: 'hud-flag', text: this.cfg.away.flag }),
      h('span', { class: 'hud-abbr', text: this.cfg.away.id }),
      h('span', { class: 'hud-score', text: s.score.away })
    ]));
    this.hud.appendChild(h('div', { class: 'hud-mid' }, [
      h('div', { class: 'hud-clock', text: (s.overtime ? 'OT ' : 'Q' + s.quarter + '  ') + clk }),
      h('div', { class: 'hud-down', text: downTxt + ' — ' + toGain })
    ]));
    this.hud.appendChild(h('div', { class: 'hud-team ' + (offTeam === 'home' ? 'has-ball' : '') }, [
      h('span', { class: 'hud-score', text: s.score.home }),
      h('span', { class: 'hud-abbr', text: this.cfg.home.id }),
      h('span', { class: 'hud-flag', text: this.cfg.home.flag })
    ]));

    // Phase-driven panels
    if (s.phase !== this._lastPhase) {
      this._lastPhase = s.phase;
      if (s.phase === 'playcall') this._showPlaycall();
      else this.playcallEl.classList.add('hidden');
      if (s.phase === 'presnap' || s.phase === 'live') this._showTouch();
      else if (s.phase !== 'playcall') this.touch.classList.add('hidden');
    }
    // Snap prompt on presnap
    if (s.phase === 'presnap') this._presnapHint();
  };

  GameShell.prototype._presnapHint = function () {
    if (this._hintShown) return; this._hintShown = true;
  };

  GameShell.prototype._showPlaycall = function () {
    var self = this, eng = this.engine, s = eng.state;
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
        var plays = D.PLAYS.filter(function (p) { return p.type === g.key; });
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
    // Joystick
    var stick = h('div', { class: 'joystick' }, [h('div', { class: 'joy-knob' })]);
    var knob = stick.querySelector('.joy-knob');
    var active = false, cx = 0, cy = 0;
    function startJ(x, y) { active = true; var r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; moveJ(x, y); }
    function moveJ(x, y) {
      if (!active) return;
      var dx = x - cx, dy = y - cy, m = Math.hypot(dx, dy), max = 42;
      var cl = Math.min(m, max);
      var nx = m ? dx / m : 0, ny = m ? dy / m : 0;
      knob.style.transform = 'translate(' + (nx * cl) + 'px,' + (ny * cl) + 'px)';
      eng.setStick(nx, ny, m > 6);
    }
    function endJ() { active = false; knob.style.transform = 'translate(0,0)'; eng.setStick(0, 0, false); }
    stick.addEventListener('touchstart', function (e) { e.preventDefault(); var t = e.touches[0]; startJ(t.clientX, t.clientY); });
    stick.addEventListener('touchmove', function (e) { e.preventDefault(); var t = e.touches[0]; moveJ(t.clientX, t.clientY); });
    stick.addEventListener('touchend', function (e) { e.preventDefault(); endJ(); });
    stick.addEventListener('mousedown', function (e) { startJ(e.clientX, e.clientY); });
    global.addEventListener('mousemove', function (e) { moveJ(e.clientX, e.clientY); });
    global.addEventListener('mouseup', endJ);

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
      actBtn('RB', 'r3', 'r3'), actBtn('C', 'r4', 'r4'), sprint
    ]);
    this._defBtns = h('div', { class: 'btn-cluster' }, [
      actBtn('SWITCH', 'sw', 'switch'), actBtn('PULL', 'pull', 'pull')
    ]);

    clear(this.touch);
    this.touch.appendChild(stick);
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
