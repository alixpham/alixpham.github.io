#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — IS THE BALL ACTUALLY IN HIS HANDS?

   The engine only knows who has POSSESSION. Whether the football is being
   drawn in that man's hands is a fact about the scene graph, and the scene
   graph is the one thing a headless box score cannot see: the ball is parented
   into somebody else's bone, so "held" means a parent and a local offset, and
   every way of getting that wrong still leaves a clean console and a ball
   somewhere on the screen.

   This drives a real game in headless Chromium and, every frame, reads back
   off the renderer (field3d.ballHold):

     * what the ball is actually PARENTED to
     * how far it is, in world yards, from the nearest hand of the man the
       engine says is carrying it
     * whether it fell back to a world-space position beside him instead

   A carried ball lives in a hand. Anything past ORPHAN yards from one is the
   ball floating next to a player rather than being held by him.

     node tools/ballcheck.mjs [--seconds 90] [--json]

   Needs Playwright and the swiftshader Chromium (session-start.sh provides
   both; FLAGSTER_CHROME overrides the binary). A dev tool — nothing in
   flagster/ imports it and the site ships no deps.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECONDS = parseFloat(arg('seconds', '90'));
const AS_JSON = process.argv.includes('--json');
const ORPHAN = 0.55;          // yards: past this the ball is not in a hand at all
/* And a second, tighter bar. A ball 0.3yd from the hand is still parented to
   the right limb and still "in" it by the structural test, which is exactly
   how the Ochi grip stayed wrong: the arm was posed correctly and the ball
   hung a foot off the end of it. A held ball measures 0.09yd on the Ochi
   athlete and 0.14 on the game's own player; anything past this is a football
   being carried at arm's length. */
const LOOSE = 0.25;

const CHROME = process.env.FLAGSTER_CHROME
  || fs.globSync?.('/opt/pw-browsers/chromium*/chrome-linux/chrome')?.sort().pop()
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--no-sandbox', '--disable-dev-shm-usage']
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));
await page.goto(base, { waitUntil: 'load' });
await page.waitForSelector('.menu-tiles', { timeout: 30000 });
await page.getByRole('button', { name: /Watch Demo/i }).click();
await page.waitForFunction(() => {
  const sh = window.FLAGSTER && window.FLAGSTER.activeShell;
  return !!(sh && sh.engine && sh.field3d && sh.field3d.ballHold);
}, null, { timeout: 30000 });

/* Sample inside the render loop rather than from outside it: the ball's local
   transform is written during render() and the transfer tween rewrites it at
   the very end, so a sample taken between frames from the driver would read a
   half-finished placement and blame the renderer for it. */
await page.evaluate(() => {
  const sh = window.FLAGSTER.activeShell;
  const inner = sh.engine.externalRender;
  window.__hold = [];
  window.__throws = [];
  sh.engine.externalRender = function (s) {
    let r;
    try { r = inner.call(this, s); }
    catch (err) { window.__throws.push(String((err && err.message) || err)); throw err; }
    try {
      if (sh.field3d && sh.field3d.ballHold) window.__hold.push(sh.field3d.ballHold(s));
    } catch (e) { window.__throws.push('ballHold: ' + e.message); }
    return r;
  };
});
await page.waitForTimeout(SECONDS * 1000);
const { hold, throws } = await page.evaluate(() => ({ hold: window.__hold, throws: window.__throws }));
await ctx.close();
await browser.close();
server.close();

const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
const med = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return +b[b.length >> 1].toFixed(3); };
const max = a => a.length ? +Math.max(...a).toFixed(3) : 0;

/* A carried frame: somebody has it, it is not in flight, the model is rigged,
   and the ball is not legitimately in world space — the snap travelling from
   the turf to the hands, or a dead ball sitting on the spot, are both drawn
   unparented on purpose and are not the thing being measured here. */
const carried = hold.filter(h => h.carrier >= 0 && !h.inAir && h.rigged &&
                                 !h.snapFly && !h.onGround);
const settled = carried.filter(h => !h.xfer);          // not mid-exchange
const gaps = settled.map(h => h.hand).filter(d => d >= 0);
const orphans = settled.filter(h => h.hand < 0 || h.hand > ORPHAN);
const loose = settled.filter(h => h.hand >= 0 && h.hand > LOOSE);
const unparented = settled.filter(h => !h.host);
const hosts = {};
settled.forEach(h => { hosts[h.host || '(world)'] = (hosts[h.host || '(world)'] || 0) + 1; });

const out = {
  frames: hold.length,
  carriedFrames: carried.length,
  riggedPct: pct(hold.filter(h => h.carrier >= 0 && h.rigged).length, hold.filter(h => h.carrier >= 0).length),
  snapFlyFrames: hold.filter(h => h.snapFly).length,
  deadBallFrames: hold.filter(h => h.carrier >= 0 && h.onGround).length,
  medianHandGap: med(gaps),
  worstHandGap: max(gaps),
  orphanPct: pct(orphans.length, settled.length),
  loosePct: pct(loose.length, settled.length),
  unparentedPct: pct(unparented.length, settled.length),
  hosts,
  renderThrows: throws.length,
  consoleErrors: errs.length
};

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); }
else {
  const row = (l, v, n) => `  ${l.padEnd(30)} ${String(v).padStart(9)}   ${n || ''}`;
  console.log(`\nBALL HOLD — ${SECONDS}s of live game, ${out.frames} rendered frames\n`);
  console.log(row('Frames with a carrier', out.carriedFrames, 'excl. snap + dead ball'));
  console.log(row('  snap in flight', out.snapFlyFrames, 'world space on purpose'));
  console.log(row('  dead ball on the spot', out.deadBallFrames, 'world space on purpose'));
  console.log(row('...on the rigged model', out.riggedPct + '%', 'the procedural rig has no hands'));
  console.log(row('Ball-to-hand, median', out.medianHandGap + 'yd', 'a football is 0.31yd long'));
  console.log(row('Ball-to-hand, worst', out.worstHandGap + 'yd', ''));
  console.log(row('Not in a hand (>' + ORPHAN + 'yd)', out.orphanPct + '%', 'must be 0'));
  console.log(row('Held at arm\'s length (>' + LOOSE + 'yd)', out.loosePct + '%', 'must be 0'));
  console.log(row('Parented to nothing', out.unparentedPct + '%', 'must be 0'));
  console.log('  hosts: ' + Object.entries(hosts).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(row('Render throws', out.renderThrows, ''));
  console.log(row('Console errors', out.consoleErrors, ''));
  console.log('');
}
const bad = out.orphanPct > 0 || out.unparentedPct > 0 || out.loosePct > 0 || out.renderThrows > 0;
process.exit(bad ? 1 : 0);
