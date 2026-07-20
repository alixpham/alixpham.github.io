/* ============================================================================
   FLAGSTER — MAIN MENU + BOOTSTRAP
   ============================================================================ */
(function (global) {
  'use strict';
  var F = global.FLAGSTER, ui = F.ui, h = ui.h;

  function mainMenu() {
    var mobile = ui.isMobile();
    var tiles = [
      { id: 'world', icon: '🌍', title: 'World', sub: 'Quick Play — pick any two nations and ball out, Madden-style.', go: function () { F.world.start(mainMenu); } },
      { id: 'builder', icon: '🏗️', title: 'Team Builder', sub: 'Franchise mode — create a coach, run a nation, trade, and chase championships.', go: function () { F.teambuilder.start(mainMenu); } },
      { id: 'glory', icon: '⭐', title: 'Road to Glory', sub: 'Superstar mode — create a player, pick an archetype, and grind 65 → 99 OVR.', go: function () { F.roadtoglory.start(mainMenu); } }
    ];
    var heroCanvas = h('canvas', { class: 'hero3d-canvas' });
    ui.show(h('div', { class: 'screen main-menu' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'brand-logo' }, [ h('span', { class: 'brand-flag', text: '🏈' }), h('h1', { class: 'brand-name', text: 'FLAGSTER' }) ]),
        h('p', { class: 'brand-tag', text: 'Olympic Flag Football • LA 2028' })
      ]),
      global.THREE ? h('div', { class: 'hero3d' }, [heroCanvas]) : null,
      h('div', { class: 'menu-tiles' }, tiles.map(function (t) {
        return h('button', { class: 'menu-tile ' + t.id, onClick: t.go }, [
          h('span', { class: 'tile-icon', text: t.icon }),
          h('span', { class: 'tile-title', text: t.title }),
          h('span', { class: 'tile-sub', text: t.sub })
        ]);
      })),
      h('div', { class: 'menu-foot' }, [
        h('button', { class: 'btn ghost', html: '🎮 Controls', onClick: ui.openControls }),
        h('span', { class: 'platform-badge', text: mobile ? '📱 Mobile build' : '💻 Desktop build' })
      ])
    ]));
    // Boot the delightful top-down 3D player animations (self-cleans on nav).
    if (global.THREE && F.hero3d) {
      try { F.hero3d.mount(heroCanvas); } catch (e) { /* non-fatal: menu works without it */ }
    }
  }

  function boot() {
    if (ui.IS_TOUCH) document.body.classList.add('is-touch');
    var appEl = document.getElementById('app');
    ui.mount(appEl);
    mainMenu();
    // First-run: show controls once
    if (!F.storage.get('seenControls')) {
      F.storage.set('seenControls', true);
      setTimeout(ui.openControls, 600);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
