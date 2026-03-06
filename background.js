'use strict';

/*
 * Storage schema:
 *   global:   boolean            – default state for all sites (false = off)
 *   sites:    { hostname: bool } – per-hostname overrides
 *   pages:    { cleanUrl: bool } – per-page overrides (URL without query/hash)
 *
 * Priority: page > site > global
 * Each level is independent – toggling a higher level never clears lower overrides.
 * "Reset site" is the explicit action to clear all overrides for a hostname.
 *
 * Incognito: rules apply in-session but are NEVER written to local storage.
 *   incognitoData holds overrides for all incognito tabs, backed by
 *   chrome.storage.session so they survive SW restarts within the same browser
 *   session. They are cleared when the browser closes or the extension reloads.
 *
 * Permission model: uses activeTab instead of tabs.  State is resolved
 *   on-demand when the content script sends its URL via get-state.
 *   Other tabs update lazily when activated.
 */

// ── In-memory state (session-backed) ─────────────────────────────────────────

const incognitoData = { global: null, sites: {}, pages: {} };
// global: null means "inherit from storage"

// Restore incognito overrides from session storage when the service worker
// restarts (MV3 terminates it after ~30s of inactivity). chrome.storage.session
// survives SW restarts but is cleared when the browser closes.
const incognitoReady = chrome.storage.session.get('incognito').then(({ incognito }) => {
  if (!incognito) return;
  if (incognito.global !== undefined) incognitoData.global = incognito.global;
  if (incognito.sites !== undefined) incognitoData.sites = incognito.sites;
  if (incognito.pages !== undefined) incognitoData.pages = incognito.pages;
});

function saveIncognito() {
  chrome.storage.session.set({
    incognito: {
      global: incognitoData.global,
      sites:  { ...incognitoData.sites },
      pages:  { ...incognitoData.pages },
    },
  });
}

// Tab cache: tabId → { url, incognito } – populated by get-state and user interactions.
// Used to update badges on all known tabs without the tabs permission,
// and to let refreshMenus resolve state for the active tab.
const tabCache = new Map();

// Merges storage data with incognito in-memory overrides
function getEffectiveData(storageData) {
  return {
    global: incognitoData.global !== null ? incognitoData.global : storageData.global,
    sites:  { ...storageData.sites, ...incognitoData.sites },
    pages:  { ...storageData.pages, ...incognitoData.pages },
  };
}

// Returns the correct data object for a given tab (effective for incognito, raw for normal)
function getTabData(storageData, incognito) {
  return incognito ? getEffectiveData(storageData) : storageData;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripUrl(url) {
  return url.split(/[?#]/)[0];
}

function resolveState(global, sites, pages, hostname, url) {
  const clean = stripUrl(url);
  if (clean in pages) return pages[clean];
  if (hostname in sites) return sites[hostname];
  return global;
}

function siteState(data, hostname) {
  return hostname in data.sites ? data.sites[hostname] : data.global;
}

function deletePagesForHost(pages, hostname) {
  for (const key of Object.keys(pages)) {
    try { if (new URL(key).hostname === hostname) delete pages[key]; } catch {}
  }
}

function hasPagesForHost(pages, hostname) {
  return Object.keys(pages).some(k => {
    try { return new URL(k).hostname === hostname; } catch { return false; }
  });
}

// ── Toggle logic (normal storage) ────────────────────────────────────────────

function smartToggle(data, hostname, clean) {
  const hasPage = clean in data.pages;

  if (hasPage) {
    const newPageVal = !data.pages[clean];
    const parentVal = siteState(data, hostname);
    if (newPageVal === parentVal) {
      delete data.pages[clean];
    } else {
      data.pages[clean] = newPageVal;
    }
    return { sites: data.sites, pages: data.pages };
  }

  const currentSite = siteState(data, hostname);
  const newSiteVal = !currentSite;
  if (newSiteVal === data.global) {
    delete data.sites[hostname];
  } else {
    data.sites[hostname] = newSiteVal;
  }
  return { sites: data.sites, pages: data.pages };
}

function toggleSite(data, hostname) {
  const newVal = !siteState(data, hostname);
  if (newVal === data.global) {
    delete data.sites[hostname];
  } else {
    data.sites[hostname] = newVal;
  }
}

function togglePage(data, hostname, clean) {
  const currentResolved = resolveState(data.global, data.sites, data.pages, hostname, clean);
  const newVal = !currentResolved;
  const parentVal = siteState(data, hostname);
  if (newVal === parentVal) {
    delete data.pages[clean];
  } else {
    data.pages[clean] = newVal;
  }
}

// ── Toggle logic (incognito – modifies incognitoData, never storage) ──────────

// In incognito, we always write the new value — never delete during a toggle.
// The "redundancy cleanup" used for normal storage cannot apply here because a
// storage rule may exist underneath: deleting the incognito override would let
// the storage rule shine through again, making the toggle a no-op.
// Cleanup only happens on explicit "reset-site" in incognito.

function smartToggleIncognito(storageData, hostname, clean) {
  const eff = getEffectiveData(storageData);
  if (clean in eff.pages) {
    incognitoData.pages[clean] = !eff.pages[clean];
  } else {
    incognitoData.sites[hostname] = !siteState(eff, hostname);
  }
}

function toggleSiteIncognito(storageData, hostname) {
  const eff = getEffectiveData(storageData);
  incognitoData.sites[hostname] = !siteState(eff, hostname);
}

function togglePageIncognito(storageData, hostname, clean) {
  const eff = getEffectiveData(storageData);
  const currentResolved = resolveState(eff.global, eff.sites, eff.pages, hostname, clean);
  incognitoData.pages[clean] = !currentResolved;
}

// ── Misc ─────────────────────────────────────────────────────────────────────

function parseTab(tab) {
  if (!tab?.url || !tab.url.startsWith('http')) return null;
  const u = new URL(tab.url);
  return { hostname: u.hostname, url: tab.url, clean: stripUrl(tab.url), tabId: tab.id };
}

async function getData() {
  const { global = false, sites = {}, pages = {} } =
    await chrome.storage.local.get(['global', 'sites', 'pages']);
  return { global, sites, pages };
}

// ── Notify active tab ────────────────────────────────────────────────────────

// Update badges for all known tabs from cache (prevents flicker on tab switch)
function updateAllBadges(storageData, effData) {
  if (!effData) effData = getEffectiveData(storageData);
  for (const [tabId, { url, incognito }] of tabCache) {
    applyBadge(tabId, url, incognito ? effData : storageData);
  }
}

function sendState(tabId, url, data) {
  if (!url?.startsWith('http')) return;
  const { hostname } = new URL(url);
  const enabled = resolveState(data.global, data.sites, data.pages, hostname, url);
  chrome.tabs.sendMessage(tabId, { type: 'click-and-copy-state', enabled }).catch(() => {});
}

function sendRefresh(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'click-and-copy-refresh' }).catch(() => {});
}

// Post-toggle epilogue for incognito: compute effective data once, update all badges,
// notify the active tab, and refresh menus.
async function applyIncognitoChange(storageData, tab, tabId, url) {
  const effData = getEffectiveData(storageData);
  updateAllBadges(storageData, effData);
  if (url) sendState(tabId, url, effData);
  saveIncognito();
  await refreshMenus(storageData, tab);
}

// ── Badge (per-tab) ──────────────────────────────────────────────────────────

function applyBadge(tabId, url, data) {
  if (!url || !url.startsWith('http')) {
    chrome.action.setBadgeText({ text: '', tabId });
    return;
  }
  const { hostname } = new URL(url);
  const on = resolveState(data.global, data.sites, data.pages, hostname, url);

  if (on) {
    chrome.action.setBadgeText({ text: '✓', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

// ── Context menus ────────────────────────────────────────────────────────────

const msg = chrome.i18n.getMessage;

let menusReady = Promise.resolve();

function createMenus() {
  menusReady = new Promise(resolve => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'toggle-global', title: msg('menuEnableAllSites'), contexts: ['action'] });
      chrome.contextMenus.create({ id: 'sep1', type: 'separator', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'toggle-site', title: msg('menuEnableForSite'), contexts: ['action'] });
      chrome.contextMenus.create({ id: 'toggle-page', title: msg('menuEnableForPage'), contexts: ['action'] });
      chrome.contextMenus.create({ id: 'sep2', type: 'separator', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'reset-site', title: msg('menuResetSite'), contexts: ['action'] }, resolve);
    });
  });
}

async function refreshMenus(storageData, activeTab) {
  await menusReady;
  if (!storageData) storageData = await getData();

  let parsed = null;
  let incognito = false;

  if (activeTab?.url) {
    // Full tab object with URL (from action/context menu click – granted by activeTab)
    parsed = parseTab(activeTab);
    incognito = !!activeTab.incognito;
  } else {
    // No URL available – look up from cache
    let tab = activeTab;
    if (!tab) {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
    if (tab) {
      incognito = !!tab.incognito;
      const cached = tabCache.get(tab.id);
      if (cached) {
        parsed = parseTab({ url: cached.url, id: tab.id });
      }
    }
  }

  const data = getTabData(storageData, incognito);

  chrome.contextMenus.update('toggle-global', {
    title: data.global ? msg('menuDisableAllSites') : msg('menuEnableAllSites'),
  });

  if (!parsed) {
    chrome.contextMenus.update('toggle-site', { title: msg('menuEnableForSite'), enabled: false });
    chrome.contextMenus.update('toggle-page', { title: msg('menuEnableForPage'), enabled: false });
    chrome.contextMenus.update('reset-site', { title: msg('menuResetSite'), enabled: false });
    return;
  }

  const { hostname, url } = parsed;
  const currentSite = siteState(data, hostname);
  const pageResolved = resolveState(data.global, data.sites, data.pages, hostname, url);

  chrome.contextMenus.update('toggle-site', {
    title: currentSite ? msg('menuDisableForHost', [hostname]) : msg('menuEnableForHost', [hostname]),
    enabled: true,
  });

  chrome.contextMenus.update('toggle-page', {
    title: pageResolved ? msg('menuDisableForPage') : msg('menuEnableForPage'),
    enabled: true,
  });

  const hasRules = (hostname in data.sites) || hasPagesForHost(data.pages, hostname);
  chrome.contextMenus.update('reset-site', {
    title: msg('menuResetSite'),
    enabled: hasRules,
  });
}

// ── Initialisation ───────────────────────────────────────────────────────────

// Context menus persist across SW restarts in MV3.
// Create them only on install/update to avoid duplicate-id errors.
chrome.runtime.onInstalled.addListener(async () => {
  createMenus();
  await menusReady;
  refreshMenus();
});

// Icon click: smart toggle (page if page rule exists, otherwise site)
chrome.action.onClicked.addListener(async (tab) => {
  const parsed = parseTab(tab);
  if (!parsed) return;

  tabCache.set(tab.id, { url: tab.url, incognito: !!tab.incognito });
  const [storageData] = await Promise.all([getData(), incognitoReady]);

  if (tab.incognito) {
    smartToggleIncognito(storageData, parsed.hostname, parsed.clean);
    await applyIncognitoChange(storageData, tab, parsed.tabId, parsed.url);
    return;
  }

  const toSave = smartToggle(storageData, parsed.hostname, parsed.clean);
  await chrome.storage.local.set(toSave);
  // Badge + menus updated by storage.onChanged
});

// Context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const [storageData] = await Promise.all([getData(), incognitoReady]);

  if (info.menuItemId === 'toggle-global') {
    if (tab?.incognito) {
      incognitoData.global = !(incognitoData.global ?? storageData.global);
      if (tab.url) tabCache.set(tab.id, { url: tab.url, incognito: true });
      await applyIncognitoChange(storageData, tab, tab.id, tab.url);
    } else {
      await chrome.storage.local.set({ global: !storageData.global });
    }
    return;
  }

  const parsed = parseTab(tab);
  if (!parsed) return;

  tabCache.set(tab.id, { url: tab.url, incognito: !!tab.incognito });

  if (tab?.incognito) {
    if (info.menuItemId === 'toggle-site') {
      toggleSiteIncognito(storageData, parsed.hostname);
    } else if (info.menuItemId === 'toggle-page') {
      togglePageIncognito(storageData, parsed.hostname, parsed.clean);
    } else if (info.menuItemId === 'reset-site') {
      delete incognitoData.sites[parsed.hostname];
      deletePagesForHost(incognitoData.pages, parsed.hostname);
    }
    await applyIncognitoChange(storageData, tab, parsed.tabId, parsed.url);
    return;
  }

  if (info.menuItemId === 'toggle-site') {
    toggleSite(storageData, parsed.hostname);
    await chrome.storage.local.set({ sites: storageData.sites });
  } else if (info.menuItemId === 'toggle-page') {
    togglePage(storageData, parsed.hostname, parsed.clean);
    await chrome.storage.local.set({ pages: storageData.pages });
  } else if (info.menuItemId === 'reset-site') {
    delete storageData.sites[parsed.hostname];
    deletePagesForHost(storageData.pages, parsed.hostname);
    await chrome.storage.local.set({
      sites: storageData.sites, pages: storageData.pages,
    });
  }
  // Badge + menus updated by storage.onChanged
});

// Tab switch: badge is already correct (updated eagerly), just refresh menus + content script
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  sendRefresh(tabId);
  const cached = tabCache.get(tabId);
  if (cached) {
    const tab = await chrome.tabs.get(tabId);
    refreshMenus(null, { ...tab, url: cached.url });
  } else {
    refreshMenus();
  }
});

// Page load complete: ensure content script has latest state
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    sendRefresh(tabId);
  }
});

// Tab closed: clean up cache
chrome.tabs.onRemoved.addListener((tabId) => tabCache.delete(tabId));

// Storage change (from options page or normal toggle): update all badges + refresh active tab
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if ('global' in changes || 'sites' in changes || 'pages' in changes) {
    const [storageData, [activeTab]] = await Promise.all([
      getData(),
      chrome.tabs.query({ active: true, currentWindow: true }),
      incognitoReady,
    ]);
    updateAllBadges(storageData);
    refreshMenus(storageData);
    if (activeTab) sendRefresh(activeTab.id);
  }
});

// Handle state requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get-state') {
    const tab = sender.tab;
    const url = message.url;
    if (!tab || !url?.startsWith('http')) {
      sendResponse({ enabled: false });
      return;
    }

    const isMainFrame = sender.frameId === 0;
    if (isMainFrame) {
      tabCache.set(tab.id, { url, incognito: !!tab.incognito });
    }

    Promise.all([getData(), incognitoReady]).then(([storageData]) => {
      const data = getTabData(storageData, tab.incognito);
      const { hostname } = new URL(url);
      const enabled = resolveState(data.global, data.sites, data.pages, hostname, url);

      if (isMainFrame) {
        applyBadge(tab.id, url, data);
        if (tab.active) refreshMenus(storageData, { ...tab, url });
      }

      sendResponse({ enabled });
    }).catch(() => sendResponse({ enabled: false }));
    return true; // keep channel open for async response
  }
});

// Startup: refresh menus (badges set when content scripts send get-state)
refreshMenus();
