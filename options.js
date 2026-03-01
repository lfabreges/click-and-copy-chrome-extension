'use strict';

const globalToggle = document.getElementById('global-toggle');
const globalHint = document.getElementById('global-hint');
const rulesList = document.getElementById('rules-list');
const detectedList = document.getElementById('detected-list');

async function getData() {
  const { global = false, sites = {}, pages = {}, detected = {} } =
    await chrome.storage.local.get(['global', 'sites', 'pages', 'detected']);
  return { global, sites, pages, detected };
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
  const { global, sites, pages, detected } = data;

  // Global
  globalToggle.checked = global;
  globalHint.textContent = global ? 'Actif sur tous les sites' : 'Désactivé par défaut';

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
    rulesList.innerHTML = '<li class="empty">Aucune exception configurée</li>';
  } else {
    rulesList.innerHTML = rules.map(r => `
      <li>
        <span class="rule-target">
          <span class="badge badge--${r.type}">${r.type === 'site' ? 'Site' : 'Page'}</span>
          <span class="rule-name">${escapeHtml(r.type === 'page' ? simplifyUrl(r.target) : r.target)}</span>
        </span>
        <span class="rule-actions">
          <span class="state state--${r.enabled ? 'on' : 'off'}">${r.enabled ? 'ON' : 'OFF'}</span>
          <button class="remove" data-type="${r.type}" data-target="${escapeAttr(r.target)}">&times;</button>
        </span>
      </li>
    `).join('');
  }

  // Detected
  const hostnames = Object.keys(detected).sort();
  if (hostnames.length === 0) {
    detectedList.innerHTML = '<li class="empty">Aucun site détecté pour le moment</li>';
  } else {
    detectedList.innerHTML = hostnames.map(h => `<li>${escapeHtml(h)}</li>`).join('');
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
    delete data.detected[target];
    await chrome.storage.local.set({ sites: data.sites, pages: data.pages, detected: data.detected });
  } else {
    delete data.pages[target];
    await chrome.storage.local.set({ pages: data.pages });
  }
});

chrome.storage.onChanged.addListener(() => {
  getData().then(render);
});

getData().then(render);
