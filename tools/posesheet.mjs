#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — CLIP CONTACT SHEET

   Renders a baked clip full-body, at several phases and from several angles,
   through the real playermodel.js build path.

       node tools/posesheet.mjs Bow Lasso Salute      # one sheet each
       node tools/posesheet.mjs --frames 8 --angles front,three-quarter Griddy
       node tools/posesheet.mjs --out /tmp/poses Point

   tools/measure-clip.mjs is the honest test of whether a clip is CORRECT —
   feet on the turf, shoulders where a biomechanist would put them, arms in
   step with the legs. It cannot tell you whether the pose is any good, and a
   celebration is judged on exactly that. The game shows a player forty pixels
   tall from behind; this shows the same rig, from the same build path, at a
   size where a bad shoulder is visible.

   Stills only, deliberately: timing errors are invisible in a still and belong
   to measure-clip's gait coupling check. What this catches is the other half —
   an arm through the chest, a hand nowhere near where it was meant to be, a
   silhouette that reads as a shrug rather than a flex.

   A dev tool. Nothing in flagster/ imports it.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const CLIPS = process.argv.slice(2).filter((a, i, all) =>
  !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--')));
const OUT = path.resolve(arg('out', path.join(ROOT, '.posesheets')));
const FRAMES = parseInt(arg('frames', '6'), 10);
const ANGLES = arg('angles', 'three-quarter,front').split(',');
const CHROME = process.env.FLAGSTER_CHROME
  || fs.globSync?.('/opt/pw-browsers/chromium*/chrome-linux/chrome')?.sort().pop()
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

if (!CLIPS.length) { console.error('usage: node tools/posesheet.mjs <Clip> [Clip...]'); process.exit(1); }

let chromium;
try {
  ({ chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules/playwright/index.js')).href)
    .then(m => m.default || m));
} catch { console.error('posesheet.mjs needs Playwright:  npm install'); process.exit(1); }

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.json': 'application/json' };
const PAGE = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#20242b}</style>
<script type="importmap">{"imports":{"three":"/flagster/lib/three/three.module.js","three/addons/":"/flagster/lib/three/jsm/"}}</script>
<script type="module">
import * as NS from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
const THREE = Object.assign({}, NS);
THREE.GLTFLoader = GLTFLoader; THREE.SkeletonUtils = SkeletonUtils;
window.THREE = THREE;
await new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = '/flagster/js/playermodel.js'; s.onload = res; s.onerror = rej;
  document.head.appendChild(s);
});
const PM = window.FLAGSTER.PlayerModel;
PM.preload(THREE);
await new Promise(r => PM.whenReady(r));

const W = 300, H = 420;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.setPixelRatio(2);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242b);
const key = new THREE.DirectionalLight(0xfff4e6, 3.1); key.position.set(1.4, 2.4, 2.4);
const fill = new THREE.DirectionalLight(0xcfe0ff, 1.2); fill.position.set(-2.2, 1.0, 1.2);
const rim  = new THREE.DirectionalLight(0xffffff, 2.2); rim.position.set(-0.8, 1.8, -2.4);
scene.add(key, fill, rim, new THREE.HemisphereLight(0xbfd4ff, 0x4a4238, 0.9));

/* THE TURF IS PART OF THE TEST. Half of what goes wrong with a pose is a foot
   an inch under the ground or an inch over it, and against an empty background
   neither is visible. A grid at y=0 makes both obvious. */
const grid = new THREE.GridHelper(8, 16, 0x55606e, 0x39414c);
scene.add(grid);

const P = PM.build(THREE, { seed: 'USA-0', jersey: 0x2f6fd0, trim: 0xffffff });
P.setPlateVisible(false);
scene.add(P.root);
const S = P.scale || 1;

window.__clips = PM.clipNames.slice();
window.pose = function (clip, u, angle) {
  const a = P.actions[clip];
  if (!a) return null;
  P.mixer.stopAllAction();
  a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.play(); a.paused = true;
  a.time = u * a.getClip().duration;
  P.mixer.update(0);
  P.root.updateMatrixWorld(true);
  /* FRAME THE WHOLE BODY INCLUDING THE FEET. The first version of this aimed
     at chest height from four metres and cropped the shoes off the bottom —
     which threw away half of what a pose sheet is for, since a foot through the
     turf is the most common way one of these goes wrong. */
  const c = new THREE.Vector3(0, 1.02 * S, 0);
  const dist = 4.6 * S;
  const rad = { front: 0, 'three-quarter': 0.85, profile: 1.5708, back: 3.1416 }[angle] ?? 0;
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 40);
  camera.position.set(c.x + Math.sin(rad) * dist, 1.25 * S, c.z + Math.cos(rad) * dist);
  camera.lookAt(c);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
window.__ready = true;
</script>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined, headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--no-sandbox', '--disable-dev-shm-usage']
});
const page = await (await browser.newContext({ viewport: { width: 700, height: 900 } })).newPage();
const errors = [];
// The browser asks for a favicon this bare page does not serve, and a 404 for
// one is not a finding — reporting it trains you to ignore the error list.
const noise = t => /favicon/i.test(t) || /Failed to load resource/i.test(t);
page.on('pageerror', e => { if (!noise(e.message)) errors.push(e.message); });
page.on('console', m => { if (m.type() === 'error' && !noise(m.text())) errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
try { await page.waitForFunction(() => window.__ready, null, { timeout: 90000 }); }
catch { console.error('the render page never came up:'); errors.slice(0, 8).forEach(m => console.error('  ' + m)); process.exit(1); }

const known = await page.evaluate(() => window.__clips);
for (const clip of CLIPS) {
  if (!known.includes(clip)) { console.error('no such clip: ' + clip + '  (have: ' + known.join(', ') + ')'); continue; }
  const cells = [];
  for (const angle of ANGLES) {
    for (let i = 0; i < FRAMES; i++) {
      const u = i / FRAMES;
      const url = await page.evaluate(([c, uu, a]) => window.pose(c, uu, a), [clip, u, angle]);
      if (url) cells.push({ u, angle, buf: Buffer.from(url.split(',')[1], 'base64') });
    }
  }
  // Contact sheet: one row per angle, one column per phase, drawn in the page.
  const sheet = await page.evaluate(async ({ imgs, cols }) => {
    const loaded = await Promise.all(imgs.map(src => new Promise(r => {
      const im = new Image(); im.onload = () => r(im); im.src = src;
    })));
    const w = loaded[0].width, h = loaded[0].height;
    const rows = Math.ceil(loaded.length / cols);
    const cv = document.createElement('canvas');
    cv.width = w * cols; cv.height = h * rows;
    const g = cv.getContext('2d');
    loaded.forEach((im, i) => g.drawImage(im, (i % cols) * w, Math.floor(i / cols) * h));
    return cv.toDataURL('image/png');
  }, { imgs: cells.map(c => 'data:image/png;base64,' + c.buf.toString('base64')), cols: FRAMES });
  const file = path.join(OUT, 'clip-' + clip + '.png');
  fs.writeFileSync(file, Buffer.from(sheet.split(',')[1], 'base64'));
  console.log('  ' + file + '   ' + FRAMES + ' phases x ' + ANGLES.join(', '));
}

await browser.close();
server.close();
if (errors.length) { console.log('\n  page errors:'); errors.slice(0, 8).forEach(m => console.log('    ' + m)); }
