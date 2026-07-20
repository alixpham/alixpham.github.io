/* ============================================================================
   FLAGSTER — SAVE / LOAD (localStorage)
   ============================================================================ */
(function (global) {
  'use strict';
  var PREFIX = 'flagster.';

  function get(key, fallback) {
    try {
      var raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : (fallback === undefined ? null : fallback);
    } catch (e) { return fallback === undefined ? null : fallback; }
  }
  function set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }
  function remove(key) { try { localStorage.removeItem(PREFIX + key); } catch (e) {} }

  global.FLAGSTER = global.FLAGSTER || {};
  global.FLAGSTER.storage = { get: get, set: set, remove: remove };
})(window);
