/* ============================================================================
   FLAGSTER — WORLD (Quick Play, Madden-style)
   Pick your team + opponent, choose jerseys, kick off. Full 5v5 game.
   ============================================================================ */
(function (global) {
  'use strict';
  var F = global.FLAGSTER, ui = F.ui, D = F.data, h = ui.h;

  function teamCard(nation, selected, onPick) {
    var ovr = D.teamOvr(nation.id);
    return h('button', {
      class: 'team-card' + (selected ? ' selected' : ''),
      style: { '--c1': nation.colors[0], '--c2': nation.colors[1] },
      onClick: function () { onPick(nation); }
    }, [
      h('span', { class: 'tc-flag', text: nation.flag }),
      h('span', { class: 'tc-name', text: nation.name }),
      h('span', { class: 'tc-ovr', text: 'OVR ' + ovr })
    ]);
  }

  function start(back) {
    var state = { user: null, opp: null, userJersey: 0, oppJersey: 0, quarters: 4, quarterLen: 150 };

    function screenTeamSelect() {
      var grid1 = h('div', { class: 'team-grid' });
      var grid2 = h('div', { class: 'team-grid' });
      function render() {
        ui.clear(grid1); ui.clear(grid2);
        D.NATIONS.forEach(function (n) {
          grid1.appendChild(teamCard(n, state.user && state.user.id === n.id, function (nn) { state.user = nn; render(); }));
          grid2.appendChild(teamCard(n, state.opp && state.opp.id === n.id, function (nn) { state.opp = nn; render(); }));
        });
        nextBtn.disabled = !(state.user && state.opp);
      }
      var nextBtn = h('button', { class: 'btn primary big', text: 'Next → Jerseys', disabled: true, onClick: function () {
        if (state.user && state.opp) screenJersey();
      } });
      render();
      ui.show(h('div', { class: 'screen select-screen' }, [
        header('World — Quick Play', back),
        h('div', { class: 'sel-block' }, [ h('h3', { html: '🎽 Your Team' }), grid1 ]),
        h('div', { class: 'sel-block' }, [ h('h3', { html: '🆚 Opponent' }), grid2 ]),
        h('div', { class: 'sel-actions' }, [nextBtn]),
        ui.controlsButton()
      ]));
    }

    function jerseyRow(nation, sel, onPick) {
      var js = D.jerseysFor(nation.id);
      return h('div', { class: 'jersey-row' }, js.map(function (j, i) {
        return h('button', {
          class: 'jersey-swatch' + (sel === i ? ' selected' : ''),
          onClick: function () { onPick(i); }
        }, [
          h('span', { class: 'js-shirt', style: { background: j.colors[0], borderColor: j.colors[1] } }, [
            h('span', { class: 'js-stripe', style: { background: j.colors[1] } })
          ]),
          h('span', { class: 'js-label', text: j.name })
        ]);
      }));
    }

    function screenJersey() {
      var uRow, oRow;
      function render() {
        uRow && uRow.replaceWith(uRow = jerseyRow(state.user, state.userJersey, function (i) { state.userJersey = i; render(); }));
        oRow && oRow.replaceWith(oRow = jerseyRow(state.opp, state.oppJersey, function (i) { state.oppJersey = i; render(); }));
      }
      uRow = jerseyRow(state.user, state.userJersey, function (i) { state.userJersey = i; render(); });
      oRow = jerseyRow(state.opp, state.oppJersey, function (i) { state.oppJersey = i; render(); });

      var lenSel = h('select', { class: 'fld', onChange: function (e) { state.quarterLen = parseInt(e.target.value, 10); } }, [
        optEl('90', '2 min quarters (quick)'), optEl('150', '2.5 min quarters', true), optEl('240', '4 min quarters')
      ]);

      ui.show(h('div', { class: 'screen jersey-screen' }, [
        header('Choose Jerseys', screenTeamSelect),
        h('div', { class: 'jersey-block' }, [
          matchupHead(state.user, state.opp),
          h('div', { class: 'jersey-grid' }, [
            h('div', {}, [h('h4', { text: state.user.name }), uRow]),
            h('div', {}, [h('h4', { text: state.opp.name }), oRow])
          ]),
          h('div', { class: 'game-opts' }, [ h('label', { text: 'Game length: ' }), lenSel ]),
          h('button', { class: 'btn primary big', html: '🏈 Kick Off!', onClick: kickoff })
        ]),
        ui.controlsButton()
      ]));
    }

    function kickoff() {
      var uJ = D.jerseysFor(state.user.id)[state.userJersey];
      var oJ = D.jerseysFor(state.opp.id)[state.oppJersey];
      // user is "home", opponent "away"; away gets ball first
      var shell = new ui.GameShell({
        home: state.user, away: state.opp,
        homeJersey: uJ, awayJersey: oJ,
        userSide: 'home', startPossession: 'away',
        quarters: state.quarters, quarterLen: state.quarterLen,
        onQuit: function () { back(); },
        onGameOver: function (res) { showResult(res); }
      });
      ui.show(shell.build());
    }

    function showResult(res) {
      var userWon = res.winner === res.userSide;
      var uScore = res.userSide === 'home' ? res.score.home : res.score.away;
      var oScore = res.userSide === 'home' ? res.score.away : res.score.home;
      ui.show(h('div', { class: 'screen result-screen' }, [
        h('div', { class: 'result-card' }, [
          h('div', { class: 'result-emoji', text: userWon ? '🏆' : '😤' }),
          h('h1', { text: userWon ? 'You Win!' : 'You Lose' }),
          h('div', { class: 'result-score', text: state.user.flag + ' ' + uScore + '  —  ' + oScore + ' ' + state.opp.flag }),
          h('div', { class: 'result-stats' }, [
            statLine('Passing yards', (res.stats[res.userSide].pass * 8)),
            statLine('Rushing yards', res.stats[res.userSide].rush),
            statLine('Touchdowns', res.stats[res.userSide].td),
            statLine('Flag pulls', res.stats[res.userSide].tackles)
          ]),
          h('div', { class: 'result-actions' }, [
            h('button', { class: 'btn primary', text: 'Rematch', onClick: kickoff }),
            h('button', { class: 'btn', text: 'New Matchup', onClick: screenTeamSelect }),
            h('button', { class: 'btn', text: 'Main Menu', onClick: back })
          ])
        ])
      ]));
    }

    screenTeamSelect();
  }

  /* --------------------------- shared bits ------------------------------- */
  function header(title, back) {
    return h('div', { class: 'screen-head' }, [
      h('button', { class: 'back-btn', html: '‹ Back', onClick: back }),
      h('h2', { text: title })
    ]);
  }
  function matchupHead(a, b) {
    return h('div', { class: 'matchup-head' }, [
      h('span', { class: 'mh-team', text: a.flag + ' ' + a.id }),
      h('span', { class: 'mh-vs', text: 'VS' }),
      h('span', { class: 'mh-team', text: b.id + ' ' + b.flag })
    ]);
  }
  function statLine(label, val) {
    return h('div', { class: 'stat-line' }, [h('span', { text: label }), h('b', { text: String(val) })]);
  }
  function optEl(v, label, sel) { var o = h('option', { value: v, text: label }); if (sel) o.selected = true; return o; }

  F.world = { start: start, header: header, matchupHead: matchupHead, statLine: statLine, optEl: optEl, teamCard: teamCard };
})(window);
