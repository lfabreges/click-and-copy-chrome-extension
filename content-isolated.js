'use strict';

/**
 * Click & Copy – isolated-world bridge
 *
 * Reads the enabled state from storage and relays any changes to the
 * MAIN world content script via a CustomEvent on the shared window object.
 * Runs in every frame (all_frames: true) so iframes are also covered.
 */

function dispatch(enabled) {
  window.dispatchEvent(new CustomEvent('__clickAndCopy__', { detail: { enabled } }));
}

// Send initial state once storage is read (async, but MAIN world listener
// is already set up synchronously at document_start before this resolves).
chrome.storage.local.get('enabled').then(({ enabled = false }) => dispatch(enabled));

// Relay live toggles from the background service worker.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'enabled' in changes) {
    dispatch(changes.enabled.newValue ?? false);
  }
});
