// Blocking statistics, kept on this device only (chrome.storage.local).
// The service worker observes blocked requests through webRequest (read-only:
// the blocking itself stays in declarativeNetRequest) and feeds them here.

const KEY = 'stats';
const DAYS_KEPT = 90;
const MAX_SITES = 300;
const MAX_DOMAINS = 500;

// Rough per-request averages used for the "saved" estimates on the dashboard.
export const AVG_BYTES = 25 * 1024;
export const AVG_MS = 40;

const empty = () => ({
  since: Date.now(),
  total: { ads: 0, trackers: 0, threats: 0, cleaned: 0 },
  days: {},     // 'YYYY-MM-DD' -> { ads, trackers, threats, cleaned }
  sites: {},    // site -> blocked count
  domains: {},  // blocked domain -> count
});

let state = null;
let loading = null;
let dirty = false;
let timer = 0;

export function load() {
  loading ??= chrome.storage.local.get(KEY).then((r) => { state = r[KEY] || empty(); return state; });
  return loading;
}

export function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Keep only the biggest entries so storage doesn't grow forever.
function trim(map, max) {
  const keys = Object.keys(map);
  if (keys.length <= max * 1.2) return map;
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, max));
}

function flush() {
  timer = 0;
  if (!dirty || !state) return;
  dirty = false;
  const days = Object.keys(state.days).sort();
  for (const d of days.slice(0, Math.max(0, days.length - DAYS_KEPT))) delete state.days[d];
  state.sites = trim(state.sites, MAX_SITES);
  state.domains = trim(state.domains, MAX_DOMAINS);
  chrome.storage.local.set({ [KEY]: state });
}

/** kind: 'ads' | 'trackers' | 'threats' | 'cleaned' */
export async function record(kind, site, domain) {
  await load();
  state.total[kind] = (state.total[kind] || 0) + 1;
  const day = (state.days[todayKey()] ||= { ads: 0, trackers: 0, threats: 0, cleaned: 0 });
  day[kind] = (day[kind] || 0) + 1;
  if (kind !== 'cleaned') {
    if (site) state.sites[site] = (state.sites[site] || 0) + 1;
    if (domain) state.domains[domain] = (state.domains[domain] || 0) + 1;
  }
  dirty = true;
  // batched: a busy page blocks dozens of requests in a second
  if (!timer) timer = setTimeout(flush, 2000);
}

export async function get() {
  await load();
  return state;
}

export async function reset() {
  state = empty();
  dirty = true;
  flush();
}
