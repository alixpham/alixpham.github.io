#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — DOES THE SITE WORK FROM A SUBPATH?

     npm run subpath

   A GitHub *user* page is served from a domain root (`alixpham.github.io/`); a
   *project* page is served from a folder (`malixsys.github.io/flagster/`). Those
   are not the same thing, and the difference silently breaks any site that
   reaches for a path starting with "/" — the import map, a script src, a fetch
   for a .glb. Everything resolves one directory up and 404s, and because
   `boot3d.js` is built to fall back to the 2D canvas when Three.js fails to
   load, the page still comes up. It just quietly stops being a 3D game.

   So this serves the repo under a `/flagster` prefix, refuses anything outside
   it, and asserts four things: Three.js loaded, the menu rendered, no console
   or page errors, and — the one that actually catches it — **no failed
   requests**. A 404 on a .glb does not throw; it arrives as a failed request
   and nothing else.

   The site passes today because every path in it is relative: the import map
   uses `./flagster/lib/three/...`, the boot script is `flagster/js/boot3d.js`
   with no leading slash, and `playermodel.js` derives its own base by reading
   the `src` of its `<script>` tag rather than assuming one. None of that is
   accidental and all of it is easy to undo with one absolute path, which is
   why this is a check and not a comment.
   ============================================================================ */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = process.argv.includes('--prefix')
  ? process.argv[process.argv.indexOf('--prefix') + 1]
  : '/flagster';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.glb': 'model/gltf-binary', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const srv = http.createServer((rq, rs) => {
  let u = decodeURIComponent(rq.url.split('?')[0]);
  /* Refusing everything outside the prefix is the whole point: on a real
     project page there IS nothing outside it, so a request that escapes the
     folder must fail here too or the check proves nothing. */
  if (!u.startsWith(PREFIX)) { rs.writeHead(404); rs.end('outside the project page'); return; }
  u = u.slice(PREFIX.length) || '/';
  let p = path.join(ROOT, u);
  if (p.endsWith('/') || p.endsWith(path.sep)) p = path.join(p, 'index.html');
  fs.readFile(p, (e, d) => {
    if (e) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    rs.end(d);
  });
});
await new Promise(r => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}${PREFIX}/`;

const browser = await chromium.launch({
  executablePath: process.env.FLAGSTER_CHROME,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage']
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errs = [], failed = [];
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', e => errs.push(e.message));
page.on('requestfailed', r => failed.push(r.url()));

await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => !!(window.FLAGSTER && window.FLAGSTER.ui), null, { timeout: 30000 });
await page.waitForTimeout(2500);
const st = await page.evaluate(() => ({
  three: typeof THREE !== 'undefined',
  menu: !!document.querySelector('.menu-tiles')
}));

console.log(`\nSUBPATH — served at ${base}\n`);
const bar = (label, ok, detail) =>
  console.log('  ' + label.padEnd(24) + (ok ? 'ok' : 'FAIL').padStart(6) + '   ' + (detail || ''));
bar('Three.js loaded', st.three);
bar('menu rendered', st.menu);
bar('console/page errors', errs.length === 0, String(errs.length));
bar('failed requests', failed.length === 0, String(failed.length));
for (const f of failed.slice(0, 8)) console.log('      ' + f);
for (const e of errs.slice(0, 8)) console.log('      ' + e.slice(0, 140));

const ok = st.three && st.menu && !errs.length && !failed.length;
console.log(ok
  ? `\n  every path in the site is relative — it will serve from a project page.\n`
  : `\n  something in the site assumes a domain root; it would break at ${PREFIX}/.\n`);

await browser.close();
srv.close();
process.exit(ok ? 0 : 1);
