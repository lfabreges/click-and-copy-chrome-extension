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
 * Incognito: rules apply in-session but are NEVER written to storage.
 *   incognitoData holds in-memory overrides for all incognito tabs.
 *   It is lost when the service worker restarts (browser exit, extension reload).
 */

// ── In-memory state for incognito (never persisted) ──────────────────────────

const incognitoData = { global: null, sites: {}, pages: {} };
// global: null means "inherit from storage"

// Merges storage data with incognito in-memory overrides
function getEffectiveData(storageData) {
  return {
    global: incognitoData.global !== null ? incognitoData.global : storageData.global,
    sites:  { ...storageData.sites, ...incognitoData.sites },
    pages:  { ...storageData.pages, ...incognitoData.pages },
  };
}

// Returns the correct data object for a given tab (effective for incognito, raw for normal)
function getTabData(storageData, tab) {
  return tab?.incognito ? getEffectiveData(storageData) : storageData;
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

// ── Tab notification ──────────────────────────────────────────────────────────

function notifyTab(tabId, url, data) {
  if (!url?.startsWith('http')) return;
  const { hostname } = new URL(url);
  const enabled = resolveState(data.global, data.sites, data.pages, hostname, url);
  chrome.tabs.sendMessage(tabId, { type: 'click-and-copy-state', enabled }).catch(() => {});
}

async function notifyTabs(data, { incognito } = {}) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (incognito !== undefined && tab.incognito !== incognito) continue;
    notifyTab(tab.id, tab.url, data);
  }
}

async function notifyIncognitoTabsForHost(effData, hostname, excludeTabId) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.incognito || tab.id === excludeTabId || !tab.url?.startsWith('http')) continue;
    try {
      if (new URL(tab.url).hostname === hostname) {
        applyBadge(tab.id, tab.url, effData);
        notifyTab(tab.id, tab.url, effData);
      }
    } catch {}
  }
}

// Apply incognito toggle result: update badge, notify current + sibling tabs, refresh menus.
// Must be async and awaited — unawaited promises in MV3 service workers can be dropped.
async function applyIncognitoChange(storageData, tab, parsed) {
  const effData = getEffectiveData(storageData);
  applyBadge(parsed.tabId, parsed.url, effData);
  notifyTab(parsed.tabId, parsed.url, effData);
  await notifyIncognitoTabsForHost(effData, parsed.hostname, parsed.tabId);
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

async function updateAllBadges(storageData) {
  if (!storageData) storageData = await getData();
  const effData = getEffectiveData(storageData);
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    applyBadge(tab.id, tab.url, tab.incognito ? effData : storageData);
  }
}

// ── Context menus ────────────────────────────────────────────────────────────

const msg = chrome.i18n.getMessage;

let menusReady;

function createMenus() {
  menusReady = new Promise(resolve => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'toggle-global', title: msg('menuEnableAllSites'), contexts: ['action'] });
      chrome.contextMenus.create({ id: 'sep1', type: 'separator', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'toggle-site', title: msg('menuEnableForSite'), contexts: ['action'] });
      chrome.contextMenus.create({ id: 'toggle-page', title: msg('menuEnableForPage'), contexts: ['action'] });
      chrome.contextMenus.create({ id: 'sep2', type: 'separator', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'reset-site', title: msg('menuResetSite'), contexts: ['action'] });
      chrome.contextMenus.create({ id: 'sep3', type: 'separator', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'open-options', title: msg('menuOptions'), contexts: ['action'] }, resolve);
    });
  });
}

async function refreshMenus(storageData, activeTab) {
  if (menusReady) await menusReady;
  if (!storageData) storageData = await getData();

  if (!activeTab) {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }

  const data = getTabData(storageData, activeTab);

  chrome.contextMenus.update('toggle-global', {
    title: data.global ? msg('menuDisableAllSites') : msg('menuEnableAllSites'),
  });

  const parsed = activeTab ? parseTab(activeTab) : null;

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

async function refreshAll(storageData) {
  if (!storageData) storageData = await getData();
  updateAllBadges(storageData);
  refreshMenus(storageData);
}

// ── Initialisation ───────────────────────────────────────────────────────────

createMenus();

// Icon click: smart toggle (page if page rule exists, otherwise site)
chrome.action.onClicked.addListener(async (tab) => {
  const parsed = parseTab(tab);
  if (!parsed) return;

  const storageData = await getData();

  if (tab.incognito) {
    smartToggleIncognito(storageData, parsed.hostname, parsed.clean);
    await applyIncognitoChange(storageData, tab, parsed);
    return;
  }

  const toSave = smartToggle(storageData, parsed.hostname, parsed.clean);
  await chrome.storage.local.set(toSave);
});

// Context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-options') {
    chrome.runtime.openOptionsPage();
    return;
  }

  const storageData = await getData();

  if (info.menuItemId === 'toggle-global') {
    if (tab?.incognito) {
      incognitoData.global = !(incognitoData.global ?? storageData.global);
      const effData = getEffectiveData(storageData);
      await updateAllBadges(storageData);
      await refreshMenus(storageData, tab);
      await notifyTabs(effData, { incognito: true });
    } else {
      await chrome.storage.local.set({ global: !storageData.global });
    }
    return;
  }

  const parsed = parseTab(tab);
  if (!parsed) return;

  const { hostname, clean } = parsed;

  if (tab?.incognito) {
    if (info.menuItemId === 'toggle-site') {
      toggleSiteIncognito(storageData, hostname);
    } else if (info.menuItemId === 'toggle-page') {
      togglePageIncognito(storageData, hostname, clean);
    } else if (info.menuItemId === 'reset-site') {
      delete incognitoData.sites[hostname];
      deletePagesForHost(incognitoData.pages, hostname);
    }
    await applyIncognitoChange(storageData, tab, parsed);
    return;
  }

  if (info.menuItemId === 'toggle-site') {
    toggleSite(storageData, hostname);
    await chrome.storage.local.set({ sites: storageData.sites });
  } else if (info.menuItemId === 'toggle-page') {
    togglePage(storageData, hostname, clean);
    await chrome.storage.local.set({ pages: storageData.pages });
  } else if (info.menuItemId === 'reset-site') {
    delete storageData.sites[hostname];
    deletePagesForHost(storageData.pages, hostname);
    await chrome.storage.local.set({
      sites: storageData.sites, pages: storageData.pages,
    });
  }
});

// Tab navigation: update badge + menus
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    const storageData = await getData();
    applyBadge(tabId, tab.url, getTabData(storageData, tab));
    if (tab.active) refreshMenus(storageData, tab);
  }
});

// Tab switch: update menus for the new active tab
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  refreshMenus(null, tab);
});

// Any storage change: refresh badges, menus, and notify non-incognito content scripts
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if ('global' in changes || 'sites' in changes || 'pages' in changes) {
    const storageData = await getData();
    refreshAll(storageData);
    notifyTabs(storageData, { incognito: false });
  }
});

// Handle state requests from content scripts (needed for incognito-aware resolution)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get-state') {
    const tab = sender.tab;
    if (!tab?.url?.startsWith('http')) {
      sendResponse({ enabled: false });
      return;
    }
    getData().then(storageData => {
      const data = getTabData(storageData, tab);
      const { hostname } = new URL(tab.url);
      const enabled = resolveState(data.global, data.sites, data.pages, hostname, tab.url);
      sendResponse({ enabled });
    }).catch(() => sendResponse({ enabled: false }));
    return true; // keep channel open for async response
  }
});

// Startup: restore state
refreshAll();
