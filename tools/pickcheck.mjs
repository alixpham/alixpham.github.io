#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — DOES THE PICK SIX ACTUALLY PLAY?

   An interception return is the only moment in this game when the field turns
   round. Possession changes while the ball is still live, the man carrying it
   runs at the end zone BEHIND the offence he took it from, and the camera has
   to come with him — `engine.viewSign()` and `state.viewDir` exist for exactly
   this and were a hard-wired +1 for eleven releases.

   None of that is visible to a headless box score. simstats can tell you a
   return happened and how many yards it made; it cannot tell you the shot was
   pointing the wrong way while it did, because a camera on the wrong side of
   the ball still renders a clean frame with the ball in it — keepInFrame makes
   sure of that. So this drives a real game in headless Chromium, forces picks,
   and reads back off the renderer every frame of every return:

     * WHICH SIDE OF THE BALL THE LENS IS ON. Behind the offence for a normal
       down (camera x < ball x, because the offence attacks +x); behind the
       RETURNER for a return, which is the other side.
     * whether the man being watched is on screen at all, in CSS pixels.
     * that the play stayed live, and how far the return covered.

     node tools/pickcheck.mjs [--picks 6] [--json]

   The pick is forced rather than waited for: an interception is ~4.5% of pass
   plays, so waiting for six of them in a demo takes a quarter of an hour of
   swiftshader. `engine._interception` is the same entry point _resolveCatch
   calls, with the ball put in the defender's hands the same way.

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
const PICKS = parseInt(arg('picks', '6'), 10);
const AS_JSON = process.argv.includes('--json');
const W = 1280, H = 720;

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
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
const page = await ctx.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));
await page.goto(base, { waitUntil: 'load' });
await page.waitForSelector('.menu-tiles', { timeout: 30000 });
await page.getByRole('button', { name: /Watch Demo/i }).click();
await page.waitForFunction(() => {
  const sh = window.FLAGSTER && window.FLAGSTER.activeShell;
  return !!(sh && sh.engine && sh.field3d && sh.field3d.debugCamera);
}, null, { timeout: 30000 });

await page.evaluate((n) => {
  const sh = window.FLAGSTER.activeShell, eng = sh.engine;
  const inner = eng.externalRender;
  window.__f = [];            // one row per rendered frame
  window.__throws = [];
  window.__picks = 0;
  window.__want = n;
  /* Sample inside the render loop: the camera is written during render(), so a
     sample taken from the driver between frames reads whatever was left over. */
  eng.externalRender = function (s) {
    /* FORCE ONE, BEFORE THE FRAME IS DRAWN. A real interception is resolved
       inside engine._update, which runs before the renderer sees the state, so
       forcing one afterwards would leave the camera one frame behind the flip
       and blame the renderer for the probe's own ordering — worth 1.9% of
       return frames on the wrong side of the ball, which is exactly the
       failure this is looking for. Wait until the passer has held it a beat
       too: a pick on the frame of the snap starts the return inside the
       formation and measures the camera against a pile of bodies. */
    try {
      if (s.phase === 'live' && !s.returning && s.carrier && s.carrier === s.passer &&
          s.snapT > 1.4 && !s.ball.inAir && window.__picks < window.__want) {
        const qb = s.carrier;
        const d = s.players.filter(p => p.team !== qb.team && !p.flagPulled)
          .sort((a, b) => Math.hypot(a.x - qb.x, a.y - qb.y) - Math.hypot(b.x - qb.x, b.y - qb.y))[2];
        if (d) {
          qb.hasBall = false; d.hasBall = true; s.carrier = d;
          s.ball.x = d.x; s.ball.y = d.y; s.ball.z = 0;
          eng._interception('INTERCEPTED by ' + d.last + '!', d);
          window.__picks++;
        }
      }
    } catch (e) { window.__throws.push('force: ' + e.message); }
    let r;
    try { r = inner.call(this, s); }
    catch (err) { window.__throws.push(String((err && err.message) || err)); throw err; }
    try {
      const cam = sh.field3d.debugCamera();
      const box = sh.field3d.carrierScreen(s, window.innerWidth, window.innerHeight);
      window.__f.push({
        phase: s.phase, returning: !!s.returning, viewDir: s.viewDir,
        ballX: s.ball ? s.ball.x : null, ballY: s.ball ? s.ball.y : null,
        carrier: s.carrier ? s.players.indexOf(s.carrier) : -1,
        camX: cam.x, lookX: cam.lookX,
        onScreen: box ? (box.x + box.w > 0 && box.x < window.innerWidth &&
                         box.y + box.h > 0 && box.y < window.innerHeight) : null,
        score: s.score.home + s.score.away
      });
    } catch (e) { window.__throws.push('probe: ' + e.message); }
    return r;
  };
}, PICKS);

/* Swiftshader renders about two frames a second against a 50ms clamped delta,
   so this waits on the COUNT rather than on the clock (see celebcheck). */
await page.waitForFunction(() => window.__picks >= window.__want &&
  !window.FLAGSTER.activeShell.engine.state.returning, null, { timeout: 600000 });
await page.waitForTimeout(3000);
const { f, throws, picks } = await page.evaluate(() =>
  ({ f: window.__f, throws: window.__throws, picks: window.__picks }));
await ctx.close();
await browser.close();
server.close();

/* ---- read it back ------------------------------------------------------- */
const live = f.filter(r => r.phase === 'live' && r.carrier >= 0 && r.ballX != null);
const rets = live.filter(r => r.returning);
const normal = live.filter(r => !r.returning);

/* BEHIND HIM. The lens sits `back` yards the other side of the ball from the
   way he is running: camera x below the ball on a normal down, above it on a
   return. A yard of slack, because the shot eases and a hard cut still takes
   one frame to land. */
const wrongSideNormal = normal.filter(r => r.camX > r.ballX - 1);
const wrongSideReturn = rets.filter(r => r.camX < r.ballX + 1);
const offScreen = rets.filter(r => r.onScreen === false);
const noFlip = rets.filter(r => r.viewDir !== -1);

/* How far each return actually went, from the frames themselves. */
const runs = [];
let cur = null;
for (const r of f) {
  if (r.returning && !cur) cur = { from: r.ballX, to: r.ballX, frames: 0 };
  else if (r.returning && cur) { cur.to = r.ballX; cur.frames++; }
  else if (!r.returning && cur) { runs.push(cur); cur = null; }
}
if (cur) runs.push(cur);

const pct = (n, d) => d ? +(100 * n / d).toFixed(1) : 0;
const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0;
const out = {
  frames: f.length,
  picksForced: picks,
  returns: runs.length,
  returnFrames: rets.length,
  avgReturnYds: avg(runs.map(r => r.from - r.to)),
  longestReturnYds: runs.length ? +Math.max(...runs.map(r => r.from - r.to)).toFixed(2) : 0,
  cameraWrongSideNormalPct: pct(wrongSideNormal.length, normal.length),
  cameraWrongSideReturnPct: pct(wrongSideReturn.length, rets.length),
  returnerOffScreenPct: pct(offScreen.length, rets.length),
  viewDirNotFlippedPct: pct(noFlip.length, rets.length),
  renderThrows: throws.length,
  consoleErrors: errs.length
};

if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  const row = (l, v, n) => `  ${l.padEnd(32)} ${String(v).padStart(9)}   ${n || ''}`;
  console.log(`\nPICK SIX — ${out.picksForced} forced interceptions, ${out.frames} rendered frames\n`);
  console.log(row('Returns rendered', out.returns, out.returnFrames + ' frames'));
  console.log(row('Return distance, average', out.avgReturnYds + 'yd', 'longest ' + out.longestReturnYds));
  console.log(row('Lens ahead of a normal down', out.cameraWrongSideNormalPct + '%', 'must be 0'));
  console.log(row('Lens ahead of a return', out.cameraWrongSideReturnPct + '%', 'must be 0'));
  console.log(row('Returner off screen', out.returnerOffScreenPct + '%', 'must be 0'));
  console.log(row('viewDir did not flip', out.viewDirNotFlippedPct + '%', 'must be 0'));
  console.log(row('Render throws', out.renderThrows, ''));
  console.log(row('Console errors', out.consoleErrors, ''));
  console.log('');
}
const bad = out.returns < 1 || out.cameraWrongSideNormalPct > 0 || out.cameraWrongSideReturnPct > 0 ||
            out.returnerOffScreenPct > 0 || out.viewDirNotFlippedPct > 0 || out.renderThrows > 0;
process.exit(bad ? 1 : 0);
