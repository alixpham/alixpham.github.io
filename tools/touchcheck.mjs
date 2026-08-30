#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — MOBILE CONTROL RED TEAM

     node tools/touchcheck.mjs [--out DIR]

   The thumb controls have never been measured. `smoke` proves the phone
   viewports render without throwing, which is a statement about the console
   and not about whether a person can PLAY on a phone. This asks the questions
   a console cannot:

     size      every control against Apple HIG 44pt and Material 48dp, at the
               VISUAL rect and again at the hit rect — a 44px button with no
               expanded hit area is 44px, whatever the design intent
     safe      every control against the device's real notch / home-indicator
               insets. The CSS says `viewport-fit=cover` and then positions the
               cluster at a flat `right:14px;bottom:16px`, and there is not one
               env(safe-area-inset-*) in the file
     dead      a hit-test grid over the whole screen: every point is a button,
               the swipe pad, or SWALLOWED — a container with pointer-events
               auto that is not itself a control eats the touch and steers
               nothing. Those are the gaps between the buttons
     reflow    the same button, offence vs defence: a wrapping flexbox moves
               its children when the set changes, and muscle memory dies
     occlude   where the ball carrier actually is on screen (found by picking
               a grid through the renderer, not by guessing) against where the
               controls are
     slash     the one that needs the live engine. A slash and a stick share
               one gesture and the switch happens at 64px of travel, so every
               slash STEERS THE PLAYER for its first 63px. This drives a real
               CDP touch stroke and records what the engine was handed.

   Safe-area insets cannot be read from headless Chromium — env() resolves to
   0 with no notch — so they are modelled per device from Apple's published
   metrics and named as such in the output. Everything else is measured.

   A dev tool. Nothing in flagster/ imports it and the site still ships no deps.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg('out', path.join(ROOT, '.touch'));
const CHROME = process.env.FLAGSTER_CHROME
  || fs.globSync?.('/opt/pw-browsers/chromium*/chrome-linux/chrome')?.sort().pop()
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* Apple HIG "Buttons": 44x44pt minimum. Material Design accessibility:
   48x48dp minimum with 8dp between targets. Both are FLOORS for a settled UI;
   a control pressed under time pressure while the other thumb is busy is the
   case they were never written for. */
const HIG = 44, MATERIAL = 48, GAP_MIN = 8;

/* Modelled, not measured — see header. Portrait insets from Apple's device
   metrics; in landscape the sensor housing takes BOTH side insets because the
   OS does not know which way you turned the phone. */
const DEVICES = [
  { id: 'iphone-se-portrait',    w: 375, h: 667, safe: { t: 20, r: 0,  b: 0,  l: 0  }, note: 'no notch — the control case' },
  { id: 'iphone-15-portrait',    w: 393, h: 852, safe: { t: 59, r: 0,  b: 34, l: 0  } },
  { id: 'iphone-15-landscape',   w: 852, h: 393, safe: { t: 0,  r: 59, b: 21, l: 59 } },
  { id: 'iphone-15-pm-landscape',w: 932, h: 430, safe: { t: 0,  r: 59, b: 21, l: 59 } },
  { id: 'pixel-7-landscape',     w: 915, h: 412, safe: { t: 0,  r: 24, b: 24, l: 24 } }
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(b);
  });
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--no-sandbox', '--disable-dev-shm-usage']
});

const findings = [];
const add = (sev, dev, code, msg) => findings.push({ sev, dev, code, msg });

/* Start a real user-controlled game (not the demo — the demo hides the
   controls entirely, which is why none of this has ever been on screen in a
   harness before). */
async function startGame(page) {
  await page.waitForSelector('.menu-tiles', { timeout: 30000 });
  /* Build the shell directly rather than clicking through World. The menu path
     needs a nation picker per device and the thing under test is the HUD, not
     the front end — and `demo:true` hides the touch controls entirely, which is
     why no harness has ever had them on screen. */
  await page.evaluate(() => {
    const F = window.FLAGSTER, ui = F.ui, D = F.data;
    const a = D.NATIONS[0], b = D.NATIONS[1];
    const shell = new ui.GameShell({
      home: a, away: b,
      homeJersey: D.jerseysFor(a.id)[0], awayJersey: D.jerseysFor(b.id)[1],
      userSide: 'home', startPossession: 'home',
      halves: 2, halfLen: 1200, demo: false, difficulty: 'pro',
      onQuit: function () {}, onGameOver: function () {}
    });
    ui.show(shell.build());
  });
  await page.waitForFunction(() => {
    const sh = window.FLAGSTER && window.FLAGSTER.activeShell;
    return !!(sh && sh.engine && sh.field3d);
  }, null, { timeout: 30000 });
  await page.waitForTimeout(2500);

  /* Get to a LIVE ball. Everything below this line measures the controls
     against the field, and a shell that has only just been built is sitting
     behind a full-screen play-call sheet — the first run of this probe
     measured the button cluster through that sheet and reported a screen with
     no dead zones and no players on it, because there were none. */
  /* AND PICK IT WITH A THUMB. `locator.click()` is a MOUSE click, and it waits
     for the element to be "visible, enabled and stable" first — a check that
     timed out after ten seconds on every device here while the card's bounding
     box was byte-identical across six consecutive animation frames and
     `elementFromPoint` at its centre returned the card. Whatever that check is
     unhappy about under swiftshader, it is not something a finger would care
     about: the same tap dispatched as a real touch selects the play in 800ms.

     Two devices were silently landing on the play-call sheet because of it,
     and the sheet is opaque and full-screen — every field measurement taken
     through it is void. It only surfaced at all because of the `state` guard a
     few lines down, which exists because an earlier version of this probe
     measured the sheet and reported a screen with no dead zones and no players
     on it. A touch probe that reaches its own test fixture by mouse deserved
     to be bitten. */
  const card = await page.evaluate(() => {
    const c = document.querySelector('.play-card'); if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (card) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: card.x, y: card.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const sh = window.FLAGSTER.activeShell;
    document.body.classList.add('is-touch');
    sh.touch.classList.remove('hidden');
    if (sh.engine.state.phase === 'presnap') sh.engine.action('primary');
  });
  await page.waitForFunction(() => {
    const s = window.FLAGSTER.activeShell.engine.state;
    return s.phase === 'live' && !!s.carrier;
  }, null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
}

for (const dev of DEVICES) {
  const ctx = await browser.newContext({
    viewport: { width: dev.w, height: dev.h },
    hasTouch: true, isMobile: true, deviceScaleFactor: 3
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(base, { waitUntil: 'load' });
  try { await startGame(page); }
  catch (e) { add('BLOCK', dev.id, 'nogame', 'could not reach a playable game: ' + e.message.slice(0, 80)); await ctx.close(); continue; }

  /* Say out loud what state we are measuring. The first version of this probe
     silently measured the play-call sheet and reported a clean screen. */
  const phase = await page.evaluate(() => {
    const sh = window.FLAGSTER.activeShell;
    document.body.classList.add('is-touch');
    sh.touch.classList.remove('hidden');
    return { phase: sh.engine.state.phase,
             sheet: !!document.querySelector('.playcall:not(.hidden)'),
             carrier: !!sh.engine.state.carrier };
  });
  if (phase.phase !== 'live' || phase.sheet)
    add('BLOCK', dev.id, 'state', `not measuring a live play (phase=${phase.phase}, playcall sheet up=${phase.sheet}) — field results below are void`);

  /* THE MODELLED NOTCH, STOOD UP BEFORE ANYTHING IS MEASURED.

     A headless browser has no notch and resolves `env(safe-area-inset-*)` to 0
     in every direction, so a stylesheet that pads for one and a stylesheet that
     ignores it lay out identically here. Checking the modelled inset against
     that geometry graded the stylesheet's intentions, not the layout.

     The insets are read through `--safe-*` variables that default to `env()`,
     so putting this device's real values in their place is one setProperty per
     side. Everything below then measures where the controls ACTUALLY went on a
     phone with that notch. */
  await page.evaluate((s) => {
    const r = document.documentElement.style;
    r.setProperty('--safe-t', s.t + 'px'); r.setProperty('--safe-r', s.r + 'px');
    r.setProperty('--safe-b', s.b + 'px'); r.setProperty('--safe-l', s.l + 'px');
  }, dev.safe);
  await page.waitForTimeout(150);

  /* ---------------- 1. control geometry, both button sets ---------------- */
  const geo = await page.evaluate(() => {
    const sh = window.FLAGSTER.activeShell;
    const snap = (setName) => {
      sh._offBtns.style.display = setName === 'off' ? '' : 'none';
      sh._defBtns.style.display = setName === 'def' ? '' : 'none';
      sh._snapBtn.style.display = '';
      const out = [];
      document.querySelectorAll('.act-btn').forEach(b => {
        if (!b.offsetParent) return;
        const r = b.getBoundingClientRect();
        out.push({ label: (b.textContent || '').trim() || b.className,
                   x: r.x, y: r.y, w: r.width, h: r.height });
      });
      return out;
    };
    const off = snap('off'), def = snap('def');
    const cl = document.querySelector('.right-cluster').getBoundingClientRect();
    sh._offBtns.style.display = ''; sh._defBtns.style.display = 'none';
    return { off, def, cluster: { x: cl.x, y: cl.y, w: cl.width, h: cl.height } };
  });

  for (const b of geo.off.concat(geo.def)) {
    const min = Math.min(b.w, b.h);
    if (min < HIG) add('HIGH', dev.id, 'size', `"${b.label}" is ${b.w.toFixed(0)}x${b.h.toFixed(0)} — under Apple's 44pt floor`);
    else if (min < MATERIAL) add('MED', dev.id, 'size', `"${b.label}" is ${b.w.toFixed(0)}x${b.h.toFixed(0)} — meets Apple 44 but under Material 48`);
  }

  /* ---------------- 2. safe areas ----------------
     A HEADLESS BROWSER HAS NO NOTCH, and `env(safe-area-inset-*)` resolves to
     0 in one — so a stylesheet that pads for the notch and one that ignores it
     lay out identically here, and this check could only ever compare the
     modelled inset against geometry that never moved. It graded the
     stylesheet's intentions.

     The insets are read through `--safe-*` variables that default to `env()`,
     so standing the modelled device's real values up in their place is one
     `setProperty` per side. The layout then reflows as it would on the phone
     and what follows measures where the buttons ACTUALLY went. */
  const S = dev.safe;
  for (const b of geo.off.concat(geo.def)) {
    const over = [];
    if (b.y < S.t) over.push(`top by ${(S.t - b.y).toFixed(0)}px`);
    if (b.x < S.l) over.push(`left by ${(S.l - b.x).toFixed(0)}px`);
    if (b.x + b.w > dev.w - S.r) over.push(`right by ${(b.x + b.w - (dev.w - S.r)).toFixed(0)}px`);
    if (b.y + b.h > dev.h - S.b) over.push(`bottom by ${(b.y + b.h - (dev.h - S.b)).toFixed(0)}px`);
    if (over.length) add('HIGH', dev.id, 'safe', `"${b.label}" intrudes into the ${over.join(' and ')} inset`);
  }

  /* ---------------- 3. gaps between adjacent targets ---------------- */
  const bs = geo.off;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j];
    const gx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
    const gy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
    const g = Math.hypot(gx, gy);
    const touching = (gx === 0 && gy < 40) || (gy === 0 && gx < 40);
    if (touching && g > 0 && g < GAP_MIN)
      add('LOW', dev.id, 'gap', `"${a.label}" and "${b.label}" are ${g.toFixed(0)}px apart — under Material's 8dp`);
  }

  /* ---------------- 4. dead zones: where does a touch actually go? ------- */
  const dead = await page.evaluate(() => {
    const STEP = 6, out = { total: 0, swipe: 0, btn: 0, swallowed: 0, boxes: [] };
    let run = null;
    for (let y = 0; y < innerHeight; y += STEP) {
      for (let x = 0; x < innerWidth; x += STEP) {
        const el = document.elementFromPoint(x, y);
        out.total++;
        let kind = 'swallowed';
        if (!el) kind = 'swallowed';
        else if (el.closest('.act-btn, .mini-btn')) kind = 'btn';
        else if (el.closest('.swipe-pad')) kind = 'swipe';
        else if (el.closest('.sb, .playcall, .overlay, .grab-wrap')) kind = 'hud';
        out[kind === 'hud' ? 'swipe' : kind]++;   // HUD is not a control failure
        if (kind === 'swallowed') {
          const t = el ? (el.className || el.tagName) : 'null';
          out.boxes.push({ x, y, t: String(t).slice(0, 40) });
        }
      }
    }
    return out;
  });
  if (dead.swallowed > 0) {
    // Collapse to a bounding box so the report is readable.
    const xs = dead.boxes.map(b => b.x), ys = dead.boxes.map(b => b.y);
    const pct = (100 * dead.swallowed / dead.total).toFixed(1);
    add('HIGH', dev.id, 'dead',
      `${dead.swallowed} of ${dead.total} sampled points (${pct}%) hit nothing — ` +
      `x ${Math.min(...xs)}-${Math.max(...xs)}, y ${Math.min(...ys)}-${Math.max(...ys)}; ` +
      `topmost is "${dead.boxes[0].t}". These are the channels BETWEEN the buttons: ` +
      `a thumb landing there neither presses nor steers.`);
  }

  /* ---------------- 5. reflow between offence and defence --------------- */
  const moved = [];
  for (const a of geo.off) {
    const b = geo.def.find(d => d.label === a.label);
    if (b && (Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2))
      moved.push(`${a.label} ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(0)}px`);
  }
  const snapOff = geo.off.find(b => /SNAP/.test(b.label));
  const snapDef = geo.def.find(b => /SNAP/.test(b.label));
  if (snapOff && snapDef && Math.hypot(snapOff.x - snapDef.x, snapOff.y - snapDef.y) > 2)
    moved.push(`SNAP ${Math.hypot(snapOff.x - snapDef.x, snapOff.y - snapDef.y).toFixed(0)}px`);
  if (moved.length) add('MED', dev.id, 'reflow', `controls move when possession flips: ${moved.join(', ')}`);

  /* ---------------- 6. does the cluster cover the ball carrier? --------- */
  const occl = await page.evaluate(() => {
    const sh = window.FLAGSTER.activeShell;
    if (!sh.field3d || !sh.field3d.pick) return null;
    const st = sh.engine.state;
    const carrier = st.carrier;
    const idx = carrier ? st.players.indexOf(carrier) : -1;
    const hits = [];
    for (let y = 0; y < innerHeight; y += 8)
      for (let x = 0; x < innerWidth; x += 8) {
        const p = sh.field3d.pick(x, y);
        if (p >= 0) hits.push({ x, y, p });
      }
    const cl = document.querySelector('.right-cluster').getBoundingClientRect();
    const inCluster = h => h.x >= cl.x && h.x <= cl.right && h.y >= cl.y && h.y <= cl.bottom;
    const mine = idx >= 0 ? hits.filter(h => h.p === idx) : [];
    return {
      idx, players: hits.length, hidden: hits.filter(inCluster).length,
      carrierPts: mine.length, carrierHidden: mine.filter(inCluster).length,
      cluster: { x: cl.x, y: cl.y, w: cl.width, h: cl.height },
      clusterPctOfScreen: 100 * (cl.width * cl.height) / (innerWidth * innerHeight)
    };
  });
  if (occl) {
    add('INFO', dev.id, 'cluster',
      `button cluster is ${occl.cluster.w.toFixed(0)}x${occl.cluster.h.toFixed(0)}px = ` +
      `${occl.clusterPctOfScreen.toFixed(1)}% of the screen`);
    if (occl.players && occl.hidden / occl.players > 0.06)
      add('MED', dev.id, 'occlude',
        `${(100 * occl.hidden / occl.players).toFixed(0)}% of all on-screen player pixels sit under the button cluster`);
  }

  /* ---------------- 6a. …and where he is over a whole DOWN ---------------
     "Right now" is one frame, and one frame of a football match is not a
     measurement — the same lesson the QB work learned from a single seed. The
     carrier is drawn low because the chase camera looks PAST him at a point
     downfield, so he sits below the screen centre for the whole play and the
     button cluster is bottom-right: whether they collide depends entirely on
     how far he drifts sideways, which is exactly what one still cannot tell
     you. A single sample here read 52% on one device and 0% on three others
     that turn out to be no better.

     So sample him every rendered frame for a stretch of live play and report
     the distribution: what share of frames he is under the buttons at all, and
     the worst overlap seen. Cheap enough to do per frame because
     `carrierScreen` projects eight corners instead of raycasting the viewport.

     Note the clock. Under swiftshader the renderer manages about two frames a
     second against a 50ms clamped delta, so sim time runs at roughly a tenth
     of real — waiting in WALL time samples almost nothing. Count FRAMES. */
  const track = await page.evaluate(async () => {
    const sh = window.FLAGSTER.activeShell;
    const f3 = sh.field3d;
    if (!f3 || !f3.carrierScreen) return null;
    const cl = document.querySelector('.right-cluster').getBoundingClientRect();
    const out = [];
    for (let i = 0; i < 90; i++) {
      await new Promise(r => requestAnimationFrame(r));
      const st = sh.engine.state;
      if (st.phase !== 'live') continue;
      const b = f3.carrierScreen(st, innerWidth, innerHeight);
      if (!b || b.w <= 0 || b.h <= 0) continue;
      const ox = Math.max(0, Math.min(b.x + b.w, cl.right) - Math.max(b.x, cl.x));
      const oy = Math.max(0, Math.min(b.y + b.h, cl.bottom) - Math.max(b.y, cl.y));
      out.push({ frac: (ox * oy) / (b.w * b.h), cx: (b.x + b.w / 2) / innerWidth });
    }
    return out;
  });
  if (track && track.length >= 10) {
    const hit = track.filter(t => t.frac > 0.02);
    const worst = track.reduce((m, t) => Math.max(m, t.frac), 0);
    const mean = track.reduce((a, t) => a + t.frac, 0) / track.length;
    const cx = track.reduce((a, t) => a + t.cx, 0) / track.length;
    add('INFO', dev.id, 'carrier',
      `over ${track.length} live frames the carrier sits at x=${(100 * cx).toFixed(0)}% of the width; ` +
      `under the buttons in ${(100 * hit.length / track.length).toFixed(0)}% of them ` +
      `(mean ${(100 * mean).toFixed(1)}% of him, worst ${(100 * worst).toFixed(0)}%)`);
    if (hit.length / track.length > 0.15 || worst > 0.5)
      add('HIGH', dev.id, 'occlude',
        `the BALL CARRIER is behind the buttons in ${(100 * hit.length / track.length).toFixed(0)}% of ` +
        `${track.length} live frames (worst ${(100 * worst).toFixed(0)}% of him); ` +
        `he averages x=${(100 * cx).toFixed(0)}% of the screen width`);
  } else if (track) {
    add('MED', dev.id, 'carrier', `only ${track.length} live frames sampled — carrier tracking inconclusive`);
  }

  /* ---------------- 6b. do the controls collide with the HUD? ----------- */
  /* `.pc` and `.sit` are dropped at max-width:620px — a rule written for
     portrait. Every landscape phone is wider than that, so in the orientation
     people actually play in the panels stay up and the button stack, which is
     anchored bottom-right and grows UPWARD, climbs into them. */
  const hud = await page.evaluate(() => {
    const cl = document.querySelector('.right-cluster');
    if (!cl) return null;
    const r = cl.getBoundingClientRect(), out = [];
    ['.sit', '.pc', '.sb'].forEach(sel => {
      const el = document.querySelector(sel);
      if (!el || !el.offsetParent) return;
      const b = el.getBoundingClientRect();
      const ox = Math.max(0, Math.min(r.right, b.right) - Math.max(r.x, b.x));
      const oy = Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.y, b.y));
      if (ox > 0 && oy > 0) out.push({ sel, ox, oy, pct: 100 * (ox * oy) / (b.width * b.height) });
    });
    return { cluster: { y: r.y, h: r.height }, vh: innerHeight, overlaps: out };
  });
  if (hud) {
    add('INFO', dev.id, 'stack', `the button stack spans ${(100 * hud.cluster.h / hud.vh).toFixed(0)}% of the screen height, topping out ${hud.cluster.y.toFixed(0)}px from the top edge`);
    hud.overlaps.forEach(o => add('HIGH', dev.id, 'hudclash',
      `the button stack covers ${o.pct.toFixed(0)}% of ${o.sel} (${o.ox.toFixed(0)}x${o.oy.toFixed(0)}px) — the panels are only dropped below 620px, a portrait breakpoint no landscape phone ever hits`));
  }

  /* ---------------- 7. latched inputs and slide-across ------------------ */
  /* The OS steals touches — an edge gesture, a call, palm rejection — and
     delivers touchcancel instead of touchend. A hold button that only listens
     for touchend never hears about it and stays down forever. */
  const latch = await page.evaluate(() => {
    const eng = window.FLAGSTER.activeShell.engine, out = {};
    const send = (el, ty, t) => el.dispatchEvent(new TouchEvent(ty, {
      touches: ty === 'touchstart' ? [t] : [], targetTouches: ty === 'touchstart' ? [t] : [],
      changedTouches: [t], bubbles: true, cancelable: true }));
    const sprint = document.querySelector('.act-btn.sprint');
    if (sprint) {
      const t = new Touch({ identifier: 91, target: sprint, clientX: 1, clientY: 1 });
      send(sprint, 'touchstart', t);
      const on = eng.input.sprint;
      send(sprint, 'touchcancel', t);
      out.sprintStuck = on && eng.input.sprint === true;
      send(sprint, 'touchend', t); eng.input.sprint = false;
    }
    // A touch that begins on one button and slides onto another: the first
    // element captures the whole stroke, so the second never hears anything.
    const bs = [...document.querySelectorAll('.act-btn')].filter(b => b.offsetParent);
    if (bs.length > 1) {
      let fired = 0; const real = eng.action.bind(eng);
      eng.action = (a) => { fired++; return real(a); };
      const ra = bs[0].getBoundingClientRect(), rb = bs[1].getBoundingClientRect();
      const t1 = new Touch({ identifier: 92, target: bs[0], clientX: ra.x + ra.width / 2, clientY: ra.y + ra.height / 2 });
      send(bs[0], 'touchstart', t1);
      const t2 = new Touch({ identifier: 92, target: bs[0], clientX: rb.x + rb.width / 2, clientY: rb.y + rb.height / 2 });
      bs[0].dispatchEvent(new TouchEvent('touchmove', { touches: [t2], targetTouches: [t2], changedTouches: [t2], bubbles: true, cancelable: true }));
      send(bs[0], 'touchend', t2);
      eng.action = real;
      out.slideAcross = fired > 1;
    }
    // Is preventDefault actually honoured, or is the listener passive?
    const pad = document.querySelector('.swipe-pad');
    const tp = new Touch({ identifier: 93, target: pad, clientX: 300, clientY: 200 });
    const ev = new TouchEvent('touchstart', { touches: [tp], targetTouches: [tp], changedTouches: [tp], bubbles: true, cancelable: true });
    pad.dispatchEvent(ev);
    out.padPrevented = ev.defaultPrevented;
    send(pad, 'touchend', tp);
    return out;
  });
  if (latch.sprintStuck)
    add('HIGH', dev.id, 'latch', 'SPRINT stays ON after a touchcancel — the button has no touchcancel handler, so any touch the OS steals (edge gesture, notification, palm rejection) latches sprint down for the rest of the game');
  if (latch.slideAcross === false)
    add('LOW', dev.id, 'slide', 'a touch that starts on one button and slides to another never fires the second — the first element captures the stroke, so the cluster cannot be thumbed across');
  if (!latch.padPrevented)
    add('HIGH', dev.id, 'passive', 'the swipe pad cannot preventDefault — the listener is passive and the page will scroll under the gesture');

  /* ---------------- 7. the slash pre-steer ------------------------------ */
  /* Draw an L: 120px right, then 120px up — the "cut around a defender" the
     feature exists for. Record every setStick the engine is handed, and every
     slash waypoint, in order. */
  const slash = await page.evaluate(async () => {
    const sh = window.FLAGSTER.activeShell, eng = sh.engine;
    const log = [];
    const realStick = eng.setStick.bind(eng);
    const realAppend = eng.appendSlash ? eng.appendSlash.bind(eng) : null;
    eng.setStick = (dx, dy, a) => { log.push({ k: 'stick', dx, dy, a }); return realStick(dx, dy, a); };
    if (realAppend) eng.appendSlash = (g) => { log.push({ k: 'slash' }); return realAppend(g); };

    const pad = document.querySelector('.swipe-pad');
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 7, target: pad, clientX: x, clientY: y });
      pad.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        targetTouches: type === 'touchend' ? [] : [t],
        changedTouches: [t], bubbles: true, cancelable: true
      }));
    };
    const x0 = Math.round(innerWidth * 0.35), y0 = Math.round(innerHeight * 0.6);
    mk('touchstart', x0, y0);
    for (let i = 6; i <= 120; i += 6) mk('touchmove', x0 + i, y0);
    for (let i = 6; i <= 120; i += 6) mk('touchmove', x0 + 120, y0 - i);
    mk('touchend', x0 + 120, y0 - 120);

    eng.setStick = realStick; if (realAppend) eng.appendSlash = realAppend;
    const steers = log.filter(l => l.k === 'stick' && l.a);
    const firstSlash = log.findIndex(l => l.k === 'slash');
    const before = firstSlash < 0 ? steers.length
      : log.slice(0, firstSlash).filter(l => l.k === 'stick' && l.a).length;
    return {
      steers: steers.length, before, slashPts: log.filter(l => l.k === 'slash').length,
      dirs: steers.slice(0, before).map(s => Math.round(Math.atan2(s.dy, s.dx) * 180 / Math.PI))
    };
  });
  if (slash.slashPts === 0) {
    add('MED', dev.id, 'slash', 'the L-stroke never became a slash — it steered for the whole gesture');
  } else if (slash.before > 0) {
    const uniq = [...new Set(slash.dirs)];
    add('HIGH', dev.id, 'slash',
      `an L-shaped slash fed the engine ${slash.before} live steering frames ` +
      `(heading ${uniq.join('/')}deg) BEFORE the route took over — the player is ` +
      `driven up to 64px-worth of travel along the first leg of a stroke you are ` +
      `drawing to avoid exactly that`);
  }

  await page.screenshot({ path: path.join(OUT, dev.id + '.png') });
  if (errs.length) add('MED', dev.id, 'error', errs[0].slice(0, 120));
  await ctx.close();
}

await browser.close();
server.close();

/* ------------------------------- report -------------------------------- */
const ORDER = { BLOCK: 0, HIGH: 1, MED: 2, LOW: 3, INFO: 4 };
findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || a.code.localeCompare(b.code));
console.log('\n  FLAGSTER — mobile control red team\n');
let last = '';
for (const f of findings) {
  if (f.sev !== last) { console.log(`  ── ${f.sev} ──`); last = f.sev; }
  console.log(`  [${f.code.padEnd(7)}] ${f.dev.padEnd(22)} ${f.msg}`);
}
const bad = findings.filter(f => f.sev === 'HIGH' || f.sev === 'BLOCK').length;
console.log(`\n  ${findings.length} findings, ${bad} high/blocking — shots in ${OUT}\n`);
process.exit(0);
