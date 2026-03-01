'use strict';

const BADGE_ON  = { text: 'ON', color: '#22c55e' };
const BADGE_OFF = { text: '',   color: '#999999' };

function applyBadge({ text, color }) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// Toggle on icon click (fires only when no default_popup is set)
chrome.action.onClicked.addListener(async () => {
  const { enabled = false } = await chrome.storage.local.get('enabled');
  const next = !enabled;
  await chrome.storage.local.set({ enabled: next });
  applyBadge(next ? BADGE_ON : BADGE_OFF);
});

// Restore badge whenever the service worker starts / restarts
(async () => {
  const { enabled = false } = await chrome.storage.local.get('enabled');
  applyBadge(enabled ? BADGE_ON : BADGE_OFF);
})();
