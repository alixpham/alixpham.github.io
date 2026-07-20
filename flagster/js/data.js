/* ============================================================================
   FLAGSTER — DATA LAYER
   2028 Olympic flag football nations, rosters, plays, archetypes, jerseys.

   NOTE ON REALISM: The 2028 LA Olympics flag football rosters have not been
   named yet, and real athlete "face scans" are not licensable for a fan game.
   So Flagster ships stylized generated avatars + representative rosters built
   from the nations expected to contend, with Madden-style last-name labels.
   ============================================================================ */
(function (global) {
  'use strict';

  // ---- Positions (5v5 IFAF Olympic flag football) --------------------------
  var OFFENSE_POS = ['QB', 'C', 'WR', 'WR', 'RB'];   // 5 on the field
  var DEFENSE_POS = ['RUSH', 'MLB', 'CB', 'CB', 'S']; // 5 on the field

  var POS_INFO = {
    QB:   { name: 'Quarterback',        side: 'off', canCatch: false },
    C:    { name: 'Center',             side: 'off', canCatch: true, noBlock: true },
    WR:   { name: 'Wide Receiver',      side: 'off', canCatch: true },
    RB:   { name: 'Running Back',       side: 'off', canCatch: true },
    RUSH: { name: 'Rusher',             side: 'def' },
    MLB:  { name: 'Middle Linebacker',  side: 'def' },
    CB:   { name: 'Cornerback',         side: 'def' },
    S:    { name: 'Safety',             side: 'def' }
  };

  // ---- Nations (expected LA28 contenders + qualifiers) ---------------------
  // colors: [jersey primary, secondary/accent]
  var NATIONS = [
    { id: 'USA', name: 'United States', flag: '🇺🇸', colors: ['#1b2a6b', '#ffffff'], alt: ['#ffffff', '#b31942'], rating: 95 },
    { id: 'MEX', name: 'Mexico',        flag: '🇲🇽', colors: ['#006847', '#ffffff'], alt: ['#ce1126', '#ffffff'], rating: 90 },
    { id: 'CAN', name: 'Canada',        flag: '🇨🇦', colors: ['#d80621', '#ffffff'], alt: ['#ffffff', '#d80621'], rating: 84 },
    { id: 'FRA', name: 'France',        flag: '🇫🇷', colors: ['#0055a4', '#ffffff'], alt: ['#ffffff', '#ef4135'], rating: 82 },
    { id: 'GER', name: 'Germany',       flag: '🇩🇪', colors: ['#111111', '#dd0000'], alt: ['#ffce00', '#111111'], rating: 83 },
    { id: 'ITA', name: 'Italy',         flag: '🇮🇹', colors: ['#0072bb', '#ffffff'], alt: ['#ffffff', '#009246'], rating: 80 },
    { id: 'GBR', name: 'Great Britain', flag: '🇬🇧', colors: ['#00247d', '#cf142b'], alt: ['#ffffff', '#00247d'], rating: 79 },
    { id: 'JPN', name: 'Japan',         flag: '🇯🇵', colors: ['#bc002d', '#ffffff'], alt: ['#ffffff', '#bc002d'], rating: 86 },
    { id: 'AUS', name: 'Australia',     flag: '🇦🇺', colors: ['#00843d', '#ffcd00'], alt: ['#ffcd00', '#00843d'], rating: 78 },
    { id: 'BRA', name: 'Brazil',        flag: '🇧🇷', colors: ['#009c3b', '#ffdf00'], alt: ['#ffdf00', '#002776'], rating: 77 },
    { id: 'AUT', name: 'Austria',       flag: '🇦🇹', colors: ['#ed2939', '#ffffff'], alt: ['#ffffff', '#ed2939'], rating: 81 },
    { id: 'DEN', name: 'Denmark',       flag: '🇩🇰', colors: ['#c8102e', '#ffffff'], alt: ['#ffffff', '#c8102e'], rating: 76 },
    { id: 'ISR', name: 'Israel',        flag: '🇮🇱', colors: ['#0038b8', '#ffffff'], alt: ['#ffffff', '#0038b8'], rating: 78 },
    { id: 'PAN', name: 'Panama',        flag: '🇵🇦', colors: ['#005293', '#da121a'], alt: ['#ffffff', '#005293'], rating: 75 }
  ];

  // ---- Name pools per nation (for generated but nation-flavored rosters) ----
  var LAST_NAMES = {
    USA: ['Carter','Brooks','Hayes','Reed','Mitchell','Turner','Coleman','Bryant','Foster','Grant','Wallace','Pierce'],
    MEX: ['Ramírez','Hernández','Vega','Castillo','Morales','Ortiz','Reyes','Guzmán','Flores','Núñez','Salazar','Ríos'],
    CAN: ['Tremblay','Gagnon','Roy','Côté','Bergeron','Fortin','Leblanc','Mercer','Doucet','Boivin','Nadeau','Poulin'],
    FRA: ['Dubois','Laurent','Moreau','Girard','Lefevre','Rousseau','Mercier','Bernard','Faure','Renard','Colin','Perrin'],
    GER: ['Müller','Schmidt','Weber','Wagner','Becker','Hoffmann','Schulz','Koch','Richter','Klein','Wolf','Neumann'],
    ITA: ['Rossi','Russo','Ferrari','Esposito','Bianchi','Romano','Colombo','Ricci','Marino','Greco','Bruno','Gallo'],
    GBR: ['Walker','Wright','Robinson','Clarke','Hughes','Baker','Morgan','Cooper','Ward','Bennett','Fox','Shaw'],
    JPN: ['Tanaka','Suzuki','Takahashi','Watanabe','Ito','Nakamura','Kobayashi','Kato','Yoshida','Yamada','Sasaki','Mori'],
    AUS: ['Nguyen','Kelly','Ryan','Cameron','Hunter','Marsh','Dixon','Ellis','Reid','Barnes','Steele','Chapman'],
    BRA: ['Silva','Santos','Oliveira','Souza','Costa','Pereira','Almeida','Lima','Gomes','Ribeiro','Carvalho','Rocha'],
    AUT: ['Gruber','Huber','Bauer','Wagner','Steiner','Moser','Berger','Fischer','Winkler','Lang','Egger','Wimmer'],
    DEN: ['Jensen','Nielsen','Hansen','Andersen','Larsen','Kristensen','Madsen','Sørensen','Møller','Holm','Dahl','Bech'],
    ISR: ['Cohen','Levi','Mizrahi','Peretz','Biton','Avraham','Friedman','Katz','Shapira','Barak','Golan','Ronen'],
    PAN: ['Barría','Quintero','Cedeño','Villarreal','Sánchez','Pinzón','Delgado','Aguilar','Batista','Espinoza','Serrano','Caballero']
  };
  var FIRST_NAMES = {
    common: ['A.','J.','M.','D.','K.','R.','L.','T.','C.','B.','S.','E.'],
    JPN: ['Y.','H.','K.','R.','T.','S.','D.','N.','M.','A.','K.','R.']
  };

  // Deterministic pseudo-random so rosters are stable across sessions.
  function seeded(seed) {
    var s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  }
  function hashStr(str) { var h = 0, i; for (i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; } return Math.abs(h) + 1; }

  // Player template. Ratings scale with nation strength.
  function makePlayer(nationId, idx, pos, rnd, baseline) {
    var lasts = LAST_NAMES[nationId];
    var firsts = FIRST_NAMES[nationId] || FIRST_NAMES.common;
    var last = lasts[idx % lasts.length];
    var first = firsts[idx % firsts.length];
    function stat(spread) { return Math.max(55, Math.min(99, Math.round(baseline + (rnd() * 2 - 1) * spread))); }
    var speed = stat(9), catch_ = stat(10), thr = stat(12), agi = stat(9), aware = stat(8), pull = stat(9);
    // position tilts
    if (pos === 'QB') { thr = Math.min(99, thr + 6); catch_ = Math.max(40, catch_ - 20); }
    if (pos === 'WR') { catch_ = Math.min(99, catch_ + 6); speed = Math.min(99, speed + 4); }
    if (pos === 'RB') { agi = Math.min(99, agi + 5); speed = Math.min(99, speed + 3); }
    if (pos === 'C')  { catch_ = Math.min(99, catch_ + 2); speed = Math.max(50, speed - 3); }
    if (pos === 'RUSH'){ pull = Math.min(99, pull + 5); speed = Math.min(99, speed + 3); }
    if (pos === 'CB' || pos === 'S') { speed = Math.min(99, speed + 4); pull = Math.min(99, pull + 3); }
    var contrib = POS_INFO[pos].side === 'off'
      ? (pos === 'QB' ? thr * 0.5 + aware * 0.5 : catch_ * 0.4 + speed * 0.35 + agi * 0.25)
      : speed * 0.35 + pull * 0.35 + aware * 0.3;
    var ovr = Math.max(58, Math.min(99, Math.round(contrib)));
    return {
      id: nationId + '-' + idx,
      name: first + ' ' + last,
      last: last,
      pos: pos,
      ovr: ovr,
      speed: speed, catch: catch_, throw: thr, agi: agi, aware: aware, pull: pull,
      nation: nationId
    };
  }

  // Build a full roster (12 players covering both units + depth).
  function buildRoster(nation) {
    var rnd = seeded(hashStr(nation.id));
    var baseline = 60 + (nation.rating - 75) * 0.9;
    var slots = ['QB', 'C', 'WR', 'WR', 'RB', 'WR', 'RUSH', 'MLB', 'CB', 'CB', 'S', 'RB'];
    return slots.map(function (pos, i) { return makePlayer(nation.id, i, pos, rnd, baseline); });
  }

  var ROSTERS = {};
  NATIONS.forEach(function (n) { ROSTERS[n.id] = buildRoster(n); });

  // Roster overrides let Team Builder (franchise) trades change lineups.
  var OVERRIDES = {};
  function setRosterOverride(nationId, players) { OVERRIDES[nationId] = players; }
  function clearOverrides() { OVERRIDES = {}; }
  function rosterOf(nationId) { return OVERRIDES[nationId] || ROSTERS[nationId]; }

  // Offensive starters = first 5 offensive players in canonical order.
  function starters(nationId, side) {
    var roster = rosterOf(nationId);
    function byPos(pos, n) { return roster.filter(function (p) { return p.pos === pos; })[n || 0]; }
    // Fallback: if a trade left a hole, borrow the best remaining player.
    function fill(list) {
      var pool = roster.slice().sort(function (a, b) { return b.ovr - a.ovr; });
      return list.map(function (p) {
        if (p) return p;
        for (var i = 0; i < pool.length; i++) { if (list.indexOf(pool[i]) === -1) return pool[i]; }
        return roster[0];
      });
    }
    if (side === 'off') {
      return fill([byPos('QB'), byPos('C'), byPos('WR', 0), byPos('WR', 1), byPos('RB')]);
    }
    return fill([byPos('RUSH'), byPos('MLB'), byPos('CB', 0), byPos('CB', 1), byPos('S')]);
  }

  function teamOvr(nationId) {
    var r = rosterOf(nationId);
    return Math.round(r.reduce(function (a, p) { return a + p.ovr; }, 0) / r.length);
  }

  /* ---- ROUTES ---------------------------------------------------------------
     Routes are lists of waypoints in "local" yards relative to the receiver's
     start. +x = downfield (toward opponent end zone), +y = toward the right
     sideline. The engine mirrors/scales these to field coordinates.          */
  var R = {
    slant:   [{ x: 2, y: 0 }, { x: 8, y: -6 }],
    out:     [{ x: 6, y: 0 }, { x: 8, y: 7 }],
    in_:     [{ x: 6, y: 0 }, { x: 8, y: -7 }],
    go:      [{ x: 22, y: 0 }],
    post:    [{ x: 10, y: 0 }, { x: 20, y: -8 }],
    corner:  [{ x: 10, y: 0 }, { x: 18, y: 9 }],
    curl:    [{ x: 9, y: 0 }, { x: 7, y: 0 }],
    flat:    [{ x: 1, y: 6 }],
    wheel:   [{ x: 2, y: 6 }, { x: 16, y: 4 }],
    drag:    [{ x: 3, y: 0 }, { x: 6, y: -10 }],
    swing:   [{ x: -1, y: 5 }, { x: 3, y: 9 }],
    block:   [{ x: 0, y: 0 }],
    hitch:   [{ x: 5, y: 0 }, { x: 4, y: 0 }]
  };

  /* ---- PLAYBOOK -------------------------------------------------------------
     Each play assigns a route to the 4 eligible receivers (WR1, WR2, RB, C).
     type: 'pass-short' | 'pass-med' | 'pass-long' | 'run' | 'trick'
     For runs, "carrier" names who takes the handoff.                          */
  var PLAYS = [
    // Short passes
    { id: 'quick-slants', name: 'Quick Slants', type: 'pass-short', icon: '↗',
      routes: { WR1: 'slant', WR2: 'slant', RB: 'flat', C: 'hitch' } },
    { id: 'flat-attack', name: 'Flat Attack', type: 'pass-short', icon: '→',
      routes: { WR1: 'out', WR2: 'drag', RB: 'flat', C: 'curl' } },
    { id: 'double-drag', name: 'Double Drag', type: 'pass-short', icon: '↔',
      routes: { WR1: 'drag', WR2: 'drag', RB: 'swing', C: 'hitch' } },
    // Medium passes
    { id: 'curl-flat', name: 'Curl & Flat', type: 'pass-med', icon: '◠',
      routes: { WR1: 'curl', WR2: 'out', RB: 'flat', C: 'hitch' } },
    { id: 'in-out', name: 'In / Out', type: 'pass-med', icon: '⤨',
      routes: { WR1: 'in_', WR2: 'out', RB: 'wheel', C: 'curl' } },
    { id: 'mesh', name: 'Mesh', type: 'pass-med', icon: '#',
      routes: { WR1: 'drag', WR2: 'in_', RB: 'wheel', C: 'flat' } },
    // Long passes
    { id: 'four-verts', name: 'Four Verticals', type: 'pass-long', icon: '⇈',
      routes: { WR1: 'go', WR2: 'go', RB: 'wheel', C: 'go' } },
    { id: 'post-corner', name: 'Post & Corner', type: 'pass-long', icon: '✕',
      routes: { WR1: 'post', WR2: 'corner', RB: 'flat', C: 'curl' } },
    { id: 'deep-shot', name: 'Deep Shot', type: 'pass-long', icon: '🚀',
      routes: { WR1: 'go', WR2: 'post', RB: 'swing', C: 'hitch' } },
    // Runs
    { id: 'rb-draw', name: 'RB Draw', type: 'run', icon: '🏃', carrier: 'RB',
      routes: { WR1: 'go', WR2: 'go', RB: 'block', C: 'block' } },
    { id: 'qb-sneak', name: 'QB Keeper', type: 'run', icon: '💨', carrier: 'QB',
      routes: { WR1: 'drag', WR2: 'drag', RB: 'flat', C: 'block' } },
    { id: 'sweep', name: 'Sweep', type: 'run', icon: '↻', carrier: 'RB',
      routes: { WR1: 'block', WR2: 'go', RB: 'swing', C: 'block' } },
    // Trick plays
    { id: 'reverse', name: 'Reverse', type: 'trick', icon: '⟲', carrier: 'WR2',
      routes: { WR1: 'go', WR2: 'swing', RB: 'flat', C: 'block' }, trick: 'reverse' },
    { id: 'hb-pass', name: 'RB Option Pass', type: 'trick', icon: '🎲', carrier: 'RB',
      routes: { WR1: 'go', WR2: 'post', RB: 'swing', C: 'flat' }, trick: 'rbpass' },
    { id: 'flea-flicker', name: 'Flea Flicker', type: 'trick', icon: '✨', carrier: 'QB',
      routes: { WR1: 'go', WR2: 'post', RB: 'swing', C: 'curl' }, trick: 'flea' }
  ];

  // Defensive play calls (coverages + blitz).
  var DEF_PLAYS = [
    { id: 'man', name: 'Man Cover', icon: '👤', blitz: 0 },
    { id: 'zone', name: 'Zone Cover', icon: '🛡', blitz: 0 },
    { id: 'blitz', name: 'Blitz', icon: '⚡', blitz: 2 },
    { id: 'prevent', name: 'Prevent Deep', icon: '🚧', blitz: 0, deep: true }
  ];

  // ---- Road to Glory archetypes -------------------------------------------
  var ARCHETYPES = {
    QB:   [{ id: 'gunslinger', name: 'Gunslinger', boost: { throw: 8, aware: 4 } },
           { id: 'scrambler', name: 'Scrambler', boost: { speed: 8, agi: 6 } },
           { id: 'field-general', name: 'Field General', boost: { aware: 10, throw: 4 } }],
    RB:   [{ id: 'power', name: 'Power Back', boost: { pull: 6, aware: 4, speed: 3 } },
           { id: 'elusive', name: 'Elusive', boost: { agi: 10, speed: 4 } },
           { id: 'receiving', name: 'Receiving Back', boost: { catch: 10, speed: 3 } }],
    WR:   [{ id: 'deep-threat', name: 'Deep Threat', boost: { speed: 10, catch: 3 } },
           { id: 'route-tech', name: 'Route Technician', boost: { agi: 8, catch: 6 } },
           { id: 'possession', name: 'Possession', boost: { catch: 10, aware: 4 } }],
    C:    [{ id: 'sure-hands', name: 'Sure Hands', boost: { catch: 10, aware: 5 } },
           { id: 'mobile', name: 'Mobile Center', boost: { speed: 8, agi: 6 } }],
    RUSH: [{ id: 'speed-rush', name: 'Speed Rusher', boost: { speed: 9, pull: 6 } },
           { id: 'bull-rush', name: 'Bull Rusher', boost: { pull: 10, aware: 4 } }],
    MLB:  [{ id: 'thumper', name: 'Thumper', boost: { pull: 8, aware: 6 } },
           { id: 'coverage-lb', name: 'Coverage LB', boost: { speed: 8, agi: 6 } }],
    CB:   [{ id: 'lockdown', name: 'Lockdown', boost: { aware: 8, agi: 6 } },
           { id: 'ballhawk', name: 'Ball Hawk', boost: { speed: 8, pull: 6 } }]
  };

  // Positions the player may pick in Road to Glory.
  var RTG_POSITIONS = [
    { pos: 'QB',   side: 'Offense' },
    { pos: 'RB',   side: 'Offense' },
    { pos: 'WR',   side: 'Offense' },
    { pos: 'C',    side: 'Offense', note: 'Centers can catch and may NOT block.' },
    { pos: 'RUSH', side: 'Defense' },
    { pos: 'MLB',  side: 'Defense' },
    { pos: 'CB',   side: 'Defense' }
  ];

  // ---- Jerseys -------------------------------------------------------------
  function jerseysFor(nationId) {
    var n = NATIONS.filter(function (x) { return x.id === nationId; })[0];
    return [
      { id: 'home', name: 'Home', colors: n.colors },
      { id: 'away', name: 'Away', colors: n.alt },
      { id: 'alt', name: 'Alternate', colors: [n.colors[1], n.colors[0]] }
    ];
  }

  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.data = {
    OFFENSE_POS: OFFENSE_POS, DEFENSE_POS: DEFENSE_POS, POS_INFO: POS_INFO,
    NATIONS: NATIONS, ROSTERS: ROSTERS, ROUTES: R, PLAYS: PLAYS, DEF_PLAYS: DEF_PLAYS,
    ARCHETYPES: ARCHETYPES, RTG_POSITIONS: RTG_POSITIONS,
    starters: starters, teamOvr: teamOvr, jerseysFor: jerseysFor,
    rosterOf: rosterOf, setRosterOverride: setRosterOverride, clearOverrides: clearOverrides,
    buildRoster: buildRoster,
    nationById: function (id) { return NATIONS.filter(function (n) { return n.id === id; })[0]; }
  };
})(window);
