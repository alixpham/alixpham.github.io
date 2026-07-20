/* ============================================================================
   FLAGSTER — TEAM BUILDER (Franchise, Madden-style)
   Create a coach (name + look), pick a country, run seasons: trade players,
   play/sim a schedule, top 6 make the playoffs, win the championship, repeat.
   ============================================================================ */
(function (global) {
  'use strict';
  var F = global.FLAGSTER, ui = F.ui, D = F.data, store = F.storage, h = ui.h;
  var header = function (t, b) { return F.world.header(t, b); };

  var SKINS = ['#f2d3b3', '#e8b98f', '#c68a5e', '#8d5524', '#5c3a1e'];
  var HAIRS = ['#1c1c1c', '#3d2b1f', '#7a4a20', '#c9a227', '#9a9a9a', '#b33'];

  function coachAvatar(coach, size) {
    size = size || 90;
    var c = document.createElement('canvas');
    c.width = size; c.height = size; c.className = 'coach-avatar';
    var g = c.getContext('2d');
    // background disc
    g.fillStyle = coach.accent || '#2a6'; g.beginPath(); g.arc(size/2, size/2, size/2, 0, 7); g.fill();
    // head
    g.fillStyle = SKINS[coach.skin || 0];
    g.beginPath(); g.arc(size/2, size*0.52, size*0.28, 0, 7); g.fill();
    // hair
    g.fillStyle = HAIRS[coach.hair || 0];
    g.beginPath(); g.arc(size/2, size*0.42, size*0.29, Math.PI, 0); g.fill();
    g.fillRect(size*0.21, size*0.36, size*0.58, size*0.1);
    // cap brim (coach!)
    g.fillStyle = coach.accent || '#2a6';
    g.fillRect(size*0.2, size*0.4, size*0.6, size*0.05);
    // eyes
    g.fillStyle = '#222';
    g.beginPath(); g.arc(size*0.42, size*0.54, size*0.03, 0, 7); g.fill();
    g.beginPath(); g.arc(size*0.58, size*0.54, size*0.03, 0, 7); g.fill();
    // smile
    g.strokeStyle = '#7a3b2e'; g.lineWidth = 2;
    g.beginPath(); g.arc(size/2, size*0.6, size*0.09, 0.2, Math.PI - 0.2); g.stroke();
    return c;
  }

  /* ----------------------------- ENTRY ----------------------------------- */
  function start(back) {
    var save = store.get('franchise');
    if (save) resumeMenu(back, save);
    else createCoach(back);
  }

  function resumeMenu(back, save) {
    var nation = D.nationById(save.country);
    ui.show(h('div', { class: 'screen menu-sub' }, [
      header('Team Builder', back),
      h('div', { class: 'resume-card' }, [
        coachAvatar(save.coach, 110),
        h('h2', { text: 'Coach ' + save.coach.name }),
        h('p', { class: 'muted', text: nation.flag + ' ' + nation.name + '  •  Season ' + save.season }),
        h('div', { class: 'result-actions' }, [
          h('button', { class: 'btn primary', text: 'Continue Franchise', onClick: function () { hub(back, save); } }),
          h('button', { class: 'btn danger', text: 'Delete & Start New', onClick: function () {
            if (confirm('Delete your franchise save?')) { store.remove('franchise'); createCoach(back); }
          } })
        ])
      ]),
      ui.controlsButton()
    ]));
  }

  /* ------------------------- CREATE COACH -------------------------------- */
  function createCoach(back) {
    var coach = { name: '', skin: 0, hair: 0, accent: '#2ec77a' };
    var country = null;
    var avatarBox = h('div', { class: 'avatar-box' });
    function drawAvatar() { ui.clear(avatarBox); avatarBox.appendChild(coachAvatar(coach, 130)); }
    drawAvatar();

    function swatches(arr, key, isCanvas) {
      return h('div', { class: 'swatch-row' }, arr.map(function (col, i) {
        return h('button', {
          class: 'swatch' + (coach[key] === i ? ' on' : ''),
          style: { background: col },
          onClick: function () { coach[key] = i; drawAvatar(); refresh(); }
        });
      }));
    }
    var accents = ['#2ec77a', '#3c82ff', '#ff5a5a', '#ffb020', '#a24bff', '#00c2c7'];

    var nameInput = h('input', { class: 'fld', placeholder: 'Coach name', maxlength: 16, oninput: function (e) { coach.name = e.target.value; refresh(); } });

    var countryGrid = h('div', { class: 'team-grid' });
    var startBtn;
    function refresh() {
      ui.clear(countryGrid);
      D.NATIONS.forEach(function (n) {
        countryGrid.appendChild(F.world.teamCard(n, country && country.id === n.id, function (nn) { country = nn; refresh(); }));
      });
      var skinRow = document.getElementById('skinRow');
      if (startBtn) startBtn.disabled = !(coach.name.trim() && country);
    }

    startBtn = h('button', { class: 'btn primary big', text: 'Begin Franchise', disabled: true, onClick: function () {
      if (!coach.name.trim() || !country) return;
      var save = newFranchise(coach, country.id);
      store.set('franchise', save);
      hub(back, save);
    } });

    refresh();
    ui.show(h('div', { class: 'screen create-screen' }, [
      header('Create Your Coach', back),
      h('div', { class: 'create-grid' }, [
        h('div', { class: 'create-left' }, [
          avatarBox,
          h('label', { text: 'Name' }), nameInput,
          h('label', { text: 'Skin' }), swatches(SKINS, 'skin'),
          h('label', { text: 'Hair' }), swatches(HAIRS, 'hair'),
          h('label', { text: 'Team Accent' }),
          h('div', { class: 'swatch-row' }, accents.map(function (col, i) {
            return h('button', { class: 'swatch' + (coach.accent === col ? ' on' : ''), style: { background: col },
              onClick: function () { coach.accent = col; drawAvatar(); } });
          }))
        ]),
        h('div', { class: 'create-right' }, [
          h('h3', { html: '🌍 Choose Your Country' }), countryGrid
        ])
      ]),
      h('div', { class: 'sel-actions' }, [startBtn]),
      ui.controlsButton()
    ]));
  }

  /* --------------------------- NEW FRANCHISE ----------------------------- */
  function newFranchise(coach, countryId) {
    var save = {
      coach: coach, country: countryId, season: 1, week: 0,
      phase: 'regular', standings: {}, schedule: [], rosters: {}, playoffs: null,
      trophies: 0
    };
    D.NATIONS.forEach(function (n) {
      save.standings[n.id] = { w: 0, l: 0, pf: 0, pa: 0 };
      save.rosters[n.id] = D.rosterOf(n.id).map(clonePlayer);
    });
    save.schedule = buildSchedule(countryId);
    return save;
  }
  function clonePlayer(p) { return JSON.parse(JSON.stringify(p)); }

  // Each nation plays every other nation once through the season, but we only
  // track the USER's weekly game explicitly; CPU games are simmed each week.
  function buildSchedule(countryId) {
    var others = D.NATIONS.filter(function (n) { return n.id !== countryId; });
    // shuffle deterministically-ish
    return others.map(function (n, i) {
      return { week: i + 1, home: (i % 2 === 0), opp: n.id, played: false, us: 0, them: 0 };
    });
  }

  function applyRosterOverrides(save) {
    D.clearOverrides();
    Object.keys(save.rosters).forEach(function (id) { D.setRosterOverride(id, save.rosters[id]); });
  }

  /* ------------------------------- HUB ----------------------------------- */
  function hub(back, save) {
    applyRosterOverrides(save);
    var nation = D.nationById(save.country);

    if (save.phase === 'playoffs') return playoffHub(back, save);
    if (save.phase === 'champion') return championScreen(back, save);

    var totalWeeks = save.schedule.length;
    var done = save.week >= totalWeeks;
    var nextGame = save.schedule[save.week];

    ui.show(h('div', { class: 'screen hub-screen' }, [
      header('Coach ' + save.coach.name + ' — Season ' + save.season, back),
      h('div', { class: 'hub-top' }, [
        coachAvatar(save.coach, 76),
        h('div', {}, [
          h('div', { class: 'hub-team', text: nation.flag + ' ' + nation.name }),
          h('div', { class: 'muted', text: 'Team OVR ' + D.teamOvr(save.country) + '  •  Week ' + Math.min(save.week + 1, totalWeeks) + ' / ' + totalWeeks })
        ])
      ]),
      h('div', { class: 'hub-actions' }, [
        !done ? h('button', { class: 'btn primary big', html: nextGame ? ('🏈 Play Week ' + nextGame.week + ' vs ' + D.nationById(nextGame.opp).flag + ' ' + D.nationById(nextGame.opp).name) : 'Play', onClick: function () { playWeek(back, save); } }) : null,
        done ? h('button', { class: 'btn primary big', text: '➡ Advance to Playoffs', onClick: function () { startPlayoffs(back, save); } }) : null,
        h('button', { class: 'btn', html: '🔁 Trade Players', onClick: function () { tradeScreen(back, save); } }),
        h('button', { class: 'btn', html: '👥 View Roster', onClick: function () { rosterScreen(back, save, save.country); } }),
        h('button', { class: 'btn', html: '📊 Standings', onClick: function () { standingsScreen(back, save); } }),
        !done && nextGame ? h('button', { class: 'btn ghost', text: 'Sim this week', onClick: function () { simWeek(save); store.set('franchise', save); hub(back, save); } }) : null
      ]),
      ui.controlsButton()
    ]));
  }

  /* ---------------------------- PLAY A WEEK ------------------------------ */
  function playWeek(back, save) {
    applyRosterOverrides(save);
    var game = save.schedule[save.week];
    var opp = D.nationById(game.opp);
    var us = D.nationById(save.country);
    var userIsHome = game.home;
    var homeNation = userIsHome ? us : opp;
    var awayNation = userIsHome ? opp : us;
    var shell = new ui.GameShell({
      home: homeNation, away: awayNation,
      homeJersey: D.jerseysFor(homeNation.id)[0], awayJersey: D.jerseysFor(awayNation.id)[1],
      userSide: userIsHome ? 'home' : 'away',
      startPossession: userIsHome ? 'away' : 'home',
      quarters: 4, quarterLen: 120,
      onQuit: function () { hub(back, save); },
      onGameOver: function (res) {
        var us_ = res.userSide === 'home' ? res.score.home : res.score.away;
        var them = res.userSide === 'home' ? res.score.away : res.score.home;
        game.played = true; game.us = us_; game.them = them;
        recordResult(save, save.country, game.opp, us_, them);
        simOtherGames(save, [save.country, game.opp]);
        save.week++;
        store.set('franchise', save);
        weekResult(back, save, opp, us_, them);
      }
    });
    ui.show(shell.build());
  }

  function weekResult(back, save, opp, us, them) {
    var won = us > them;
    ui.show(h('div', { class: 'screen result-screen' }, [
      h('div', { class: 'result-card' }, [
        h('div', { class: 'result-emoji', text: won ? '✅' : '❌' }),
        h('h1', { text: won ? 'Victory' : 'Defeat' }),
        h('div', { class: 'result-score', text: D.nationById(save.country).flag + ' ' + us + ' — ' + them + ' ' + opp.flag }),
        recordBadge(save),
        h('div', { class: 'result-actions' }, [
          h('button', { class: 'btn primary', text: 'Continue', onClick: function () { hub(back, save); } }),
          h('button', { class: 'btn', text: 'Standings', onClick: function () { standingsScreen(back, save); } })
        ])
      ])
    ]));
  }
  function recordBadge(save) {
    var r = save.standings[save.country];
    return h('div', { class: 'muted', text: 'Record: ' + r.w + '–' + r.l });
  }

  function recordResult(save, aId, bId, aScore, bScore) {
    var A = save.standings[aId], B = save.standings[bId];
    A.pf += aScore; A.pa += bScore; B.pf += bScore; B.pa += aScore;
    if (aScore >= bScore) { A.w++; B.l++; } else { A.l++; B.w++; }
  }

  // Sim a game between two nations by rating + variance.
  function simGame(aId, bId) {
    var ra = D.teamOvr(aId), rb = D.teamOvr(bId);
    function pts(off, def) {
      var base = 14 + (off - def) * 0.6 + (Math.random() * 20 - 8);
      return Math.max(0, Math.round(base / 6) * 6 + (Math.random() < 0.85 ? Math.round(base / 6) : 0));
    }
    var a = pts(ra, rb), b = pts(rb, ra);
    if (a === b) { if (Math.random() < 0.5) a += 6; else b += 6; } // no ties in franchise
    return { a: a, b: b };
  }

  function simOtherGames(save, exclude) {
    // pair up remaining nations randomly for a "week" of results
    var teams = D.NATIONS.map(function (n) { return n.id; }).filter(function (id) { return exclude.indexOf(id) === -1; });
    for (var i = 0; i < teams.length - 1; i += 2) {
      var r = simGame(teams[i], teams[i + 1]);
      recordResult(save, teams[i], teams[i + 1], r.a, r.b);
    }
  }
  function simWeek(save) {
    var game = save.schedule[save.week];
    var r = simGame(save.country, game.opp);
    game.played = true; game.us = r.a; game.them = r.b;
    recordResult(save, save.country, game.opp, r.a, r.b);
    simOtherGames(save, [save.country, game.opp]);
    save.week++;
  }

  /* ---------------------------- STANDINGS -------------------------------- */
  function sortedStandings(save) {
    return D.NATIONS.map(function (n) {
      var s = save.standings[n.id];
      return { id: n.id, nation: n, w: s.w, l: s.l, pf: s.pf, pa: s.pa, diff: s.pf - s.pa };
    }).sort(function (a, b) { return b.w - a.w || b.diff - a.diff; });
  }
  function standingsScreen(back, save) {
    var rows = sortedStandings(save);
    ui.show(h('div', { class: 'screen list-screen' }, [
      header('Standings — Season ' + save.season, function () { hub(back, save); }),
      h('div', { class: 'standings' }, [
        h('div', { class: 'st-row st-head' }, [
          h('span', { class: 'st-rank', text: '#' }), h('span', { class: 'st-team', text: 'Team' }),
          h('span', { text: 'W' }), h('span', { text: 'L' }), h('span', { text: 'PF' }), h('span', { text: 'PA' })
        ])
      ].concat(rows.map(function (r, i) {
        var mine = r.id === save.country;
        var playoff = i < 6;
        return h('div', { class: 'st-row' + (mine ? ' mine' : '') + (playoff ? ' playoff' : '') }, [
          h('span', { class: 'st-rank', text: (i + 1) + (playoff ? ' 🏅' : '') }),
          h('span', { class: 'st-team', text: r.nation.flag + ' ' + r.nation.name }),
          h('span', { text: r.w }), h('span', { text: r.l }), h('span', { text: r.pf }), h('span', { text: r.pa })
        ]);
      }))),
      h('p', { class: 'muted', text: 'Top 6 (🏅) advance to the playoffs.' }),
      ui.controlsButton()
    ]));
  }

  /* ------------------------------ ROSTER --------------------------------- */
  function rosterScreen(back, save, nationId) {
    var roster = save.rosters[nationId].slice().sort(function (a, b) { return b.ovr - a.ovr; });
    ui.show(h('div', { class: 'screen list-screen' }, [
      header((D.nationById(nationId).flag) + ' Roster', function () { hub(back, save); }),
      h('div', { class: 'roster-list' }, roster.map(function (p) {
        return h('div', { class: 'roster-row' }, [
          h('span', { class: 'rr-pos', text: p.pos }),
          h('span', { class: 'rr-name', text: p.name }),
          h('span', { class: 'rr-ovr ovr' + ovrTier(p.ovr), text: p.ovr })
        ]);
      })),
      ui.controlsButton()
    ]));
  }
  function ovrTier(o) { return o >= 88 ? '-elite' : o >= 78 ? '-good' : ''; }

  /* ------------------------------ TRADES --------------------------------- */
  function tradeScreen(back, save) {
    var give = null, get = null, partner = D.NATIONS.filter(function (n) { return n.id !== save.country; })[0];
    var body = h('div', { class: 'trade-body' });
    function render() {
      ui.clear(body);
      var mine = save.rosters[save.country].slice().sort(function (a, b) { return b.ovr - a.ovr; });
      var theirs = save.rosters[partner.id].slice().sort(function (a, b) { return b.ovr - a.ovr; });
      var partnerSel = h('select', { class: 'fld', onChange: function (e) { partner = D.nationById(e.target.value); get = null; render(); } },
        D.NATIONS.filter(function (n) { return n.id !== save.country; }).map(function (n) {
          var o = h('option', { value: n.id, text: n.flag + ' ' + n.name }); if (n.id === partner.id) o.selected = true; return o;
        }));

      function col(list, sel, onPick) {
        return h('div', { class: 'trade-col' }, list.map(function (p) {
          return h('button', { class: 'trade-player' + (sel === p ? ' on' : ''), onClick: function () { onPick(p); render(); } }, [
            h('span', { class: 'rr-pos', text: p.pos }), h('span', { class: 'rr-name', text: p.name }),
            h('span', { class: 'rr-ovr ovr' + ovrTier(p.ovr), text: p.ovr })
          ]);
        }));
      }
      var giveVal = give ? give.ovr : 0, getVal = get ? get.ovr : 0;
      var fair = give && get && (getVal - giveVal) <= 3; // partner accepts if you don't fleece them too hard
      body.appendChild(h('div', { class: 'trade-grid' }, [
        h('div', {}, [ h('h4', { text: D.nationById(save.country).flag + ' You give' }), col(mine, give, function (p) { give = p; }) ]),
        h('div', {}, [ h('div', { class: 'trade-partner' }, [ h('h4', { text: 'Trade with:' }), partnerSel ]), col(theirs, get, function (p) { get = p; }) ])
      ]));
      body.appendChild(h('div', { class: 'trade-footer' }, [
        h('div', { class: 'trade-summary', text: give && get ? (give.name + ' (' + give.ovr + ')  ⇄  ' + get.name + ' (' + get.ovr + ')') : 'Select a player from each team' }),
        h('button', { class: 'btn primary', text: 'Propose Trade', disabled: !(give && get), onClick: function () {
          if (!give || !get) return;
          if (!fair) { alert(D.nationById(partner.id).name + ' rejects the trade — too lopsided.'); return; }
          doTrade(save, save.country, partner.id, give, get);
          store.set('franchise', save);
          alert('Trade accepted! ' + get.name + ' joins your squad.');
          hub(back, save);
        } })
      ]));
    }
    render();
    ui.show(h('div', { class: 'screen trade-screen' }, [
      header('Trade Center', function () { hub(back, save); }), body, ui.controlsButton()
    ]));
  }

  function doTrade(save, aId, bId, playerA, playerB) {
    var A = save.rosters[aId], B = save.rosters[bId];
    A.splice(A.indexOf(playerA), 1); B.splice(B.indexOf(playerB), 1);
    playerA.nation = bId; playerB.nation = aId;
    A.push(playerB); B.push(playerA);
    applyRosterOverrides(save);
  }

  /* ----------------------------- PLAYOFFS -------------------------------- */
  function startPlayoffs(back, save) {
    var ranked = sortedStandings(save).slice(0, 6).map(function (r) { return r.id; });
    // Seeds 1-2 bye. QF: 3v6, 4v5. SF: 1 vs lowest winner, 2 vs other. F: winners.
    save.phase = 'playoffs';
    save.playoffs = { seeds: ranked, round: 'QF', results: {}, bracket: buildBracket(ranked) };
    store.set('franchise', save);
    playoffHub(back, save);
  }
  function buildBracket(seeds) {
    return {
      QF: [ { a: seeds[2], b: seeds[5] }, { a: seeds[3], b: seeds[4] } ],
      byes: [ seeds[0], seeds[1] ],
      SF: [], F: null, champ: null
    };
  }

  function playoffHub(back, save) {
    applyRosterOverrides(save);
    var po = save.playoffs, br = po.bracket;
    var userId = save.country;
    // find user's next game in current round
    var next = findUserGame(br, po.round, userId);
    ui.show(h('div', { class: 'screen playoff-screen' }, [
      header('Playoffs — Season ' + save.season, function () { back(); }),
      bracketView(br, userId),
      h('div', { class: 'hub-actions' }, [
        next ? h('button', { class: 'btn primary big', html: '🏈 Play ' + roundName(po.round) + ' vs ' + D.nationById(next.opp).flag + ' ' + D.nationById(next.opp).name, onClick: function () { playPlayoff(back, save, next); } })
             : h('button', { class: 'btn primary big', text: 'Advance Round ➡', onClick: function () { advancePlayoffRound(back, save); } }),
        (!next && po.round !== 'DONE') ? h('button', { class: 'btn ghost', text: 'Sim round', onClick: function () { advancePlayoffRound(back, save); } }) : null
      ]),
      ui.controlsButton()
    ]));
  }

  function roundName(r) { return { QF: 'Quarterfinal', SF: 'Semifinal', F: 'Championship' }[r] || r; }

  function findUserGame(br, round, userId) {
    var games = round === 'QF' ? br.QF : round === 'SF' ? br.SF : (br.F ? [br.F] : []);
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      if (!g.done && (g.a === userId || g.b === userId)) return { game: g, opp: g.a === userId ? g.b : g.a, round: round };
    }
    return null;
  }

  function playPlayoff(back, save, next) {
    applyRosterOverrides(save);
    var g = next.game, userId = save.country, oppId = next.opp;
    var us = D.nationById(userId), opp = D.nationById(oppId);
    var userIsHome = (g.a === userId);
    var homeNation = userIsHome ? us : opp, awayNation = userIsHome ? opp : us;
    var shell = new ui.GameShell({
      home: homeNation, away: awayNation,
      homeJersey: D.jerseysFor(homeNation.id)[0], awayJersey: D.jerseysFor(awayNation.id)[1],
      userSide: userIsHome ? 'home' : 'away', startPossession: userIsHome ? 'away' : 'home',
      quarters: 4, quarterLen: 120,
      onQuit: function () { playoffHub(back, save); },
      onGameOver: function (res) {
        var uS = res.userSide === 'home' ? res.score.home : res.score.away;
        var oS = res.userSide === 'home' ? res.score.away : res.score.home;
        var winner = uS >= oS ? userId : oppId;
        g.done = true; g.winner = winner; g.score = userIsHome ? [uS, oS] : [oS, uS];
        if (winner !== userId) { save.phase = 'eliminated'; store.set('franchise', save); return eliminated(back, save, opp); }
        store.set('franchise', save);
        playoffHub(back, save);
      }
    });
    ui.show(shell.build());
  }

  function advancePlayoffRound(back, save) {
    var po = save.playoffs, br = po.bracket, userId = save.country;
    // resolve any unplayed CPU games in this round
    var games = po.round === 'QF' ? br.QF : po.round === 'SF' ? br.SF : (br.F ? [br.F] : []);
    games.forEach(function (g) {
      if (!g.done) { var r = simGame(g.a, g.b); g.done = true; g.winner = r.a >= r.b ? g.a : g.b; g.score = [r.a, r.b]; }
    });
    if (po.round === 'QF') {
      var w = br.QF.map(function (g) { return g.winner; });
      // seeds 0,1 (byes) vs QF winners
      br.SF = [ { a: br.byes[0], b: w[1] }, { a: br.byes[1], b: w[0] } ];
      po.round = 'SF';
    } else if (po.round === 'SF') {
      var sw = br.SF.map(function (g) { return g.winner; });
      br.F = { a: sw[0], b: sw[1] };
      po.round = 'F';
    } else if (po.round === 'F') {
      br.champ = br.F.winner;
      po.round = 'DONE';
      if (br.champ === userId) { save.phase = 'champion'; save.trophies++; store.set('franchise', save); return championScreen(back, save); }
      save.phase = 'eliminated'; store.set('franchise', save); return eliminated(back, save, D.nationById(br.champ), true);
    }
    store.set('franchise', save);
    playoffHub(back, save);
  }

  function bracketView(br, userId) {
    function cell(id, winner) {
      if (!id) return h('span', { class: 'bk-team tbd', text: 'TBD' });
      var n = D.nationById(id);
      return h('span', { class: 'bk-team' + (id === userId ? ' mine' : '') + (winner === id ? ' won' : ''), text: n.flag + ' ' + n.id });
    }
    function match(g) {
      if (!g) return h('div', { class: 'bk-match' }, [cell(null), cell(null)]);
      return h('div', { class: 'bk-match' }, [
        cell(g.a, g.winner), cell(g.b, g.winner),
        g.done ? h('span', { class: 'bk-score', text: (g.score ? g.score.join('–') : '') }) : null
      ]);
    }
    return h('div', { class: 'bracket' }, [
      h('div', { class: 'bk-col' }, [ h('h4', { text: 'Byes' }), cell(br.byes[0]), cell(br.byes[1]),
        h('h4', { text: 'Quarterfinals' }), match(br.QF[0]), match(br.QF[1]) ]),
      h('div', { class: 'bk-col' }, [ h('h4', { text: 'Semifinals' }), match(br.SF[0]), match(br.SF[1]) ]),
      h('div', { class: 'bk-col' }, [ h('h4', { text: 'Championship' }), match(br.F),
        br.champ ? h('div', { class: 'bk-champ', text: '🏆 ' + D.nationById(br.champ).name } ) : null ])
    ]);
  }

  function eliminated(back, save, byNation, wasFinal) {
    ui.show(h('div', { class: 'screen result-screen' }, [
      h('div', { class: 'result-card' }, [
        h('div', { class: 'result-emoji', text: '😔' }),
        h('h1', { text: wasFinal ? 'Runner-up' : 'Eliminated' }),
        h('p', { text: (wasFinal ? byNation.name + ' won the championship.' : 'Knocked out by ' + byNation.name + '.') }),
        h('div', { class: 'result-actions' }, [
          h('button', { class: 'btn primary', text: 'Next Season ➡', onClick: function () { nextSeason(back, save); } }),
          h('button', { class: 'btn', text: 'Main Menu', onClick: back })
        ])
      ])
    ]));
  }

  function championScreen(back, save) {
    ui.show(h('div', { class: 'screen result-screen champ' }, [
      h('div', { class: 'result-card' }, [
        h('div', { class: 'result-emoji', text: '🏆' }),
        h('h1', { text: 'CHAMPIONS!' }),
        h('p', { text: D.nationById(save.country).name + ' wins the Flagster Championship!' }),
        h('p', { class: 'muted', text: 'Trophies: ' + save.trophies + '  •  Season ' + save.season }),
        h('div', { class: 'result-actions' }, [
          h('button', { class: 'btn primary', text: 'Start Next Season ➡', onClick: function () { nextSeason(back, save); } }),
          h('button', { class: 'btn', text: 'Main Menu', onClick: back })
        ])
      ])
    ]));
  }

  function nextSeason(back, save) {
    save.season++; save.week = 0; save.phase = 'regular'; save.playoffs = null;
    D.NATIONS.forEach(function (n) { save.standings[n.id] = { w: 0, l: 0, pf: 0, pa: 0 }; });
    save.schedule = buildSchedule(save.country);
    store.set('franchise', save);
    hub(back, save);
  }

  F.teambuilder = { start: start };
})(window);
