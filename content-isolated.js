'use strict';

/**
 * Click & Copy – isolated-world bridge
 *
 * Reads the 3-level state (global > site > page) from storage and relays
 * the resolved enabled/disabled state to the MAIN world content script.
 */

function resolveState(global, sites, pages, hostname, url) {
  const cleanUrl = url.split(/[?#]/)[0];
  if (cleanUrl in pages) return pages[cleanUrl];
  if (hostname in sites) return sites[hostname];
  return global;
}

function dispatch(enabled) {
  window.dispatchEvent(new CustomEvent('__clickAndCopy__', { detail: { enabled } }));
}

const hostname = location.hostname;
const url = location.href;

function resolve(data) {
  const { global = false, sites = {}, pages = {} } = data;
  return resolveState(global, sites, pages, hostname, url);
}

// Send initial state
chrome.storage.local.get(['global', 'sites', 'pages']).then(data => dispatch(resolve(data)));

// Relay live toggles
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('global' in changes || 'sites' in changes || 'pages' in changes) {
    chrome.storage.local.get(['global', 'sites', 'pages']).then(data => dispatch(resolve(data)));
  }
});
