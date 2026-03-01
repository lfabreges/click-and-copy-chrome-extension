/**
 * Click & Copy – MAIN world content script
 * Injected at document_start in every frame. All three layers are wired up
 * immediately but stay dormant (enabled = false) until the user clicks the
 * extension icon, at which point the isolated-world bridge dispatches a
 * '__clickAndCopy__' CustomEvent that calls setEnabled(true/false).
 */
(function () {
  'use strict';

  const BLOCKED = new Set(['contextmenu', 'selectstart', 'copy', 'cut']);
  const CSS_ID  = '__click-and-copy__';
  const CSS_TEXT = '*, *::before, *::after { -webkit-user-select: text !important; user-select: text !important; }';

  let enabled = false;

  // ── Layer 1: neutralise preventDefault() for blocked events ──────────────
  // Handles explicit e.preventDefault() calls and onX handlers returning false
  // (the browser internally calls preventDefault() for the return-false case).
  const origPreventDefault = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () {
    if (BLOCKED.has(this.type)) {
      if (enabled) return;
    }
    origPreventDefault.call(this);
  };

  // ── Layer 2: capture-phase listeners (belt & suspenders) ─────────────────
  // Added at document_start so ours are always first in the capture chain.
  // When enabled, stopImmediatePropagation() prevents every page handler from
  // running – no handler can call preventDefault(), so the browser's default
  // action (context menu, text selection, clipboard copy…) is preserved.
  BLOCKED.forEach(type => {
    window.addEventListener(type, e => {
      if (enabled) e.stopImmediatePropagation();
    }, true);
  });

  // ── Layer 3: dynamic CSS for user-select ─────────────────────────────────
  function applyCSS() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeCSS() {
    document.getElementById(CSS_ID)?.remove();
  }

  // ── State switch ──────────────────────────────────────────────────────────
  function setEnabled(value) {
    enabled = value;
    if (enabled) applyCSS();
    else removeCSS();
  }

  // ── Listen for state changes relayed by the isolated-world bridge ─────────
  window.addEventListener('__clickAndCopy__', e => {
    setEnabled(Boolean(e.detail?.enabled));
  });
})();
