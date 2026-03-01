'use strict';

const msg = chrome.i18n.getMessage;

// Apply i18n to all elements with data-i18n attribute
document.querySelectorAll('[data-i18n]').forEach(el => {
  const key = el.getAttribute('data-i18n');
  const text = msg(key);
  if (text) el.textContent = text;
});

// Set page title
document.title = msg('optionsTitle');

const globalToggle = document.getElementById('global-toggle');
const globalHint = document.getElementById('global-hint');
const rulesList = document.getElementById('rules-list');

async function getData() {
  const { global = false, sites = {}, pages = {} } =
    await chrome.storage.local.get(['global', 'sites', 'pages']);
  return { global, sites, pages };
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function simplifyUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch { return url; }
}

function render(data) {
  const { global, sites, pages } = data;

  // Global
  globalToggle.checked = global;
  globalHint.textContent = global ? msg('activeOnAllSites') : msg('disabledByDefault');

  // Rules
  const rules = [];
  for (const [hostname, enabled] of Object.entries(sites)) {
    rules.push({ type: 'site', target: hostname, enabled });
  }
  for (const [url, enabled] of Object.entries(pages)) {
    rules.push({ type: 'page', target: url, enabled });
  }

  rules.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'site' ? -1 : 1;
    return a.target.localeCompare(b.target);
  });

  if (rules.length === 0) {
    rulesList.innerHTML = `<li class="empty">${escapeHtml(msg('noExceptions'))}</li>`;
  } else {
    rulesList.innerHTML = rules.map(r => `
      <li>
        <span class="rule-target">
          <span class="badge badge--${r.type}">${r.type === 'site' ? msg('badgeSite') : msg('badgePage')}</span>
          <span class="rule-name">${escapeHtml(r.type === 'page' ? simplifyUrl(r.target) : r.target)}</span>
        </span>
        <span class="rule-actions">
          <span class="state state--${r.enabled ? 'on' : 'off'}">${r.enabled ? 'ON' : 'OFF'}</span>
          <button class="remove" data-type="${r.type}" data-target="${escapeAttr(r.target)}">&times;</button>
        </span>
      </li>
    `).join('');
  }
}

// Events
globalToggle.addEventListener('change', () => {
  chrome.storage.local.set({ global: globalToggle.checked });
});

rulesList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button.remove');
  if (!btn) return;
  const type = btn.dataset.type;
  const target = btn.dataset.target;
  const data = await getData();

  if (type === 'site') {
    delete data.sites[target];
    for (const key of Object.keys(data.pages)) {
      try { if (new URL(key).hostname === target) delete data.pages[key]; } catch {}
    }
    await chrome.storage.local.set({ sites: data.sites, pages: data.pages });
  } else {
    delete data.pages[target];
    await chrome.storage.local.set({ pages: data.pages });
  }
});

chrome.storage.onChanged.addListener(() => {
  getData().then(render);
});

getData().then(render);
