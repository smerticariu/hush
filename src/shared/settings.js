// User settings, synced across computers through chrome.storage.sync.
// Custom filters can exceed the 8 KB per-item limit, so they are split into
// chunks (uf0, uf1, ...). If they don't fit in sync's ~100 KB either, they stay
// in chrome.storage.local (this computer only).

const CHUNK = 3000; // characters; non-ASCII text and JSON escaping can double the bytes
const FILTER_KEY = /^uf\d+$/;

let groupsPromise;
export const loadGroups = () => (groupsPromise ??= fetch('/data/groups.json').then((r) => r.json()));

async function defaults() {
  const groups = await loadGroups();
  return { enabledGroups: groups.filter((g) => g.defaultOn).map((g) => g.id), disabledSites: [], userFilters: '' };
}

export async function loadSettings() {
  const [d, sync, local] = await Promise.all([defaults(), chrome.storage.sync.get(null), chrome.storage.local.get(['userFilters', 'filtersLocal'])]);
  let userFilters = d.userFilters;
  if (local.filtersLocal) userFilters = local.userFilters ?? '';
  else if (sync.ufCount !== undefined) {
    userFilters = Array.from({ length: sync.ufCount }, (_, i) => sync[`uf${i}`] ?? '').join('');
  }
  return {
    enabledGroups: sync.enabledGroups ?? d.enabledGroups,
    disabledSites: sync.disabledSites ?? d.disabledSites,
    userFilters,
    filtersLocal: !!local.filtersLocal,
  };
}

/** Saves only the given fields. Returns { filtersLocal } when the filters didn't fit in sync. */
export async function saveSettings(patch) {
  const out = {};
  const sync = {};
  if (patch.enabledGroups) sync.enabledGroups = patch.enabledGroups;
  if (patch.disabledSites) sync.disabledSites = patch.disabledSites;
  if (Object.keys(sync).length) await chrome.storage.sync.set(sync);

  if (patch.userFilters !== undefined) {
    const text = patch.userFilters;
    const chunks = {};
    for (let i = 0; i * CHUNK < text.length; i++) chunks[`uf${i}`] = text.slice(i * CHUNK, (i + 1) * CHUNK);
    const count = Object.keys(chunks).length;
    const stale = Object.keys(await chrome.storage.sync.get(null)).filter((k) => FILTER_KEY.test(k) && +k.slice(2) >= count);
    try {
      await chrome.storage.sync.set({ ...chunks, ufCount: count });
      if (stale.length) await chrome.storage.sync.remove(stale);
      await chrome.storage.local.remove(['userFilters', 'filtersLocal']);
      out.filtersLocal = false;
    } catch {
      // too big for sync: keep it local
      await chrome.storage.local.set({ userFilters: text, filtersLocal: true });
      out.filtersLocal = true;
    }
  }
  return out;
}

/** Moves the old settings from storage.local to sync, once. */
export async function migrateFromLocal() {
  const old = await chrome.storage.local.get(['enabledGroups', 'disabledSites', 'userFilters', 'migrated']);
  if (old.migrated) return;
  const sync = await chrome.storage.sync.get(['enabledGroups', 'disabledSites', 'ufCount']);
  const patch = {};
  // whatever is already in sync (from another computer) wins
  if (old.enabledGroups && !sync.enabledGroups) patch.enabledGroups = old.enabledGroups;
  if (old.disabledSites && !sync.disabledSites) patch.disabledSites = old.disabledSites;
  if (old.userFilters && sync.ufCount === undefined) patch.userFilters = old.userFilters;
  if (Object.keys(patch).length) await saveSettings(patch);
  await chrome.storage.local.remove(['enabledGroups', 'disabledSites']);
  if (!patch.userFilters) await chrome.storage.local.remove('userFilters');
  await chrome.storage.local.set({ migrated: true });
}

/** cb(Set of names: 'enabledGroups' | 'disabledSites' | 'userFilters') */
export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    const names = new Set();
    for (const key of Object.keys(changes)) {
      if (area === 'sync' && (key === 'enabledGroups' || key === 'disabledSites')) names.add(key);
      if ((area === 'sync' && (FILTER_KEY.test(key) || key === 'ufCount')) || (area === 'local' && key === 'userFilters')) names.add('userFilters');
    }
    if (names.size) cb(names);
  });
}
