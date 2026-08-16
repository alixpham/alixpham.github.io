#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — HEAD CLOSE-UP HARNESS

   Renders the real rig's head, through the real playermodel.js build path, at
   a distance nothing in the game ever shows it from. Every previous round of
   head work was judged from a 40-pixel-tall player jogging past the camera,
   which is exactly how a bare ellipsoid with blobs stuck to it survived: at
   that size everything reads as "a head".

       node tools/headshot.mjs                    # 6 seeds x 4 angles
       node tools/headshot.mjs --out /tmp/heads   # somewhere else
       node tools/headshot.mjs --seeds 12 --angles front,profile

   Writes head-<seed>-<angle>.png plus a contact sheet, and prints the seeds'
   resolved appearances so a bad one can be reproduced.

   Needs Playwright and the pre-installed Chromium; it is a dev tool, not part
   of the site, and nothing in flagster/ imports it.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const OUT = path.resolve(arg('out', path.join(ROOT, '.headshots')));
const SEEDS = parseInt(arg('seeds', '6'), 10);
const ANGLES = arg('angles', 'front,three-quarter,profile,back').split(',');

let chromium;
try {
  ({ chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules/playwright/index.js')).href)
    .then(m => m.default || m));
} catch (e) {
  console.error('headshot.mjs needs Playwright:  npm i -D playwright');
  process.exit(1);
}

/* ---- serve the repo ------------------------------------------------------ */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};
const PAGE = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#20242b}canvas{display:block}</style>
<script type="importmap">{"imports":{
  "three":"/flagster/lib/three/three.module.js",
  "three/addons/":"/flagster/lib/three/jsm/"}}</script>
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

const W = 420, H = 520;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H); renderer.setPixelRatio(2);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242b);
// Three-point light rig: a face is judged on how its forms catch light, and a
// single lamp flattens exactly the cheekbone and brow this work is about.
const key = new THREE.DirectionalLight(0xfff4e6, 3.1); key.position.set(1.4, 2.0, 2.4);
const fill = new THREE.DirectionalLight(0xcfe0ff, 1.1); fill.position.set(-2.2, 0.6, 1.2);
const rim  = new THREE.DirectionalLight(0xffffff, 2.0); rim.position.set(-0.8, 1.6, -2.4);
scene.add(key, fill, rim, new THREE.HemisphereLight(0xbfd4ff, 0x4a4238, 0.9));

const camera = new THREE.PerspectiveCamera(24, W / H, 0.05, 40);

// The appearance the game would actually give this seed — not a copy of the
// rules kept in the harness, which is how a harness ends up passing while the
// game regresses.
window.__look = function (seed, gender) { return PM.appearanceOf(seed, gender); };

let current = null;
window.shoot = async function (opts, angle) {
  if (!current || current.key !== JSON.stringify(opts)) {
    if (current) { scene.remove(current.P.root); current.P.dispose(); }
    const P = PM.build(THREE, opts);
    P.setPlateVisible(false);
    // Deliberately NOT posed. Idle leans the spine 0.2 rad forward, which
    // swings the head 12 cm toward the lens and silently changes the framing
    // between runs — a head shot wants the rest pose.
    scene.add(P.root);
    current = { P, key: JSON.stringify(opts) };
  }
  const P = current.P, s = P.scale;
  P.root.updateMatrixWorld(true);
  // Aim at the skull's centre, not the Head joint — the joint sits down at the
  // jaw hinge, 9 cm below the middle of the head.
  const c = new THREE.Vector3();
  P.nodes.Head.getWorldPosition(c);
  c.y += 0.092 * s;
  const dist = 0.95;
  const a = { front: 0, 'three-quarter': 0.9, profile: 1.5708, back: 3.1416 }[angle] ?? 0;
  camera.position.set(c.x + Math.sin(a) * dist, c.y + 0.03, c.z + Math.cos(a) * dist);
  camera.lookAt(c);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL('image/png');
};
window.__ready = true;
</script>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '/headshot.html') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return;
  }
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

/* ---- the appearances under test -----------------------------------------
   Mirrors flagster/js/field3d.js appearanceOf(), which is the code the game
   actually runs; kept here as a plain import of the same table would mean
   loading the whole renderer in Node. */
const NAMES = ['USA-0', 'BRA-4', 'JPN-2', 'GER-7', 'MEX-3', 'GBR-9', 'PAN-1', 'FRA-5',
  'AUS-8', 'ITA-6', 'DEN-10', 'CAN-11'];

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined, headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--no-sandbox', '--disable-dev-shm-usage']
});
const page = await (await browser.newContext({ viewport: { width: 480, height: 600 } })).newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__ready, null, { timeout: 60000 });
} catch (e) {
  console.error('the render page never came up:');
  errors.slice(0, 10).forEach(m => console.error('  ' + m));
  process.exit(1);
}
await page.waitForFunction(() => window.FLAGSTER.PlayerModel.isReady()
  || window.FLAGSTER.PlayerModel.isFailed(), null, { timeout: 60000 });
if (await page.evaluate(() => window.FLAGSTER.PlayerModel.isFailed())) {
  console.error('the .glb failed to load — run node tools/build-player-glb.mjs first');
  process.exit(1);
}

const rows = [];
for (let i = 0; i < SEEDS; i++) {
  const id = NAMES[i % NAMES.length];
  const look = await page.evaluate((seedId) => window.__look(seedId), id).catch(() => null);
  const opts = look || { skin: '#c68a5e', hair: '#1a1310', hairStyle: 'crop' };
  const shots = [];
  for (const angle of ANGLES) {
    const url = await page.evaluate(([o, a]) => window.shoot(o, a), [opts, angle]);
    const file = path.join(OUT, `head-${id}-${angle}.png`);
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    shots.push(file);
  }
  rows.push({ id, opts, shots });
  console.log(`${id.padEnd(8)} ${JSON.stringify(opts)}`);
}

/* Contact sheet, so six seeds can be compared as six people in one look. */
const sheet = path.join(OUT, 'contact-sheet.html');
fs.writeFileSync(sheet,
  '<style>body{background:#181b21;color:#ddd;font:13px system-ui;margin:16px}' +
  'img{width:210px;image-rendering:auto}div{margin-bottom:8px}</style>' +
  rows.map(r => `<div><b>${r.id}</b> ${r.opts.hairStyle}/${r.opts.facialHair || 'clean-shaven'}<br>` +
    r.shots.map(s => `<img src="${path.basename(s)}">`).join('') + '</div>').join(''));

console.log(`\n${rows.length} heads x ${ANGLES.length} angles -> ${OUT}`);
console.log(`contact sheet: ${sheet}`);
if (errors.length) { console.log('\nPAGE ERRORS:'); errors.slice(0, 10).forEach(e => console.log('  ' + e)); }
await browser.close();
server.close();
