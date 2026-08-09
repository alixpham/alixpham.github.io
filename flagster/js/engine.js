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

  // How close a player must get to a drawn waypoint before it counts as reached.
  var SLASH_REACH = 1.1;                 // yards
  var SLASH_MAX = 80;                    // waypoints; a scribble can't run forever
  var PLAY_CLOCK = 25;                   // seconds on the play clock pre-snap
  var AI_JUKE_PER_SEC = 2.2;             // AI escape attempts per second, frame-rate free
  var AI_SCRAMBLE_AT = 3.4;              // seconds holding the ball before a QB tucks and runs
  var AI_MIN_SEP = 2.2;                  // yards of separation a CPU QB wants before throwing
  var AI_FORCE_THROW_AT = 3.0;           // ...unless it's been this long, then take what's there

  /* Difficulty presets. The game shipped at roughly "All-Pro" and was brutal:
     defenders matched your speed and the flag came off the instant they
     touched you. Rookie is now the default. */
  var DIFFICULTY = {
    rookie: { name: 'Rookie', defSpeed: 0.84, pullTime: 1.05, catchBonus: 0.20, intScale: 0.45, jukeCd: 1.1 },
    pro:    { name: 'Pro',    defSpeed: 0.93, pullTime: 0.72, catchBonus: 0.10, intScale: 0.75, jukeCd: 1.5 },
    allpro: { name: 'All-Pro',defSpeed: 1.00, pullTime: 0.50, catchBonus: 0.00, intScale: 1.00, jukeCd: 2.0 }
  };
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
    this.slash = null;        // { owner, pts[] } — a route drawn with a slash
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
    this.difficulty = DIFFICULTY[cfg.difficulty] || DIFFICULTY.rookie;
    this.demo = !!cfg.demo;              // CPU vs CPU attract/demo mode
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
    if (this.demo) {
      s.userControlled = null;           // demo mode: the CPU plays both sides
    } else if (this.userOnOffense()) {
      s.userControlled = players.filter(function (p) { return p.slot === 'QB' && p.team === this.offenseTeam(); }, this)[0];
    } else {
      s.userControlled = this._nearestDefenderToBall();
    }
    s.phase = 'presnap';
    s.playClockLeft = PLAY_CLOCK;        // fresh 25 on every new down
    this.clearSlash();
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
      jukeCd: 0, jukeFx: 0, jukeCount: 0, stun: 0, jukeImpT: 0, stam: 1,
      cover: null, isUser: false, animPhase: 0,
      pos: playerData.pos, last: playerData.last, ovr: playerData.ovr, num: playerData.num
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
    // Your number could already be on someone else's back in this unit; the
    // squad was numbered without knowing you'd be added to it.
    var clash = arr.some(function (p, i) { return i !== idx && p && p.num === me.num; });
    if (clash) {
      var used = {};
      arr.forEach(function (p, i) { if (i !== idx && p) used[p.num] = true; });
      for (var n = 1; n < 100; n++) if (!used[n]) { me.num = n; break; }
    }
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
    if (s.phase !== 'live' || !s.carrier || s.ball.inAir || s.pendingThrow) return;
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
    /* WIND UP, then release. The ball used to become airborne on the same
       frame the button was pressed, while the throw animation it is supposed
       to come out of runs for 1.10s — so the pass was ten yards downfield
       before the arm had come through, and the quarterback mimed a throw at
       empty air behind it. The ball now leaves at RELEASE_AT through the clip,
       which is where the hand passes the ear.

       This is a real wind-up, not a cosmetic delay: the quarterback still has
       the ball during it, so a defender who gets there first takes them down
       before the pass gets out. That is the correct outcome, and it is what
       makes pressure mean anything. */
    s.pendingThrow = { slot: slot, target: target, t: 0, dur: THROW_WINDUP, thrower: carrier };
    this.onEvent({ type: 'windup', slot: slot });
  };

  var THROW_CLIP = 1.10;                 // seconds, matches the baked Throw clip
  var RELEASE_AT = 0.34;                 // fraction of the clip where the ball leaves
  var THROW_WINDUP = THROW_CLIP * RELEASE_AT;

  /* Fire the pass the wind-up was building to. */
  Engine.prototype._releaseThrow = function () {
    var s = this.state;
    var pt = s.pendingThrow;
    s.pendingThrow = null;
    if (!pt) return;
    var carrier = pt.thrower, target = pt.target;
    // The play can move underneath a wind-up: a sack, a fumble of possession,
    // or the target's flag coming off. Any of those and the pass never happens.
    if (s.phase !== 'live' || s.carrier !== carrier || carrier.flagPulled) return;
    if (!target || target.flagPulled) return;

    var throwSpeed = 22;
    /* Lead the receiver to where they will BE when the ball arrives. The lead
       used to be a flat 0.35-0.57s regardless of distance, while a 15-yard
       ball is in the air 0.68s and a deep one well over a second — so every
       pass was thrown behind a running receiver, and the deeper it went the
       further behind it landed. Solve for the intercept instead: guess the
       flight time, move the receiver along it, re-time, twice more. */
    var t = dist(carrier, target) / throwSpeed;
    var px = target.x, py = target.y;
    for (var it = 0; it < 3; it++) {
      px = target.x + (target.vx || 0) * t;
      py = target.y + (target.vy || 0) * t;
      t = Math.hypot(px - carrier.x, py - carrier.y) / throwSpeed;
    }
    // A weaker arm misses the spot; a 99 is nearly exact.
    var err = (1 - clamp(carrier.data.throw, 40, 99) / 110) * 2.2;
    px += (Math.random() * 2 - 1) * err;
    py += (Math.random() * 2 - 1) * err;
    var predicted = { x: clamp(px, 0, FIELD_LEN), y: clamp(py, 0, FIELD_WID) };
    var d = dist(carrier, predicted);
    s.ball = {
      x: carrier.x, y: carrier.y, inAir: true,
      from: { x: carrier.x, y: carrier.y }, to: predicted,
      t: 0, dur: d / throwSpeed, thrower: carrier, targetSlot: pt.slot,
      arcH: Math.min(3.5, d * 0.09)
    };
    carrier.hasBall = false;
    s.carrier = null;
    s.thrownTo = target;
    s.stats[this.offenseTeam()].pass++;
    this.onEvent({ type: 'throw', slot: pt.slot });
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
    if (!s) return;

    /* PLAY CLOCK. Counts down while the offense stands over the ball. Running
       it out snaps the ball rather than flagging delay of game: this is a
       5v5 arcade game with no penalty system to hang a flag off, and a dead
       stop with no way to resume would be worse than a rushed snap. */
    if (s.phase === 'presnap') {
      s.playClockLeft = Math.max(0, (s.playClockLeft == null ? PLAY_CLOCK : s.playClockLeft) - dt);
      if (s.playClockLeft <= 0) { this._flash('Play clock — snap!'); this.snap(); }
    } else if (s.phase !== 'live') {
      s.playClockLeft = PLAY_CLOCK;
    }

    if (s.phase !== 'live') return;
    s.snapT += dt;
    s.playClock += dt;
    this._updateStamina(dt);
    this._updateTimers(dt);

    // Wind-up in flight: the arm is coming through, the ball is still in hand.
    if (s.pendingThrow) {
      s.pendingThrow.t += dt;
      if (s.pendingThrow.t >= s.pendingThrow.dur) this._releaseThrow();
    }

    var off = s.players.filter(function (p) { return p.team === this.offenseTeam(); }, this);
    var def = s.players.filter(function (p) { return p.team === this.defenseTeam(); }, this);

    // Auto handoff for run/trick shortly after snap
    if (s.autoHandoff && !s.handoffDone && s.snapT > 0.55) this._doHandoff();

    // Move receivers along routes
    off.forEach(function (p) {
      if (p === s.carrier) return;
      /* The ball is in the air and it is coming to you: go and get it. The
         defence has always broken on the throw — _aiDefender seeks ball.to the
         moment it is airborne — but the receiver it was thrown to just kept
         running the route they were handed, so the only player NOT playing the
         ball was the one it was aimed at. Any adjustment after the release
         (a cut, a shove, coverage) left them stranded from the catch point and
         the pass fell incomplete. */
      if (s.ball && s.ball.inAir && s.thrownTo === p) { this._seek(p, s.ball.to, dt, 1.05); return; }
      if (p.slot === 'QB' && !s.autoHandoff) { this._dropback(p, dt); return; }
      this._runRoute(p, dt);
    }, this);

    // Move carrier (user-controlled if on offense, else AI)
    if (s.carrier) {
      if (this.demo) {
        this._aiQBOrCarrier(s.carrier, dt);
      } else if (this.userOnOffense() && (s.carrier.slot === 'QB' || s.carrier.isUser || this._isUserCarrier(s.carrier))) {
        this._moveByInput(s.carrier, dt);
      } else if (this.userOnOffense()) {
        this._moveByInput(s.carrier, dt); // user always drives the ball carrier
      } else {
        this._aiQBOrCarrier(s.carrier, dt);
      }
      s.ball.x = s.carrier.x; s.ball.y = s.carrier.y;
    }

    // Ball in air
    if (s.ball && s.ball.inAir) this._updateBall(dt);

    // Defense AI (and user-controlled defender)
    def.forEach(function (d) {
      if (d.flagPulled) return;
      if (!this.demo && !this.userOnOffense() && d === s.userControlled) { this._moveByInput(d, dt); return; }
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

  /* STAMINA. Each player carries a 0..1 gas tank that empties while they are
     running hard and refills when they ease off. It is read by the HUD, and
     it feeds `staminaScale()` so a gassed player actually slows down — a bar
     that only decorates the screen isn't worth the pixels.

     Drain is keyed off SPEED rather than the sprint flag so the CPU pays the
     same price as the player; recovery is deliberately slower than drain, but
     a play only lasts a few seconds so nobody bottoms out mid-down. */
  var STAM_DRAIN = 0.16;      // per second at full sprint
  var STAM_RECOVER = 0.10;    // per second at a standstill
  /* Raised from 0.35. The drain was written when "a play only lasts a few
     seconds so nobody bottoms out mid-down" was true; now that the CPU
     completes passes, a receiver can catch it deep and still be running eight
     seconds later, empty, at a third of their pace. A gassed player should be
     visibly slower, not reduced to walking a game of football to a standstill. */
  var STAM_FLOOR = 0.55;      // worst-case speed multiplier

  /* One place where every per-player clock ticks, for everyone, every frame.
     These used to be scattered: jukeCd and jukeFx were decayed inside
     _checkFlagPull, which only runs when there IS a ball carrier, so a juke
     cooldown froze the instant the ball left the quarterback's hand and
     resumed when somebody caught it — the cooldown measured possession, not
     time. Defender stun was decayed inside _aiDefender, so it ran on a
     different schedule again. */
  Engine.prototype._updateTimers = function (dt) {
    var s = this.state;
    if (!s || !s.players) return;
    for (var i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      if (p.jukeCd > 0) p.jukeCd = Math.max(0, p.jukeCd - dt);
      if (p.jukeFx > 0) p.jukeFx = Math.max(0, p.jukeFx - dt);
      if (p.stun > 0) p.stun = Math.max(0, p.stun - dt);
      /* The sidestep, spread over a few frames. It used to be a single
         teleport: the carrier's x/y jumped 0.9yd between one frame and the
         next, with vx/vy untouched, so the renderer saw a stationary player
         who had changed places and the move read as a glitch rather than a
         cut. */
      if (p.jukeImpT > 0) {
        var k = Math.min(dt, p.jukeImpT);
        p.x = clamp(p.x + p.jukeIx * k, 0, FIELD_LEN);
        p.y = clamp(p.y + p.jukeIy * k, 0, FIELD_WID);
        p.vx = p.jukeIx; p.vy = p.jukeIy;      // so the body actually turns into it
        p.jukeImpT = Math.max(0, p.jukeImpT - dt);
      }
    }
  };

  Engine.prototype._updateStamina = function (dt) {
    var s = this.state;
    if (!s.players) return;
    for (var i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      if (p.stam == null) p.stam = 1;
      var sp = Math.hypot(p.vx || 0, p.vy || 0);
      var effort = clamp(sp / 7.0, 0, 1);           // 7 yd/s ~= flat out
      p.stam = clamp(p.stam + (effort > 0.35
        ? -STAM_DRAIN * effort * dt
        : STAM_RECOVER * (1 - effort) * dt), 0, 1);
    }
  };

  // Speed multiplier from remaining stamina: full pace down to STAM_FLOOR.
  Engine.prototype.staminaScale = function (p) {
    if (!p || p.stam == null) return 1;
    return STAM_FLOOR + (1 - STAM_FLOOR) * clamp(p.stam, 0, 1);
  };

  Engine.prototype._isUserCarrier = function () { return true; };

  Engine.prototype._dropback = function (qb, dt) {
    var s = this.state;
    if (!this.demo && this.userOnOffense() && qb === s.carrier) { this._moveByInput(qb, dt); return; }
    /* AI QB: drop back, then work the pocket. A fixed drop spot means arriving
       and standing rigid until the throw, which on an extended play is one
       more frozen player. */
    qb.shuf = (qb.shuf || 0) + dt;
    var target = { x: s.losX - 5 + Math.sin(qb.shuf * 1.4) * 0.5,
                   y: qb.y + Math.cos(qb.shuf * 1.1) * 0.6 };
    this._seek(qb, target, dt, 0.7);
    if (s.snapT > 1.6 && !s.ball.inAir && !s.pendingThrow) this._aiThrow();
  };

  Engine.prototype._runRoute = function (p, dt) {
    var s = this.state;
    var wps = (p.route && p.route !== 'block') ? D.ROUTES[p.route] : null;
    if (!wps) { this._release(p, dt); return; }
    // mirror y by which side of field the receiver started
    var side = p.startSide || (p.startSide = (p.y < FIELD_WID / 2 ? -1 : 1), p.origin = { x: p.x, y: p.y }, p.startSide);
    var origin = p.origin;
    var wp = wps[Math.min(p.wp, wps.length - 1)];
    var tx = origin.x + wp.x;
    var ty = origin.y + wp.y * side;
    ty = clamp(ty, 1, FIELD_WID - 1);
    var target = { x: tx, y: ty };

    /* Route's been run and the play is still alive. Only the verticals used to
       have an answer for this — go/post/corner/wheel re-anchor their origin and
       keep pushing — so every other route (hitch, curl, slant, drag, out, in,
       flat, swing) ended with the receiver arriving at the last waypoint and
       standing perfectly still for the rest of the down. Latched, because
       working open moves them off the waypoint and they'd otherwise snap
       straight back to seeking it. */
    if (p.routeDone) { this._workOpen(p, dt); return; }

    var atEnd = p.wp >= wps.length - 1;
    var dTgt = dist(p, target);
    this._seek(p, target, dt, 1.0);
    if (dTgt < 1.0 && !atEnd) p.wp++;
    else if (dTgt < 0.8 && atEnd) {
      if (VERTICAL[p.route]) p.origin = { x: p.x, y: p.y };   // keep pushing
      else p.routeDone = true;
    }
  };

  // Routes that have somewhere to go after their last waypoint: straight on.
  var VERTICAL = { go: 1, post: 1, corner: 1, wheel: 1 };

  /* Work open. A receiver whose route is finished doesn't stop — they slide off
     coverage and come back toward the passer, which is both what the sport
     looks like and what keeps the QB with somewhere to throw. The target is
     always about three yards off the player's current spot, so it never
     collapses onto them and _seek never damps it down to a standstill. */
  Engine.prototype._workOpen = function (p, dt) {
    var s = this.state;
    var qb = s.carrier;
    var nd = null, nDist = 1e9;
    for (var i = 0; i < s.players.length; i++) {
      var o = s.players[i];
      if (o.team === p.team || o.flagPulled) continue;
      var d = dist(o, p);
      if (d < nDist) { nDist = d; nd = o; }
    }
    var ax = 0, ay = 0;
    if (nd && nDist < 6) { ax += (p.x - nd.x); ay += (p.y - nd.y); }      // off coverage
    if (qb && qb !== p) { ax += (qb.x - p.x) * 0.35; ay += (qb.y - p.y) * 0.15; }  // back to the ball
    if (Math.hypot(ax, ay) < 0.4) {
      // Everything cancelled out — keep working across rather than settling.
      if (p.openSide == null) p.openSide = (p.y < FIELD_WID / 2 ? 1 : -1);
      if (p.y < 3 || p.y > FIELD_WID - 3) p.openSide = -p.openSide;
      ax = 0.3; ay = p.openSide * 2;
    }
    var m = Math.hypot(ax, ay) || 1;
    this._seek(p, {
      x: clamp(p.x + ax / m * 3, 1, FIELD_LEN - 1),
      y: clamp(p.y + ay / m * 3, 1.5, FIELD_WID - 1.5)
    }, dt, 0.75);
  };

  /* No route to run — the play assigned 'block', or it named a route that
     isn't in D.ROUTES and the player would otherwise vanish from the sim.

     Flag football forbids blocking, and the centre may not even stay in to
     fake it (POS_INFO.C.noBlock). That rule used to be implemented as
     literally nothing: no seek, no velocity reset, just `return`. So on every
     run call — Draw, Keeper, Sweep, Reverse all assign C:'block' — the centre
     stood as a statue for the entire play while nine players moved around
     them. A player who cannot block RELEASES instead: the centre is an
     eligible receiver, so they leak out as a check-down safety valve. */
  Engine.prototype._release = function (p, dt) {
    if (!p.relOrigin) p.relOrigin = { x: p.x, y: p.y };
    if (p.relSide == null) p.relSide = (p.y < FIELD_WID / 2 ? -1 : 1);
    if (p.pos === 'C') {
      /* Release into a shallow crossing drift and KEEP working across, turning
         back at the numbers. A single fixed check-down point just moves the
         problem one seek downstream: they arrive, and plant. A check-down
         receiver who has settled works back across to stay open, so the target
         has to keep moving for as long as the play is alive. */
      p.relT = (p.relT || 0) + dt;
      var depth = p.relOrigin.x + Math.min(5.5, p.relT * 3.2);
      var tgtY = clamp(p.relOrigin.y + p.relSide * 9, 2.5, FIELD_WID - 2.5);
      if (Math.abs(p.y - tgtY) < 1.0) { p.relSide = -p.relSide; }   // reached it: come back
      this._seek(p, { x: depth, y: tgtY }, dt, 0.9);
    } else {
      this._seek(p, { x: p.x + 1, y: p.y }, dt, 0.4);
    }
  };

  Engine.prototype._seek = function (p, target, dt, spdMul) {
    var spd = this.speedYds(p.data.speed) * (spdMul || 1) * this.staminaScale(p);
    // Give a human ball carrier a fighting chance: CPU defenders run at a
    // difficulty-scaled fraction of full speed.
    if (!this.demo && this.difficulty && p.team !== this.userSide) {
      spd *= this.difficulty.defSpeed;
    }
    var dx = target.x - p.x, dy = target.y - p.y;
    var m = Math.hypot(dx, dy);
    // Standing exactly on the target used to divide by the `|| 1` fallback and
    // produce a hard zero — a player frozen mid-stride. Just short of it they
    // overshot and buzzed. Ease through the last half-yard instead.
    if (m < 1e-4) { p.vx = 0; p.vy = 0; return; }
    if (m < 0.5) spd *= m / 0.5;
    p.vx = dx / m * spd; p.vy = dy / m * spd;
    p.x = clamp(p.x + p.vx * dt, 0, FIELD_LEN);
    p.y = clamp(p.y + p.vy * dt, 0, FIELD_WID);
    if (m > 0.05) p.ang = Math.atan2(dy, dx);
  };

  /* Input is given in SCREEN space (dx = right, dy = down). The camera sits
     behind whichever team you're playing as and flips with possession, so
     screen axes do NOT line up with field axes — feeding them straight through
     made "right" travel sideways/down the pitch. Rotate the stick into field
     space using the same orientation the camera uses:
        on offense  we look toward +x  -> screen-up = +x, screen-right = +y
        on defense  we look toward -x  -> screen-up = -x, screen-right = -y  */
  Engine.prototype.viewSign = function () {
    if (this.demo) return 1;
    return (this.state && this.state.possession === this.userSide) ? 1 : -1;
  };

  Engine.prototype._moveByInput = function (p, dt) {
    var i = this.input;
    var dx = 0, dy = 0;
    if (i.left) dx -= 1; if (i.right) dx += 1;
    if (i.up) dy -= 1; if (i.down) dy += 1;
    if (this.pointer && this.pointer.active) { dx = this.pointer.dx; dy = this.pointer.dy; }
    var m = Math.hypot(dx, dy);
    var sprint = i.sprint ? 1.12 : 1.0;
    var spd = this.speedYds(p.data.speed) * sprint * this.staminaScale(p);
    var fx, fy;

    if (m > 0.05) {
      // Hands on the controls always win — taking the stick tears up the route.
      this.clearSlash();
      var sgn = this.viewSign();
      fx = (-dy / m) * sgn;              // screen up -> downfield
      fy = (dx / m) * sgn;               // screen right -> across the field
    } else {
      var step = this._slashHeading(p);
      if (!step) { p.vx = 0; p.vy = 0; return; }
      fx = step.fx; fy = step.fy;
    }

    p.vx = fx * spd; p.vy = fy * spd;
    p.x = clamp(p.x + p.vx * dt, 0, FIELD_LEN);
    p.y = clamp(p.y + p.vy * dt, 0, FIELD_WID);
    p.ang = Math.atan2(fy, fx);
  };

  /* SLASH-TO-DIRECT.
     Draw a stroke across the field and the player runs it. The stroke is kept
     as field-space waypoints, so it stays pinned to the turf you drew it on no
     matter how the camera flips with possession — unlike stick input, which is
     screen-space and has to be rotated by viewSign().

     Returns a unit heading toward the next waypoint, or null when there is no
     route left to run. */
  Engine.prototype._slashHeading = function (p) {
    var sl = this.slash;
    if (!sl || !sl.pts.length) return null;
    // Whoever we drew it for has handed off or been swapped out — a route drawn
    // for the QB isn't the receiver's to run.
    if (sl.owner !== p) { this.clearSlash(); return null; }
    // Retire waypoints we've reached (several at once if the stroke was dense).
    while (sl.pts.length) {
      var w = sl.pts[0];
      var ax = w.x - p.x, ay = w.y - p.y;
      var d = Math.hypot(ax, ay);
      if (d > SLASH_REACH) return { fx: ax / d, fy: ay / d };
      sl.pts.shift();
    }
    this.clearSlash();
    return null;
  };

  /* Extend the route by one waypoint, starting one if there isn't a route yet.
     Strokes are fed in as they're drawn rather than handed over on release, so
     the player sets off the moment the line is recognisable as a route and
     keeps following it while you carry on drawing.

     Waypoints closer together than the arrival radius get dropped: they'd be
     retired the same instant as the one before, which only adds jitter to the
     heading. */
  Engine.prototype.appendSlash = function (pt) {
    var s = this.state;
    // Only while there's a play to run: a stroke that lands after the whistle
    // (say, the swipe that put you out of bounds) must not queue a route.
    if (!s || (s.phase !== 'live' && s.phase !== 'presnap')) return false;
    if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) return false;
    var who = this.userPlayer();
    if (!who) return false;
    if (!this.slash || this.slash.owner !== who) this.slash = { owner: who, pts: [] };
    var pts = this.slash.pts;
    if (pts.length >= SLASH_MAX) return false;      // a route can't outlast the field
    var last = pts.length ? pts[pts.length - 1] : who;
    if (Math.hypot(pt.x - last.x, pt.y - last.y) < SLASH_REACH * 1.5) return false;
    pts.push({ x: clamp(pt.x, 0, FIELD_LEN), y: clamp(pt.y, 0, FIELD_WID) });
    return true;
  };

  /* Replace the running route with a whole stroke at once. */
  Engine.prototype.setSlash = function (pts) {
    if (!pts || !pts.length) return false;
    this.clearSlash();
    var any = false;
    for (var i = 0; i < pts.length; i++) any = this.appendSlash(pts[i]) || any;
    return any;
  };

  Engine.prototype.clearSlash = function () { this.slash = null; };

  /* The player the user's input is actually driving this frame. On offense
     that's whoever is holding the ball — the QB at the snap, then the receiver
     the moment they catch it — which is NOT the same as state.userControlled,
     since that still names the QB. On defense it's the selected defender. */
  Engine.prototype.userPlayer = function () {
    var s = this.state;
    if (!s || this.demo) return null;
    if (this.userOnOffense()) return s.carrier || s.userControlled || null;
    return s.userControlled || null;
  };

  /* Tap-to-select (mobile): choose which defender you're controlling, or on
     offense tap a receiver to throw to them. `i` indexes state.players. */
  Engine.prototype.selectPlayerIndex = function (i) {
    var s = this.state;
    if (!s || this.demo) return false;
    var p = s.players && s.players[i];
    if (!p || p.team !== this.userSide) return false;

    if (this.userOnOffense()) {
      // tapping one of your receivers is a pass to them
      if (s.phase !== 'live' || !s.carrier || s.ball && s.ball.inAir) return false;
      if (p === s.carrier || p.slot === 'QB') return false;
      this.throwTo(p.slot);
      return true;
    }
    if (p.flagPulled) return false;
    s.userControlled = p;
    this.onEvent({ type: 'switch', player: p });
    return true;
  };

  /* A CPU quarterback still holding the ball should be reading the field, not
     tucking it and running.

     THE AI COULD NOT PASS AT ALL. _dropback is what calls _aiThrow, and the
     receivers loop skips the ball carrier — `if (p === s.carrier) return` —
     so _dropback was only ever reached by a quarterback who had already got
     rid of the ball. Until they threw they were the carrier, and the carrier
     went to _aiCarrier, which just runs at the end zone. A deadlock: the only
     path to a pass required having already passed. Every CPU snap in every
     mode was a quarterback scramble, and no throw event has ever fired.

     Holding the ball forever is not the answer either, so after the pocket
     collapses the quarterback tucks it and goes. */
  Engine.prototype._aiQBOrCarrier = function (p, dt) {
    var s = this.state;
    if (p.slot === 'QB' && !s.autoHandoff && s.snapT < AI_SCRAMBLE_AT) {
      this._dropback(p, dt);
      return;
    }
    this._aiCarrier(p, dt);
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
    var best = null, bestScore = -1, bestSep = 0;
    off.forEach(function (r) {
      if (r.flagPulled) return;
      var sep = 99;
      def.forEach(function (d) { if (!d.flagPulled) sep = Math.min(sep, dist(r, d)); });
      var downfield = r.x - s.losX;
      var score = sep + downfield * 0.2;
      if (score > bestScore) { bestScore = score; best = r; bestSep = sep; }
    });
    if (!best) return false;
    /* And don't throw it just because the clock says 1.6s. Nobody open yet
       means hold the ball and let them keep working — the pocket timer makes
       the decision soon enough, and after that the quarterback tucks and runs.
       Throwing on a stopwatch into blanket coverage is what made the CPU
       complete barely a third of its passes. */
    if (bestSep < AI_MIN_SEP && s.snapT < AI_FORCE_THROW_AT) return false;
    this.throwTo(best.slot);
    return true;
  };

  Engine.prototype._aiDefender = function (d, dt) {
    var s = this.state;
    // Caught flat-footed by a juke. Zero the velocity too — the renderer reads
    // it for stride and facing, so a stale one moonwalks them on the spot.
    // (_updateTimers owns the countdown.)
    if (d.stun > 0) { d.vx = 0; d.vy = 0; return; }
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
      // man coverage: shadow, stay goal-side. Same shuffle as the zone — a
      // defender matched exactly to a stationary receiver would otherwise
      // freeze alongside them.
      var c = d.cover;
      d.shuf = (d.shuf || 0) + dt;
      var target = { x: c.x + 0.6 + Math.sin(d.shuf * 1.9) * 0.35,
                     y: c.y + Math.cos(d.shuf * 1.5) * 0.45 };
      this._seek(d, target, dt, 0.98);
    } else if (d.zone) {
      /* A landmark is a fixed point, and a defender who reaches a fixed point
         stops dead — which is both the last big source of frozen players and
         not what zone coverage is. Two things keep them alive, and both are
         real: the spot slides with the quarterback, and the defender matches
         the nearest receiver working into the area, harder the closer they get. */
      var qb = s.carrier;
      var zx = s.losX + d.zone.x;
      var zy = d.zone.y + (qb ? clamp((qb.y - FIELD_WID / 2) * 0.35, -3, 3) : 0);
      var thr = null, td = 1e9;
      for (var i = 0; i < s.players.length; i++) {
        var o = s.players[i];
        if (o.team === d.team || o.flagPulled) continue;
        var dd = Math.hypot(o.x - zx, o.y - zy);
        if (dd < td) { td = dd; thr = o; }
      }
      if (thr) {
        var wgt = clamp(1 - td / 12, 0, 0.7);
        zx = lerp(zx, thr.x, wgt); zy = lerp(zy, thr.y, wgt);
      }
      /* And never rigid. With no receiver in the area and the passer standing
         still there is nothing left to track, and the defender would settle
         onto the spot and hold it like a bollard. Coverage is a constant
         shuffle, so the spot itself breathes — under a yard, too small to
         weaken the zone, enough that nobody on the field is ever a statue. */
      d.shuf = (d.shuf || 0) + dt;
      zx += Math.sin(d.shuf * 1.7 + d.zone.x) * 0.55;
      zy += Math.cos(d.shuf * 1.3 + d.zone.y) * 0.75;
      this._seek(d, { x: zx, y: clamp(zy, 1.5, FIELD_WID - 1.5) }, dt, 0.85);
    } else {
      // Spy: mirror the passer instead of a fixed dot on the field, which the
      // spy would simply arrive at and then stand on.
      var t = s.carrier || { x: s.losX - 4, y: FIELD_WID / 2 };
      this._seek(d, { x: t.x + 4, y: lerp(FIELD_WID / 2, t.y, 0.6) }, dt, 0.6);
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
    var bonus = (!this.demo && receiver && receiver.team === this.userSide) ? this.difficulty.catchBonus : 0;
    var pCatch = clamp(base * reach - sepPenalty + bonus, 0.03, 0.98);

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
    } else if (nd < 1.4 && roll < pCatch + (nearDef ? nearDef.data.pull / 400 : 0) * (this.difficulty ? this.difficulty.intScale : 1)) {
      // interception
      this._turnover('INTERCEPTED by ' + nearDef.last + '!', nearDef);
    } else {
      this._incomplete('Incomplete pass', pt);
    }
  };

  /* CONTESTED FLAG PULL.
     Contact no longer rips the flag instantly. A defender in reach starts
     GRABBING: they must sustain contact while a meter fills. The carrier can
     break the engagement with a juke (manual on offense, automatic for the AI),
     and a shifty runner drains the meter just by being hard to hold. How long
     the defender needs is set by difficulty. */
  Engine.prototype._checkFlagPull = function (def) {
    var s = this.state;
    var c = s.carrier;
    var dt = this._dt || 0.016;
    if (!c || (c.slot === 'QB' && s.ball && s.ball.inAir)) return;

    // closest defender within reach
    var grabber = null, best = 1e9;
    for (var i = 0; i < def.length; i++) {
      var d = def[i];
      // A defender you just shook off cannot also be holding your flag. The
      // stun used to stop only their movement AI while this loop happily kept
      // picking them as the grabber, so the shove bought exactly nothing and
      // the meter carried on filling through it.
      if (d.flagPulled || d.stun > 0) continue;
      var range = 1.15 + d.data.pull / 400;
      var dd = dist(d, c);
      if (dd < range && dd < best) { best = dd; grabber = d; }
    }

    // nobody in reach -> the engagement decays quickly (you shook them off)
    if (!grabber) {
      c.grabT = Math.max(0, (c.grabT || 0) - dt * 2.2);
      if (s.grabbedBy) { s.grabbedBy.grabbing = false; s.grabbedBy = null; }
      s.grabProgress = 0;
      return;
    }

    s.grabbedBy = grabber; grabber.grabbing = true;
    var need = this.difficulty.pullTime;

    // Fill rate: the defender's pull vs the carrier's agility. A very shifty
    // carrier can hold a defender off almost indefinitely.
    var rate = (0.55 + grabber.data.pull / 150) * (1 - clamp(c.data.agi / 320, 0, 0.55));
    c.grabT = (c.grabT || 0) + dt * rate;
    s.grabProgress = clamp(c.grabT / need, 0, 1);

    /* AI ball carriers try to juke out when the meter gets dangerous. The test
       was `Math.random() < 0.05` PER FRAME, which is three attempts a second at
       60fps and one a second at 20 — the AI's escape ability quietly scaled
       with the player's frame rate. Same intent, expressed per second. */
    if (!this.userOnOffense() || this.demo) {
      if (s.grabProgress > 0.45 && (c.jukeCd || 0) <= 0 && Math.random() < AI_JUKE_PER_SEC * dt) this.juke();
    }

    if (c.grabT >= need) this._flagPull(grabber, c);
  };

  /* JUKE — break a defender's grip.

     The old one was a trap when it missed and an exploit when it hit.

     A whiff — pressing it with nobody holding you — still charged the full
     cooldown, so the punishment for a mistimed press was being unable to juke
     for the 1-2 seconds when it actually mattered. Now a whiff is a sidestep
     that costs a short recovery, not the whole cooldown.

     A hit reset the grab meter to zero outright. On Rookie, the default, the
     cooldown (1.1s) is shorter than the time a defender needs to refill the
     meter (~1.3s), so a carrier who simply pressed juke on cooldown could
     never be pulled — measured at 18 jukes and no tackle across 20 seconds of
     being held. Repeat jukes in the same play now break progressively less of
     the meter and buy progressively less stun, so the move stays strong the
     first time and stops being a lock. */
  Engine.prototype.juke = function () {
    var s = this.state;
    var c = s && s.carrier;
    if (!c || s.phase !== 'live') return false;
    if ((c.jukeCd || 0) > 0) return false;

    var held = s.grabbedBy;
    // Diminishing returns, counted per play: 1st 100%, 2nd 53%, 3rd 36% ...
    var n = (c.jukeCount || 0) + 1;
    var eff = 1 / (1 + 0.9 * (n - 1));

    if (held) {
      c.jukeCount = n;
      c.jukeCd = this.difficulty.jukeCd;
      c.grabT = Math.max(0, (c.grabT || 0) * (1 - eff));
      s.grabProgress = clamp(c.grabT / this.difficulty.pullTime, 0, 1);
      held.grabbing = false;
      held.stun = 0.55 * eff;              // long enough to actually get away
      s.grabbedBy = null;
    } else {
      // Nothing to break: a sidestep into space, cheap to attempt.
      c.jukeCd = 0.35;
    }

    // Sidestep away from whoever was on you, or across your own line of travel.
    var dx, dy;
    if (held) { dx = c.x - held.x; dy = c.y - held.y; }
    else { dx = -(c.vy || 0); dy = (c.vx || 1); }
    var m = Math.hypot(dx, dy) || 1;
    var burst = 8.0 * (held ? eff : 0.6);
    c.jukeIx = (-dy / m) * burst;          // perpendicular to the engagement
    c.jukeIy = (dx / m) * burst;
    c.jukeImpT = 0.20;                     // ~1.6yd of lateral break, over frames

    c.jukeFx = 0.35;                       // renderer/UX cue
    this._flash(held ? 'Juke!' : 'Sidestep');
    this.onEvent({ type: 'juke', player: c, broke: !!held });
    return true;
  };

  Engine.prototype._flagPull = function (defender, carrier) {
    var s = this.state;
    s.stats[this.defenseTeam()].tackles++;
    // spot the ball where the carrier is
    var spotX = carrier.x;
    this.anim.push({ type: 'flag', x: carrier.x, y: carrier.y, t: 0, dur: 0.7,
      color: this._jerseyColor(carrier.team)[0] });
    this.onEvent({ type: 'flagpull', defender: defender, carrier: carrier });
    // THE safety condition: the flag came off behind your own goal line.
    if (spotX <= GOAL_L) {
      this._flash(defender.last + ' pulls the flag — SAFETY!');
      this._safety();
      return;
    }
    this._flash(defender.last + ' pulls the flag!');
    this._endPlay(spotX, false);
  };

  Engine.prototype._checkBoundaries = function () {
    var s = this.state;
    var c = s.carrier;
    if (!c) return;
    // Touchdown
    if (c.x >= GOAL_R) { this._touchdown(); return; }
    /* NO automatic safety for merely being back there. This used to fire on
       position alone — c.x <= GOAL_L — with no defender within ten yards, and
       backed up near your own line it was unavoidable: at yardsToGoal 50 the
       line of scrimmage IS the goal line, so the QB starts at x = 6, already
       behind it, and conceded two points 0.3s after every snap without being
       touched. Retreating into your own end zone is legal and you can run back
       out; it costs you two points only if your flag comes off back there,
       which _flagPull now handles. */
    // Out of bounds
    if (c.y <= 0.4 || c.y >= FIELD_WID - 0.4) { this._endPlay(c.x, false); }
  };

  /* --------------------------- PLAY RESOLUTION --------------------------- */
  Engine.prototype._endPlay = function (spotX, noGain) {
    this.clearSlash();
    this.state.pendingThrow = null;
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
    this.clearSlash();            // scoring plays skip _endPlay, which usually does this
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
    this.clearSlash();            // scoring plays skip _endPlay, which usually does this
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

  /* Demo mode: the CPU calls a play for BOTH sides. */
  Engine.prototype.autoCall = function () {
    var s = this.state;
    if (!s || s.phase !== 'playcall') return;
    s.offPlay = D.PLAYS[Math.floor(Math.random() * D.PLAYS.length)];
    s.defPlay = D.DEF_PLAYS[Math.floor(Math.random() * D.DEF_PLAYS.length)];
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
    this.clearSlash();                   // the route belonged to the old defender
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
      // Optional external renderer (e.g. Three.js 3D field). When present it
      // replaces the 2D field draw; the simulation keeps updating unchanged.
      if (self.externalRender) {
        try { self.externalRender(self.state); }
        catch (e) {
          self._extErr = (self._extErr || 0) + 1;
          if (self._extErr > 5) { self.externalRender = null; if (self.onExternalFail) self.onExternalFail(e); }
          self._render();
        }
      } else {
        self._render();
      }
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
      if (k === 'f') self.action('juke');
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
        if (a === 'juke') this.juke();
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
