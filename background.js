'use strict';

/*
 * Storage schema:
 *   global:   boolean            – default state for all sites (false = off)
 *   sites:    { hostname: bool } – per-hostname overrides
 *   pages:    { cleanUrl: bool } – per-page overrides (URL without query/hash)
 *   detected: { hostname: bool } – sites where event blocking was detected
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

function parseTab(tab) {
  if (!tab?.url || !tab.url.startsWith('http')) return null;
  const u = new URL(tab.url);
  return { hostname: u.hostname, url: tab.url, clean: stripUrl(tab.url), tabId: tab.id };
}

async function getData() {
  const { global = false, sites = {}, pages = {}, detected = {} } =
    await chrome.storage.local.get(['global', 'sites', 'pages', 'detected']);
  return { global, sites, pages, detected };
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
    chrome.action.setBadgeText({ text: 'ON', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId });
  } else if (data.detected[hostname]) {
    chrome.action.setBadgeText({ text: '!', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b', tabId });
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

// Promise that resolves once menus are created. refreshMenus() awaits it.
let menusReady;

function createMenus() {
  menusReady = new Promise(resolve => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'toggle-global', title: 'Activer pour tous les sites', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'sep1', type: 'separator', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'toggle-site', title: 'Activer pour ce site', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'toggle-page', title: 'Activer pour cette page', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'sep2', type: 'separator', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'reset-site', title: 'Réinitialiser ce site', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'sep3', type: 'separator', contexts: ['action'] });
      chrome.contextMenus.create({ id: 'open-options', title: 'Options…', contexts: ['action'] }, resolve);
    });
  });
}

async function refreshMenus(data, activeTab) {
  if (menusReady) await menusReady;
  if (!data) data = await getData();

  chrome.contextMenus.update('toggle-global', {
    title: data.global ? 'Désactiver pour tous les sites' : 'Activer pour tous les sites',
  });

  if (!activeTab) {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  const parsed = activeTab ? parseTab(activeTab) : null;

  if (!parsed) {
    chrome.contextMenus.update('toggle-site', { title: 'Activer pour ce site', enabled: false });
    chrome.contextMenus.update('toggle-page', { title: 'Activer pour cette page', enabled: false });
    chrome.contextMenus.update('reset-site', { title: 'Réinitialiser ce site', enabled: false });
    return;
  }

  const { hostname, url } = parsed;
  const currentSite = siteState(data, hostname);
  const pageResolved = resolveState(data.global, data.sites, data.pages, hostname, url);

  chrome.contextMenus.update('toggle-site', {
    title: currentSite ? `Désactiver pour ${hostname}` : `Activer pour ${hostname}`,
    enabled: true,
  });

  chrome.contextMenus.update('toggle-page', {
    title: pageResolved ? 'Désactiver pour cette page' : 'Activer pour cette page',
    enabled: true,
  });

  const hasRules = (hostname in data.sites) || hasPagesForHost(data.pages, hostname);
  chrome.contextMenus.update('reset-site', {
    title: 'Réinitialiser ce site',
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove('enabled'); // clean up old schema
});

// Icon click: toggle for the whole site (hostname)
chrome.action.onClicked.addListener(async (tab) => {
  const parsed = parseTab(tab);
  if (!parsed) return;

  const data = await getData();
  const current = siteState(data, parsed.hostname);
  data.sites[parsed.hostname] = !current;
  await chrome.storage.local.set({ sites: data.sites });
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

  const { hostname, url: tabUrl, clean } = parsed;
  const data = await getData();

  if (info.menuItemId === 'toggle-site') {
    data.sites[hostname] = !siteState(data, hostname);
    await chrome.storage.local.set({ sites: data.sites });
  } else if (info.menuItemId === 'toggle-page') {
    const pageResolved = resolveState(data.global, data.sites, data.pages, hostname, tabUrl);
    data.pages[clean] = !pageResolved;
    await chrome.storage.local.set({ pages: data.pages });
  } else if (info.menuItemId === 'reset-site') {
    delete data.sites[hostname];
    deletePagesForHost(data.pages, hostname);
    delete data.detected[hostname];
    await chrome.storage.local.set({
      sites: data.sites, pages: data.pages, detected: data.detected,
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

// Detection reports from content scripts
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'detected' && msg.hostname && sender.tab) {
    chrome.storage.local.get('detected').then(({ detected = {} }) => {
      if (!detected[msg.hostname]) {
        detected[msg.hostname] = true;
        chrome.storage.local.set({ detected });
      }
    });
  }
});

// Any storage change: refresh all badges + context menu titles
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('global' in changes || 'sites' in changes || 'pages' in changes || 'detected' in changes) {
    refreshAll();
  }
});

// Startup: restore state
refreshAll();
