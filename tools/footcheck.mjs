#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — DO THE PLAYERS STAND ON THE GRASS?

     node tools/footcheck.mjs [--secs 170] [--character ochi]

   "Make sure gravity works" is a question about where the feet are, and the
   only honest answer comes off the RENDERER: the engine has no vertical
   physics for a player at all, so every centimetre of rise and fall is the
   animation plus one constant, PLAYER_LIFT, that raises the holder because the
   rig dips below its own origin.

   This wraps field3d's render and, on EVERY frame it draws, skins each
   player's meshes through three.js's own `applyBoneTransform` and records the
   lowest vertex. What comes back is the lowest each player ever got.

   SAMPLE FROM INSIDE THE FRAME, NOT BY POLLING. A first attempt polled from
   Node every 180ms and reported players hovering 4cm off the turf; they were
   not, it had simply never caught them in stance. Swiftshader draws about
   twice a second, so an outside sampler sees a handful of frames and the
   airborne half of a stride is half of them. Accumulating in the page costs
   nothing and cannot miss a frame.

   AND NOT THE MINIMUM EITHER. The lowest a player EVER gets includes the
   frame he dived, and a dive is meant to put him thirty centimetres down; one
   such frame in four hundred drags the number to -4cm and makes a sound lift
   look broken. What is wanted is where he stands and runs, so each player is
   scored by the TENTH PERCENTILE of his own per-frame low — stance, not the
   one frame he left his feet, and not the one frame he threw himself at the
   grass.

   WHAT GOOD LOOKS LIKE: every player reaching zero, give or take a centimetre.
   Well below zero is feet sunk into the turf; well above is a squad hovering,
   which is what a broken lift looks like.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECS = Number(arg('secs', 170));
const CHAR = arg('character', '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png', '.css': 'text/css' };

const server = http.createServer((q, r) => {
  let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (f.endsWith('/')) f += 'index.html';
  fs.readFile(f, (e, b) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(b);
  });
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
const chrome = process.env.FLAGSTER_CHROME || fs.globSync('/opt/pw-browsers/chromium*/chrome-linux/chrome').sort().pop();
const browser = await chromium.launch({ executablePath: chrome, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 700, height: 450 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(base + (CHAR ? '?character=' + CHAR : ''), { waitUntil: 'load' });
await page.waitForSelector('.menu-tiles', { timeout: 60000 });
await page.getByRole('button', { name: /Watch Demo/i }).click();
await page.waitForTimeout(5000);

await page.evaluate(() => {
  const F = window.FLAGSTER, sh = F.activeShell, f3 = sh && sh.field3d, THREE = window.THREE;
  if (!f3) { window.__err = 'no field3d'; return; }
  window.__lows = {}; window.__frames = 0;
  const orig = f3.render.bind(f3);
  f3.render = function (dt) {
    const r = orig(dt);
    try {
      let root = f3.ball; while (root.parent) root = root.parent;
      const per = new Map();
      root.traverse(o => {
        if (!o.isSkinnedMesh) return;
        let h = o; while (h.parent && h.parent !== root) h = h.parent;   // the player's holder
        const pos = o.geometry.attributes.position, v = new THREE.Vector3();
        let lo = 1e9;
        for (let i = 0; i < pos.count; i += 9) {
          v.fromBufferAttribute(pos, i); o.applyBoneTransform(i, v); o.localToWorld(v);
          if (v.y < lo) lo = v.y;
        }
        per.set(h, Math.min(per.has(h) ? per.get(h) : 1e9, lo));
      });
      let k = 0;
      for (const [, lo] of per) {
        const key = 'p' + (k++);
        (window.__lows[key] || (window.__lows[key] = [])).push(lo);
      }
      window.__frames++;
    } catch (e) { window.__err = String(e); }
    return r;
  };
});
await page.waitForTimeout(SECS * 1000);
const out = await page.evaluate(() => ({
  frames: window.__frames, err: window.__err || null,
  character: (window.FLAGSTER.PlayerModel.character && window.FLAGSTER.PlayerModel.character()) || '?',
  mins: Object.values(window.__lows).map(a => {
    const s = a.slice().sort((x, y) => x - y);
    return +(s[Math.floor(s.length * 0.10)] * 100).toFixed(2);
  })
}));
await browser.close(); server.close();

if (out.err) { console.error('\n  ' + out.err + '\n'); process.exit(1); }
const m = out.mins.slice().sort((a, b) => a - b);
const mean = m.reduce((a, b) => a + b, 0) / (m.length || 1);
console.log(`\nFLAGSTER foot contact — ${out.character}, ${out.frames} rendered frames, ${m.length} players\n`);
console.log('  where each player plants — 10th percentile of his per-frame low (cm, 0 = the turf):');
console.log('    ' + m.map(v => v.toFixed(2).padStart(6)).join(''));
console.log(`\n  deepest ${m[0].toFixed(2)}cm   highest ${m[m.length - 1].toFixed(2)}cm   mean ${mean.toFixed(2)}cm   spread ${(m[m.length - 1] - m[0]).toFixed(2)}cm`);
const bad = m[m.length - 1] > 3 ? 'HOVERING — nobody is reaching the turf' : m[0] < -4 ? 'SUNK — feet well through the turf' : null;
console.log('  ' + (bad || 'contact is sound: every player reaches the turf within a centimetre or two') + '\n');
if (errs.length) console.log('  page errors: ' + errs.length);
process.exit(bad ? 1 : 0);
