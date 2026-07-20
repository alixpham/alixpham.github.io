/* ============================================================================
   FLAGSTER — ROAD TO GLORY (Superstar mode)
   Create a player at any offensive/defensive position, pick an archetype, start
   at 65 OVR, and grind up by completing in-game challenges each game.
   ============================================================================ */
(function (global) {
  'use strict';
  var F = global.FLAGSTER, ui = F.ui, D = F.data, store = F.storage, h = ui.h;
  var header = function (t, b) { return F.world.header(t, b); };

  var POS_ICON = { QB: '🎯', RB: '🏃', WR: '🙌', C: '🎣', RUSH: '💥', MLB: '🛡', CB: '🔒' };

  /* ------------------------ derive player from save ---------------------- */
  function buildPlayer(save) {
    var b = save.ovr;
    var s = { speed: b, catch: b, throw: b, agi: b, aware: b, pull: b };
    var arch = archetypeOf(save);
    if (arch) Object.keys(arch.boost).forEach(function (k) { s[k] = clamp(s[k] + arch.boost[k], 40, 99); });
    // position tilts
    if (save.pos === 'QB') { s.throw = clamp(s.throw + 6, 40, 99); s.catch = clamp(s.catch - 15, 40, 99); }
    if (save.pos === 'WR') { s.catch = clamp(s.catch + 4, 40, 99); }
    if (save.pos === 'C') { s.catch = clamp(s.catch + 4, 40, 99); }
    if (save.pos === 'RUSH') { s.pull = clamp(s.pull + 4, 40, 99); }
    var last = save.name.trim().split(/\s+/).slice(-1)[0] || save.name;
    return {
      id: 'RTG-me', name: save.name, last: last, pos: save.pos, ovr: save.ovr,
      speed: s.speed, catch: s.catch, throw: s.throw, agi: s.agi, aware: s.aware, pull: s.pull,
      nation: save.country, isMe: true
    };
  }
  function archetypeOf(save) {
    var list = D.ARCHETYPES[save.pos] || [];
    return list.filter(function (a) { return a.id === save.archetype; })[0] || list[0];
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ------------------------------ ENTRY ---------------------------------- */
  function start(back) {
    var save = store.get('rtg');
    if (save) resumeMenu(back, save);
    else createPlayer(back);
  }

  function resumeMenu(back, save) {
    var n = D.nationById(save.country);
    ui.show(h('div', { class: 'screen menu-sub' }, [
      header('Road to Glory', back),
      h('div', { class: 'resume-card' }, [
        h('div', { class: 'rtg-badge big', text: POS_ICON[save.pos] }),
        h('h2', { text: save.name }),
        h('p', { class: 'muted', text: n.flag + ' ' + n.name + ' • ' + D.POS_INFO[save.pos].name + ' • ' + archetypeOf(save).name }),
        ovrMeter(save),
        h('div', { class: 'result-actions' }, [
          h('button', { class: 'btn primary', text: 'Continue Career', onClick: function () { hub(back, save); } }),
          h('button', { class: 'btn danger', text: 'Delete & Restart', onClick: function () {
            if (confirm('Delete your Road to Glory career?')) { store.remove('rtg'); createPlayer(back); }
          } })
        ])
      ]),
      ui.controlsButton()
    ]));
  }

  function ovrMeter(save) {
    var pct = clamp((save.ovr - 60) / (99 - 60) * 100, 3, 100);
    var xpPct = (save.xp % 100);
    return h('div', { class: 'ovr-meter' }, [
      h('div', { class: 'ovr-num', text: 'OVR ' + save.ovr }),
      h('div', { class: 'ovr-bar' }, [ h('div', { class: 'ovr-fill', style: { width: pct + '%' } }) ]),
      h('div', { class: 'xp-row' }, [
        h('span', { class: 'muted', text: 'Level ' + save.level }),
        h('div', { class: 'xp-bar' }, [ h('div', { class: 'xp-fill', style: { width: xpPct + '%' } }) ]),
        h('span', { class: 'muted', text: (save.xp % 100) + '/100 XP' })
      ])
    ]);
  }

  /* --------------------------- CREATE PLAYER ----------------------------- */
  function createPlayer(back) {
    var save = { name: '', pos: null, archetype: null, country: null, ovr: 65, xp: 0, level: 1,
      games: 0, wins: 0, careerTD: 0, careerPulls: 0, careerCatches: 0 };
    var step = 0;

    function nameStep() {
      var input = h('input', { class: 'fld big-input', placeholder: 'Your name', maxlength: 18,
        oninput: function (e) { save.name = e.target.value; nx.disabled = !save.name.trim(); } });
      var nx = h('button', { class: 'btn primary big', text: 'Next →', disabled: true, onClick: posStep });
      ui.show(wrap('What\'s your name, superstar?', back, [ input, h('div', { class: 'sel-actions' }, [nx]) ]));
      setTimeout(function () { input.focus(); }, 50);
    }

    function posStep() {
      var grid = h('div', { class: 'pos-grid' });
      D.RTG_POSITIONS.forEach(function (rp) {
        grid.appendChild(h('button', { class: 'pos-card' + (save.pos === rp.pos ? ' selected' : ''), onClick: function () {
          save.pos = rp.pos; save.archetype = null; archStep();
        } }, [
          h('span', { class: 'pos-ico', text: POS_ICON[rp.pos] }),
          h('span', { class: 'pos-name', text: D.POS_INFO[rp.pos].name }),
          h('span', { class: 'pos-side', text: rp.side }),
          rp.note ? h('span', { class: 'pos-note', text: rp.note }) : null
        ]));
      });
      ui.show(wrap('Choose your position', nameStep, [ grid ]));
    }

    function archStep() {
      var list = D.ARCHETYPES[save.pos] || [];
      var grid = h('div', { class: 'arch-grid' });
      list.forEach(function (a) {
        var boosts = Object.keys(a.boost).map(function (k) { return '+' + a.boost[k] + ' ' + k.toUpperCase(); }).join('  ');
        grid.appendChild(h('button', { class: 'arch-card' + (save.archetype === a.id ? ' selected' : ''), onClick: function () {
          save.archetype = a.id; countryStep();
        } }, [
          h('span', { class: 'arch-name', text: a.name }),
          h('span', { class: 'arch-boost', text: boosts })
        ]));
      });
      ui.show(wrap('Pick your archetype', posStep, [ grid ]));
    }

    function countryStep() {
      var grid = h('div', { class: 'team-grid' });
      D.NATIONS.forEach(function (n) {
        grid.appendChild(F.world.teamCard(n, save.country === n.id, function (nn) {
          save.country = nn.id;
          store.set('rtg', save);
          debut(back, save);
        }));
      });
      ui.show(wrap('Choose your country', archStep, [ grid ]));
    }

    nameStep();
  }

  function debut(back, save) {
    var p = buildPlayer(save);
    ui.show(h('div', { class: 'screen result-screen' }, [
      h('div', { class: 'result-card' }, [
        h('div', { class: 'rtg-badge big', text: POS_ICON[save.pos] }),
        h('h1', { text: save.name }),
        h('p', { class: 'muted', text: D.nationById(save.country).flag + ' ' + D.POS_INFO[save.pos].name + ' • ' + archetypeOf(save).name }),
        ovrMeter(save),
        h('p', { text: 'Every player starts at 65 OVR. Complete challenges in games to level up all the way to 99!' }),
        h('div', { class: 'result-actions' }, [
          h('button', { class: 'btn primary', text: 'Start My Career ➡', onClick: function () { hub(back, save); } })
        ])
      ])
    ]));
  }

  function wrap(title, back, kids) {
    return h('div', { class: 'screen create-screen center' }, [
      header(title, back), h('div', { class: 'create-center' }, kids), ui.controlsButton()
    ]);
  }

  /* ------------------------------ CHALLENGES ----------------------------- */
  function challengesFor(pos) {
    var C = {
      QB: [ ['Throw 2 completions', 'catch', 2, 30], ['Throw a touchdown', 'passtd', 1, 50], ['Win the game', 'win', 1, 40] ],
      WR: [ ['Catch 3 passes', 'mycatch', 3, 30], ['Score a touchdown', 'mytd', 1, 50], ['Gain 40+ yards', 'yards', 40, 30] ],
      RB: [ ['Get 30+ rushing yards', 'yards', 30, 30], ['Score a touchdown', 'mytd', 1, 50], ['Win the game', 'win', 1, 40] ],
      C:  [ ['Catch 2 passes', 'mycatch', 2, 40], ['Score a touchdown', 'mytd', 1, 60], ['Win the game', 'win', 1, 30] ],
      RUSH:[ ['Pull 3 flags', 'mypull', 3, 30], ['Force a stop', 'stop', 1, 40], ['Win the game', 'win', 1, 40] ],
      MLB: [ ['Pull 3 flags', 'mypull', 3, 30], ['Force a stop', 'stop', 1, 40], ['Win the game', 'win', 1, 40] ],
      CB:  [ ['Pull 2 flags', 'mypull', 2, 30], ['Break up a pass', 'stop', 1, 40], ['Win the game', 'win', 1, 40] ]
    };
    return (C[pos] || C.WR).map(function (c) { return { label: c[0], key: c[1], target: c[2], xp: c[3], progress: 0, done: false }; });
  }

  /* ------------------------------- HUB ----------------------------------- */
  function hub(back, save) {
    var n = D.nationById(save.country);
    var challenges = challengesFor(save.pos);
    ui.show(h('div', { class: 'screen hub-screen rtg-hub' }, [
      header(save.name + ' — Road to Glory', back),
      h('div', { class: 'hub-top' }, [
        h('div', { class: 'rtg-badge', text: POS_ICON[save.pos] }),
        h('div', {}, [
          h('div', { class: 'hub-team', text: n.flag + ' ' + n.name }),
          h('div', { class: 'muted', text: D.POS_INFO[save.pos].name + ' • ' + archetypeOf(save).name + ' • ' + save.games + ' games, ' + save.wins + ' W' })
        ])
      ]),
      ovrMeter(save),
      h('div', { class: 'challenge-card' }, [
        h('h4', { text: 'Next game challenges' }),
        h('div', { class: 'challenge-list' }, challenges.map(function (c) {
          return h('div', { class: 'challenge-row' }, [ h('span', { text: '◻ ' + c.label }), h('b', { class: 'chal-xp', text: '+' + c.xp + ' XP' }) ]);
        }))
      ]),
      h('div', { class: 'hub-actions' }, [
        h('button', { class: 'btn primary big', text: '🏈 Play Next Game', onClick: function () { playGame(back, save, challenges); } }),
        h('button', { class: 'btn', text: 'Player Card', onClick: function () { playerCard(back, save); } })
      ]),
      ui.controlsButton()
    ]));
  }

  function playerCard(back, save) {
    var p = buildPlayer(save);
    function bar(label, val) {
      return h('div', { class: 'attr-row' }, [ h('span', { text: label }), h('div', { class: 'attr-bar' }, [ h('div', { class: 'attr-fill', style: { width: val + '%' } }) ]), h('b', { text: val }) ]);
    }
    ui.show(h('div', { class: 'screen list-screen' }, [
      header('Player Card', function () { hub(back, save); }),
      h('div', { class: 'player-card' }, [
        h('div', { class: 'pc-head' }, [ h('div', { class: 'rtg-badge big', text: POS_ICON[save.pos] }),
          h('div', {}, [ h('h2', { text: save.name }), h('p', { class: 'muted', text: D.POS_INFO[save.pos].name + ' • ' + archetypeOf(save).name }) ]),
          h('div', { class: 'pc-ovr', text: save.ovr }) ]),
        bar('Speed', p.speed), bar('Catching', p.catch), bar('Throwing', p.throw),
        bar('Agility', p.agi), bar('Awareness', p.aware), bar('Flag Pull', p.pull),
        h('div', { class: 'pc-career' }, [
          h('div', { class: 'stat-line' }, [ h('span', { text: 'Career TDs' }), h('b', { text: save.careerTD }) ]),
          h('div', { class: 'stat-line' }, [ h('span', { text: 'Career catches' }), h('b', { text: save.careerCatches }) ]),
          h('div', { class: 'stat-line' }, [ h('span', { text: 'Career flag pulls' }), h('b', { text: save.careerPulls }) ])
        ])
      ]),
      ui.controlsButton()
    ]));
  }

  /* ------------------------------ PLAY GAME ------------------------------ */
  function playGame(back, save, challenges) {
    var me = buildPlayer(save);
    var isOffense = D.POS_INFO[save.pos].side === 'off';
    var userId = save.country;
    // random opponent
    var opps = D.NATIONS.filter(function (x) { return x.id !== userId; });
    var opp = opps[Math.floor(Math.random() * opps.length)];
    var tracker = { mycatch: 0, mytd: 0, mypull: 0, catch: 0, passtd: 0, yards: 0, stop: 0, win: 0 };

    var shell = new ui.GameShell({
      home: D.nationById(userId), away: opp,
      homeJersey: D.jerseysFor(userId)[0], awayJersey: D.jerseysFor(opp.id)[1],
      userSide: 'home', startPossession: 'away',
      quarters: 4, quarterLen: 120,
      rtg: { player: me, side: isOffense ? 'off' : 'def' },
      onQuit: function () { hub(back, save); },
      onEvent: function (ev, s) {
        if (ev.type === 'catch' && ev.player && ev.player.data && ev.player.data.id === 'RTG-me') { tracker.mycatch++; }
        if (ev.type === 'catch') tracker.catch++;
        if (ev.type === 'flagpull' && ev.defender && ev.defender.data && ev.defender.data.id === 'RTG-me') { tracker.mypull++; tracker.stop++; }
        if (ev.type === 'touchdown' && ev.team === 'home') { tracker.mytd += (isOffense ? 1 : 0); tracker.passtd += (save.pos === 'QB' ? 1 : 0); }
        if (ev.type === 'incomplete') tracker.stop += (isOffense ? 0 : 1);
      },
      onGameOver: function (res) {
        var uS = res.score.home, oS = res.score.away;
        tracker.win = uS > oS ? 1 : 0;
        tracker.yards = res.stats.home.pass * 8 + res.stats.home.rush;
        finishGame(back, save, challenges, tracker, uS, oS, opp);
      }
    });
    ui.show(shell.build());
  }

  function finishGame(back, save, challenges, tracker, uS, oS, opp) {
    save.games++; if (uS > oS) save.wins++;
    save.careerTD += tracker.mytd; save.careerCatches += tracker.mycatch; save.careerPulls += tracker.mypull;
    var gained = 0, results = [];
    challenges.forEach(function (c) {
      var val = tracker[c.key] || 0;
      var done = val >= c.target;
      if (done) gained += c.xp;
      results.push({ label: c.label, done: done, xp: c.xp });
    });
    var oldOvr = save.ovr, oldLevel = save.level;
    save.xp += gained;
    while (save.xp >= save.level * 100 && save.ovr < 99) {
      save.xp -= save.level * 100; save.level++; save.ovr = Math.min(99, save.ovr + 1);
    }
    store.set('rtg', save);

    var leveledUp = save.ovr > oldOvr;
    ui.show(h('div', { class: 'screen result-screen' + (leveledUp ? ' champ' : '') }, [
      h('div', { class: 'result-card' }, [
        h('div', { class: 'result-emoji', text: uS > oS ? '🔥' : '💪' }),
        h('h1', { text: uS > oS ? 'W' : 'L' }),
        h('div', { class: 'result-score', text: D.nationById(save.country).flag + ' ' + uS + ' — ' + oS + ' ' + opp.flag }),
        h('div', { class: 'challenge-results' }, results.map(function (r) {
          return h('div', { class: 'challenge-row ' + (r.done ? 'done' : 'miss') }, [
            h('span', { text: (r.done ? '✅ ' : '⬜ ') + r.label }), h('b', { text: (r.done ? '+' + r.xp : '0') + ' XP' })
          ]);
        })),
        h('div', { class: 'xp-gain', text: '+' + gained + ' XP earned' }),
        leveledUp ? h('div', { class: 'levelup', text: '⬆ OVERALL UP! ' + oldOvr + ' → ' + save.ovr } ) : null,
        ovrMeter(save),
        h('div', { class: 'result-actions' }, [
          h('button', { class: 'btn primary', text: 'Continue', onClick: function () { hub(back, save); } })
        ])
      ])
    ]));
  }

  F.roadtoglory = { start: start };
})(window);
