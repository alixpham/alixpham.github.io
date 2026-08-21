#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — CELEBRATION PROBE

   Drives the real game in headless Chromium, fires each kind of celebration
   through the engine's own entry point, and reports what the ten bodies on the
   field ACTUALLY did — which clip each one ran, how many distinct silhouettes
   the group held, whether the man it happened to played his one-shot, and how
   far off the turf anybody got.

       node tools/celebcheck.mjs [--timeout 120] [--shots dir]

   WHY IT HAS TO FORCE THEM

   Celebrations are the rarest thing the renderer draws. A touchdown is maybe
   one event a minute; the first-down celebration fires only on the down that
   crosses midfield; a takeaway can go a whole demo without happening at all.
   tools/animcheck.mjs samples a real game and is the honest measure of what a
   player will typically SEE — but it can watch for three minutes and report
   nothing about a clip that is wired up perfectly. So this one asks the engine
   for each piece of news in turn (Engine._celebrate, exactly what a score
   calls) and then reads the answer back off the renderer.

   WHAT IT CHECKS, and why each is the honest test

   clips        Per player, the clip the mixer is actually on, sampled every
                rendered frame — not "was play() called". A celebration that
                names a clip the rig doesn't carry fails silently and leaves
                the player standing exactly as he was, which is a bug you
                cannot see in a still.
   variety      How many DISTINCT clips the celebrating side held at once. The
                whole point of having ten celebrations is that a group is not
                one animation played five times; one distinct clip across five
                men is the failure this exists to catch.
   star         Whether the man it happened to fired his one-shot (Spike for a
                score, Point for a first down) and landed in his loop.
   ground       The lowest holder height on the celebrating side. Players hop;
                they must not sink. Negative is a body through the turf.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
/* A WALL-CLOCK WAIT IS THE WRONG WAIT, and getting that wrong is how this
   probe first reported that a first down plays the Spike. swiftshader renders
   this page about twice a second and the engine clamps its frame delta to 50ms,
   so SIM time runs at roughly a tenth of wall time: three real seconds is a
   third of a second of animation, which is not even the length of the one-shot.
   So nothing here waits a number of seconds — it waits for the celebration the
   renderer is running to actually END, however long that takes. */
const TIMEOUT = parseFloat(arg('timeout', '120'));
const SHOTS = arg('shots', '');

const CHROME = process.env.FLAGSTER_CHROME
  || fs.globSync?.('/opt/pw-browsers/chromium*/chrome-linux/chrome')?.sort().pop()
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  ({ chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules/playwright/index.js')).href)
    .then(m => m.default || m));
} catch {
  console.error('celebcheck.mjs needs Playwright:  npm install');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const browser = await chromium.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--no-sandbox', '--disable-dev-shm-usage']
});
const ctx = await browser.newContext({ viewport: { width: 900, height: 506 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForSelector('.menu-tiles', { timeout: 30000 });
await page.getByRole('button', { name: /Watch Demo/i }).click();
await page.waitForFunction(() => {
  const sh = window.FLAGSTER && window.FLAGSTER.activeShell;
  return !!(sh && sh.engine && sh.engine.externalRender && sh.field3d && sh.field3d.debugPlayers);
}, null, { timeout: 45000 });
// Let the demo reach a live play, so there is a carrier to be the star of it.
await page.waitForFunction(() => {
  const s = window.FLAGSTER.activeShell.engine.state;
  return s.phase === 'live' && s.carrier;
}, null, { timeout: 45000 });

/* The sampler. Hooks externalRender rather than a timer for the same reason
   animcheck does: a timer measures swiftshader's frame rate, not the game. */
await page.evaluate(() => {
  const sh = window.FLAGSTER.activeShell, e = sh.engine, f3 = sh.field3d;
  const S = window.__CELEB = { on: false, seen: {}, star: [], lowY: Infinity, frames: 0 };
  const inner = e.externalRender;
  e.externalRender = function (s) {
    inner.call(this, s);
    if (!S.on || S.done) return;
    try {
      const cs = f3.celebState();
      // Started, then stopped: that is the whole celebration, in sim time.
      if (!cs.kind) { if (S.frames) S.done = true; return; }
      S.frames++;
      const dbg = f3.debugPlayers();
      for (const d of dbg) {
        if (cs.teams[d.i] !== cs.team || !d.clip) continue;
        (S.seen[d.i] = S.seen[d.i] || []).push(d.clip);
        if (d.i === S.starIdx && S.star[S.star.length - 1] !== d.clip) S.star.push(d.clip);
        const y = cs.y[d.i];
        if (y != null && y < S.lowY) S.lowY = y;
      }
    } catch (err) { S.err = String((err && err.message) || err); }
  };
});

/* `side` is which half of the roster celebrates, because that is not a free
   choice: state.players is five on offence then five on defence, so a score is
   always celebrated by slots 0-4 and a takeaway always by slots 5-9. Firing
   them all as the offence would test one half of the palette twice and the
   other never. */
const KINDS = [
  { kind: 'td', label: 'TOUCHDOWN', once: 'Spike', side: 'offence' },
  { kind: 'firstdown', label: 'FIRST DOWN', once: 'Point', side: 'offence' },
  { kind: 'takeaway', label: 'TAKEAWAY', once: '', side: 'defence' }
];
const results = [];
for (const K of KINDS) {
  /* Freeze the play first. The engine stops moving bodies when the ball is
     dead, and a celebration on top of a live play would have five men running
     out from under their own animation — which is not what any of these is
     ever seen over. */
  await page.evaluate(({ kind, side }) => {
    const sh = window.FLAGSTER.activeShell, e = sh.engine, s = e.state;
    const S = window.__CELEB;
    S.on = true; S.done = false; S.seen = {}; S.star = []; S.lowY = Infinity; S.frames = 0;
    s.phase = 'dead';
    /* The star is the man it happened to, which the renderer reads as
       state.carrier: the scorer for a score, and for a takeaway the defender
       who now has the ball — the engine hands him the carrier slot on the
       interception, so putting him in it here is not a fiction. */
    const c = side === 'defence' ? s.players[5] : (s.carrier || s.players[0]);
    s.carrier = c;
    S.starIdx = s.players.indexOf(c);
    // Exactly what a score, a set of chains or a pick calls.
    e._celebrate(kind, { x: c.x, y: c.y }, c.team);
  }, { kind: K.kind, side: K.side });
  await page.waitForFunction(() => window.__CELEB.done, null, { timeout: TIMEOUT * 1000 })
    .catch(() => {});
  const r = await page.evaluate(() => {
    const S = window.__CELEB;
    S.on = false;
    S.ranOut = !S.done;
    const per = {};
    for (const i of Object.keys(S.seen)) per[i] = [...new Set(S.seen[i])];
    return { per, star: S.star, lowY: S.lowY, frames: S.frames, starIdx: S.starIdx,
             ranOut: S.ranOut, err: S.err };
  });
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, 'celeb-' + K.kind + '.png') });
  }
  results.push({ ...K, ...r });
  // Hand the ball back to a live play so the next kind has a star of its own.
  await page.evaluate(() => { window.FLAGSTER.activeShell.engine.state.phase = 'live'; });
  await page.waitForTimeout(400);
}

await browser.close();
server.close();

let bad = 0;
console.log('\nFLAGSTER celebration probe — each kind watched to its end\n');
for (const r of results) {
  const distinct = new Set(Object.values(r.per).flat());
  const men = Object.keys(r.per).length;
  console.log('  ' + r.label);
  if (!r.frames) { console.log('    NOT SEEN — the renderer never started it'); bad++; continue; }
  console.log('    men celebrating    ' + men + '   over ' + r.frames + ' sampled frames' +
    (r.ranOut ? '   <-- STILL RUNNING AT TIMEOUT' : ''));
  console.log('    clips on screen    ' + [...distinct].join(', '));
  console.log('    per player         ' + Object.keys(r.per).map(i =>
    (+i === r.starIdx ? '*' : '') + i + ':' + r.per[i].join('/')).join('  '));
  console.log('    distinct clips     ' + distinct.size + (distinct.size < 2 && men > 2 ? '   <-- ONE ANIMATION, MANY MEN' : ''));
  console.log('    the star ran       ' + (r.star.join(' -> ') || '(nothing)') +
    (r.once && !r.star.includes(r.once) ? '   <-- MISSING ' + r.once.toUpperCase() : ''));
  console.log('    lowest body        ' + (isFinite(r.lowY) ? r.lowY.toFixed(3) : '?') + ' yd' +
    (r.lowY < -0.02 ? '   <-- THROUGH THE TURF' : ''));
  if (r.err) console.log('    probe error        ' + r.err);
  if (distinct.size < 2 && men > 2) bad++;
  if (r.once && !r.star.includes(r.once)) bad++;
  if (r.lowY < -0.02) bad++;
  console.log('');
}
console.log('  console errors     ' + errors.length);
for (const e of errors.slice(0, 5)) console.log('    ' + e);
console.log('');
process.exit(bad || errors.length ? 1 : 0);
