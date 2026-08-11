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
  /* NFL FLAG field: 70 x 30 with 10-yard end zones, so 50 between the goal
     lines. The width was 25 — five yards narrow, which is a fifth of the
     playing surface missing and the single dimension that decides how much
     room a receiver has to work with against man coverage. */
  var FIELD_LEN = 70, FIELD_WID = 30, EZ = 10;      // end zone depth
  var GOAL_L = EZ, GOAL_R = FIELD_LEN - EZ;         // x=10 (own), x=60 (target)
  var MIDFIELD = (GOAL_L + GOAL_R) / 2;             // x=35

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // How close a player must get to a drawn waypoint before it counts as reached.
  var SLASH_REACH = 1.1;                 // yards
  var SLASH_MAX = 80;                    // waypoints; a scribble can't run forever
  var PLAY_CLOCK = 25;                   // seconds on the play clock pre-snap
  /* IFAF rules the arcade build never modelled. */
  var PASS_CLOCK = 7;                    // seconds to get the ball out, or it's dead
  var RUSH_LINE = 7;                     // a rusher must start this far off the LOS
  var NO_RUN_ZONE = 5;                   // no running plays inside 5 of a goal line or midfield
  var GRAVITY = 10.73;                   // yd/s^2 (9.81 m/s^2)
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
      /* A6 — IFAF plays TWO HALVES, not four quarters. `quarters` is kept as
         the field name so every caller and the HUD keep working, but it now
         defaults to 2 periods of 20 minutes. */
      quarter: 1, quarters: cfg.halves || cfg.quarters || 2,
      halves: true,
      clock: cfg.halfLen || cfg.quarterLen || 1200,
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
      // A rusher must start 7 yards off the ball (IFAF). This used to be 1.5,
      // which put a free runner in the quarterback's lap on every single snap.
      RUSH:{ x: losX + RUSH_LINE, y: cy },
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
    /* E2 — there is a ball on the ground before the snap. It used to
       materialise in the quarterback's hands when snap() ran; pre-snap the
       field was simply empty of it. */
    s.ballSpot = { x: losX, y: cy };
    s.lineToGain = s.crossedMid ? GOAL_R : MIDFIELD;
    s.ball = { x: losX, y: cy, z: 0, inAir: false, onGround: true };
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
      jukeCd: 0, jukeFx: 0, pullFx: 0, jukeCount: 0, stun: 0, stam: 1,
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

    /* Rushing is a CALL, not a constant. `rusher.blitz = true` used to run
       unconditionally, so Prevent Deep — a coverage whose entire point is not
       to rush — still sent a free runner. Only calls that actually rush do. */
    var rusher = def.filter(function (d) { return d.slot === 'RUSH'; })[0];
    if (rusher && play.blitz > 0) rusher.blitz = true;

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
    // Who the original passer is, for the 7-second clock and the rule that
    // they may not carry it across the line.
    s.passer = qb;
    qb.hasBall = true;
    s.ball = { x: qb.x, y: qb.y, z: 0, inAir: false, target: null, from: null, to: null, t: 0, dur: 0 };
    // The snap is a real travel from the spot to the quarterback's hands.
    s.snapFly = { from: { x: s.ballSpot ? s.ballSpot.x : qb.x, y: s.ballSpot ? s.ballSpot.y : qb.y },
                  t: 0, dur: 0.22 };
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

  /* THE BALL LEAVES A HAND AND ARRIVES AT A PAIR OF THEM.

     The trajectory used to run from the ground to the ground, and the 3D
     renderer papered over it by drawing the whole parabola a flat 1.0 yards
     higher. Two things were wrong with that. The release height was not the
     height of the hand the ball had just been in — so the ball visibly dropped
     out of the quarterback's grip the instant it went airborne. And the ball
     then "landed" at 1.0yd, which is neither the ground nor where a receiver
     catches it.

     So the flight is now solved between the two heights it actually happens
     between, and the renderer draws `z` as-is. Everything downstream — hang
     time, how far the arm really reaches, the underthrow — falls out of the
     same solve rather than being corrected for afterwards.

     Both heights are MEASURED off the rig rather than guessed, with
     tools/measure-clip.mjs, and converted through the scales the renderer
     applies (metres -> yards / 0.9144, then field3d's 0.87 player scale and
     its 1.010 quarterback build, plus PLAYER_LIFT):

       Throw at t=0.374 (RELEASE_AT):  hand 1.83m -> 1.86yd
       Catch, ball secured:            hands 1.29m -> 1.35yd                */
  var RELEASE_Z = 1.86;                  // yards: the throwing hand at release
  var CATCH_Z = 1.35;                    // yards: chest height, where it's gathered

  /* Time for a ball launched upward at vz from z0 to fall back to z1.
     z1 = z0 + vz*t - g*t^2/2, taking the positive root. */
  function flightTime(vz, z0, z1) {
    var drop = Math.max(0, z0 - z1);
    return (vz + Math.sqrt(vz * vz + 2 * GRAVITY * drop)) / GRAVITY;
  }

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

    /* C1 — BALLISTICS. Every pass used to leave at a fixed 22yd/s in a straight
       line with a cosmetic sin() bump, so a 5-yard flat and a 40-yard bomb were
       thrown at identical velocity and arrived in the same shape.

       Launch speed comes from the arm; the angle is solved for the range below
       and gravity does the rest. Hang time, loft and — when the arm can't cover
       the distance — a genuine underthrow all fall out of it.

       This lived in throwTo() where it could not do anything: throwTo only
       starts the wind-up, and the whole ballistic solve happens HERE, 374ms
       later, where a local `var throwSpeed = 22` shadowed it. Every arm in the
       league threw at exactly the same velocity and the rating showed up only
       as scatter — the very thing the comment said had been fixed. */
    var throwSpeed = 18 + (clamp(carrier.data.throw, 40, 99) - 40) / 59 * 12; // yards/sec
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
    /* A weaker arm misses the spot, and everyone misses more the further they
       throw — accuracy is not a constant, which is what makes a deep ball a
       risk rather than just a slower one. */
    var err = (1 - clamp(carrier.data.throw, 40, 99) / 110) * (1.5 + t * throwSpeed * 0.06);
    px += (Math.random() * 2 - 1) * err;
    py += (Math.random() * 2 - 1) * err;
    var predicted = { x: clamp(px, 0, FIELD_LEN), y: clamp(py, 0, FIELD_WID) };
    var d = dist(carrier, predicted);
    var dirx = d > 1e-4 ? (predicted.x - carrier.x) / d : 1;
    var diry = d > 1e-4 ? (predicted.y - carrier.y) / d : 0;

    /* SOLVE THE ANGLE FOR THE RANGE THE BALL ACTUALLY HAS.

       THIS IS WHY NOTHING WAS EVER CAUGHT. The angle came from sin(2t) =
       g*d/v^2, which is the range of a projectile that lands at the height it
       left from. This one does not: it leaves a hand at RELEASE_Z and is
       gathered at CATCH_Z, half a yard lower, and that extra half yard of fall
       buys it extra flight time and extra distance. Measured across 150 CPU
       passes, the aim point was 12.6 yards away and the ball landed 15.4 —
       every single pass sailed 2.8 yards long, while the receiver ran to the
       aim point and stood there. The catch radius is 2.4. Completion rate:
       one pass in three hundred.

       Nothing else was wrong — the receivers arrived within 0.24 yards of
       where they were sent. The ball was simply thrown past them, on purpose,
       by the arithmetic.

       So solve the real thing. Range for a launch at angle t, from a height
       `drop` above where it will be caught, is

           R(t) = v*cos(t) * (v*sin(t) + sqrt((v*sin(t))^2 + 2*g*drop)) / g

       which rises to a maximum at tOpt = atan(v / sqrt(v^2 + 2*g*drop)) — 45
       degrees when there is no height difference, flatter when there is — and
       is monotonic below it. Bisect that branch. A target past the maximum is
       genuinely out of the arm's range, and gets the best angle there is and
       an honest underthrow, which is the same behaviour as before.

       The old code also imposed a loft floor (`theta >= d*0.011`) to keep deep
       balls in the air. That is gone: it was a correction for a range solve
       that was wrong, and the exact solve already lofts a deep ball on its own
       — 21 degrees at thirty yards — while keeping a five-yard out flat. */
    var tOpt = Math.atan(throwSpeed / Math.sqrt(throwSpeed * throwSpeed + 2 * GRAVITY * Math.max(0, RELEASE_Z - CATCH_Z)));
    function rangeAt(t) {
      var vz = throwSpeed * Math.sin(t);
      return throwSpeed * Math.cos(t) * flightTime(vz, RELEASE_Z, CATCH_Z);
    }
    var theta;
    if (d >= rangeAt(tOpt)) {
      theta = tOpt;                     // out of range: best he's got, falls short
    } else {
      var lo = -0.7, hi = tOpt;
      for (var bi = 0; bi < 32; bi++) {
        var mid = (lo + hi) / 2;
        if (rangeAt(mid) < d) lo = mid; else hi = mid;
      }
      theta = (lo + hi) / 2;
    }
    var hv = throwSpeed * Math.cos(theta);        // horizontal component
    var vz = throwSpeed * Math.sin(theta);        // vertical component
    var flight = flightTime(vz, RELEASE_Z, CATCH_Z);
    var reach = hv * flight;                      // how far it ACTUALLY goes
    if (reach < d) {                              // underthrow — the arm fell short
      predicted = { x: clamp(carrier.x + dirx * reach, 0, FIELD_LEN),
                    y: clamp(carrier.y + diry * reach, 0, FIELD_WID) };
    }
    s.ball = {
      x: carrier.x, y: carrier.y, z: RELEASE_Z, inAir: true,
      from: { x: carrier.x, y: carrier.y }, to: predicted,
      dirx: dirx, diry: diry, hv: hv, vz: vz, z0: RELEASE_Z, z1: CATCH_Z,
      t: 0, dur: flight, thrower: carrier, targetSlot: pt.slot
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
    if (s.snapFly) {
      s.snapFly.t += dt;
      if (s.snapFly.t >= s.snapFly.dur) s.snapFly = null;
    }
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

    // Two bodies cannot occupy the same yard.
    this._separate(dt);

    /* RENDER VELOCITY. The animation must be driven by what the body actually
       did this frame, not by what the simulation intended it to do. Position
       gets corrected after the fact — by separation, by clamping to the field,
       by the odd rule — and every one of those corrections used to move a
       player without touching vx/vy, so the legs and the facing followed a
       velocity that disagreed with the ground. That disagreement IS the skate.
       Measured against intent it was 5.7% of moving frames; against this it is
       zero by construction, because this is the ground truth. */
    for (var ri = 0; ri < s.players.length; ri++) {
      var rp = s.players[ri];
      if (rp._px == null) { rp.rvx = rp.vx; rp.rvy = rp.vy; }
      else { rp.rvx = (rp.x - rp._px) / dt; rp.rvy = (rp.y - rp._py) / dt; }
      rp._px = rp.x; rp._py = rp.y;
    }

    // Rules that are checked every frame while the ball is live
    this._checkRules(dt, def);
    if (s.phase !== 'live') return;

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
      if (p.pullFx > 0) p.pullFx = Math.max(0, p.pullFx - dt);
      if (p.stun > 0) p.stun = Math.max(0, p.stun - dt);
      /* The sidestep used to be scripted here — first a teleport, then a
         positional impulse integrated over a fifth of a second — because the
         movement model had no momentum for a juke to work against. It does
         now, so the juke is a change of MOMENTUM applied once at the moment of
         the cut (see juke()), and the ordinary steering carries and then bleeds
         it off. Nothing to drive per-frame any more. */
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
    /* D4 — THE BREAK RESPONDS TO LEVERAGE. Routes were static waypoint lists
       mirrored by which side the receiver lined up on: the same break at the
       same spot whether the corner was sitting inside, outside, or nowhere.
       A receiver breaks AWAY from where the defender is leaning, which is what
       makes leverage (D2) worth holding in the first place. */
    var lean = 0;
    for (var li = 0; li < s.players.length; li++) {
      var o = s.players[li];
      if (o.team === p.team || o.flagPulled) continue;
      if (dist(o, p) > 4.5) continue;
      lean += (o.y > p.y ? -1 : 1);          // push the break off their leverage
    }
    if (lean) ty = clamp(ty + clamp(lean, -1, 1) * 1.1, 1, FIELD_WID - 1);

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

  /* B1 — MOMENTUM.

     _seek and _moveByInput used to assign velocity directly:

         p.vx = dx / m * spd;  p.vy = dy / m * spd;

     so every player went from a standstill to top speed in one frame and could
     reverse at a sprint for free. Speed and agility barely mattered, because
     nobody ever spent time accelerating — which is exactly where a fast player
     separates — and a 90-degree cut cost nothing.

     Everything now steers: changes to velocity are rate-limited, braking is
     stronger than accelerating, turning is limited harder still, and a hard
     turn sheds speed. Roughly half a second from rest to top speed for a good
     athlete, which is about right. */
  Engine.prototype._accelOf = function (p) {
    var d = p.data || {};
    var agi = d.agi == null ? 70 : d.agi, spd = d.speed == null ? 70 : d.speed;
    return 8.5 + (agi - 55) / 44 * 5.0 + (spd - 55) / 44 * 2.0;   // yd/s^2
  };

  /* Steer toward a desired velocity and integrate. The one place velocity is
     allowed to change. */
  Engine.prototype._steer = function (p, dvx, dvy, dt) {
    var vx = p.vx || 0, vy = p.vy || 0;
    var A = this._accelOf(p);
    var sp = Math.hypot(vx, vy);
    var ddx = dvx - vx, ddy = dvy - vy;

    if (sp > 0.05) {
      // Split the wanted change into along-track (speed) and cross-track (turn).
      var ux = vx / sp, uy = vy / sp;
      var along = ddx * ux + ddy * uy;
      var cx = ddx - along * ux, cy = ddy - along * uy;
      var cm = Math.hypot(cx, cy);
      var maxAlong = (along >= 0 ? A : A * 1.7) * dt;    // you stop faster than you start
      var maxCross = A * 0.62 * dt;                      // turning is the hardest of the three
      if (along > maxAlong) along = maxAlong;
      else if (along < -maxAlong) along = -maxAlong;
      if (cm > maxCross) { cx = cx / cm * maxCross; cy = cy / cm * maxCross; }
      vx += along * ux + cx; vy += along * uy + cy;

      // A hard change of direction costs speed — you cannot carry a sprint
      // through a cut.
      var nsp = Math.hypot(vx, vy);
      if (nsp > 0.05) {
        var dot = (vx * ux + vy * uy) / nsp;
        var turn = Math.acos(clamp(dot, -1, 1));
        if (turn > 0.30) {
          var keep = 1 - Math.min(0.45, (turn - 0.30) * 0.9);
          vx *= keep; vy *= keep;
        }
      }
    } else {
      var m = Math.hypot(ddx, ddy), lim = A * dt;
      if (m > lim) { ddx = ddx / m * lim; ddy = ddy / m * lim; }
      vx += ddx; vy += ddy;
    }

    p.vx = vx; p.vy = vy;
    /* OUT OF BOUNDS. The step was clamped into the field and nothing else
       happened, so a ball carrier driven at the sideline did not go out — he
       pressed against the paint and kept running along it, for as long as you
       liked, gaining yards down a line he was standing on. There is no such
       thing in the sport: the moment any part of you touches out, the ball is
       dead where you crossed.

       The clamp stays — a body that keeps its feet on the grass is the right
       way to draw the last frame, and everyone who is NOT carrying the ball
       simply cannot leave the field. What is new is that the crossing is
       recorded before it is clamped away, so _update can blow the whistle on
       the carrier. `outAt` is the spot, which is the yardage. */
    var nx = p.x + vx * dt, ny = p.y + vy * dt;
    if (ny < 0 || ny > FIELD_WID || nx < 0 || nx > FIELD_LEN) {
      p.outOfBounds = true;
      p.outAt = { x: clamp(nx, 0, FIELD_LEN), y: clamp(ny, 0, FIELD_WID) };
    } else {
      p.outOfBounds = false;
    }
    p.x = clamp(nx, 0, FIELD_LEN);
    p.y = clamp(ny, 0, FIELD_WID);
    if (Math.hypot(vx, vy) > 0.05) p.ang = Math.atan2(vy, vx);
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
    if (m < 1e-4) { this._steer(p, 0, 0, dt); return; }
    if (m < 0.5) spd *= m / 0.5;
    this._steer(p, dx / m * spd, dy / m * spd, dt);
  };

  /* Input is given in SCREEN space (dx = right, dy = down) and has to be
     rotated into field space using whatever orientation the camera is using,
     or "right" travels sideways down the pitch.

     The camera USED to sit behind whichever team you were playing as, and so
     flipped end-for-end with possession; this returned -1 to match. It now
     sits behind whoever has the ball, and the offence always attacks +x, so
     the shot never turns around and the answer is always +1:

        we always look toward +x -> screen-up = +x, screen-right = +y

     The seam is kept — every caller still asks the camera which way is
     downfield rather than assuming — so a camera that ever does turn round
     again only has to change this one line. */
  Engine.prototype.viewSign = function () {
    return 1;
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
      if (!step) { this._steer(p, 0, 0, dt); return; }   // coast down, don't stop dead
      fx = step.fx; fy = step.fy;
    }

    // Same momentum as everyone else — the human doesn't get to teleport
    // between velocities either.
    this._steer(p, fx * spd, fy * spd, dt);
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
    if (p === s.passer && !s.handoffDone) {
      /* The passer never becomes a runner. They work the pocket for the whole
         seven seconds and throw it away rather than tuck it — carrying it past
         the line is a dead ball, so "tuck and run" was never a legal out. */
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

  /* D3 — THE QUARTERBACK HAS A PROGRESSION.

     This threw on a fixed timer to whoever had 2.2 yards of separation, and
     never threw the ball away. Two consequences: the ball only ever went to a
     genuinely open man, which is why nothing was ever intercepted, and there
     was no such thing as a bad decision.

     Now there is a read order, and pressure compresses it. Clean pocket: work
     the progression and wait for real separation. Rusher bearing down, or the
     seven-second clock running out: take what's there, which is sometimes a
     window far too tight — and that is where interceptions come from. With
     nothing at all and no time left, throw it away rather than eat the down. */
  Engine.prototype._aiThrow = function () {
    var s = this.state;
    var qb = s.carrier;
    if (!qb) return false;
    var off = s.players.filter(function (p) { return p.team === this.offenseTeam() && p !== qb; }, this);
    var def = s.players.filter(function (p) { return p.team === this.defenseTeam(); }, this);

    // How much heat is on: distance to the nearest defender who is coming.
    var heat = 99;
    for (var i = 0; i < def.length; i++) {
      if (def[i].flagPulled) continue;
      var dd = dist(def[i], qb);
      if (dd < heat) heat = dd;
    }
    var pressured = heat < 3.2;
    var late = s.snapT > PASS_CLOCK - 1.8;

    // Read order: the play names one, otherwise nearest-to-deepest.
    var order = (s.offPlay && s.offPlay.reads) || ['WR1', 'WR2', 'RB', 'C'];
    var ranked = [];
    order.forEach(function (slot) {
      var r = off.filter(function (p) { return p.slot === slot; })[0];
      if (r && !r.flagPulled) ranked.push(r);
    });
    off.forEach(function (r) { if (!r.flagPulled && ranked.indexOf(r) < 0) ranked.push(r); });
    if (!ranked.length) return false;

    function sepOf(r) {
      var sep = 99;
      for (var k = 0; k < def.length; k++) {
        if (def[k].flagPulled) continue;
        var q = dist(r, def[k]);
        if (q < sep) sep = q;
      }
      return sep;
    }

    // What counts as open shrinks as the pocket does.
    var want = AI_MIN_SEP;
    if (pressured) want = 1.70;
    if (late) want = Math.min(want, 1.15);

    // Work the read order and take the first man who is open enough.
    for (var j = 0; j < ranked.length; j++) {
      if (sepOf(ranked[j]) >= want) { this.throwTo(ranked[j].slot); return true; }
    }

    // Nobody open. Hold it unless we're out of road.
    if (!pressured && !late && s.snapT < AI_FORCE_THROW_AT) return false;

    // Out of road: force it to the best of a bad set, or throw it away.
    var best = null, bestSep = -1;
    ranked.forEach(function (r) { var q = sepOf(r); if (q > bestSep) { bestSep = q; best = r; } });
    if (late && bestSep < 0.9) { this._throwAway(qb); return true; }
    if (best) { this.throwTo(best.slot); return true; }
    return false;
  };

  /* Out of bounds, deliberately. Costs the down, saves the sack, and cannot be
     intercepted — which is exactly the trade a quarterback is making. */
  Engine.prototype._throwAway = function (qb) {
    var s = this.state;
    this._flash('Thrown away');
    this.onEvent({ type: 'throwaway' });
    /* Where a throwaway goes: OUT. It was aimed half a yard inside the
       touchline, which is a live ball landing in play — the very thing a
       quarterback throwing it away is trying not to do. */
    this._incomplete('Thrown away', { x: qb.x, y: qb.y < FIELD_WID / 2 ? 0 : FIELD_WID });
  };

  /* B3 — PURSUIT ANGLES.

     _aiDefender used to seek the carrier's CURRENT position, so a defender
     chasing someone moving away was always aimed at where they had just been
     and could never close. Real pursuit solves an intercept: where will they be
     when I can get there, given how fast I am? Same quadratic every missile
     guidance problem uses.

     This is what contains the run now that the rusher lines up seven yards off
     the ball where the rule puts them. */
  Engine.prototype._interceptPoint = function (chaser, target, chaserSpeed) {
    var rx = target.x - chaser.x, ry = target.y - chaser.y;
    var vx = target.vx || 0, vy = target.vy || 0;
    var a = vx * vx + vy * vy - chaserSpeed * chaserSpeed;
    var b = 2 * (rx * vx + ry * vy);
    var c = rx * rx + ry * ry;
    var t;
    if (Math.abs(a) < 1e-4) {
      t = (Math.abs(b) < 1e-6) ? 0 : -c / b;
    } else {
      var disc = b * b - 4 * a * c;
      if (disc < 0) t = 0;                       // can't be caught: run at them anyway
      else {
        var sq = Math.sqrt(disc);
        var t1 = (-b + sq) / (2 * a), t2 = (-b - sq) / (2 * a);
        var best = Infinity;
        if (t1 > 0 && t1 < best) best = t1;
        if (t2 > 0 && t2 < best) best = t2;
        t = (best === Infinity) ? 0 : best;
      }
    }
    t = clamp(t, 0, 2.5);
    return {
      x: clamp(target.x + vx * t, 0, FIELD_LEN),
      y: clamp(target.y + vy * t, 0, FIELD_WID)
    };
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
      if (tgt === s.carrier && tgt !== s.passer) {
        var bspd = this.speedYds(d.data.speed) * this.staminaScale(d);
        tgt = this._interceptPoint(d, tgt, bspd);
      }
      this._seek(d, tgt, dt, 1.0);
      return;
    }
    /* D1 — NOT EVERYONE BREAKS ON THE THROW.

       The moment the ball was airborne all five defenders were sent at the
       catch point, so zone discipline, trail technique and second-level help
       all evaporated on every single pass. Only a defender who can plausibly
       get there plays it: the man covering the target, or anyone close enough
       to the arrival point to matter. Everybody else stays in coverage, which
       is what leaves someone home when the ball goes somewhere else. */
    if (s.ball && s.ball.inAir) {
      var to = s.ball.to;
      var covering = (d.cover && d.cover === s.thrownTo);
      var reachable = Math.hypot(to.x - d.x, to.y - d.y) < BREAK_RADIUS;
      if (covering || reachable) { this._seek(d, to, dt, 1.05); return; }
      // otherwise fall through and keep playing your assignment
    }
    if (s.carrier && s.carrier !== s.passer) {
      // Pursue where the carrier is GOING, not where they are.
      var spd = this.speedYds(d.data.speed) * this.staminaScale(d) *
                ((!this.demo && this.difficulty && d.team !== this.userSide) ? this.difficulty.defSpeed : 1);
      this._seek(d, this._interceptPoint(d, s.carrier, spd), dt, 1.0);
      return;
    }
    if (d.cover) {
      /* Man coverage: shadow, stay goal-side, and hold LEVERAGE — sit a little
         to the inside so the throw has to go to the sideline, where it is
         harder and where the boundary helps. Coverage had no concept of a side
         to defend before; a defender simply stood on the receiver. */
      var c = d.cover;
      d.shuf = (d.shuf || 0) + dt;
      var inside = (c.y < FIELD_WID / 2) ? 1 : -1;      // toward the middle
      var target = { x: c.x + 0.6 + Math.sin(d.shuf * 1.9) * 0.35,
                     y: c.y + inside * 0.75 + Math.cos(d.shuf * 1.5) * 0.45 };
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
    var z1 = b.z1 == null ? 0 : b.z1;
    b.t += dt;
    /* A THROWN BALL IS NOT ON THE FIELD, so it isn't held to it. These two
       were clamped, which meant a pass aimed at the sideline curved back in
       and landed inbounds — you could not throw one away, and a ball you
       watched sail toward the touchline turned round in mid-air and came
       home. It flies where it was thrown; whether that is in play is decided
       when it arrives. */
    b.x = b.from.x + b.dirx * b.hv * b.t;
    b.y = b.from.y + b.diry * b.hv * b.t;
    b.z = Math.max(z1, (b.z0 || 0) + b.vz * b.t - 0.5 * GRAVITY * b.t * b.t);
    if (b.t >= b.dur || (b.z <= z1 && b.t > 0.05)) { b.z = z1; this._resolveCatch(); }
  };

  /* C2 — THE CATCH IS CONTESTED IN SPACE, NOT DECIDED BY A COIN FLIP.

     This used to run once at arrival and settle the whole thing with a single
     Math.random() against a probability assembled from ratings and distances.
     A defender who was *right there* only shifted a number; nothing was
     actually contested.

     Now every player near the arrival point plays the ball, and the best play
     on it wins. Each gets a score from how close they are, whether they're
     facing it, how fast they're closing, and the right rating for their job —
     hands for a receiver, the ability to break it up for a defender. Drops,
     tips, break-ups and contested catches all fall out of the same comparison
     instead of each needing a branch. */
  var CATCH_RADIUS = 2.4;                 // yards from the ball you can play it
  var CATCH_NEED = 0.495;                  // how good the play on it has to be
  var DEF_READ = 0.96;                    // a defender's expectation, vs 1.0 for the target

  Engine.prototype._resolveCatch = function () {
    var s = this.state, b = s.ball;
    var receiver = s.thrownTo;
    b.inAir = false;
    var pt = { x: b.x, y: b.y };
    var off = this.offenseTeam();

    /* A CATCH HAS TO BE MADE IN BOUNDS. A player is always on the field (they
       are clamped there), so what decides this is where the BALL came down:
       past the touchline or out of the back of the end zone and nobody can
       legally have caught it, however close they were standing. A pitch is
       different — it is a live ball, and one that goes out is dead at the spot
       it left the field, not an incompletion. */
    if (pt.y < 0 || pt.y > FIELD_WID || pt.x < 0 || pt.x > FIELD_LEN) {
      var edge = { x: clamp(pt.x, 0, FIELD_LEN), y: clamp(pt.y, 0, FIELD_WID) };
      s.clockStops = true;
      if (b.lateral) { this._flash('Pitch out of bounds'); this._endPlay(edge.x, true); return; }
      this._incomplete('Incomplete — out of bounds', edge);
      return;
    }

    var contenders = [];
    for (var i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      if (p.flagPulled) continue;
      var d = dist(p, pt);
      if (d > CATCH_RADIUS) continue;
      var isOff = (p.team === off);

      var reach = 1 - d / CATCH_RADIUS;                       // 0..1
      var skill = isOff ? (p.data.catch / 100)
                        : (p.data.pull * 0.7 + p.data.catch * 0.3) / 100;
      // Facing the ball matters: you cannot catch what's behind your head.
      var sp = Math.hypot(p.vx || 0, p.vy || 0);
      var face = 1;
      if (sp > 0.5) {
        var tox = pt.x - p.x, toy = pt.y - p.y, tm = Math.hypot(tox, toy) || 1;
        var dot = ((p.vx || 0) * tox + (p.vy || 0) * toy) / (sp * tm);
        face = 0.62 + 0.38 * clamp((dot + 1) / 2, 0, 1);
      }
      // The intended receiver knows it's coming; everyone else is reacting.
      /* A defender is reacting rather than expecting it, but not by as much as
         0.80 implied — at that value one standing alone at the arrival point
         still could not clear the bar, which is why nothing was ever picked
         off. DEF_READ is what a defender's read is worth. */
      var expectation = (p === receiver) ? 1.0 : (isOff ? 0.72 : DEF_READ);
      /* THE UNDERCUT — where interceptions actually come from. A defender who
         is covering the intended man and has got IN FRONT of them, between the
         receiver and the thrower, has read the route and jumped it. Without
         this a defender can only ever arrive alongside and contest, which is a
         break-up; nothing was ever picked off. */
      var undercut = 0;
      if (!isOff && receiver && p.cover === receiver && b.from) {
        var dp = Math.hypot(p.x - b.from.x, p.y - b.from.y);
        var dr = Math.hypot(receiver.x - b.from.x, receiver.y - b.from.y);
        if (dp < dr - 0.3) undercut = clamp((dr - dp) * 0.30, 0, 0.35);
      }
      var bonus = ((!this.demo && isOff && p.team === this.userSide) ? this.difficulty.catchBonus : 0) + undercut;
      var score = reach * (0.45 + 0.55 * skill) * face * expectation
                * (0.72 + 0.56 * Math.random()) + bonus;
      contenders.push({ p: p, isOff: isOff, score: score, d: d });
    }

    if (!contenders.length) {
      // A pitch nobody gathered is a dead ball at the spot, not an incompletion.
      if (b.lateral) { this._flash('Pitch goes loose'); this._endPlay(pt.x, true); return; }
      this._incomplete('Incomplete', pt); return;
    }
    contenders.sort(function (a, c) { return c.score - a.score; });
    var best = contenders[0];

    // Contested: being closely challenged makes the play harder for whoever
    // gets to it first, which is where drops and break-ups come from.
    var rival = contenders[1];
    var contest = rival ? clamp(rival.score / Math.max(0.01, best.score), 0, 1) * 0.35 : 0;
    var need = CATCH_NEED + contest;

    if (best.score < need) {
      if (rival && !best.isOff) this._incomplete('Broken up by ' + best.p.last + '!', pt);
      else if (!best.isOff) this._incomplete('Broken up by ' + best.p.last + '!', pt);
      else this._incomplete(best.p === receiver ? 'Dropped by ' + best.p.last : 'Incomplete', pt);
      return;
    }

    if (best.isOff) {
      best.p.hasBall = true;
      s.carrier = best.p;
      s.thrownTo = best.p;
      s.ball.x = best.p.x; s.ball.y = best.p.y; s.ball.z = 0;
      this._flash('Caught by ' + best.p.last + '!');
      this.onEvent({ type: 'catch', player: best.p });
    } else {
      var pick = best.p;
      var scale = this.difficulty ? this.difficulty.intScale : 1;
      // Even a clean read is dropped sometimes; intScale keeps difficulty honest.
      if (Math.random() < clamp(0.55 * scale + 0.35, 0.2, 0.95)) {
        this._turnover('INTERCEPTED by ' + pick.last + '!', pick);
      } else {
        this._incomplete('Broken up by ' + pick.last + '!', pt);
      }
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

  /* A8 — LATERALS. A pitch backwards is legal anywhere on the field and is a
     staple of this sport; only the pre-baked 'reverse' trick play approximated
     one, and it didn't model a pitch at all. Any carrier can flick it back to
     a trailing team-mate: the ball genuinely travels, and a pitch with nobody
     behind you simply isn't thrown. */
  var PITCH_RANGE = 9;

  Engine.prototype.pitch = function () {
    var s = this.state;
    var c = s && s.carrier;
    if (!c || s.phase !== 'live' || (s.ball && s.ball.inAir) || s.pendingThrow) return false;
    var back = null, bestD = 1e9;
    for (var i = 0; i < s.players.length; i++) {
      var p = s.players[i];
      if (p === c || p.team !== c.team || p.flagPulled) continue;
      // A lateral is a BACKWARDS pass; forward from a runner is not legal.
      if (p.x >= c.x - 0.6) continue;
      var d = dist(p, c);
      if (d <= PITCH_RANGE && d < bestD) { bestD = d; back = p; }
    }
    if (!back) { this._flash('Nobody back there'); return false; }

    /* A pitch is flicked from where the ball is being carried and gathered at
       the same height, so it leaves and arrives at CATCH_Z. The loft is solved
       from the distance rather than fixed: it used to launch at a flat 1.2yd/s
       whatever the range, which brought the ball back down after 0.22s — so
       any pitch longer than about three yards died in mid-air short of the
       man it was thrown to. Now it arrives when it gets there. */
    var d2 = Math.max(0.5, bestD), speed = 16;
    var pdur = d2 / speed;
    s.ball = {
      x: c.x, y: c.y, z: CATCH_Z, inAir: true, lateral: true,
      from: { x: c.x, y: c.y }, to: { x: back.x, y: back.y },
      dirx: (back.x - c.x) / d2, diry: (back.y - c.y) / d2,
      hv: speed, vz: GRAVITY * pdur / 2, z0: CATCH_Z, z1: CATCH_Z,
      t: 0, dur: pdur, thrower: c, targetSlot: back.slot
    };
    c.hasBall = false;
    s.carrier = null;
    s.thrownTo = back;
    this._flash('Pitch to ' + back.last + '!');
    this.onEvent({ type: 'pitch', from: c, to: back });
    return true;
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

    /* A real weight shift: shove momentum sideways, across the engagement, and
       let the movement model deal with the consequences. The carrier now has
       lateral velocity they have to steer out of, which is what a cut costs —
       and because a hard turn sheds speed, breaking one way genuinely gives
       something up to gain the separation. */
    var dx, dy;
    if (held) { dx = c.x - held.x; dy = c.y - held.y; }
    else { dx = -(c.vy || 0); dy = (c.vx || 1); }
    var m = Math.hypot(dx, dy) || 1;
    var burst = 7.0 * (held ? eff : 0.5);
    c.vx = (c.vx || 0) + (-dy / m) * burst;   // perpendicular to the engagement
    c.vy = (c.vy || 0) + (dx / m) * burst;
    /* A cut REDIRECTS momentum, it does not manufacture it. Without this cap
       the sideways shove simply adds to the carrier's speed and the juke turns
       into a free burst of pace — measured as yards-per-run jumping from 8.0
       back to 11.1. Capping at their own top speed means breaking sideways is
       paid for out of going forwards, which is what a cut is. */
    var maxSp = this.speedYds(c.data.speed) * this.staminaScale(c);
    var sp = Math.hypot(c.vx, c.vy);
    if (sp > maxSp) { c.vx = c.vx / sp * maxSp; c.vy = c.vy / sp * maxSp; }

    c.jukeFx = 0.35;                       // renderer/UX cue
    this._flash(held ? 'Juke!' : 'Sidestep');
    this.onEvent({ type: 'juke', player: c, broke: !!held });
    return true;
  };

  Engine.prototype._flagPull = function (defender, carrier) {
    var s = this.state;
    s.stats[this.defenseTeam()].tackles++;
    /* NOBODY'S FLAG HAS EVER COME OFF. `flagPulled` is initialised to false on
       every player at every snap, read in a dozen places, and was set to true
       in exactly none of them. So the flag came off in the scoreline and
       nowhere else: no flag burst, no reaction from the carrier, and no
       celebration from the defender, because the renderer's entire flag-pull
       branch is gated on this flag and it never once fired.

       `pullFx` is the defender's cue, on the same pattern as jukeFx — a short
       countdown ticked down in _updateTimers, which the renderer turns into
       the reaching-and-ripping animation. The renderer used to guess who made
       the play by finding the nearest opponent; it is told now. */
    carrier.flagPulled = true;
    defender.pullFx = 0.9;
    defender.grabbing = false;
    s.grabbedBy = null;
    s.grabProgress = 0;
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

  /* THE RULES THAT MAKE IT FLAG FOOTBALL RATHER THAN ARCADE TACKLE.

     A1 — the 7 second pass clock. IFAF gives the passer 7 seconds to get rid
     of it; if it doesn't come out the play is dead and it's a loss of down.
     This is the rule that makes the sport a timed read instead of a scramble
     drill, and nothing modelled it.

     A3 — the original passer may not advance the ball past the line of
     scrimmage. They may scramble laterally and behind it all they like.

     A2 (second half) — a defender who did not line up 7 yards back may not
     cross the line while the passer still has the ball. Illegal rush: five
     yards and replay the down. */
  /* B2 — SOFT SEPARATION.

     There was no collision code anywhere in the repo, so a defender and a
     receiver could stand in the same yard and render as one merged figure.

     Blocking is illegal in flag football, so this deliberately is NOT a
     blocking system: it is positional only, applied equally to both bodies,
     with no momentum transfer and no effect on velocity. You cannot lean on
     someone to move them — you can only fail to stand inside them. The radius
     is a little under the flag-pull reach, so it never pushes a defender out
     of range of a grab they had earned. */
  var BODY_R = 0.45;
  var BREAK_RADIUS = 9;                  // how near the catch you must be to leave coverage
  var SEP_PUSH = 6.0;                    // yd/s of mutual avoidance at full overlap
  var SEP_SLIDE_MAX = 0.5;               // cap on any single positional correction
  var SEP_PASSES = 4;                    // relaxation iterations per frame

  Engine.prototype._separate = function (dt) {
    var ps = this.state.players;
    if (!ps) return;
    /* Relaxed a few times over. One pass fixes each pair in isolation, but
       resolving A against B moves A into C — in a pile of three or more a
       single pass leaves bodies still inside each other (measured: two players
       0.098yd apart in a 0.9yd body). Iterating settles the whole pile, and
       costs nothing to do because the renderer now animates real displacement,
       so a firm positional correction no longer shows up as a slide. */
    for (var pass = 0; pass < SEP_PASSES; pass++) this._separatePass(dt / SEP_PASSES);
  };

  Engine.prototype._separatePass = function (dt) {
    var ps = this.state.players;
    for (var i = 0; i < ps.length; i++) {
      var a = ps[i];
      if (a.flagPulled) continue;
      for (var j = i + 1; j < ps.length; j++) {
        var b = ps[j];
        if (b.flagPulled) continue;
        var dx = b.x - a.x, dy = b.y - a.y;
        var d2 = dx * dx + dy * dy;
        var min = BODY_R * 2;
        if (d2 >= min * min || d2 < 1e-8) continue;
        var d = Math.sqrt(d2);
        var ux = dx / d, uy = dy / d;
        var overlap = (min - d) / min;              // 0..1

        /* Resolve it in VELOCITY, not by teleporting the bodies apart.
           This used to move x/y directly and leave vx/vy alone, so a player
           being separated slid sideways across the turf while their stride and
           their facing both still followed a velocity that knew nothing about
           it — measured at 5.7% of all moving frames more than 25 degrees off,
           which is precisely the skating you can see. Steering away from
           someone is something the legs can express; being shoved is not.

           Still not a block: it is equal and opposite, it scales only with how
           far inside each other they are, and neither player can aim it. */
        var push = SEP_PUSH * overlap * dt;
        a.vx -= ux * push; a.vy -= uy * push;
        b.vx += ux * push; b.vy += uy * push;

        /* And a hard positional guarantee, because the avoidance above can
           never win against an AI that is deliberately seeking the very player
           it is overlapping — a defender closing for the flag pull is supposed
           to arrive. This part is what stops two bodies merging into one
           figure; it no longer causes a slide because the renderer animates
           actual displacement (rvx/rvy below) rather than intent. */
        var fix = Math.min((min - d) * 0.5, SEP_SLIDE_MAX);
        a.x = clamp(a.x - ux * fix, 0, FIELD_LEN); a.y = clamp(a.y - uy * fix, 0, FIELD_WID);
        b.x = clamp(b.x + ux * fix, 0, FIELD_LEN); b.y = clamp(b.y + uy * fix, 0, FIELD_WID);
      }
    }
  };

  Engine.prototype._checkRules = function (dt, def) {
    var s = this.state;
    var c = s.carrier;
    if (!c) return;
    var passer = s.passer;

    if (c === passer && !s.handoffDone) {
      // A1 — out of time
      if (s.snapT >= PASS_CLOCK) {
        this._flash('Seven seconds — dead ball!');
        this.onEvent({ type: 'passclock' });
        this._endPlay(s.losX, true);
        return;
      }
      // A3 — the passer crossing the line kills the play at the line
      if (c.x > s.losX + 0.35) {
        c.x = s.losX;
        this._flash('Passer past the line — dead ball!');
        this.onEvent({ type: 'passerpastline' });
        this._endPlay(s.losX, true);
        return;
      }
      // A2 — anyone rushing who didn't earn the right to
      for (var i = 0; i < def.length; i++) {
        var d = def[i];
        if (d.blitz || d.flagPulled) continue;
        if (d.x < s.losX - 0.5) { this._illegalRush(d); return; }
      }
    }
  };

  /* A7 — FLAG GUARDING, the defining offensive foul of the sport: the carrier
     shielding their flags from the defender. Modelled where it actually
     happens — while someone has a grip on you and you are swatting them off.
     Ten yards from the spot and a loss of down. */
  Engine.prototype._flagGuard = function (c, d) {
    var s = this.state;
    this._flash(c.last + ' guarded the flag — 10 yards');
    this.onEvent({ type: 'penalty', kind: 'flag-guard', player: c });
    s.yardsToGoal = clamp(s.yardsToGoal + 10, 1, 50);
    this._endPlay(GOAL_R - s.yardsToGoal, true);
  };

  Engine.prototype._illegalRush = function (d) {
    var s = this.state;
    this._flash('Illegal rush on ' + d.last + ' — 5 yards');
    this.onEvent({ type: 'penalty', kind: 'illegal-rush', player: d });
    s.penaltyReplay = true;                       // same down, ball moved on
    s.yardsToGoal = clamp(s.yardsToGoal - 5, 1, 50);
    this._endPlay(GOAL_R - s.yardsToGoal, true);
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
    /* OUT OF BOUNDS — also stops the clock.

       This used to fire on the carrier being within 0.4 yards of the sideline,
       which is not the rule and cost the offence a strip of field on both
       touchlines: half a yard inside the paint is inbounds and playable, and
       working the sideline is one of the things a 30-yard field is FOR. It
       also never ended a play at the right spot, because it triggered before
       the crossing rather than at it.

       _steer records the frame in which a step would genuinely have carried a
       body over the line, and where (see `outOfBounds` / `outAt`), so the
       whistle goes exactly where the player left the field. */
    if (c.outOfBounds) {
      s.clockStops = true;
      var spot = c.outAt || { x: c.x, y: c.y };
      // Leaving the field inside your own end zone is a safety, for the same
      // reason losing your flag back there is.
      if (spot.x <= GOAL_L) { this._flash('Out of bounds in the end zone — SAFETY!'); this._safety(); return; }
      this._flash('Out of bounds');
      this._endPlay(spot.x, false);
    }
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
    // A conversion is one play: it either reached the end zone or it didn't.
    if (s.patActive) { this._endPAT(false); return; }
    this.runPlayClock(s.snapT || 0, !!s.clockStops);
    s.clockStops = false;
    if (s.gameOver) return;

    /* FOUR DOWNS TO CROSS MIDFIELD, THREE TO SCORE ONCE YOU HAVE. The second
       half of that rule was missing — a team that had crossed got four downs
       to score as well, which is a whole extra play on every drive in the
       half of the field where drives are decided. */
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
      if (s.down > 3) return this._turnoverOnDowns();
    }
    this._nextSnap();
  };

  Engine.prototype._incomplete = function (msg, pt) {
    this.state.clockStops = true;        // incomplete stops it inside two minutes
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
    // Picked off on a conversion: the conversion simply failed.
    if (s.patActive) { setTimeout(function () { this._endPAT(false); }.bind(this), 1200); return; }
    if (s.overtime) {
      setTimeout(function () { if (!this._otPossessionOver()) this._nextSnap(); }.bind(this), 1200);
      return;
    }
    setTimeout(function () {
      s.possession = this.defenseTeam();
      s.yardsToGoal = clamp(50 - s.yardsToGoal, 8, 45);
      s.down = 1; s.crossedMid = false;
      this.runPlayClock(s.snapT || 0, false);
      this._nextSnap();
    }.bind(this), 1200);
  };

  Engine.prototype._turnoverOnDowns = function () {
    this._flash('Turnover on downs!');
    var s = this.state;
    // This burned no clock whatever, so a change of downs was free time.
    this.runPlayClock(s.snapT || 0, false);
    if (s.patActive) { setTimeout(function () { this._endPAT(false); }.bind(this), 1200); return; }
    if (s.overtime) {
      setTimeout(function () { if (!this._otPossessionOver()) this._nextSnap(); }.bind(this), 1200);
      return;
    }
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
    if (s.patActive) {            // crossing the line on a conversion is the conversion
      this.onEvent({ type: 'touchdown', team: off, pat: true });
      setTimeout(function () { this._endPAT(true); }.bind(this), 900);
      return;
    }
    s.score[off] += 6;
    s.stats[off].td++;
    this._flash('TOUCHDOWN ' + s[off].abbr + '!  🎉');
    this.anim.push({ type: 'td', t: 0, dur: 1.4 });
    this.onEvent({ type: 'touchdown', team: off });
    setTimeout(function () { this._startPAT(off); }.bind(this), 1500);
  };

  /* A5 — THE EXTRA POINT IS A PLAY.

     There is no kicking of any kind in flag football, and this used to be
     resolved with `Math.random() < 0.92`. It's a real snap: from the 5 for one
     point, or from the 10 for two, against a defence, and it is the first
     genuinely interesting risk decision in the game. */
  Engine.prototype._startPAT = function (team) {
    var s = this.state;
    if (s.gameOver) return;
    s.patActive = true;
    s.patTeam = team;
    s.possession = team;
    s.down = 1;
    s.crossedMid = true;                 // no line-to-gain logic on a conversion
    s.offPlay = null; s.defPlay = null;
    var userChooses = !this.demo && team === this.userSide;
    if (userChooses) {
      // Ask; the UI calls choosePAT(). Until then the play doesn't start.
      s.patChoicePending = true;
      s.phase = 'patchoice';
      this.onEvent({ type: 'patchoice', team: team });
    } else {
      this.choosePAT(this._cpuPATChoice(team));
    }
  };

  /* Down two late? Go for two. Otherwise take the point. */
  Engine.prototype._cpuPATChoice = function (team) {
    var s = this.state;
    var other = team === 'home' ? 'away' : 'home';
    var margin = s.score[team] - s.score[other];
    var late = (s.quarter >= s.quarters);
    if (late && (margin === -2 || margin === -8 || margin === 1)) return 2;
    return (Math.random() < 0.12) ? 2 : 1;
  };

  Engine.prototype.choosePAT = function (points) {
    var s = this.state;
    if (!s.patActive) return false;
    s.patPoints = (points === 2) ? 2 : 1;
    s.patChoicePending = false;
    s.yardsToGoal = (s.patPoints === 2) ? 10 : 5;
    s.phase = 'playcall';
    this._flash('Going for ' + s.patPoints + ' from the ' + s.yardsToGoal);
    this.onEvent({ type: 'patstart', points: s.patPoints });
    return true;
  };

  /* Conversion over, either way. Hand the ball to the other side. */
  Engine.prototype._endPAT = function (good) {
    var s = this.state;
    var team = s.patTeam;
    if (good) {
      s.score[team] += s.patPoints;
      this._flash(s.patPoints + '-point conversion GOOD!');
    } else {
      this._flash('Conversion no good');
    }
    this.onEvent({ type: 'patresult', good: !!good, points: s.patPoints });
    s.patActive = false; s.patTeam = null; s.patChoicePending = false;
    this.runPlayClock(s.snapT || 0, false);
    if (s.gameOver) return;
    if (s.overtime) { if (this._otPossessionOver()) return; this._nextSnap(); return; }
    s.possession = team === 'home' ? 'away' : 'home';
    s.yardsToGoal = 45; s.down = 1; s.crossedMid = false;
    this._nextSnap();
  };

  Engine.prototype._safety = function () {
    var s = this.state;
    if (s.patActive) { this._endPAT(false); return; }
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
  /* A6 — THE CLOCK.

     It used to burn a flat 28 + rand*8 seconds per play whatever happened,
     which is why a whole game was 23 plays. The clock runs CONTINUOUSLY in
     this sport: the time a play actually took, plus the time taken to line up
     again — and inside the last two minutes it stops on an incomplete pass, a
     player going out of bounds, or a score, which is what makes a two-minute
     drill possible at all. */
  var HUDDLE = 40;                       // seconds between plays with the clock running
  var LAST_TWO = 120;                    // when the clock starts stopping

  Engine.prototype.runPlayClock = function (playSeconds, stopsClock) {
    var s = this.state;
    var burn = playSeconds || 0;
    var inLastTwo = (s.clock <= LAST_TWO) && (s.quarter >= s.quarters || s.overtime);
    if (!(inLastTwo && stopsClock)) burn += HUDDLE;
    this._runClock(burn);
  };

  Engine.prototype._runClock = function (sec) {
    var s = this.state;
    if (s.overtime) return;              // OT is untimed: possessions, not a clock
    s.clock -= sec;
    while (s.clock <= 0) {
      if (s.quarter >= s.quarters) {
        if (s.score.home === s.score.away) { this._startOvertime(); return; }
        s.clock = 0; this._gameOver(); return;
      }
      s.quarter++; s.clock += (this.cfg.halfLen || this.cfg.quarterLen || 1200);
      this._flash('End of ' + (s.halves ? ('H' + (s.quarter - 1)) : ('Q' + (s.quarter - 1))));
    }
  };

  /* IFAF overtime: alternating possessions from the 5-yard line, no clock.
     Flagster played a 90-second sudden-death period, which is not the rule and
     is not how anyone experiences the end of a tied game. */
  Engine.prototype._startOvertime = function () {
    var s = this.state;
    s.overtime = true;
    s.clock = 0;
    s.otRound = 1;
    s.otFirst = s.possession;
    s.otScoreAtRoundStart = { home: s.score.home, away: s.score.away };
    s.quarter = s.quarters + 1;
    this._flash('OVERTIME — alternating possessions from the 5');
    this.onEvent({ type: 'overtime', round: 1 });
  };

  /* Called when a possession ends in overtime. Each side gets one; if they're
     still level after both, go again. */
  Engine.prototype._otPossessionOver = function () {
    var s = this.state;
    if (!s.overtime) return false;
    var secondOfRound = (s.possession !== s.otFirst);
    if (secondOfRound) {
      if (s.score.home !== s.score.away) { this._gameOver(); return true; }
      s.otRound++;
      this.onEvent({ type: 'overtime', round: s.otRound });
      this._flash('Overtime — round ' + s.otRound);
    }
    s.possession = (s.possession === 'home') ? 'away' : 'home';
    s.yardsToGoal = 5; s.down = 1; s.crossedMid = true;
    return false;
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
  /* A4 — no-run zones. Running is prohibited in the 5 yards before either goal
     line and the 5 before midfield, precisely so a team can't power it over
     the line to gain. Returns the plays that are legal from this spot. */
  Engine.prototype.legalPlays = function () {
    var s = this.state;
    var all = D.PLAYS;
    if (!s) return all;
    var ytg = s.yardsToGoal;
    var toLine = s.crossedMid ? ytg : (ytg - 25);      // yards to the line to gain
    /* Inside 5 of the end zone you're attacking, or either side of the line to
       gain. The own-goal bound is strict rather than inclusive so that the
       standard spot — yardsToGoal 45, exactly 5 out from your own line — is
       still a legal place to hand the ball off; otherwise nearly every drive
       would open unable to run. */
    var inNoRun = (ytg <= NO_RUN_ZONE) || (Math.abs(toLine) <= NO_RUN_ZONE) || (ytg > 50 - NO_RUN_ZONE);
    if (!inNoRun) return all;
    var pass = all.filter(function (p) { return /pass/.test(p.type); });
    return pass.length ? pass : all;
  };

  Engine.prototype.inNoRunZone = function () { return this.legalPlays().length !== D.PLAYS.length; };

  Engine.prototype.autoCall = function () {
    var s = this.state;
    if (!s || s.phase !== 'playcall') return;
    var legal = this.legalPlays();
    s.offPlay = legal[Math.floor(Math.random() * legal.length)];
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
      if (k === 'l') self.action('pitch');
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
        if (a === 'pitch') this.pitch();
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
