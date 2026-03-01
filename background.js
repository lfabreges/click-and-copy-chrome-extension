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
 */

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

// Toggle the most specific existing rule for this tab.
// If a page rule exists → toggle page; otherwise → toggle site.
// After toggling, remove the rule if it becomes redundant with its parent level.
function smartToggle(data, hostname, clean) {
  const hasPage = clean in data.pages;

  if (hasPage) {
    // Toggle page rule
    const newPageVal = !data.pages[clean];
    const parentVal = siteState(data, hostname);
    if (newPageVal === parentVal) {
      // Page rule would match site level → remove it (let site rule apply)
      delete data.pages[clean];
    } else {
      data.pages[clean] = newPageVal;
    }
    return { sites: data.sites, pages: data.pages };
  }

  // Toggle site rule
  const currentSite = siteState(data, hostname);
  const newSiteVal = !currentSite;
  if (newSiteVal === data.global) {
    // Site rule would match global → remove it (let global apply)
    delete data.sites[hostname];
  } else {
    data.sites[hostname] = newSiteVal;
  }
  return { sites: data.sites, pages: data.pages };
}

// Toggle at a specific level, then clean up if redundant with parent.
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

async function updateAllBadges(data) {
  if (!data) data = await getData();
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) applyBadge(tab.id, tab.url, data);
}

// ── Context menus ────────────────────────────────────────────────────────────

const msg = chrome.i18n.getMessage;

// Promise that resolves once menus are created. refreshMenus() awaits it.
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

async function refreshMenus(data, activeTab) {
  if (menusReady) await menusReady;
  if (!data) data = await getData();

  chrome.contextMenus.update('toggle-global', {
    title: data.global ? msg('menuDisableAllSites') : msg('menuEnableAllSites'),
  });

  if (!activeTab) {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
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

async function refreshAll(data) {
  if (!data) data = await getData();
  updateAllBadges(data);
  refreshMenus(data);
}

// ── Initialisation ───────────────────────────────────────────────────────────

createMenus();

// Icon click: smart toggle (page if page rule exists, otherwise site)
chrome.action.onClicked.addListener(async (tab) => {
  const parsed = parseTab(tab);
  if (!parsed) return;

  const data = await getData();
  const toSave = smartToggle(data, parsed.hostname, parsed.clean);
  await chrome.storage.local.set(toSave);
});

// Context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-options') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (info.menuItemId === 'toggle-global') {
    const data = await getData();
    await chrome.storage.local.set({ global: !data.global });
    return;
  }

  const parsed = parseTab(tab);
  if (!parsed) return;

  const { hostname, clean } = parsed;
  const data = await getData();

  if (info.menuItemId === 'toggle-site') {
    toggleSite(data, hostname);
    await chrome.storage.local.set({ sites: data.sites });
  } else if (info.menuItemId === 'toggle-page') {
    togglePage(data, hostname, clean);
    await chrome.storage.local.set({ pages: data.pages });
  } else if (info.menuItemId === 'reset-site') {
    delete data.sites[hostname];
    deletePagesForHost(data.pages, hostname);
    await chrome.storage.local.set({
      sites: data.sites, pages: data.pages,
    });
  }
});

// Tab navigation: update badge + menus
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    const data = await getData();
    applyBadge(tabId, tab.url, data);
    if (tab.active) refreshMenus(data, tab);
  }
});

// Tab switch: update menus for the new active tab
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  refreshMenus(null, tab);
});

// Any storage change: refresh all badges + context menu titles
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('global' in changes || 'sites' in changes || 'pages' in changes) {
    refreshAll();
  }
});

// Startup: restore state
refreshAll();
