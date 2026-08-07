/* ============================================================================
   FLAGSTER — POST-PROCESSING (Three.js EffectComposer)

   A restrained broadcast grade: subtle bloom on stadium highlights plus SMAA
   edge antialiasing, ending in an OutputPass so tone mapping and colour space
   are applied once, correctly, at the end of the chain.

   Everything is optional. If the postprocessing addons are unavailable (or a
   pass throws), create() returns null and the caller renders directly — the
   game never depends on this module.
   ============================================================================ */
(function (global) {
  'use strict';

  function create(THREE, renderer, scene, camera, opts) {
    var LIB = global.FLAGSTER && global.FLAGSTER.FXLIB;
    if (!LIB || !LIB.EffectComposer || !LIB.RenderPass) return null;
    opts = opts || {};

    try {
      var composer = new LIB.EffectComposer(renderer);
      composer.addPass(new LIB.RenderPass(scene, camera));

      // Subtle bloom — enough to make floodlights and white paint glow, far
      // short of the hazy over-bloom that screams "amateur demo".
      var bloom = null;
      if (LIB.UnrealBloomPass && THREE.Vector2) {
        var size = renderer.getSize(new THREE.Vector2());
        bloom = new LIB.UnrealBloomPass(
          new THREE.Vector2(size.x || 1280, size.y || 720),
          opts.bloomStrength != null ? opts.bloomStrength : 0.22,  // strength
          opts.bloomRadius != null ? opts.bloomRadius : 0.6,       // radius
          opts.bloomThreshold != null ? opts.bloomThreshold : 0.86 // threshold
        );
        composer.addPass(bloom);
      }

      // SMAA: cheap edge AA that still works when rendering through a composer
      // (the renderer's own MSAA does not apply to offscreen targets).
      if (LIB.SMAAPass) {
        try { composer.addPass(new LIB.SMAAPass()); } catch (e) { /* optional */ }
      }

      // Tone mapping + sRGB conversion happen here, once, at the end.
      if (LIB.OutputPass) composer.addPass(new LIB.OutputPass());

      return {
        composer: composer,
        bloom: bloom,
        render: function () { composer.render(); },
        setSize: function (w, h) {
          composer.setSize(w, h);
          if (bloom && bloom.setSize) bloom.setSize(w, h);
        },
        dispose: function () {
          try {
            if (composer.renderTarget1) composer.renderTarget1.dispose();
            if (composer.renderTarget2) composer.renderTarget2.dispose();
            (composer.passes || []).forEach(function (p) { if (p.dispose) p.dispose(); });
          } catch (e) { /* best effort */ }
        }
      };
    } catch (e) {
      return null;   // caller falls back to direct rendering
    }
  }

  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.FX = { create: create };
})(window);
