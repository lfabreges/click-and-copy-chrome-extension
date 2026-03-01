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
 *
 * Sends its own URL so the background never needs the `tabs` permission.
 */

function dispatch(enabled) {
  window.dispatchEvent(new CustomEvent('__clickAndCopy__', { detail: { enabled } }));
}

function requestState() {
  chrome.runtime.sendMessage({ type: 'get-state', url: location.href }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response) dispatch(response.enabled);
  });
}

// Get initial state from background
requestState();

// Receive pushed state updates or refresh requests from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'click-and-copy-state') {
    dispatch(message.enabled);
  } else if (message.type === 'click-and-copy-refresh') {
    requestState();
  }
});
