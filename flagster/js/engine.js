/* ============================================================================
   FLAGSTER — GAME ENGINE
   Top-down 5v5 flag football. Field to IFAF scale (70yd x 25yd incl. two
   10-yard end zones -> 50 yards between goal lines). Handles routes, throwing,
   catching, running, defensive AI, and the signature flag-pull animation.
   ============================================================================ */
(function (global) {
  'use strict';
  var D = global.FLAGSTER.data;

  // Field constants (yards)
  var FIELD_LEN = 70, FIELD_WID = 25, EZ = 10;      // end zone depth
  var GOAL_L = EZ, GOAL_R = FIELD_LEN - EZ;         // x=10 (own), x=60 (target)
  var MIDFIELD = (GOAL_L + GOAL_R) / 2;             // x=35

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function Engine(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.raf = null;
    this.lastT = 0;
    this.input = { up: false, down: false, left: false, right: false, sprint: false };
    this.pointer = null;
    this.state = null;
    this.anim = [];            // transient animations (flag pulls, etc.)
    this.onEvent = opts.onEvent || function () {};
    this._bindInput();
  }

  Engine.prototype.speedYds = function (rating) { return 4.0 + (clamp(rating, 40, 99) - 55) / 44 * 5.2; };

  /* ---------------------------- GAME SETUP -------------------------------- */
  Engine.prototype.newGame = function (cfg) {
    // cfg: { home, away, homeJersey, awayJersey, userSide:'home'|'away',
    //        quarters, quarterLen, rtg:{playerId, side} , onDrive }
    this.cfg = cfg;
    this.state = {
      home: cfg.home, away: cfg.away,
      homeJersey: cfg.homeJersey, awayJersey: cfg.awayJersey,
      score: { home: 0, away: 0 },
      quarter: 1, quarters: cfg.quarters || 4,
      clock: cfg.quarterLen || 150,   // seconds per quarter
      possession: cfg.startPossession || 'away', // team with ball
      yardsToGoal: 45, down: 1, crossedMid: false,
      phase: 'playcall',
      players: [], ball: null,
      carrier: null, userControlled: null,
      playType: null, offPlay: null, defPlay: null,
      message: '', flashUntil: 0,
      overtime: false, gameOver: false,
      stats: { home: blankStats(), away: blankStats() }
    };
    this.userSide = cfg.userSide || 'home';
    this._resize();
  };

  function blankStats() { return { pass: 0, rush: 0, td: 0, tackles: 0, plays: 0 }; }

  Engine.prototype.offenseTeam = function () { return this.state.possession; };
  Engine.prototype.defenseTeam = function () { return this.state.possession === 'home' ? 'away' : 'home'; };
  Engine.prototype.nationId = function (side) { return this.state[side].id; };
  Engine.prototype.userOnOffense = function () { return this.state.possession === this.userSide; };

  /* ------------------------- FORMATION / SNAP ---------------------------- */
  // Build 5 offensive + 5 defensive players for the current down.
  Engine.prototype.setupFormation = function () {
    var s = this.state;
    var offNation = this.nationId(this.offenseTeam());
    var defNation = this.nationId(this.defenseTeam());
    var offStar = D.starters(offNation, 'off');
    var defStar = D.starters(defNation, 'def');

    // Inject Road to Glory player onto the user's roster at their position.
    if (this.cfg.rtg) this._injectRtg(offStar, defStar);

    var losX = GOAL_R - s.yardsToGoal;      // line of scrimmage (offense attacks +x)
    var cy = FIELD_WID / 2;
    var players = [];

    // Offense: QB behind, C on LOS center, WR1 top, WR2 bottom, RB beside QB
    var offPlay = s.offPlay;
    var offSpots = {
      QB: { x: losX - 4, y: cy },
      C:  { x: losX,     y: cy },
      WR1:{ x: losX - 0.5, y: 3.5 },
      WR2:{ x: losX - 0.5, y: FIELD_WID - 3.5 },
      RB: { x: losX - 3, y: cy + 3.5 }
    };
    var offMap = { QB: offStar[0], C: offStar[1], WR1: offStar[2], WR2: offStar[3], RB: offStar[4] };
    Object.keys(offSpots).forEach(function (slot) {
      var pl = offMap[slot];
      players.push(makeGP(pl, this.offenseTeam(), slot, offSpots[slot], offPlay));
    }, this);

    // Defense mirrors across the LOS
    var defSpots = {
      RUSH:{ x: losX + 1.5, y: cy },
      MLB: { x: losX + 6, y: cy },
      CB:  { x: losX + 3, y: 4 },
      CB2: { x: losX + 3, y: FIELD_WID - 4 },
      S:   { x: losX + 12, y: cy }
    };
    var defMap = { RUSH: defStar[0], MLB: defStar[1], CB: defStar[2], CB2: defStar[3], S: defStar[4] };
    Object.keys(defSpots).forEach(function (slot) {
      var pl = defMap[slot];
      players.push(makeGP(pl, this.defenseTeam(), slot, defSpots[slot], null));
    }, this);

    s.players = players;
    s.losX = losX;
    s.lineToGain = s.crossedMid ? GOAL_R : MIDFIELD;
    s.ball = null;
    s.carrier = null;
    s.snapT = 0;

    // Assign coverage
    this._assignDefense();

    // Who does the user control pre-snap?
    if (this.userOnOffense()) {
      s.userControlled = players.filter(function (p) { return p.slot === 'QB' && p.team === this.offenseTeam(); }, this)[0];
    } else {
      s.userControlled = this._nearestDefenderToBall();
    }
    s.phase = 'presnap';
  };

  function makeGP(playerData, team, slot, spot, offPlay) {
    var routeKey = null;
    if (offPlay && offPlay.routes) {
      var map = { WR1: 'WR1', WR2: 'WR2', RB: 'RB', C: 'C' };
      if (map[slot]) routeKey = offPlay.routes[slot];
    }
    return {
      data: playerData, team: team, slot: slot,
      x: spot.x, y: spot.y, vx: 0, vy: 0, ang: 0,
      route: routeKey, wp: 0, flagPulled: false,
      cover: null, isUser: false, animPhase: 0,
      pos: playerData.pos, last: playerData.last, ovr: playerData.ovr
    };
  }

  Engine.prototype._injectRtg = function (offStar, defStar) {
    var rtg = this.cfg.rtg;
    if (this.offenseTeam() !== this.userSide && this.defenseTeam() !== this.userSide) return;
    var me = rtg.player;
    var arr = D.POS_INFO[me.pos] && D.POS_INFO[me.pos].side === 'off' ? offStar : defStar;
    // find a matching-position slot to replace
    var idx = -1;
    for (var i = 0; i < arr.length; i++) { if (arr[i].pos === me.pos) { idx = i; break; } }
    if (idx === -1) idx = 0;
    arr[idx] = me;
    this._rtgPlayerId = me.id;
  };

  /* --------------------------- DEFENSE AI -------------------------------- */
  Engine.prototype._assignDefense = function () {
    var s = this.state;
    var def = s.players.filter(function (p) { return p.team === this.defenseTeam(); }, this);
    var off = s.players.filter(function (p) { return p.team === this.offenseTeam(); }, this);
    var receivers = off.filter(function (p) { return p.slot !== 'QB'; });
    var play = s.defPlay || D.DEF_PLAYS[0];
    def.forEach(function (d) { d.cover = null; d.blitz = false; d.zone = null; });

    var rusher = def.filter(function (d) { return d.slot === 'RUSH'; })[0];
    if (rusher) rusher.blitz = true;

    if (play.id === 'blitz') {
      def.filter(function (d) { return d.slot === 'MLB'; }).forEach(function (d) { d.blitz = true; });
    }
    if (play.id === 'zone' || play.id === 'prevent') {
      // Zone: assign vertical thirds/flats
      var zoners = def.filter(function (d) { return !d.blitz; });
      var zones = [{ x: 8, y: 5 }, { x: 8, y: 20 }, { x: 16, y: 12.5 }, { x: play.deep ? 24 : 14, y: 12.5 }];
      zoners.forEach(function (d, i) { d.zone = zones[i % zones.length]; });
    } else {
      // Man: cornerbacks/safety/MLB take receivers by proximity
      var coverers = def.filter(function (d) { return !d.blitz; });
      var pool = receivers.slice();
      coverers.forEach(function (d) {
        pool.sort(function (a, b) { return dist(d, a) - dist(d, b); });
        d.cover = pool.length ? pool.shift() : null;
      });
    }
  };

  /* ------------------------------ SNAP ----------------------------------- */
  Engine.prototype.snap = function () {
    var s = this.state;
    if (s.phase !== 'presnap') return;
    var off = s.players.filter(function (p) { return p.team === this.offenseTeam(); }, this);
    var qb = off.filter(function (p) { return p.slot === 'QB'; })[0];
    s.carrier = qb;
    qb.hasBall = true;
    s.ball = { x: qb.x, y: qb.y, inAir: false, target: null, from: null, to: null, t: 0, dur: 0 };
    s.phase = 'live';
    s.snapT = 0;
    s.playClock = 0;
    s.handoffDone = false;
    s.trickStage = 0;
    s.stats[this.offenseTeam()].plays++;
    // trick / run handoff timing
    var op = s.offPlay;
    s.autoHandoff = (op && (op.type === 'run' || op.type === 'trick'));
    this.onEvent({ type: 'snap' });
  };

  /* ------------------------------ THROW ---------------------------------- */
  // slot: 'WR1'|'WR2'|'RB'|'C'  (throw to that receiver)
  Engine.prototype.throwTo = function (slot) {
    var s = this.state;
    if (s.phase !== 'live' || !s.carrier || s.ball.inAir) return;
    var carrier = s.carrier;
    if (carrier.slot === 'QB' && D.POS_INFO.QB) { /* QB or trick passer */ }
    // Only the ball carrier who is a legal passer may throw, and only behind LOS-ish
    if (!carrier.data || carrier.pos === undefined) return;
    var off = s.players.filter(function (p) { return p.team === this.offenseTeam(); }, this);
    var target = off.filter(function (p) { return p.slot === slot; })[0];
    if (!target || target === carrier) return;
    // Center may catch; QB throws. Passing after crossing LOS not allowed (flag rule).
    var losX = s.losX;
    if (carrier.x > losX + 1.0 && !s.autoHandoff) { this._flash('No forward pass past the line!'); return; }

    // Lead the receiver
    var throwSpeed = 22; // yards/sec
    var lead = 0.35 + (99 - carrier.data.throw) / 200;
    var predicted = { x: target.x + target.vx * lead, y: target.y + target.vy * lead };
    predicted.x = clamp(predicted.x, 0, FIELD_LEN);
    predicted.y = clamp(predicted.y, 0, FIELD_WID);
    var d = dist(carrier, predicted);
    s.ball = {
      x: carrier.x, y: carrier.y, inAir: true,
      from: { x: carrier.x, y: carrier.y }, to: predicted,
      t: 0, dur: d / throwSpeed, thrower: carrier, targetSlot: slot,
      arcH: Math.min(3.5, d * 0.09)
    };
    carrier.hasBall = false;
    s.carrier = null;
    s.thrownTo = target;
    s.stats[this.offenseTeam()].pass++;
    this.onEvent({ type: 'throw', slot: slot });
  };

  // Handoff / pitch for runs & tricks
  Engine.prototype._doHandoff = function () {
    var s = this.state;
    var op = s.offPlay;
    if (!op || s.handoffDone) return;
    var off = s.players.filter(function (p) { return p.team === this.offenseTeam(); }, this);
    var carrierSlot = op.carrier;
    if (op.trick === 'reverse') carrierSlot = 'QB'; // QB hands to RB then RB to WR2 later
    var tgt = off.filter(function (p) { return p.slot === (op.carrier === 'QB' ? 'QB' : op.carrier); })[0];
    if (!tgt) return;
    if (op.carrier !== 'QB') {
      var qb = s.carrier;
      qb.hasBall = false;
      tgt.hasBall = true;
      s.carrier = tgt;
    }
    s.handoffDone = true;
  };

  /* ---------------------------- UPDATE LOOP ------------------------------ */
  Engine.prototype._update = function (dt) {
    var s = this.state;
    if (!s || s.phase !== 'live') return;
    s.snapT += dt;
    s.playClock += dt;

    var off = s.players.filter(function (p) { return p.team === this.offenseTeam(); }, this);
    var def = s.players.filter(function (p) { return p.team === this.defenseTeam(); }, this);

    // Auto handoff for run/trick shortly after snap
    if (s.autoHandoff && !s.handoffDone && s.snapT > 0.55) this._doHandoff();

    // Move receivers along routes
    off.forEach(function (p) {
      if (p === s.carrier) return;
      if (p.slot === 'QB' && !s.autoHandoff) { this._dropback(p, dt); return; }
      this._runRoute(p, dt);
    }, this);

    // Move carrier (user-controlled if on offense, else AI)
    if (s.carrier) {
      if (this.userOnOffense() && (s.carrier.slot === 'QB' || s.carrier.isUser || this._isUserCarrier(s.carrier))) {
        this._moveByInput(s.carrier, dt);
      } else if (this.userOnOffense()) {
        this._moveByInput(s.carrier, dt); // user always drives the ball carrier
      } else {
        this._aiCarrier(s.carrier, dt);
      }
      s.ball.x = s.carrier.x; s.ball.y = s.carrier.y;
    }

    // Ball in air
    if (s.ball && s.ball.inAir) this._updateBall(dt);

    // Defense AI (and user-controlled defender)
    def.forEach(function (d) {
      if (d.flagPulled) return;
      if (!this.userOnOffense() && d === s.userControlled) { this._moveByInput(d, dt); return; }
      this._aiDefender(d, dt);
    }, this);

    // Flag-pull checks (defender near carrier)
    if (s.carrier) this._checkFlagPull(def);

    // Out of bounds / scoring / end zone checks
    this._checkBoundaries();

    // Play clock too long with QB holding -> sack pressure handled by rushers; timeout safety
    if (s.playClock > 12 && s.carrier && s.carrier.slot === 'QB') {
      // scramble timeout: nothing, rushers will get him
    }
  };

  Engine.prototype._isUserCarrier = function () { return true; };

  Engine.prototype._dropback = function (qb, dt) {
    var s = this.state;
    if (this.userOnOffense() && qb === s.carrier) { this._moveByInput(qb, dt); return; }
    // AI QB: drop back slightly then throw to open man
    var target = { x: s.losX - 5, y: qb.y };
    this._seek(qb, target, dt, 0.7);
    if (s.snapT > 1.6 && !s.ball.inAir) this._aiThrow();
  };

  Engine.prototype._runRoute = function (p, dt) {
    var s = this.state;
    if (!p.route || p.route === 'block') {
      // Center may not block (rule). Others "block" = drift upfield slowly.
      if (p.pos !== 'C') this._seek(p, { x: p.x + 1, y: p.y }, dt, 0.4);
      return;
    }
    var wps = D.ROUTES[p.route];
    if (!wps) return;
    // mirror y by which side of field the receiver started
    var side = p.startSide || (p.startSide = (p.y < FIELD_WID / 2 ? -1 : 1), p.origin = { x: p.x, y: p.y }, p.startSide);
    var origin = p.origin;
    var wp = wps[Math.min(p.wp, wps.length - 1)];
    var tx = origin.x + wp.x;
    var ty = origin.y + wp.y * side;
    ty = clamp(ty, 1, FIELD_WID - 1);
    var target = { x: tx, y: ty };
    this._seek(p, target, dt, 1.0);
    if (dist(p, target) < 1.0 && p.wp < wps.length - 1) p.wp++;
    else if (dist(p, target) < 0.8 && p.wp >= wps.length - 1) {
      // continue straight for verticals
      if (p.route === 'go' || p.route === 'post' || p.route === 'corner' || p.route === 'wheel') {
        p.origin = { x: p.x, y: p.y }; // keep pushing
      }
    }
  };

  Engine.prototype._seek = function (p, target, dt, spdMul) {
    var spd = this.speedYds(p.data.speed) * (spdMul || 1);
    var dx = target.x - p.x, dy = target.y - p.y;
    var m = Math.hypot(dx, dy) || 1;
    p.vx = dx / m * spd; p.vy = dy / m * spd;
    p.x = clamp(p.x + p.vx * dt, 0, FIELD_LEN);
    p.y = clamp(p.y + p.vy * dt, 0, FIELD_WID);
    if (m > 0.05) p.ang = Math.atan2(dy, dx);
  };

  Engine.prototype._moveByInput = function (p, dt) {
    var i = this.input;
    var dx = 0, dy = 0;
    if (i.left) dx -= 1; if (i.right) dx += 1;
    if (i.up) dy -= 1; if (i.down) dy += 1;
    if (this.pointer && this.pointer.active) { dx = this.pointer.dx; dy = this.pointer.dy; }
    var m = Math.hypot(dx, dy);
    var sprint = i.sprint ? 1.12 : 1.0;
    var spd = this.speedYds(p.data.speed) * sprint;
    if (m > 0.05) {
      p.vx = dx / m * spd; p.vy = dy / m * spd;
      p.x = clamp(p.x + p.vx * dt, 0, FIELD_LEN);
      p.y = clamp(p.y + p.vy * dt, 0, FIELD_WID);
      p.ang = Math.atan2(dy, dx);
    } else { p.vx = 0; p.vy = 0; }
  };

  Engine.prototype._aiCarrier = function (p, dt) {
    // AI ball carrier: head toward end zone, avoid nearest defender
    var s = this.state;
    var goalX = GOAL_R + 3;
    var def = s.players.filter(function (d) { return d.team === this.defenseTeam() && !d.flagPulled; }, this);
    var nearest = null, nd = 999;
    def.forEach(function (d) { var dd = dist(d, p); if (dd < nd) { nd = dd; nearest = d; } });
    var ty = p.y;
    if (nearest && nd < 6) {
      // juke away laterally
      ty = p.y + (p.y < nearest.y ? -4 : 4);
      ty = clamp(ty, 2, FIELD_WID - 2);
    }
    this._seek(p, { x: goalX, y: ty }, dt, 1.0);
  };

  Engine.prototype._aiThrow = function () {
    var s = this.state;
    var off = s.players.filter(function (p) { return p.team === this.offenseTeam() && p.slot !== 'QB'; }, this);
    var def = s.players.filter(function (p) { return p.team === this.defenseTeam(); }, this);
    // pick most open receiver
    var best = null, bestSep = -1;
    off.forEach(function (r) {
      var sep = 99;
      def.forEach(function (d) { sep = Math.min(sep, dist(r, d)); });
      var downfield = r.x - s.losX;
      var score = sep + downfield * 0.2;
      if (score > bestSep) { bestSep = score; best = r; }
    });
    if (best) this.throwTo(best.slot);
  };

  Engine.prototype._aiDefender = function (d, dt) {
    var s = this.state;
    if (d.blitz && (!s.carrier || s.carrier.slot === 'QB' || s.ball.inAir === false)) {
      // rush the passer / chase carrier
      var tgt = s.carrier || (s.thrownTo || { x: s.losX - 4, y: FIELD_WID / 2 });
      this._seek(d, tgt, dt, 1.0);
      return;
    }
    if (s.ball && s.ball.inAir) {
      // break on the ball
      this._seek(d, s.ball.to, dt, 1.05);
      return;
    }
    if (s.carrier && s.carrier.slot !== 'QB') {
      // pursue the ball carrier
      this._seek(d, s.carrier, dt, 1.0);
      return;
    }
    if (d.cover) {
      // man coverage: shadow, stay goal-side
      var c = d.cover;
      var target = { x: c.x + 0.6, y: c.y };
      this._seek(d, target, dt, 0.98);
    } else if (d.zone) {
      this._seek(d, { x: s.losX + d.zone.x, y: d.zone.y }, dt, 0.85);
    } else {
      // spy the QB
      this._seek(d, { x: s.losX + 4, y: FIELD_WID / 2 }, dt, 0.6);
    }
  };

  Engine.prototype._updateBall = function (dt) {
    var s = this.state, b = s.ball;
    b.t += dt;
    var t = clamp(b.t / b.dur, 0, 1);
    b.x = lerp(b.from.x, b.to.x, t);
    b.y = lerp(b.from.y, b.to.y, t);
    b.z = Math.sin(t * Math.PI) * b.arcH;
    if (t >= 1) { this._resolveCatch(); }
  };

  Engine.prototype._resolveCatch = function () {
    var s = this.state, b = s.ball;
    var receiver = s.thrownTo;
    b.inAir = false;
    var off = s.players.filter(function (p) { return p.team === this.offenseTeam(); }, this);
    var def = s.players.filter(function (p) { return p.team === this.defenseTeam(); }, this);
    // nearest defender to the catch point
    var pt = { x: b.x, y: b.y };
    var nearDef = null, nd = 999;
    def.forEach(function (d) { var dd = dist(d, pt); if (dd < nd) { nd = dd; nearDef = d; } });
    var recDist = receiver ? dist(receiver, pt) : 99;

    // Catch probability
    var base = receiver ? receiver.data.catch / 100 : 0;
    var sepPenalty = clamp((2.2 - nd) * 0.22, 0, 0.55);
    var reach = clamp(1 - recDist / 3.2, 0, 1);
    var pCatch = clamp(base * reach - sepPenalty, 0.03, 0.97);

    var roll = Math.random();
    if (recDist > 3.5 || (receiver && receiver.slot === undefined)) {
      this._incomplete('Incomplete', pt); return;
    }
    if (roll < pCatch) {
      // caught
      receiver.hasBall = true;
      s.carrier = receiver;
      s.ball.x = receiver.x; s.ball.y = receiver.y;
      this._flash('Caught by ' + receiver.last + '!');
      this.onEvent({ type: 'catch', player: receiver });
    } else if (nd < 1.4 && roll < pCatch + (nearDef ? nearDef.data.pull / 400 : 0)) {
      // interception
      this._turnover('INTERCEPTED by ' + nearDef.last + '!', nearDef);
    } else {
      this._incomplete('Incomplete pass', pt);
    }
  };

  Engine.prototype._checkFlagPull = function (def) {
    var s = this.state;
    var c = s.carrier;
    if (!c || c.slot === 'QB' && s.ball && s.ball.inAir) return;
    for (var i = 0; i < def.length; i++) {
      var d = def[i];
      if (d.flagPulled) continue;
      var dd = dist(d, c);
      // pull range scales slightly with defender pull rating
      var range = 1.05 + d.data.pull / 350;
      if (dd < range) {
        // pull success chance vs carrier agility (jukes)
        var evade = c.data.agi / 260;
        if (Math.random() > evade) {
          this._flagPull(d, c);
          return;
        }
      }
    }
  };

  Engine.prototype._flagPull = function (defender, carrier) {
    var s = this.state;
    s.stats[this.defenseTeam()].tackles++;
    // spot the ball where the carrier is
    var spotX = carrier.x;
    this.anim.push({ type: 'flag', x: carrier.x, y: carrier.y, t: 0, dur: 0.7,
      color: this._jerseyColor(carrier.team)[0] });
    this._flash(defender.last + ' pulls the flag!');
    this.onEvent({ type: 'flagpull', defender: defender, carrier: carrier });
    this._endPlay(spotX, false);
  };

  Engine.prototype._checkBoundaries = function () {
    var s = this.state;
    var c = s.carrier;
    if (!c) return;
    // Touchdown
    if (c.x >= GOAL_R) { this._touchdown(); return; }
    // Safety (tackled in own end zone)
    if (c.x <= GOAL_L && s.snapT > 0.3) { this._safety(); return; }
    // Out of bounds
    if (c.y <= 0.4 || c.y >= FIELD_WID - 0.4) { this._endPlay(c.x, false); }
  };

  /* --------------------------- PLAY RESOLUTION --------------------------- */
  Engine.prototype._endPlay = function (spotX, noGain) {
    var s = this.state;
    if (s.phase === 'dead') return;
    s.phase = 'dead';
    var off = this.offenseTeam();
    // yards gained
    var newYTG = clamp(GOAL_R - spotX, 0, 50);
    var gained = s.yardsToGoal - newYTG;
    if (s.offPlay && (s.offPlay.type === 'run' || s.offPlay.type === 'trick')) s.stats[off].rush += Math.max(0, Math.round(gained));
    s.yardsToGoal = newYTG;

    // crossed midfield?
    if (!s.crossedMid && s.yardsToGoal <= MIDFIELD - GOAL_L + 0.001 && spotX >= MIDFIELD) {
      // reached/past midfield -> fresh set to score
    }
    var reachedMid = spotX >= MIDFIELD;
    setTimeout(this._advanceDown.bind(this, gained, reachedMid), 900);
  };

  Engine.prototype._advanceDown = function (gained, reachedMid) {
    var s = this.state;
    this._runClock(28 + Math.round(Math.random() * 8));
    if (s.gameOver) return;

    if (!s.crossedMid) {
      if (reachedMid) {
        s.crossedMid = true; s.down = 1;
        this._flash('First down — past midfield!');
      } else {
        s.down++;
        if (s.down > 4) return this._turnoverOnDowns();
      }
    } else {
      s.down++;
      if (s.down > 4) return this._turnoverOnDowns();
    }
    this._nextSnap();
  };

  Engine.prototype._incomplete = function (msg, pt) {
    this._flash(msg);
    this.anim.push({ type: 'incomplete', x: pt.x, y: pt.y, t: 0, dur: 0.6 });
    var s = this.state;
    this.onEvent({ type: 'incomplete' });
    s.phase = 'dead';
    // no yardage change; advance down (no midfield gain)
    setTimeout(this._advanceDown.bind(this, 0, false), 800);
  };

  Engine.prototype._turnover = function (msg, byPlayer) {
    this._flash(msg);
    var s = this.state;
    this.onEvent({ type: 'turnover' });
    s.phase = 'dead';
    setTimeout(function () {
      s.possession = this.defenseTeam();
      s.yardsToGoal = clamp(50 - s.yardsToGoal, 8, 45);
      s.down = 1; s.crossedMid = false;
      this._runClock(20);
      this._nextSnap();
    }.bind(this), 1200);
  };

  Engine.prototype._turnoverOnDowns = function () {
    this._flash('Turnover on downs!');
    var s = this.state;
    setTimeout(function () {
      s.possession = this.defenseTeam();
      s.yardsToGoal = clamp(50 - s.yardsToGoal, 8, 45);
      s.down = 1; s.crossedMid = false;
      this._nextSnap();
    }.bind(this), 1200);
  };

  Engine.prototype._touchdown = function () {
    var s = this.state;
    var off = this.offenseTeam();
    s.phase = 'dead';
    s.score[off] += 6;
    s.stats[off].td++;
    this._flash('TOUCHDOWN ' + s[off].abbr + '!  🎉');
    this.anim.push({ type: 'td', t: 0, dur: 1.4 });
    this.onEvent({ type: 'touchdown', team: off });
    setTimeout(function () {
      // auto extra point (kick-style) success ~ 92%
      if (Math.random() < 0.92) { s.score[off] += 1; this._flash('Extra point good!'); }
      else this._flash('Extra point missed!');
      this._runClock(15);
      setTimeout(function () {
        s.possession = this.defenseTeam();
        s.yardsToGoal = 45; s.down = 1; s.crossedMid = false;
        this._nextSnap();
      }.bind(this), 900);
    }.bind(this), 1500);
  };

  Engine.prototype._safety = function () {
    var s = this.state;
    var def = this.defenseTeam();
    s.score[def] += 2;
    this._flash('SAFETY!');
    s.phase = 'dead';
    setTimeout(function () {
      s.possession = def; s.yardsToGoal = 45; s.down = 1; s.crossedMid = false;
      this._nextSnap();
    }.bind(this), 1400);
  };

  Engine.prototype._nextSnap = function () {
    var s = this.state;
    if (s.gameOver) return;
    s.offPlay = null; s.defPlay = null;
    s.phase = 'playcall';
    s.thrownTo = null;
    this.onEvent({ type: 'playcall', offense: this.offenseTeam() });
  };

  /* ------------------------------- CLOCK --------------------------------- */
  Engine.prototype._runClock = function (sec) {
    var s = this.state;
    s.clock -= sec;
    while (s.clock <= 0) {
      if (s.quarter >= s.quarters) {
        if (s.score.home === s.score.away) {
          s.overtime = true; s.quarter++; s.clock = 90;
          this._flash('OVERTIME!');
        } else { s.clock = 0; this._gameOver(); return; }
      } else {
        s.quarter++; s.clock += (this.cfg.quarterLen || 150);
        this._flash('End of Q' + (s.quarter - 1));
      }
    }
  };

  Engine.prototype._gameOver = function () {
    var s = this.state;
    s.gameOver = true; s.phase = 'final';
    var win = s.score.home > s.score.away ? 'home' : 'away';
    this.onEvent({ type: 'gameover', winner: win, score: { home: s.score.home, away: s.score.away } });
  };

  /* ----------------------------- PLAY CALL ------------------------------- */
  Engine.prototype.callOffense = function (play) {
    var s = this.state;
    s.offPlay = play;
    // CPU picks defense
    s.defPlay = D.DEF_PLAYS[Math.floor(Math.random() * D.DEF_PLAYS.length)];
    this.setupFormation();
  };
  Engine.prototype.callDefense = function (play) {
    var s = this.state;
    s.defPlay = play;
    // CPU picks offense
    s.offPlay = D.PLAYS[Math.floor(Math.random() * D.PLAYS.length)];
    this.setupFormation();
  };

  /* ------------------------------ HELPERS -------------------------------- */
  Engine.prototype._flash = function (msg) {
    this.state.message = msg;
    this.state.flashUntil = this._now() + 1500;
  };
  Engine.prototype._now = function () { return this._t || 0; };
  Engine.prototype._nearestDefenderToBall = function () {
    var s = this.state;
    var def = s.players.filter(function (p) { return p.team === this.defenseTeam(); }, this);
    var ref = s.carrier || { x: s.losX, y: FIELD_WID / 2 };
    var best = def[0], bd = 999;
    def.forEach(function (d) { var dd = dist(d, ref); if (dd < bd) { bd = dd; best = d; } });
    return best;
  };
  Engine.prototype.switchDefender = function () {
    if (this.userOnOffense()) return;
    var s = this.state;
    s.userControlled = this._nearestDefenderToBall();
  };
  Engine.prototype.pullAction = function () {
    // manual pull attempt for user-controlled defender
    var s = this.state;
    if (this.userOnOffense() || !s.carrier || !s.userControlled) return;
    var d = s.userControlled, c = s.carrier;
    if (dist(d, c) < 1.6) this._flagPull(d, c);
  };

  Engine.prototype._jerseyColor = function (team) {
    var s = this.state;
    return team === 'home' ? s.homeJersey.colors : s.awayJersey.colors;
  };

  /* ------------------------------ RENDER --------------------------------- */
  Engine.prototype._resize = function () {
    var c = this.canvas;
    var rect = c.getBoundingClientRect();
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    c.width = Math.max(320, rect.width) * dpr;
    c.height = Math.max(200, rect.height) * dpr;
    this.dpr = dpr;
  };

  Engine.prototype._px = function (fx, fy) {
    // Field to pixel. Field drawn horizontally, letterboxed.
    var W = this.canvas.width, H = this.canvas.height;
    var pad = 8 * this.dpr;
    var sx = (W - pad * 2) / FIELD_LEN;
    var sy = (H - pad * 2) / FIELD_WID;
    var sc = Math.min(sx, sy);
    var ox = (W - sc * FIELD_LEN) / 2;
    var oy = (H - sc * FIELD_WID) / 2;
    this._sc = sc; this._ox = ox; this._oy = oy;
    return { x: ox + fx * sc, y: oy + fy * sc, sc: sc };
  };

  Engine.prototype._render = function () {
    var ctx = this.ctx, s = this.state;
    if (!s) return;
    var W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Stadium backdrop (fills letterbox around the field)
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a2013'); bg.addColorStop(0.5, '#06180c'); bg.addColorStop(1, '#0a2013');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    var p0 = this._px(0, 0), p1 = this._px(FIELD_LEN, FIELD_WID);
    var sc = this._sc;
    // Crowd bands + sideline shadow just outside the field
    var band = Math.max(6, (p0.y) * 0.6);
    for (var cb = 0; cb < 2; cb++) {
      var by = cb === 0 ? Math.max(0, p0.y - band) : p1.y;
      var grd = ctx.createLinearGradient(0, by, 0, by + band);
      grd.addColorStop(0, cb === 0 ? '#0c2a18' : '#123320');
      grd.addColorStop(1, cb === 0 ? '#123320' : '#0c2a18');
      ctx.fillStyle = grd; ctx.fillRect(p0.x, by, p1.x - p0.x, band);
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 12 * this.dpr;
    ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
    ctx.restore();

    // Grass
    var fw = p1.x - p0.x, fh = p1.y - p0.y;
    for (var i = 0; i < FIELD_LEN; i += 5) {
      ctx.fillStyle = ((i / 5) % 2 === 0) ? '#2f8f3f' : '#2b8339';
      var a = this._px(i, 0), b = this._px(i + 5, FIELD_WID);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    }
    // End zones
    ctx.save();
    ctx.globalAlpha = 0.85;
    var homeC = s.homeJersey.colors[0], awayC = s.awayJersey.colors[0];
    var lz = this._px(0, 0), lze = this._px(EZ, FIELD_WID);
    ctx.fillStyle = shade(awayC, -10); ctx.fillRect(lz.x, lz.y, lze.x - lz.x, lze.y - lz.y);
    var rz = this._px(GOAL_R, 0), rze = this._px(FIELD_LEN, FIELD_WID);
    ctx.fillStyle = shade(homeC, -10); ctx.fillRect(rz.x, rz.y, rze.x - rz.x, rze.y - rz.y);
    ctx.restore();

    // Yard lines every 5 yards
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, sc * 0.08);
    for (var y = GOAL_L; y <= GOAL_R; y += 5) {
      var t = this._px(y, 0), bt = this._px(y, FIELD_WID);
      ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(bt.x, bt.y); ctx.stroke();
    }
    // Goal lines & midfield emphasized
    [GOAL_L, GOAL_R, MIDFIELD].forEach(function (gx, k) {
      var t = this._px(gx, 0), bt = this._px(gx, FIELD_WID);
      ctx.strokeStyle = k === 2 ? 'rgba(255,230,120,0.9)' : 'rgba(255,255,255,0.95)';
      ctx.lineWidth = Math.max(1.5, sc * 0.14);
      ctx.beginPath(); ctx.moveTo(t.x, t.y); ctx.lineTo(bt.x, bt.y); ctx.stroke();
    }, this);

    // Line of scrimmage + line to gain
    if (s.losX != null && (s.phase === 'presnap' || s.phase === 'live' || s.phase === 'playcall')) {
      var l = this._px(s.losX, 0), lb = this._px(s.losX, FIELD_WID);
      ctx.strokeStyle = 'rgba(60,130,255,0.95)'; ctx.lineWidth = Math.max(1.5, sc * 0.12);
      ctx.beginPath(); ctx.moveTo(l.x, l.y); ctx.lineTo(lb.x, lb.y); ctx.stroke();
      var ltg = s.crossedMid ? GOAL_R : MIDFIELD;
      var g = this._px(ltg, 0), gb = this._px(ltg, FIELD_WID);
      ctx.strokeStyle = 'rgba(255,220,40,0.9)'; ctx.setLineDash([6 * this.dpr, 4 * this.dpr]);
      ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(gb.x, gb.y); ctx.stroke(); ctx.setLineDash([]);
    }

    // Route preview during presnap (offense)
    if (s.phase === 'presnap' && this.userOnOffense()) this._drawRoutes(ctx);

    // Players
    s.players.forEach(function (p) { this._drawPlayer(ctx, p); }, this);

    // Ball in air
    if (s.ball && s.ball.inAir) {
      var bp = this._px(s.ball.x, s.ball.y);
      var zr = (s.ball.z || 0) * sc * 0.4;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(bp.x, bp.y, sc * 0.35, sc * 0.2, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#7a4a20';
      ctx.beginPath(); ctx.ellipse(bp.x, bp.y - zr, sc * 0.42, sc * 0.26, 0.4, 0, 7); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = sc * 0.05;
      ctx.beginPath(); ctx.moveTo(bp.x - sc * 0.2, bp.y - zr); ctx.lineTo(bp.x + sc * 0.2, bp.y - zr); ctx.stroke();
      ctx.restore();
    }

    // Animations (flag pulls etc.)
    this._drawAnims(ctx);

    // Flash message
    if (s.message && this._t < s.flashUntil) {
      ctx.save();
      ctx.font = 'bold ' + (Math.max(16, sc * 1.3)) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 4 * this.dpr; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(s.message, W / 2, oy(this) + 34 * this.dpr);
      ctx.fillStyle = '#fff';
      ctx.fillText(s.message, W / 2, oy(this) + 34 * this.dpr);
      ctx.restore();
    }
    function oy(e) { return e._oy; }
  };

  Engine.prototype._drawRoutes = function (ctx) {
    var s = this.state, sc = this._sc;
    var off = s.players.filter(function (p) { return p.team === this.offenseTeam() && p.route && p.route !== 'block'; }, this);
    off.forEach(function (p) {
      var wps = D.ROUTES[p.route]; if (!wps) return;
      var side = (p.y < FIELD_WID / 2 ? -1 : 1);
      var start = this._px(p.x, p.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = Math.max(1, sc * 0.06);
      ctx.setLineDash([4 * this.dpr, 3 * this.dpr]);
      ctx.beginPath(); ctx.moveTo(start.x, start.y);
      wps.forEach(function (w) {
        var pt = this._px(p.x + w.x, clamp(p.y + w.y * side, 1, FIELD_WID - 1));
        ctx.lineTo(pt.x, pt.y);
      }, this);
      ctx.stroke(); ctx.setLineDash([]);
    }, this);
  };

  Engine.prototype._drawPlayer = function (ctx, p) {
    var s = this.state, sc = this._sc;
    var pp = this._px(p.x, p.y);
    var r = sc * 0.62;
    var isOff = p.team === this.offenseTeam();
    var jersey = p.team === 'home' ? s.homeJersey.colors : s.awayJersey.colors;
    var primary = jersey[0], secondary = jersey[1];

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(pp.x, pp.y + r * 0.55, r * 0.9, r * 0.45, 0, 0, 7); ctx.fill();

    // body
    ctx.save();
    ctx.beginPath(); ctx.arc(pp.x, pp.y, r, 0, 7);
    ctx.fillStyle = primary; ctx.fill();
    ctx.lineWidth = Math.max(1, sc * 0.09);
    ctx.strokeStyle = (p === s.userControlled) ? '#ffe14d' : secondary;
    if (p === s.userControlled) ctx.lineWidth = Math.max(2, sc * 0.16);
    ctx.stroke();

    // direction wedge
    ctx.fillStyle = secondary;
    ctx.beginPath();
    ctx.moveTo(pp.x + Math.cos(p.ang) * r * 0.9, pp.y + Math.sin(p.ang) * r * 0.9);
    ctx.lineTo(pp.x + Math.cos(p.ang + 2.5) * r * 0.5, pp.y + Math.sin(p.ang + 2.5) * r * 0.5);
    ctx.lineTo(pp.x + Math.cos(p.ang - 2.5) * r * 0.5, pp.y + Math.sin(p.ang - 2.5) * r * 0.5);
    ctx.closePath(); ctx.fill();

    // flag (two ribbons at hip) — removed when pulled
    if (!p.flagPulled && isOff) {
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = Math.max(1, sc * 0.08);
      ctx.beginPath();
      ctx.moveTo(pp.x - r * 0.7, pp.y); ctx.lineTo(pp.x - r * 1.15, pp.y - r * 0.3);
      ctx.moveTo(pp.x - r * 0.7, pp.y + r * 0.2); ctx.lineTo(pp.x - r * 1.15, pp.y + r * 0.5);
      ctx.stroke();
    }

    // ball indicator
    if (p.hasBall || (s.carrier === p)) {
      ctx.fillStyle = '#7a4a20';
      ctx.beginPath(); ctx.ellipse(pp.x + r * 0.8, pp.y - r * 0.6, sc * 0.28, sc * 0.17, 0.4, 0, 7); ctx.fill();
    }
    ctx.restore();

    // Madden-style last-name nameplate
    var fs = Math.max(8, sc * 0.62);
    ctx.font = 'bold ' + fs + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    var label = p.last.toUpperCase();
    var tw = ctx.measureText(label).width;
    var plateY = pp.y - r - fs * 0.9;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, pp.x - tw / 2 - 3 * this.dpr, plateY - fs * 0.85, tw + 6 * this.dpr, fs * 1.15, 3 * this.dpr);
    ctx.fill();
    ctx.fillStyle = (p === s.userControlled) ? '#ffe14d' : '#fff';
    ctx.fillText(label, pp.x, plateY);
    // small OVR/pos
    if (sc > 9) {
      ctx.font = (fs * 0.7) + 'px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText(p.pos + ' ' + p.ovr, pp.x, plateY - fs * 0.95);
    }
  };

  Engine.prototype._drawAnims = function (ctx) {
    var sc = this._sc;
    for (var i = this.anim.length - 1; i >= 0; i--) {
      var a = this.anim[i];
      a.t += this._dt || 0.016;
      var prog = a.t / a.dur;
      if (prog >= 1) { this.anim.splice(i, 1); continue; }
      if (a.type === 'flag') {
        var pp = this._px(a.x, a.y);
        var fly = prog * sc * 3;
        ctx.save();
        ctx.globalAlpha = 1 - prog;
        ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = sc * 0.18;
        ctx.beginPath();
        ctx.moveTo(pp.x, pp.y - fly);
        ctx.lineTo(pp.x + Math.cos(prog * 10) * sc * 0.6, pp.y - fly - sc * 0.5);
        ctx.stroke();
        ctx.font = 'bold ' + (sc * 1.1) + 'px system-ui';
        ctx.textAlign = 'center'; ctx.fillStyle = '#ffd23f';
        ctx.fillText('FLAG!', pp.x, pp.y - fly - sc);
        ctx.restore();
      } else if (a.type === 'incomplete') {
        var q = this._px(a.x, a.y);
        ctx.save(); ctx.globalAlpha = 1 - prog;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = sc * 0.12;
        var rr = sc * (0.5 + prog);
        ctx.beginPath(); ctx.arc(q.x, q.y, rr, 0, 7); ctx.stroke();
        ctx.restore();
      } else if (a.type === 'td') {
        ctx.save();
        ctx.globalAlpha = Math.sin(prog * Math.PI) * 0.5;
        ctx.fillStyle = '#ffd23f';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.restore();
      }
    }
  };

  /* ------------------------------ LOOP ----------------------------------- */
  Engine.prototype.start = function () {
    var self = this;
    this._resize();
    global.addEventListener('resize', this._onResize = function () { self._resize(); });
    function frame(t) {
      if (!self.lastT) self.lastT = t;
      var dt = Math.min(0.05, (t - self.lastT) / 1000);
      self.lastT = t; self._t = t; self._dt = dt;
      self._update(dt);
      self._render();
      self.raf = global.requestAnimationFrame(frame);
    }
    this.raf = global.requestAnimationFrame(frame);
  };
  Engine.prototype.stop = function () {
    if (this.raf) global.cancelAnimationFrame(this.raf);
    this.raf = null; this.lastT = 0;
    if (this._onResize) global.removeEventListener('resize', this._onResize);
    this._unbindInput();
  };

  /* ------------------------------ INPUT ---------------------------------- */
  Engine.prototype._bindInput = function () {
    var self = this;
    this._kd = function (e) {
      var k = e.key.toLowerCase();
      if (['arrowup','arrowdown','arrowleft','arrowright',' '].indexOf(k) >= 0) e.preventDefault();
      if (k === 'w' || k === 'arrowup') self.input.up = true;
      if (k === 's' || k === 'arrowdown') self.input.down = true;
      if (k === 'a' || k === 'arrowleft') self.input.left = true;
      if (k === 'd' || k === 'arrowright') self.input.right = true;
      if (k === 'shift') self.input.sprint = true;
      if (k === ' ' || k === 'enter') self.action('primary');
      if (k === '1') self.action('r1'); if (k === '2') self.action('r2');
      if (k === '3') self.action('r3'); if (k === '4') self.action('r4');
      if (k === 'q') self.action('switch');
      if (k === 'e') self.action('pull');
    };
    this._ku = function (e) {
      var k = e.key.toLowerCase();
      if (k === 'w' || k === 'arrowup') self.input.up = false;
      if (k === 's' || k === 'arrowdown') self.input.down = false;
      if (k === 'a' || k === 'arrowleft') self.input.left = false;
      if (k === 'd' || k === 'arrowright') self.input.right = false;
      if (k === 'shift') self.input.sprint = false;
    };
    global.addEventListener('keydown', this._kd);
    global.addEventListener('keyup', this._ku);
  };
  Engine.prototype._unbindInput = function () {
    global.removeEventListener('keydown', this._kd);
    global.removeEventListener('keyup', this._ku);
  };

  // Unified action dispatch (used by keys and on-screen buttons)
  Engine.prototype.action = function (a) {
    var s = this.state; if (!s) return;
    if (s.phase === 'presnap' && a === 'primary') { this.snap(); return; }
    if (s.phase === 'live') {
      if (this.userOnOffense()) {
        if (a === 'r1') this.throwTo('WR1');
        if (a === 'r2') this.throwTo('WR2');
        if (a === 'r3') this.throwTo('RB');
        if (a === 'r4') this.throwTo('C');
      } else {
        if (a === 'switch' || a === 'primary') this.switchDefender();
        if (a === 'pull' || a === 'r1') this.pullAction();
      }
    }
  };

  // Virtual joystick input from UI
  Engine.prototype.setStick = function (dx, dy, active) {
    this.pointer = { dx: dx, dy: dy, active: active };
  };

  /* ----------------------------- UTILITIES ------------------------------- */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function shade(hex, amt) {
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    var r = clamp(parseInt(c.substr(0,2),16) + amt, 0, 255);
    var g = clamp(parseInt(c.substr(2,2),16) + amt, 0, 255);
    var b = clamp(parseInt(c.substr(4,2),16) + amt, 0, 255);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  Engine.FIELD = { LEN: FIELD_LEN, WID: FIELD_WID, EZ: EZ, GOAL_L: GOAL_L, GOAL_R: GOAL_R, MID: MIDFIELD };
  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.Engine = Engine;
})(window);
