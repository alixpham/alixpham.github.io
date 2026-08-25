#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — SCREEN SMOKE TEST

   CLAUDE.md has asked every session to confirm "0 console/page errors across
   World, Team Builder, Road to Glory and the menu, in both landscape and
   portrait" before claiming a change is done, and there was no tool for it, so
   it was re-improvised in a scratch file each time and died with the container.

     node tools/smoke.mjs [--out DIR] [--seconds 6]

   Loads every screen at both orientations, plus a live Watch Demo game, and
   reports console errors, page errors, and screenshots.

   It also answers the question a clean console CANNOT: engine.js swallows
   externalRender throws and hands over to the 2D canvas after five of them, so
   a broken 3D scene looks like a working game in a different art style. This
   wraps externalRender to catch what it threw and checks FLAGSTER.activeShell
   .field3d is still non-null at the end of the sample — a `field3d=false` on
   the `game` row means the 3D renderer fell over however clean the log looks.

   Needs Playwright and the swiftshader Chromium, both provided by
   .claude/hooks/session-start.sh; set FLAGSTER_CHROME to override the binary.
   A dev tool — nothing in flagster/ imports it and the site ships no deps.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = arg('out', path.join(ROOT, '.smoke'));
const SETTLE = parseFloat(arg('seconds', '6')) * 1000;

const CHROME = process.env.FLAGSTER_CHROME
  || fs.globSync?.('/opt/pw-browsers/chromium*/chrome-linux/chrome')?.sort().pop()
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};
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

const VIEWS = { landscape: { width: 1280, height: 720 }, portrait: { width: 430, height: 932 } };
const SCREENS = [
  ['menu',    async () => {}],
  ['world',   p => p.evaluate(() => window.FLAGSTER.world.start(function () {}))],
  ['builder', p => p.evaluate(() => window.FLAGSTER.teambuilder.start(function () {}))],
  ['glory',   p => p.evaluate(() => window.FLAGSTER.roadtoglory.start(function () {}))],
  ['game',    async (p) => {
    await p.getByRole('button', { name: /Watch Demo/i }).click();
    await p.waitForFunction(() => {
      const sh = window.FLAGSTER && window.FLAGSTER.activeShell;
      return !!(sh && sh.engine && sh.engine.externalRender && sh.field3d);
    }, null, { timeout: 30000 });
    await p.evaluate(() => {
      const e = window.FLAGSTER.activeShell.engine, inner = e.externalRender;
      window.__throws = [];
      e.externalRender = function (s) {
        try { return inner.call(this, s); }
        catch (err) { window.__throws.push(String((err && err.message) || err)); throw err; }
      };
    });
  }]
];

let bad = 0, rows = 0;
for (const [orient, viewport] of Object.entries(VIEWS)) {
  for (const [name, go] of SCREENS) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('.menu-tiles', { timeout: 30000 });
    try { await go(page); } catch (e) { errs.push('nav: ' + e.message); }
    await page.waitForTimeout(SETTLE);
    const live = await page.evaluate(() => {
      const sh = (window.FLAGSTER || {}).activeShell;
      return {
        three: !!window.THREE,
        field3d: sh ? !!sh.field3d : null,      // null = no game running on this screen
        throws: (window.__throws || []).slice(0, 3)
      };
    });
    await page.screenshot({ path: path.join(OUT, `${orient}-${name}.png`) });
    bad += errs.length + live.throws.length;
    rows++;
    console.log(`  ${orient.padEnd(10)} ${name.padEnd(8)} errors=${String(errs.length).padStart(2)}` +
                `  THREE=${live.three}  field3d=${live.field3d}  renderThrows=${live.throws.length}`);
    errs.slice(0, 3).forEach(e => console.log('      ' + e.slice(0, 160)));
    live.throws.forEach(t => console.log('      throw: ' + t.slice(0, 160)));
    await ctx.close();
  }
}
await browser.close();
server.close();
console.log(bad
  ? `\n${bad} ERRORS across ${rows} screen-orientation pairs — shots in ${OUT}\n`
  : `\n0 console/page errors across ${rows} screen-orientation pairs — shots in ${OUT}\n`);
process.exit(bad ? 1 : 0);
