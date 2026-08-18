#!/usr/bin/env node
/* ============================================================================
   FLAGSTER — ANIMATION PROBE

   Drives the real game in headless Chromium and measures the animation system
   from the OUTSIDE, once per rendered frame. It exists because every previous
   animation claim in this repo was argued from a screenshot, and a still frame
   cannot show a foot sliding, a gait rung saturating, a clip that never fires,
   or ten men striding in unison.

     node tools/animcheck.mjs [--seconds 60] [--json]

   Needs Playwright and the swiftshader Chromium (both provided by
   .claude/hooks/session-start.sh; set FLAGSTER_CHROME to override the binary).

   WHAT IT MEASURES, and why each one is the honest test

   footSlip     The definitive foot-slide number. While a foot is planted — the
                lower of the two, close to the turf — its world position should
                not move. Anything else IS the skate, whatever the facing says.
                Reported as the median and 90th-percentile speed of a planted
                foot, in yd/s. A player's own travel speed is NOT subtracted:
                the foot is measured against the ground it is standing on.

   rateClamp    playermodel clamps the gait playback rate to [0.55, 1.9]. Inside
                that range the stride matches the ground; on the clamp the feet
                are lying. Percentage of moving frames spent saturated, which is
                the fraction of the game where sliding is guaranteed by design.

   clipUse      Which of the clips in the .glb ever actually play. A clip that
                never fires is dead weight and usually a bug — flag guarding
                shipped in v2.17.0 with no call sites and nobody noticed.

   phaseSpread  Ten players sharing one stride phase march in lockstep. This is
                the spread of stridePhase() across everyone on the field; near
                zero means unison.

   idleMotion   Total bone travel over the Idle clip. Players are idle for most
                of the game clock, so this is the pose the game is seen in most.

   gaze         Whether anyone's head is aimed anywhere other than straight
                ahead. On a real field every head tracks the ball.
   ============================================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SECONDS = parseFloat(arg('seconds', '60'));
const AS_JSON = process.argv.includes('--json');

const CHROME = process.env.FLAGSTER_CHROME
  || fs.globSync?.('/opt/pw-browsers/chromium*/chrome-linux/chrome')?.sort().pop()
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  ({ chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules/playwright/index.js')).href)
    .then(m => m.default || m));
} catch {
  console.error('animcheck.mjs needs Playwright:  npm install');
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
/* Wrap the model factory BEFORE any player is built. Wrapping the api objects
   after the fact missed every call, because by then they were already made and
   the renderer holds its own references. */
await page.evaluate(() => {
  const wrap = () => {
    const PM = window.FLAGSTER && window.FLAGSTER.Player3D;
    if (!PM || PM.__wrapped) return !!PM;
    const orig = PM.build.bind(PM);
    window.__CLIPUSE = {};
    PM.build = function (...a) {
      const api = orig(...a);
      for (const fn of ['play', 'oneShot']) {
        if (typeof api[fn] !== 'function') continue;
        const f = api[fn].bind(api);
        api[fn] = function (name, ...rest) {
          const k = String(name);
          window.__CLIPUSE[k] = (window.__CLIPUSE[k] || 0) + 1;
          return f(name, ...rest);
        };
      }
      return api;
    };
    PM.__wrapped = true;
    return true;
  };
  wrap();
});
await page.getByRole('button', { name: /Watch Demo/i }).click();
await page.waitForFunction(() => {
  const sh = window.FLAGSTER && window.FLAGSTER.activeShell;
  return !!(sh && sh.engine && sh.engine.externalRender && sh.field3d);
}, null, { timeout: 30000 });

/* The sampler runs inside the page, wrapping externalRender so it sees exactly
   one sample per RENDERED frame. Sampling on a timer instead would measure
   swiftshader's frame rate, which is not the thing under test. */
const install = await page.evaluate(() => {
  const sh = window.FLAGSTER.activeShell, e = sh.engine, f3 = sh.field3d;
  /* The renderer already publishes locomotion telemetry (debugPlayers) read
     back off itself, so gait/phase/skew come from there rather than being
     recomputed here — grading the renderer against a copy of the renderer is
     exactly the mistake that surface exists to prevent. What it does not carry
     is bone positions, so the skeleton is reached by walking up from the ball,
     which is always in the scene graph somewhere. */
  if (!f3.debugPlayers) return { ok: false, why: 'field3d.debugPlayers() missing' };
  let scene = f3.ball; while (scene && scene.parent) scene = scene.parent;
  if (!scene || !scene.isScene) return { ok: false, why: 'scene unreachable from ball' };

  const A = window.__ANIM = {
    frames: 0, live: 0, moving: 0, clamped: 0, clipUse: {}, rungUse: {},
    slip: [], slipRel: [], floor: {}, gazeErr: [], headVsBody: [], gazeWant: [], lean: {}, leanRuns: [], stam: [], fatigue: [], phases: [], skews: [], banks: [], gaze: 0, gazeN: 0, err: null
  };

  const rigs = [];
  scene.traverse(o => {
    if (!o.isBone || o.name !== 'Hips') return;
    const b = {}; o.traverse(x => { if (x.isBone) b[x.name] = x; });
    if (b.Foot_L && b.Foot_R) rigs.push(b);
  });
  A.rigCount = rigs.length;

  const Vec = Object.getPrototypeOf(f3.ball.position).constructor;
  const V = new Vec(), BALL = new Vec(), HP = new Vec(), FWD = new Vec();
  const HQ = new (Object.getPrototypeOf(f3.ball.quaternion).constructor)();
  const EU = new (Object.getPrototypeOf(f3.ball.rotation).constructor)();
  const prev = new Map();
  const inner = e.externalRender;
  e.externalRender = function (s) {
    inner.call(this, s);
    try {
      A.frames++;
      if (s.phase !== 'live') return;
      A.live++;
      const dt = e._dt || 1 / 60;

      const dbg = f3.debugPlayers();

      /* Foot-slip is NOT measured here. It was, and the number was a lie: in
         swiftshader this page renders about twice a second, so two consecutive
         samples are a tenth of a stride apart and no contact phase can be
         resolved — the detector reported a "planted" foot moving at 1.27x the
         body's own speed, which is a swing foot. tools/measure-clip.mjs does
         it properly, offline, at whatever timestep it likes. */
      // ---- gait, phase, skew, bank straight off the renderer --------------
      const ph = [];
      for (const d of dbg) {
        if (d.w > 0.5) {
          A.moving++;
          if (d.rate <= 0.551 || d.rate >= 1.899) A.clamped++;
          const k = (d.b && d.b !== d.a) ? d.a + '+' + d.b : d.a;
          A.rungUse[k] = (A.rungUse[k] || 0) + 1;
          A.skews.push(Math.abs(d.skew));
          if (d.stam != null) { A.stam.push(d.stam); A.fatigue.push(d.fatigue || 0); }
          const bk = Math.abs(d.bank || 0);
          A.banks.push(bk);
          /* HOW LONG a lean is held, not just how deep it gets. A median is
             blind to exactly the complaint that matters here: a footballer
             plants, leans and comes back up inside a step, while a skater
             holds an edge and carves. Same peak angle, completely different
             read. Accumulated in SIM time (engine dt), not wall time, because
             swiftshader renders about twice a second. */
          const LEANING = 6 * Math.PI / 180;
          if (bk > LEANING) { A.lean[d.i] = (A.lean[d.i] || 0) + dt; }
          else if (A.lean[d.i]) { A.leanRuns.push(A.lean[d.i]); A.lean[d.i] = 0; }
          ph.push(d.phase);
        }
      }
      if (ph.length > 3) {
        let sx = 0, sy = 0;
        for (const p of ph) { sx += Math.cos(p * 2 * Math.PI); sy += Math.sin(p * 2 * Math.PI); }
        A.phases.push(1 - Math.hypot(sx, sy) / ph.length);
      }

      /* ---- is the head turning toward the ball? --------------------------
         The APPLIED gaze angle, read back off the renderer through
         debugPlayers, against the turn the ball's position asks for.

         Three earlier attempts reconstructed it from the skeleton — a world
         forward vector twice, then the bones' own local yaw — and all three
         produced impossible numbers (94 degrees of neck turn against a
         70-degree cap). The rig's rest frame, the root's heading offset, the
         holder's bank quaternion and the clip's own baked head motion all
         compose, and picking one factor back out of that product is not
         something a probe should be doing. The renderer already publishes what
         it applied; that is the number. */
      const ball = s.ball;
      if (ball) {
        for (let i = 0; i < dbg.length; i++) {
          const gp = s.players && s.players[i];
          if (!gp || gp === s.carrier || gp.faceYaw == null || gp.flagPulled) continue;
          const dx = ball.x - gp.x, dy = ball.y - gp.y;
          if (Math.hypot(dx, dy) < 0.6) continue;
          let want = Math.atan2(dy, dx) - gp.faceYaw;
          while (want > Math.PI) want -= 2 * Math.PI;
          while (want < -Math.PI) want += 2 * Math.PI;
          const CAP = 1.22;
          want = want > CAP ? CAP : want < -CAP ? -CAP : want;
          const got = dbg[i].gaze || 0;
          A.gazeWant.push(Math.abs(want) * 57.2958);
          A.headVsBody.push(Math.abs(got) * 57.2958);
          A.gazeErr.push(Math.abs(want - got) * 57.2958);
          A.gazeN++;
        }
      }
    } catch (err) { A.err = String((err && err.message) || err); }
  };

  // Clip usage: wrap play/oneShot on every rendered player.
  const apis = [];
  scene.traverse(o => { if (o.userData && o.userData.p3d) apis.push(o.userData.p3d); });
  A.apiCount = apis.length;
  for (const api of apis) {
    for (const fn of ['play', 'oneShot']) {
      if (typeof api[fn] !== 'function') continue;
      const orig = api[fn].bind(api);
      api[fn] = function (name, ...rest) {
        A.clipUse[String(name)] = (A.clipUse[String(name)] || 0) + 1;
        return orig(name, ...rest);
      };
    }
  }
  return { ok: true, rigs: rigs.length, apis: apis.length };
});

if (!install.ok) { console.error('probe could not attach: ' + install.why); await browser.close(); server.close(); process.exit(1); }

await page.waitForTimeout(SECONDS * 1000);

const out = await page.evaluate(() => {
  const A = window.__ANIM;
  const q = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(3); };
  const avg = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null);
  return {
    frames: A.frames, liveFrames: A.live, players: A.rigCount, apis: A.apiCount,
    
    rateClampPct: A.moving ? +(100 * A.clamped / A.moving).toFixed(1) : null,
    rungUse: A.rungUse, clipUse: A.clipUse,
    phaseSpread: avg(A.phases),
    skewMedianDeg: q(A.skews.map(x => x * 57.2958), 0.5),
    skewP95Deg: q(A.skews.map(x => x * 57.2958), 0.95),
    bankMedianDeg: q(A.banks.map(x => x * 57.2958), 0.5),
    bankP90Deg: q(A.banks.map(x => x * 57.2958), 0.9),
    bankP99Deg: q(A.banks.map(x => x * 57.2958), 0.99),
    bankMaxDeg: A.banks.length ? +(Math.max(...A.banks) * 57.2958).toFixed(1) : null,
    bankOver8Pct: A.banks.length ? +(100 * A.banks.filter(b => b > 0.1396).length / A.banks.length).toFixed(1) : null,
    stamMedian: q(A.stam, 0.5), stamP10: q(A.stam, 0.1),
    fatigueMedian: q(A.fatigue, 0.5), fatigueP90: q(A.fatigue, 0.9),
    fatiguedPct: A.fatigue.length ? +(100 * A.fatigue.filter(f => f > 0.15).length / A.fatigue.length).toFixed(1) : null,
    leanHoldMedian: q(A.leanRuns, 0.5), leanHoldP90: q(A.leanRuns, 0.9), leanEpisodes: A.leanRuns.length,
    headYawPct: A.gazeN ? +(100 * A.gaze / A.gazeN).toFixed(1) : null,
    headVsBodyMedian: q(A.headVsBody, 0.5),
    gazeWantMedian: q(A.gazeWant, 0.5),
    gazeErrMedianDeg: q(A.gazeErr, 0.5),
    gazeOnBallPct: A.gazeErr.length ? +(100 * A.gazeErr.filter(e => e < 12).length / A.gazeErr.length).toFixed(1) : null,
    probeError: A.err
  };
});

/* Clip inventory read straight out of the .glb's JSON chunk — the page has no
   accessor for it, and parsing the asset is both simpler and harder to fool. */
function clipsFromGlb(file) {
  try {
    const buf = fs.readFileSync(file);
    const len = buf.readUInt32LE(12);                 // first chunk = JSON
    const json = JSON.parse(buf.slice(20, 20 + len).toString('utf8'));
    return (json.animations || []).map(a => a.name);
  } catch { return null; }
}
const clipsInFile = clipsFromGlb(path.join(ROOT, 'flagster/lib/flagplayer.glb'));

await browser.close();
server.close();

const report = { ...out, clipsInFile, consoleErrors: errors.length, errors: errors.slice(0, 5) };
if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const row = (k, v, note) => console.log('  ' + String(k).padEnd(26) + String(v).padStart(10) + (note ? '   ' + note : ''));
console.log(`\nFLAGSTER animation probe — ${SECONDS}s, ${report.liveFrames} live frames, ${report.players} players\n`);
row('Gait rate on the clamp', report.rateClampPct + '%', 'guaranteed sliding');
row('Stride phase spread', report.phaseSpread, '0 = lockstep, 1 = scattered');
row('Facing-vs-travel (med)', report.skewMedianDeg + ' deg', 'the skate metric');
row('Facing-vs-travel (p95)', report.skewP95Deg + ' deg', '');
row('Bank (med / p90 / max)', report.bankMedianDeg + ' / ' + report.bankP90Deg + ' / ' + report.bankMaxDeg, 'deg');
row('Frames banked over 8 deg', report.bankOver8Pct + '%', '');
row('Lean held (med / p90)', report.leanHoldMedian + ' / ' + report.leanHoldP90, 'sec above 6 deg — a cut is ~0.2-0.4s');
row('Turn the ball asks for', report.gazeWantMedian + ' deg', 'median, capped at 70');
row('Turn the neck delivers', report.headVsBodyMedian + ' deg', 'as applied by the renderer');
row('Gaze lag', report.gazeErrMedianDeg + ' deg', 'median; it eases, it does not snap');
row('Heads on the ball', report.gazeOnBallPct + '%', 'within 12 deg of the ask');
row('Stamina (med / p10)', report.stamMedian + ' / ' + report.stamP10, '1 = fresh');
row('Fatigue shown (med/p90)', report.fatigueMedian + ' / ' + report.fatigueP90, '0 = upright, 1 = blown');
row('Frames visibly tired', report.fatiguedPct + '%', 'above 0.15 of full expression');
row('Console errors', report.consoleErrors, '');
console.log('\n  gait rungs in use:', JSON.stringify(report.rungUse));
if (!report.clipWrapAttached || !Object.keys(report.clipUse).length) {
  // Saying "every clip is unused" when Idle plainly plays would be worse than
  // saying nothing. Report the instrument's failure, not a fake result.
  console.log('  clip usage:        unavailable (wrap attached: ' + report.clipWrapAttached + ')');
} else {
  console.log('  clips played:     ', JSON.stringify(report.clipUse));
  if (report.clipsInFile) {
    const unused = report.clipsInFile.filter(c => !Object.keys(report.clipUse).some(u => u.toLowerCase() === c.toLowerCase()));
    console.log('  clips NEVER used: ', unused.join(', ') || '(none)');
  }
}
if (report.probeError) console.log('\n  probe error: ' + report.probeError);
console.log('');
