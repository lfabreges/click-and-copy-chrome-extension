/**
 * Click & Copy – content script (world: MAIN, run_at: document_start)
 *
 * Strategy (3 layers):
 *  1. Override Event.prototype.preventDefault so that any call to it on a
 *     blocked event type becomes a no-op. This covers:
 *       – addEventListener callbacks that call e.preventDefault()
 *       – onX property handlers that return false (browser internally calls
 *         preventDefault() when the handler returns false)
 *
 *  2. Redefine the onX property setters on every relevant prototype so that
 *     assignments like `document.oncontextmenu = fn` are silently ignored.
 *     This is done before page scripts run, so nothing slips through.
 *
 *  3. CSS (content.css) handles user-select: none via !important override.
 */
(function () {
  'use strict';

  // Events we want to always allow (never let a page block them).
  const BLOCKED = new Set(['contextmenu', 'selectstart', 'copy', 'cut']);

  // ── Layer 1: neutralise preventDefault() for blocked events ──────────────
  const origPreventDefault = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () {
    if (!BLOCKED.has(this.type)) {
      origPreventDefault.call(this);
    }
  };

  // ── Layer 2: intercept onX property assignments ───────────────────────────
  // Redefine the setter on each prototype so future assignments are no-ops
  // and the getter always returns null (avoids breaking truthiness checks).
  const ON_PROPS = ['oncontextmenu', 'onselectstart', 'oncopy', 'oncut'];

  const PROTOTYPES = [
    typeof EventTarget  !== 'undefined' ? EventTarget.prototype  : null,
    typeof Element      !== 'undefined' ? Element.prototype      : null,
    typeof HTMLElement  !== 'undefined' ? HTMLElement.prototype  : null,
    typeof Document     !== 'undefined' ? Document.prototype     : null,
    typeof Window       !== 'undefined' ? Window.prototype       : null,
  ].filter(Boolean);

  ON_PROPS.forEach(prop => {
    PROTOTYPES.forEach(proto => {
      try {
        Object.defineProperty(proto, prop, {
          get: () => null,
          set: () => {},
          configurable: true,
        });
      } catch (_) {
        // Some built-in prototypes may refuse redefinition – skip silently.
      }
    });
  });
})();
