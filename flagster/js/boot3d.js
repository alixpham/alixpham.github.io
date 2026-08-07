/* ============================================================================
   FLAGSTER — ESM BOOTSTRAP

   Modern Three.js ships as ES modules only, but the game is deliberately a
   zero-build static site of classic <script> files that read a global `THREE`.
   This module bridges the two: it imports Three.js + the addons we use, exposes
   them as `window.THREE` (plus `FLAGSTER.FXLIB` for postprocessing), and THEN
   loads the game's classic scripts in order.

   Imports are DYNAMIC and guarded: if Three.js or an addon fails to load (or
   the browser lacks import maps), we still boot the game — it simply falls back
   to its 2D canvas renderer instead of failing to start at all.

   Note: an ES module namespace object is sealed, so we spread it into a plain
   object before attaching addons — the class references are identical, so
   `instanceof` and every existing `THREE.*` lookup keep working unchanged.
   ============================================================================ */

const ROOT = new URL('../', import.meta.url).href;   // .../flagster/

const FILES = [
  'js/data.js', 'js/storage.js', 'js/engine.js',
  'js/player3d.js', 'js/stadium3d.js', 'js/fx3d.js',
  'js/hero3d.js', 'js/field3d.js',
  'js/ui.js', 'js/world.js', 'js/teambuilder.js', 'js/roadtoglory.js',
  'js/main.js'
];

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    const s = document.createElement('script');
    s.src = src;
    s.async = false;               // preserve execution order
    s.onload = resolve;
    s.onerror = function () { reject(new Error('Failed to load ' + src)); };
    document.head.appendChild(s);
  });
}

async function setupThree() {
  const THREE_NS = await import('three');
  // Mutable copy of the sealed module namespace so we can attach addons and the
  // existing global-style code can keep saying `new THREE.GLTFLoader()`.
  const THREE = Object.assign({}, THREE_NS);

  // Loaders are optional — a failure here must not stop the game.
  await Promise.all([
    import('three/addons/loaders/GLTFLoader.js')
      .then(function (m) { THREE.GLTFLoader = m.GLTFLoader; }).catch(function () {}),
    import('three/addons/utils/SkeletonUtils.js')
      .then(function (m) { THREE.SkeletonUtils = m; }).catch(function () {})
  ]);

  window.THREE = THREE;
  window.FLAGSTER = window.FLAGSTER || {};
  window.FLAGSTER.THREE_REVISION = THREE_NS.REVISION;

  // Post-processing is likewise optional (fx3d.js degrades to direct render).
  try {
    const [ec, rp, ub, op, sm] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
      import('three/addons/postprocessing/SMAAPass.js')
    ]);
    window.FLAGSTER.FXLIB = {
      EffectComposer: ec.EffectComposer, RenderPass: rp.RenderPass,
      UnrealBloomPass: ub.UnrealBloomPass, OutputPass: op.OutputPass,
      SMAAPass: sm.SMAAPass
    };
  } catch (e) { /* no postprocessing; fx3d.create() returns null */ }
}

(async function () {
  try {
    await setupThree();
  } catch (e) {
    // No WebGL stack available — the game still runs on its 2D renderer.
    if (window.console) console.warn('Flagster: Three.js unavailable, using 2D renderer.', e);
  }
  for (const f of FILES) {
    try { await loadScript(ROOT + f); }
    catch (e) { if (window.console) console.error(e); }
  }
})();
