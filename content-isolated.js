'use strict';

/**
 * Click & Copy – isolated-world bridge
 *
 * Gets the resolved enabled/disabled state from the background service worker
 * and relays it to the MAIN world content script via a CustomEvent.
 *
 * Uses runtime messaging instead of direct storage access so that the
 * background can return the correct state for incognito tabs (in-memory
 * overrides that are never written to storage).
 */

function dispatch(enabled) {
  window.dispatchEvent(new CustomEvent('__clickAndCopy__', { detail: { enabled } }));
}

// Get initial state from background (correctly handles incognito overrides)
chrome.runtime.sendMessage({ type: 'get-state' }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response) dispatch(response.enabled);
});

// Receive state updates pushed by background (toggles, storage changes, etc.)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'click-and-copy-state') {
    dispatch(message.enabled);
  }
});
