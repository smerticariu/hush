// Service worker: owns the settings, enables rulesets, serves the cosmetic CSS
// requested by the content script, registers scriptlets and the user's filters,
// and counts what gets blocked.

import {
  preprocess, classify, parseNetwork, toDnrRule, parseCosmeticBody,
  parseCosmeticDomains, hostnameCandidates, hostHash, PRIORITY,
} from './shared/filters.js';
import { loadGroups, loadSettings, saveSettings, migrateFromLocal, onSettingsChanged } from './shared/settings.js';
import * as stats from './shared/stats.js';

const HIDE_ATTR = 'hush-hidden';
const SITE_RULE_ID = 1;
const USER_RULE_BASE = 1000;

// ------------------------------------------------------------ settings

// read once per service worker wake-up, invalidated on any change
let settingsPromise = null;
const getSettings = () => (settingsPromise ??= loadSettings());

function siteKey(hostname) {
  return hostname.replace(/^www\./, '');
}

function isDisabled(settings, hostname) {
  if (!hostname) return false;
  const set = new Set(settings.disabledSites);
  return hostnameCandidates(hostname).some((h) => set.has(h));
}

// ------------------------------------------------------------ cosmetic database

// The core (exceptions, high-generic) loads at startup; site-specific cosmetics
// in shards, only for the requested host; the big generic table in the background.
let db = null;
let dbPromise = null;
const specificShards = new Map(); // index -> Promise<obj>
let genericPromise = null;

// "group\ttype\tselector[\tstyle]" -> [type, selector, group, style]
function decode(text) {
  if (!text) return [];
  return text.split('\n').map((line) => {
    const [g, t, sel, style] = line.split('\t');
    return style === undefined ? [+t, sel, +g] : [+t, sel, +g, style];
  });
}

function loadDb() {
  dbPromise ??= (async () => {
    const [raw, settings] = await Promise.all([
      fetch('/data/cosmetic-core.json').then((r) => r.json()),
      getSettings(),
    ]);
    db = {
      groups: raw.groups,
      shards: raw.shards,
      highGeneric: decode(raw.highGeneric),
      exceptions: raw.exceptions,
      elemhide: new Set(raw.elemhide),
      generichide: new Set(raw.generichide),
      specifichide: new Set(raw.specifichide),
    };
    applyGroupsToDb(settings);
    db.user = compileUserCosmetic(settings.userFilters);
    return db;
  })();
  return dbPromise;
}

function loadShard(i) {
  if (!specificShards.has(i)) {
    specificShards.set(i, fetch(`/data/cosmetic-specific-${i}.json`).then((r) => r.json()));
  }
  return specificShards.get(i);
}

function loadGeneric() {
  genericPromise ??= fetch('/data/cosmetic-generic.json').then((r) => r.json());
  return genericPromise;
}

function applyGroupsToDb(settings) {
  if (!db) return;
  db.enabled = new Set(settings.enabledGroups.map((g) => db.groups.indexOf(g)));
  cssCache.clear();
}

// Cosmetic filters written by the user (and the ones from the picker).
function compileUserCosmetic(text) {
  const user = { specific: {}, generic: [], exceptions: {} };
  for (const line of preprocess(text)) {
    const c = classify(line);
    if (!c || c.kind !== 'cosmetic') continue;
    const body = parseCosmeticBody(c.sep, c.body);
    if (!body || body.type === 'scriptlet') continue;
    const { include, exclude, dropped } = parseCosmeticDomains(c.domains);
    if (dropped && !include.length) continue;
    const entry = body.type === 'style' ? [1, body.selector, -1, body.style] : body.type === 'procedural' ? [2, body.selector, -1] : [0, body.selector, -1];
    if (c.exception) {
      for (const h of include.length ? include : ['*']) (user.exceptions[h] ||= []).push(body.selector);
      continue;
    }
    if (include.length) for (const h of include) (user.specific[h] ||= []).push(entry);
    else user.generic.push(entry);
    for (const h of exclude) (user.exceptions[h] ||= []).push(body.selector);
  }
  return user;
}

const cssCache = new Map(); // hostname -> init result

function important(style) {
  return style.split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => (/!important$/.test(d) ? d : `${d} !important`)).join('; ');
}

function entryCss(e) {
  return e[0] === 1 ? `${e[1]} { ${important(e[3])} }` : `${e[1]} { display: none !important; }`;
}

async function cosmeticsFor(hostname) {
  const cached = cssCache.get(hostname);
  if (cached) return cached;

  const candidates = hostnameCandidates(hostname);
  const has = (set) => candidates.some((h) => set.has(h));
  const result = { css: '', procedural: [], generic: true, exceptions: new Set() };

  if (has(db.elemhide)) {
    result.off = true;
  } else {
    const shards = await Promise.all([...new Set(candidates.map((h) => hostHash(h) % db.shards))].map(loadShard));
    const exceptions = result.exceptions;
    for (const h of [...candidates, '*']) {
      if (db.exceptions[h]) for (const s of db.exceptions[h].split('\n')) exceptions.add(s);
      for (const s of db.user.exceptions[h] || []) exceptions.add(s);
    }
    const ok = (e) => (e[2] === -1 || db.enabled.has(e[2])) && !exceptions.has(e[1]);
    const css = [`[${HIDE_ATTR}] { display: none !important; }`];
    const specific = [];
    if (!has(db.specifichide)) {
      for (const h of candidates) {
        for (const shard of shards) {
          if (shard[h]) for (const e of decode(shard[h])) if (ok(e)) specific.push(e);
        }
      }
    }
    for (const h of candidates) for (const e of db.user.specific[h] || []) specific.push(e);
    for (const e of specific) {
      if (e[0] === 2) result.procedural.push(e[1]);
      else css.push(entryCss(e));
    }
    result.generic = !has(db.generichide);
    if (result.generic) {
      for (const e of db.highGeneric) if (ok(e)) css.push(entryCss(e));
    }
    for (const e of db.user.generic) {
      if (exceptions.has(e[1])) continue;
      if (e[0] === 2) result.procedural.push(e[1]);
      else css.push(entryCss(e));
    }
    result.css = css.join('\n');
  }
  if (cssCache.size > 300) cssCache.delete(cssCache.keys().next().value);
  cssCache.set(hostname, result);
  return result;
}

async function genericCss(hostname, tokens) {
  const [{ exceptions }, generic] = await Promise.all([cosmeticsFor(hostname), loadGeneric()]);
  const out = [];
  for (const t of tokens) {
    for (const e of decode(generic[t])) {
      if (db.enabled.has(e[2]) && !exceptions.has(e[1])) out.push(entryCss(e));
    }
  }
  return out.join('\n');
}

function target(sender) {
  return sender.documentId
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id, frameIds: [sender.frameId] };
}

function insertCss(sender, css) {
  if (!css || !sender.tab) return Promise.resolve();
  return chrome.scripting.insertCSS({ target: target(sender), css, origin: 'USER' }).catch(() => {});
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ------------------------------------------------------------ rulesets and dynamic rules

async function syncRulesets(settings) {
  const groups = await loadGroups();
  const want = new Set(settings.enabledGroups);
  for (const g of groups) if (g.locked) want.add(g.id);
  const current = new Set(await chrome.declarativeNetRequest.getEnabledRulesets());
  const enableRulesetIds = [...want].filter((id) => !current.has(id));
  const disableRulesetIds = [...current].filter((id) => !want.has(id));
  if (enableRulesetIds.length || disableRulesetIds.length) {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
  }
}

let redirectsPromise;
const loadRedirects = () => (redirectsPromise ??= fetch('/data/redirects.json').then((r) => r.json()));

/** Network rules from the user's filters. Returns { rules, errors }. */
export async function compileUserNetwork(text) {
  const redirects = await loadRedirects();
  const rules = [];
  const errors = [];
  for (const line of preprocess(text)) {
    const c = classify(line);
    if (!c || c.kind !== 'network') continue;
    const f = parseNetwork(c.text);
    const rule = f && toDnrRule(f, redirects);
    if (!rule) { errors.push(line); continue; }
    rules.push(rule);
  }
  return { rules, errors };
}

async function syncDynamicRules(settings) {
  const rules = [];
  if (settings.disabledSites.length) {
    rules.push({
      id: SITE_RULE_ID,
      priority: PRIORITY.userAllow,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: settings.disabledSites, resourceTypes: ['main_frame'] },
    });
  }
  const { rules: user } = await compileUserNetwork(settings.userFilters);
  user.forEach((r, i) => rules.push({ ...r, id: USER_RULE_BASE + i }));

  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((r) => r.id),
    addRules: rules,
  });
}

// ------------------------------------------------------------ scriptlets

async function syncScriptlets(settings) {
  const index = await fetch('/data/scriptlets.json').then((r) => r.json());
  const want = new Set(settings.enabledGroups);
  for (const g of await loadGroups()) if (g.locked) want.add(g.id);
  const excludeMatches = settings.disabledSites.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]);

  const old = await chrome.scripting.getRegisteredContentScripts();
  if (old.length) await chrome.scripting.unregisterContentScripts({ ids: old.map((s) => s.id) });
  const scripts = index.filter((s) => want.has(s.group)).map((s) => ({
    id: s.id,
    js: s.js,
    matches: s.matches,
    excludeMatches: excludeMatches.length ? excludeMatches : undefined,
    world: s.world,
    runAt: 'document_start',
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  }));
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

// ------------------------------------------------------------ syncing

let syncChain = Promise.resolve();
function syncAll(parts = ['rulesets', 'dynamic', 'scriptlets', 'cosmetic']) {
  syncChain = syncChain.then(async () => {
    const settings = await getSettings();
    const tasks = [];
    if (parts.includes('rulesets')) tasks.push(syncRulesets(settings));
    if (parts.includes('dynamic')) tasks.push(syncDynamicRules(settings));
    if (parts.includes('scriptlets')) tasks.push(syncScriptlets(settings));
    if (parts.includes('cosmetic') && db) {
      applyGroupsToDb(settings);
      db.user = compileUserCosmetic(settings.userFilters);
    }
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') console.error('[Hush]', r.reason);
  });
  return syncChain;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await migrateFromLocal();
  settingsPromise = null;
  chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
  chrome.action.setBadgeBackgroundColor({ color: '#4b5563' });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'picker', title: 'Hide an element on this page', contexts: ['page', 'frame', 'image', 'link'] });
  });
  await syncAll();
  if (reason === 'install') chrome.tabs.create({ url: '/dashboard/dashboard.html?welcome=1' });
});

// changes also arrive from other computers, through Chrome Sync
onSettingsChanged((changed) => {
  settingsPromise = null;
  const parts = new Set();
  if (changed.has('enabledGroups')) ['rulesets', 'scriptlets', 'cosmetic'].forEach((p) => parts.add(p));
  if (changed.has('disabledSites')) ['dynamic', 'scriptlets'].forEach((p) => parts.add(p));
  if (changed.has('userFilters')) ['dynamic', 'cosmetic'].forEach((p) => parts.add(p));
  cssCache.clear();
  syncAll([...parts]).then(refreshAllIcons);
});

// ------------------------------------------------------------ per-tab icon

async function refreshIcon(tabId, url) {
  const settings = await getSettings();
  const off = isDisabled(settings, hostnameOf(url));
  const suffix = off ? '-off' : '';
  chrome.action.setIcon({ tabId, path: { 16: `/icons/16${suffix}.png`, 32: `/icons/32${suffix}.png` } }).catch(() => {});
}

async function refreshAllIcons() {
  for (const tab of await chrome.tabs.query({})) if (tab.url) refreshIcon(tab.id, tab.url);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'loading') refreshIcon(tabId, tab.url);
});

// ------------------------------------------------------------ counting
//
// webRequest is used read-only: requests blocked by our DNR rules fail with
// ERR_BLOCKED_BY_CLIENT, neutralized ones redirect to /redirects/, and stripped
// tracking parameters show up as a main_frame redirect to the same URL.

let categoriesPromise;
const loadCategories = () => (categoriesPromise ??= fetch('/data/categories.json').then((r) => r.json())
  .then((c) => ({ trackers: new Set(c.trackers), threats: new Set(c.threats) })));

async function categoryOf(host) {
  const c = await loadCategories();
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const h = labels.slice(i).join('.');
    if (c.threats.has(h)) return 'threats';
    if (c.trackers.has(h)) return 'trackers';
  }
  return 'ads';
}

// tabId -> { site, ads, trackers, threats }, mirrored in storage.session so the
// popup survives a service worker restart
const tabs = new Map();
let tabsLoaded = null;
let tabsTimer = 0;
const loadTabs = () => (tabsLoaded ??= chrome.storage.session.get('tabs').then((r) => {
  for (const [id, v] of Object.entries(r.tabs || {})) if (!tabs.has(+id)) tabs.set(+id, v);
}));
function saveTabs() {
  if (tabsTimer) return;
  tabsTimer = setTimeout(() => {
    tabsTimer = 0;
    chrome.storage.session.set({ tabs: Object.fromEntries(tabs) });
  }, 1000);
}
async function pageCounts(tabId) {
  await loadTabs();
  return tabs.get(tabId) || null;
}

async function countBlocked(details) {
  if (details.tabId < 0) return;
  await loadTabs();
  const host = hostnameOf(details.url);
  const kind = await categoryOf(host);
  let t = tabs.get(details.tabId);
  if (!t) {
    const site = siteKey(hostnameOf(details.initiator || details.documentUrl || ''));
    t = { site, ads: 0, trackers: 0, threats: 0 };
    tabs.set(details.tabId, t);
  }
  t[kind]++;
  saveTabs();
  stats.record(kind, t.site, host);
}

chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  loadTabs().then(() => {
    tabs.set(d.tabId, { site: siteKey(hostnameOf(d.url)), ads: 0, trackers: 0, threats: 0 });
    saveTabs();
  });
}, { urls: ['<all_urls>'], types: ['main_frame'] });

chrome.webRequest.onErrorOccurred.addListener((d) => {
  if (d.error === 'net::ERR_BLOCKED_BY_CLIENT') countBlocked(d);
}, { urls: ['<all_urls>'] });

const OWN = chrome.runtime.getURL('/redirects/');
chrome.webRequest.onBeforeRedirect.addListener((d) => {
  if (d.redirectUrl.startsWith(OWN)) { countBlocked(d); return; }
  if (d.type !== 'main_frame') return;
  try {
    const from = new URL(d.url);
    const to = new URL(d.redirectUrl);
    if (from.origin === to.origin && from.pathname === to.pathname && to.search.length < from.search.length) {
      stats.record('cleaned', siteKey(from.hostname));
    }
  } catch { /* not a URL we care about */ }
}, { urls: ['<all_urls>'] });

chrome.tabs.onRemoved.addListener((tabId) => {
  loadTabs().then(() => { tabs.delete(tabId); saveTabs(); });
});

// ------------------------------------------------------------ picker

async function startPicker(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content/picker.js'] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'picker' && tab?.id) startPicker(tab.id);
});

async function addUserFilter(line) {
  const settings = await getSettings();
  const lines = settings.userFilters.split('\n').filter(Boolean);
  if (!lines.includes(line)) lines.push(line);
  await saveSettings({ userFilters: lines.join('\n') + '\n' });
}

// ------------------------------------------------------------ messages

const handlers = {
  async 'cosmetic:init'(msg, sender) {
    const settings = await getSettings();
    const host = hostnameOf(msg.url) || hostnameOf(sender.origin);
    const top = hostnameOf(sender.tab?.url);
    if (isDisabled(settings, top) || isDisabled(settings, host)) return { off: true };
    await loadDb();
    const r = await cosmeticsFor(host);
    if (r.off) return { off: true };
    await insertCss(sender, r.css);
    return { generic: r.generic, procedural: r.procedural, hideAttr: HIDE_ATTR };
  },

  async 'cosmetic:generic'(msg, sender) {
    await loadDb();
    const host = hostnameOf(msg.url);
    await insertCss(sender, await genericCss(host, msg.tokens));
    return true;
  },

  async 'popup:state'({ tabId }) {
    const tab = await chrome.tabs.get(tabId);
    const settings = await getSettings();
    const host = hostnameOf(tab.url);
    const site = siteKey(host);
    const [page, all] = await Promise.all([pageCounts(tabId), stats.get()]);
    const day = all.days[stats.todayKey()] || {};
    return {
      host, site,
      web: /^https?:/.test(tab.url || ''),
      disabled: isDisabled(settings, host),
      page: page && page.site === site ? page : { ads: 0, trackers: 0, threats: 0 },
      siteTotal: all.sites[site] || 0,
      today: (day.ads || 0) + (day.trackers || 0) + (day.threats || 0),
      total: all.total.ads + all.total.trackers + all.total.threats,
    };
  },

  async 'stats:get'() {
    return { ...(await stats.get()), avgBytes: stats.AVG_BYTES, avgMs: stats.AVG_MS };
  },

  async 'stats:reset'() {
    await stats.reset();
    return true;
  },

  async 'site:set'({ site, enabled }) {
    const settings = await getSettings();
    const set = new Set(settings.disabledSites);
    // pausing "www.x.com" pauses "x.com" too
    for (const h of [site, `www.${site}`]) set.delete(h);
    if (!enabled) set.add(site);
    await saveSettings({ disabledSites: [...set].sort() });
    return true;
  },

  async 'picker:start'({ tabId }) {
    await startPicker(tabId);
    return true;
  },

  async 'picker:add'({ selector }, sender) {
    const host = siteKey(hostnameOf(sender.tab?.url));
    if (!host || !selector) return false;
    await addUserFilter(`${host}##${selector}`);
    await insertCss(sender, `${selector} { display: none !important; }`);
    return true;
  },

  async 'filters:check'({ text }) {
    const { rules, errors } = await compileUserNetwork(text);
    return { network: rules.length, errors };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  h(msg, sender).then(reply, (err) => { console.error('[Hush]', msg.type, err); reply(null); });
  return true;
});

// for the tests (tools/*.mjs) and debugging from the service worker console
self.hush = { loadSettings, saveSettings, migrateFromLocal, stats };

// start loading as soon as the service worker wakes up; the generic table after
// the core, so it doesn't delay the first answer
loadDb().then(() => setTimeout(loadGeneric, 50));
