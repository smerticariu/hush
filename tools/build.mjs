// Builds the extension into dist/: DNR rulesets, the cosmetic database,
// scriptlets, redirect resources and the files from src/.
// Run: node tools/build.mjs   (download the lists first with fetch-lists)

import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadScriptlets, loadRedirects, scriptletFromWar, WAR_DIR } from './ubo-resources.mjs';
import { LISTS, GROUPS } from './lists.mjs';
import {
  preprocess, classify, parseNetwork, toDnrRule, badfilterKey,
  parseCosmeticBody, parseCosmeticDomains, genericKey, parseScriptletArgs, hostHash, PRIORITY,
} from '../src/shared/filters.js';

const ROOT = new URL('../', import.meta.url);
const DIST = new URL('dist/', ROOT);
const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'));

const stats = {};
const stat = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };
const unknownOptions = new Set();

await rm(DIST, { recursive: true, force: true });
await mkdir(new URL('rules/', DIST), { recursive: true });
await mkdir(new URL('data/', DIST), { recursive: true });
await mkdir(new URL('scriptlets/', DIST), { recursive: true });
await mkdir(new URL('redirects/', DIST), { recursive: true });

// ------------------------------------------------------------ redirects

// uBO resources: names and aliases -> file in dist/redirects
const warMap = await loadRedirects();
const redirects = {};
for (const [name, d] of warMap) {
  if (!existsSync(new URL(d.file, WAR_DIR))) continue;
  for (const n of [name, ...d.aliases]) redirects[n] = `/redirects/${d.file}`;
}
// short names from the ABP / AdGuard syntax
Object.assign(redirects, {
  noopjs: redirects['noop.js'], noopcss: redirects['noop.css'], noopframe: redirects['noop.html'],
  nooptext: redirects['noop.txt'], 'blank-mp4': redirects['noop-1s.mp4'], 'noopmp4-1s': redirects['noop-1s.mp4'], 'blank-js': redirects['noop.js'],
});
for (const [k, v] of Object.entries(redirects)) if (!v) delete redirects[k];
await cp(WAR_DIR, new URL('redirects/', DIST), { recursive: true });
const missingRedirects = new Map();

// ------------------------------------------------------------ citirea listelor

const groupIndex = Object.fromEntries(GROUPS.map((g, i) => [g.id, i]));
const TRUSTED_LISTS = new Set(LISTS.filter((l) => /^(ubo|brave)-|^hush$/.test(l.id)).map((l) => l.id));

const network = [];   // { text, group }
const cosmetic = [];  // { c, group, list }
for (const list of LISTS) {
  const file = new URL(list.file || `lists/${list.id}.txt`, ROOT);
  if (!existsSync(file)) { console.warn(`! missing lists/${list.id}.txt — run fetch-lists`); continue; }
  for (const line of preprocess(await readFile(file, 'utf8'))) {
    const c = classify(line);
    if (!c) continue;
    if (c.kind === 'network') network.push({ text: c.text, group: list.group });
    else cosmetic.push({ c, group: list.group, list: list.id });
  }
}

// ------------------------------------------------------------ network

const badfilters = new Set();
const parsed = [];
const cosmeticExceptionHosts = { elemhide: new Set(), generichide: new Set(), specifichide: new Set() };

for (const { text, group } of network) {
  const f = parseNetwork(text, { unknownOptions });
  if (!f) { stat('network.unsupported'); continue; }
  if (f.badfilter) { badfilters.add(badfilterKey(text)); continue; }
  parsed.push({ f, text, group });
}

// the host of an exception pattern (@@||site^$ghide)
function patternHost(pattern) {
  const m = pattern.match(/^\|\|([a-z0-9.-]+)\^?\|?$/i);
  return m ? m[1].toLowerCase() : null;
}

const rulesByGroup = Object.fromEntries(GROUPS.map((g) => [g.id, []]));
for (const { f, text, group } of parsed) {
  if (badfilters.has(badfilterKey(text))) { stat('network.badfiltered'); continue; }
  if (f.cosmeticException || f.documentException) {
    const kind = f.documentException ? 'elemhide' : f.cosmeticException;
    const hosts = f.initiator?.include?.length ? f.initiator.include : [patternHost(f.pattern)].filter(Boolean);
    for (const h of hosts) cosmeticExceptionHosts[kind].add(h);
    if (f.cosmeticException) continue;
  }
  const rule = toDnrRule(f, redirects);
  if (!rule) {
    if (f.redirect && !redirects[f.redirect] && f.redirect !== 'empty') missingRedirects.set(f.redirect, (missingRedirects.get(f.redirect) || 0) + 1);
    stat('network.unconvertible');
    continue;
  }
  rulesByGroup[group].push(rule);
}

// Tracking parameters stripped from links, from Brave's list. Navigation only.
const queryFilter = JSON.parse(await readFile(new URL('lists/brave-query-filter.json', ROOT), 'utf8'));
for (const q of queryFilter) {
  const hostsOf = (patterns) => [...new Set(patterns.map((p) => p.match(/^\*:\/\/(?:\*\.)?([^/*]+)\//)?.[1]).filter(Boolean))];
  const condition = { resourceTypes: ['main_frame'] };
  if (q.include.includes('*://*/*')) condition.urlFilter = '?';
  else condition.requestDomains = hostsOf(q.include);
  const excluded = hostsOf(q.exclude || []);
  if (excluded.length) condition.excludedRequestDomains = excluded;
  rulesByGroup.privacy.push({
    priority: PRIORITY.removeparam,
    action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: q.params } } } },
    condition,
  });
}

// Merging: rules identical except for requestDomains / initiatorDomains become one.
function mergeBy(rules, field) {
  const out = [];
  const buckets = new Map();
  for (const r of rules) {
    const list = r.condition[field];
    if (!list) { out.push(r); continue; }
    const { [field]: _, ...rest } = r.condition;
    const key = JSON.stringify([r.priority, r.action, rest]);
    const b = buckets.get(key);
    if (b) for (const d of list) b.condition[field].add(d);
    else {
      const copy = { ...r, condition: { ...r.condition, [field]: new Set(list) } };
      buckets.set(key, copy);
      out.push(copy);
    }
  }
  for (const r of out) if (r.condition[field] instanceof Set) r.condition[field] = [...r.condition[field]].sort();
  return out;
}

function dedupe(rules) {
  const seen = new Set();
  return rules.filter((r) => {
    const k = JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Redundant domains: if a.com is listed, x.a.com isn't needed.
function pruneSubdomains(rules) {
  for (const r of rules) {
    const list = r.condition.requestDomains;
    if (!list || list.length < 2) continue;
    const set = new Set(list);
    r.condition.requestDomains = list.filter((d) => {
      const parts = d.split('.');
      for (let i = 1; i < parts.length - 1; i++) if (set.has(parts.slice(i).join('.'))) return false;
      return true;
    });
  }
  return rules;
}

const rulesetMeta = [];
const ruleCounts = {};
const categoryDomains = {};
let regexTotal = 0;
for (const g of GROUPS) {
  let rules = dedupe(rulesByGroup[g.id]);
  const before = rules.length;
  rules = mergeBy(rules, 'requestDomains');
  rules = mergeBy(rules, 'initiatorDomains');
  rules = pruneSubdomains(rules);
  // regexes are capped (1000 per ruleset); keep the first ones
  let regex = 0;
  rules = rules.filter((r) => !r.condition.regexFilter || ++regex <= 1000);
  regexTotal += Math.min(regex, 1000);
  rules.forEach((r, i) => { r.id = i + 1; });
  await writeFile(new URL(`rules/${g.id}.json`, DIST), JSON.stringify(rules));
  rulesetMeta.push({ id: g.id, enabled: g.defaultOn || !!g.locked, path: `rules/${g.id}.json` });
  ruleCounts[g.id] = rules.length;
  // plain blocked domains feed the "trackers" / "threats" labels in the stats
  if (g.id === 'privacy' || g.id === 'badware') {
    const set = (categoryDomains[g.id] ||= new Set());
    for (const r of rules) {
      if (r.action.type === 'block' && r.condition.requestDomains && !r.condition.initiatorDomains) r.condition.requestDomains.forEach((d) => set.add(d));
    }
  }
  const domains = rules.reduce((n, r) => n + (r.condition.requestDomains?.length || 0), 0);
  console.log(`  ruleset ${g.id.padEnd(11)} ${String(rules.length).padStart(6)} DNR rules (from ${before} filters; ${domains} domains, ${regex} regex)`);
}

// ------------------------------------------------------------ cosmetice

// Entries: [type, selector, group, style?]  type: 0 css, 1 style, 2 procedural
const highGeneric = [];
const lowGeneric = {};
const specific = {};
const exceptions = {};         // host -> [selector]
const genericExcluded = new Set();
const scriptletFilters = [];   // { include, exclude, raw, group, list }
const scriptletExceptions = {}; // host -> [raw | '']

const push = (map, key, val) => { (map[key] ||= []).push(val); };

for (const { c, group, list } of cosmetic) {
  const body = parseCosmeticBody(c.sep, c.body);
  if (!body) { stat('cosmetic.unsupported'); continue; }
  const { include, exclude, dropped } = parseCosmeticDomains(c.domains);
  if (dropped && !include.length) { stat('cosmetic.unsupportedDomains'); continue; }
  const g = groupIndex[group];

  if (body.type === 'scriptlet') {
    if (c.exception) {
      const inner = body.raw.slice(4, -1).trim();
      for (const h of include.length ? include : ['*']) push(scriptletExceptions, h, inner);
      continue;
    }
    scriptletFilters.push({ include, exclude, raw: body.raw, domains: c.domains, group, list });
    continue;
  }

  const sel = body.selector;
  if (c.exception) {
    if (!include.length) { genericExcluded.add(sel); continue; }
    for (const h of include) push(exceptions, h, sel);
    continue;
  }

  const entry = body.type === 'style' ? [1, sel, g, body.style] : body.type === 'procedural' ? [2, sel, g] : [0, sel, g];
  if (!include.length) {
    for (const h of exclude) push(exceptions, h, sel);
    if (body.type !== 'css') { stat('cosmetic.genericNonCss'); continue; } // procedural generic: prea scump
    const key = genericKey(sel);
    if (key) push(lowGeneric, key, entry); else highGeneric.push(entry);
    stat('cosmetic.generic');
  } else {
    for (const h of include) push(specific, h, entry);
    for (const h of exclude) push(exceptions, h, sel);
    stat('cosmetic.specific');
  }
}

// Generic exceptions without a domain drop the selector entirely.
const dropGeneric = (e) => !genericExcluded.has(e[1]);
const lowGenericClean = {};
for (const [k, list] of Object.entries(lowGeneric)) {
  const l = list.filter(dropGeneric);
  if (l.length) lowGenericClean[k] = dedupeEntries(l);
}
function dedupeEntries(list) {
  const seen = new Set();
  return list.filter((e) => { const k = e[1] + '\u0000' + (e[3] || ''); if (seen.has(k)) return false; seen.add(k); return true; });
}
for (const h of Object.keys(specific)) specific[h] = dedupeEntries(specific[h]);

const cosmeticDb = {
  groups: GROUPS.map((g) => g.id),
  highGeneric: dedupeEntries(highGeneric.filter(dropGeneric)),
  lowGeneric: lowGenericClean,
  specific,
  exceptions,
  elemhide: [...cosmeticExceptionHosts.elemhide],
  generichide: [...cosmeticExceptionHosts.generichide],
  specifichide: [...cosmeticExceptionHosts.specifichide],
};
// On disk: a small core (loaded when the service worker starts), site-specific
// cosmetics split into shards by hostname, and the generic table on its own.
// Entries are "group\ttype\tselector[\tstyle]" lines so JSON.parse stays fast.
const encode = (list) => list.map((e) => [e[2], e[0], e[1].replace(/[\t\n]/g, ' '), ...(e[3] !== undefined ? [e[3].replace(/[\t\n]/g, ' ')] : [])].join('\t')).join('\n');
const SPECIFIC_SHARDS = 32;
const specificShards = Array.from({ length: SPECIFIC_SHARDS }, () => ({}));
for (const [h, list] of Object.entries(specific)) specificShards[hostHash(h) % SPECIFIC_SHARDS][h] = encode(list);
for (let i = 0; i < SPECIFIC_SHARDS; i++) {
  await writeFile(new URL(`data/cosmetic-specific-${i}.json`, DIST), JSON.stringify(specificShards[i]));
}
await writeFile(new URL('data/cosmetic-generic.json', DIST), JSON.stringify(
  Object.fromEntries(Object.entries(lowGenericClean).map(([k, v]) => [k, encode(v)])),
));
await writeFile(new URL('data/cosmetic-core.json', DIST), JSON.stringify({
  groups: cosmeticDb.groups,
  shards: SPECIFIC_SHARDS,
  highGeneric: encode(cosmeticDb.highGeneric),
  exceptions: Object.fromEntries(Object.entries(exceptions).map(([h, l]) => [h, [...new Set(l)].join('\n')])),
  elemhide: cosmeticDb.elemhide,
  generichide: cosmeticDb.generichide,
  specifichide: cosmeticDb.specifichide,
}));
await writeFile(new URL('data/redirects.json', DIST), JSON.stringify(redirects));

// ------------------------------------------------------------ scriptlets
//
// uBO's scriptlets, registered as content scripts at document_start in the
// world each one needs (MAIN / ISOLATED).

const { scriptlets: uboScriptlets, aliases: uboAliases } = await loadScriptlets();
for (const [name, d] of warMap) {
  if (!name.endsWith('.js') || d.data !== 'text') continue;
  const f = new URL(d.file, WAR_DIR);
  if (!existsSync(f)) continue;
  const s = scriptletFromWar(name, await readFile(f, 'utf8'), d);
  uboScriptlets.set(name, s);
  for (const a of d.aliases) uboAliases.set(a, name);
}

function resolveScriptlet(token) {
  let name = token.endsWith('.js') ? token : `${token}.js`;
  if (uboAliases.has(name)) name = uboAliases.get(name);
  return uboScriptlets.get(name);
}

// Each registration (group × world × scope) is a self-contained file: only the
// functions it needs plus the host -> calls table. "wide" = entity (google.*)
// or generic filters: they run on every URL, so they must stay small; the rest
// only run on their own hosts.

function closureOf(names) {
  const fns = new Map();
  const stack = names.map((n) => uboScriptlets.get(n));
  while (stack.length) {
    const cur = stack.pop();
    if (fns.has(cur.fnName)) continue;
    fns.set(cur.fnName, cur.code);
    for (const dep of cur.deps) {
      const d = uboScriptlets.get(dep);
      if (d) stack.push(d);
    }
  }
  return [...fns.values()];
}

const scriptletExceptionAll = [...Object.entries(scriptletExceptions)].filter(([, l]) => l.includes('')).map(([h]) => h);
const tables = {};
const missingScriptlets = new Map();
const VALID_HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?:\.\*)?$/;

function tableFor(group, world, scope) {
  const key = `${group}-${world.toLowerCase()}-${scope}`;
  return (tables[key] ||= { key, group, world, scope, names: [], nameIdx: new Map(), arglists: [], argIdx: new Map(), hosts: {}, excl: {} });
}
function callIndex(t, def, args) {
  if (!t.nameIdx.has(def.name)) { t.nameIdx.set(def.name, t.names.length); t.names.push(def.name); }
  const call = [t.nameIdx.get(def.name), ...args];
  const ck = JSON.stringify(call);
  if (!t.argIdx.has(ck)) { t.argIdx.set(ck, t.arglists.length); t.arglists.push(call); }
  return t.argIdx.get(ck);
}

for (const s of scriptletFilters) {
  const inner = s.raw.slice(4, -1).trim();
  const args = parseScriptletArgs(inner);
  if (!args.length || !args[0]) { stat('scriptlet.unparsed'); continue; }
  const def = resolveScriptlet(args[0]);
  if (!def) { missingScriptlets.set(args[0], (missingScriptlets.get(args[0]) || 0) + 1); continue; }
  if (def.requiresTrust && !TRUSTED_LISTS.has(s.list)) { stat('scriptlet.untrusted'); continue; }

  const include = (s.include.length ? s.include : ['*']).filter((h) => h === '*' || VALID_HOST.test(h));
  for (const h of include) {
    // #@#+js(...) exceptions with the same text on the same host cancel the filter
    if (scriptletExceptions[h]?.includes(inner)) continue;
    const scope = h === '*' || h.endsWith('.*') ? 'wide' : 'hosts';
    const t = tableFor(s.group, def.world, scope);
    const ai = callIndex(t, def, args.slice(1));
    (t.hosts[h] ||= []).push(ai);
    for (const x of s.exclude) (t.excl[x] ||= []).push(ai);
  }
  stat('scriptlet.ok');
}
// #@#+js(name, args) exceptions applied to subdomains
for (const t of Object.values(tables)) {
  for (const [h, list] of Object.entries(scriptletExceptions)) {
    for (const inner of list) {
      if (!inner) continue;
      const args = parseScriptletArgs(inner);
      const def = resolveScriptlet(args[0]);
      if (!def || !t.nameIdx.has(def.name)) continue;
      const ck = JSON.stringify([t.nameIdx.get(def.name), ...args.slice(1)]);
      if (t.argIdx.has(ck)) (t.excl[h] ||= []).push(t.argIdx.get(ck));
    }
  }
}

const scriptletIndex = [];
const usedNames = new Set();

// "hosts" tables are split into shards by hostname so a page loads only its own
// shard (Chrome injects only the files whose matches apply).
const SHARD_BYTES = 48 * 1024;
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function emitShards(t) {
  const hosts = Object.keys(t.hosts);
  if (!hosts.length) return [];
  const size = JSON.stringify(t.hosts).length + JSON.stringify(t.arglists).length;
  const n = t.scope === 'wide' ? 1 : Math.max(1, Math.ceil(size / SHARD_BYTES));
  const shards = Array.from({ length: n }, () => []);
  for (const h of hosts) shards[hash(h) % n].push(h);
  return shards.filter((s) => s.length).map((shardHosts, i) => {
    // re-index the calls and functions this shard uses
    const used = [...new Set(shardHosts.flatMap((h) => t.hosts[h]))].sort((a, b) => a - b);
    const remap = new Map(used.map((old, k) => [old, k]));
    const names = [...new Set(used.map((a) => t.arglists[a][0]))];
    const nameRemap = new Map(names.map((old, k) => [old, k]));
    const arglists = used.map((a) => [nameRemap.get(t.arglists[a][0]), ...t.arglists[a].slice(1)]);
    const table = Object.fromEntries(shardHosts.map((h) => [h, [...new Set(t.hosts[h])].map((a) => remap.get(a))]));
    const excl = {};
    for (const [h, list] of Object.entries(t.excl)) {
      const l = [...new Set(list)].filter((a) => remap.has(a)).map((a) => remap.get(a));
      if (l.length) excl[h] = l;
    }
    return { id: n > 1 ? `${t.key}-${i + 1}` : t.key, hosts: shardHosts, names: names.map((k) => t.names[k]), arglists, table, excl };
  });
}

for (const t of Object.values(tables)) {
  for (const shard of emitShards(t)) {
    shard.names.forEach((n) => usedNames.add(n));
    const fnNames = shard.names.map((n) => uboScriptlets.get(n).fnName);
    const file = `scriptlets/${shard.id}.js`;
    await writeFile(new URL(file, DIST), `(function () {
'use strict';
let host = location.hostname;
if (!host) { try { host = window.top.location.hostname; } catch { return; } }
const hosts = ${JSON.stringify(shard.table)};
const excl = ${JSON.stringify(shard.excl)};
const off = new Set(${JSON.stringify(scriptletExceptionAll)});
const labels = host.split('.');
const keys = ['*'];
for (let i = 0; i < labels.length; i++) {
  const parts = labels.slice(i);
  keys.push(parts.join('.'));
  for (let j = parts.length - 1; j > 0; j--) keys.push(parts.slice(0, j).join('.') + '.*');
}
const todo = new Set();
const skip = new Set();
for (const k of keys) {
  if (off.has(k)) return;
  for (const r of hosts[k] || []) todo.add(r);
  for (const r of excl[k] || []) skip.add(r);
}
for (const r of skip) todo.delete(r);
if (!todo.size) return;
const scriptletGlobals = {};
${closureOf(shard.names).join('\n\n')}
const fns = [${fnNames.join(', ')}];
const arglists = ${JSON.stringify(shard.arglists)};
for (const r of todo) {
  const [fn, ...args] = arglists[r];
  try { fns[fn](...args); } catch { }
}
})();
`);
    const matches = t.scope === 'wide'
      ? ['<all_urls>']
      : shard.hosts.map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `*://${h}/*` : `*://*.${h}/*`));
    scriptletIndex.push({ id: shard.id, group: t.group, world: t.world, js: [file], matches });
  }
}
await writeFile(new URL('data/scriptlets.json', DIST), JSON.stringify(scriptletIndex));
const wrappers = usedNames;

// ------------------------------------------------------------ manifest + src

await cp(new URL('src/', ROOT), DIST, { recursive: true });
// Version from the build date, so every automated build can be uploaded to the
// Chrome Web Store (it requires a higher version each time): 1.YYYY.MMDD.HHMM
const now = new Date();
const version = [pkg.version.split('.')[0], now.getUTCFullYear(), (now.getUTCMonth() + 1) * 100 + now.getUTCDate(),
  now.getUTCHours() * 100 + now.getUTCMinutes()].join('.');
for (const f of ['LICENSE', 'NOTICES.md', 'PRIVACY.md']) {
  if (existsSync(new URL(f, ROOT))) await cp(new URL(f, ROOT), new URL(f, DIST));
}
const manifest = {
  manifest_version: 3,
  name: 'Hush',
  version,
  version_name: `${pkg.version} (${now.toISOString().slice(0, 10)})`,
  homepage_url: pkg.homepage,
  description: 'Blocks ads, trackers, cookie banners and dangerous sites. Free, open source, collects nothing.',
  minimum_chrome_version: '122',
  icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: { default_popup: 'popup/popup.html', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
  options_page: 'dashboard/dashboard.html',
  background: { service_worker: 'background.js', type: 'module' },
  // no 'tabs' or 'declarativeNetRequestFeedback': they add the "read your browsing
  // history" warning. Tab URLs come from host_permissions; webRequest is only
  // observed, to count what the DNR rules blocked.
  permissions: ['declarativeNetRequest', 'scripting', 'storage', 'contextMenus', 'webRequest'],
  host_permissions: ['<all_urls>'],
  declarative_net_request: { rule_resources: rulesetMeta },
  content_scripts: [{
    matches: ['<all_urls>'],
    js: ['content/cosmetic.js'],
    run_at: 'document_start',
    all_frames: true,
    match_about_blank: true,
    match_origin_as_fallback: true,
  }],
  web_accessible_resources: [{ resources: ['redirects/*'], matches: ['<all_urls>'] }],
};
await writeFile(new URL('manifest.json', DIST), JSON.stringify(manifest, null, 2));
await writeFile(new URL('data/groups.json', DIST), JSON.stringify(GROUPS));
await writeFile(new URL('data/categories.json', DIST), JSON.stringify({
  trackers: [...(categoryDomains.privacy || [])],
  threats: [...(categoryDomains.badware || [])],
}));
const listMeta = existsSync(new URL('lists/meta.json', ROOT)) ? JSON.parse(await readFile(new URL('lists/meta.json', ROOT), 'utf8')) : {};
const fetched = Object.values(listMeta).map((m) => m.fetched).sort()[0] || new Date().toISOString();
await writeFile(new URL('data/build.json', DIST), JSON.stringify({ built: fetched, rules: ruleCounts }));

// ------------------------------------------------------------ raport

const size = (o) => (JSON.stringify(o).length / 1024 / 1024).toFixed(2) + ' MB';
console.log(`  cosmetic: ${stats['cosmetic.specific'] || 0} specific, ${stats['cosmetic.generic'] || 0} generic ` +
  `(${cosmeticDb.highGeneric.length} high-generic, ${Object.keys(lowGenericClean).length} chei low-generic), ${size(cosmeticDb)}`);
console.log(`  scriptlets: ${stats['scriptlet.ok'] || 0} filters in ${scriptletIndex.length} registrations, ${wrappers.size} kinds`);
console.log(`  regex: ${regexTotal}`);
console.log('  skipped:', JSON.stringify(Object.fromEntries(Object.entries(stats).filter(([k]) => !/\.ok$|\.specific$|\.generic$/.test(k)))));
if (unknownOptions.size) console.log('  unknown options:', [...unknownOptions].join(', '));
if (missingRedirects.size) console.log('  missing redirects:', [...missingRedirects].map(([k, v]) => `${k}×${v}`).join(', '));
if (missingScriptlets.size) console.log('  missing scriptlets:', [...missingScriptlets].map(([k, v]) => `${k}×${v}`).join(', '));
