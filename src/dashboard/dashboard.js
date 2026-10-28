import { loadGroups, loadSettings as settings, saveSettings, onSettingsChanged } from '../shared/settings.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const SVG = 'http://www.w3.org/2000/svg';

const [groups, build] = await Promise.all([
  loadGroups(),
  fetch('/data/build.json').then((r) => r.json()).catch(() => null),
]);

// ---------------------------------------------------------------- tabs

const TABS = ['overview', 'protection', 'paused', 'filters', 'about'];
function showTab() {
  const id = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  for (const t of TABS) $(t).hidden = t !== id;
  for (const a of document.querySelectorAll('.side a')) a.classList.toggle('active', a.dataset.tab === id);
}
addEventListener('hashchange', showTab);
showTab();

if (new URLSearchParams(location.search).has('welcome')) $('welcome').hidden = false;
$('welcomeClose').addEventListener('click', () => { $('welcome').hidden = true; history.replaceState(null, '', location.pathname + location.hash); });

// ---------------------------------------------------------------- overview

function duration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}
function bytes(b) {
  if (b < 1024 ** 2) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(b < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(b / 1024 ** 3).toFixed(1)} GB`;
}
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastDays(days, n = 30) {
  const out = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    const k = dayKey(d);
    const v = days[k] || {};
    out.push({ date: new Date(d), ads: (v.ads || 0) + (v.threats || 0), trackers: v.trackers || 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

const shortDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}

// Stacked bars: ads at the baseline, trackers on top, 2px gap between segments.
function drawChart(data) {
  const box = $('chart');
  box.replaceChildren();
  const W = box.clientWidth || 800;
  const H = box.clientHeight || 220;
  const pad = { l: 40, r: 6, t: 8, b: 24 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` }, box);
  const max = niceMax(Math.max(...data.map((d) => d.ads + d.trackers)));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);

  for (const v of [0, max / 2, max]) {
    el('line', { class: 'gridline', x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }, svg);
    el('text', { class: 'axis', x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = fmt(v);
  }
  if (data.every((d) => d.ads + d.trackers === 0)) {
    el('text', { class: 'empty-msg', x: (W + pad.l) / 2, y: H / 2, 'text-anchor': 'middle' }, svg)
      .textContent = 'Browse a little and your daily numbers will show up here.';
    return;
  }

  const step = (W - pad.l - pad.r) / data.length;
  const bw = Math.max(4, Math.min(22, step * 0.62));
  const r = Math.min(4, bw / 2);
  data.forEach((d, i) => {
    const cx = pad.l + step * i + step / 2;
    const g = el('g', {}, svg);
    const base = y(0);
    const adsTop = y(d.ads);
    const total = y(d.ads + d.trackers);
    // only the top segment gets rounded data-ends
    if (d.ads) {
      const h = base - adsTop;
      const top = d.trackers ? 0 : r;
      el('path', { class: 'seg-ads', d: barPath(cx - bw / 2, adsTop, bw, h, top) }, g);
    }
    if (d.trackers) {
      const gap = d.ads ? 2 : 0;
      const h = Math.max(0, adsTop - total - gap);
      el('path', { class: 'seg-trackers', d: barPath(cx - bw / 2, total, bw, h, r) }, g);
    }
    if (i % 5 === 4 || i === data.length - 1) {
      el('text', { class: 'axis', x: cx, y: H - 6, 'text-anchor': 'middle' }, svg).textContent = shortDate(d.date);
    }
    // hit target is the whole column, wider than the bar
    const hit = el('rect', { class: 'hit', x: pad.l + step * i, y: pad.t, width: step, height: H - pad.t - pad.b }, svg);
    hit.addEventListener('mouseenter', () => showTip(d, cx, total, g));
    hit.addEventListener('mouseleave', hideTip);
  });
}

function barPath(x, yTop, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, h, w / 2);
  return `M${x},${yTop + h}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yTop + h}Z`;
}

let hovered = null;
function showTip(d, x, yTop, g) {
  hovered?.classList.remove('hover');
  hovered = g;
  g.classList.add('hover');
  const tip = $('tip');
  const chart = $('chart');
  tip.innerHTML = `<b>${d.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</b><br>
    <i style="background:var(--ads)"></i>Ads ${fmt(d.ads)}<br>
    <i style="background:var(--trackers)"></i>Trackers ${fmt(d.trackers)}`;
  tip.hidden = false;
  tip.style.left = `${chart.offsetLeft + x}px`;
  tip.style.top = `${chart.offsetTop + Math.max(yTop, 30)}px`;
}
function hideTip() {
  hovered?.classList.remove('hover');
  hovered = null;
  $('tip').hidden = true;
}

function drawTable(data) {
  const rows = [...data].reverse().map((d) => `<tr><td>${d.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</td><td>${fmt(d.ads)}</td><td>${fmt(d.trackers)}</td><td>${fmt(d.ads + d.trackers)}</td></tr>`);
  $('chartTable').innerHTML = `<table><thead><tr><th>Day</th><th>Ads</th><th>Trackers</th><th>Total</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

$('tableToggle').addEventListener('click', () => {
  const on = $('chartTable').hidden;
  $('chartTable').hidden = !on;
  $('chart').hidden = on;
  $('tableToggle').textContent = on ? 'Show as chart' : 'Show as table';
  $('tableToggle').setAttribute('aria-pressed', String(on));
});

function rank(list, entries, emptyText) {
  list.replaceChildren();
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    list.append(li);
    return;
  }
  const max = entries[0][1];
  for (const [name, n] of entries) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.className = 'name';
    a.textContent = name;
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = fmt(n);
    const bar = document.createElement('span');
    bar.className = 'meter';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(2, (n / max) * 100)}%`;
    bar.append(fill);
    li.append(a, c, bar);
    list.append(li);
  }
}

let chartData = [];
async function renderStats() {
  const s = await chrome.runtime.sendMessage({ type: 'stats:get' });
  if (!s) return;
  const blocked = s.total.ads + s.total.trackers + s.total.threats;
  $('totalNum').textContent = fmt(blocked);
  $('adsNum').textContent = fmt(s.total.ads);
  $('trackersNum').textContent = fmt(s.total.trackers);
  $('threatsNum').textContent = fmt(s.total.threats);
  $('cleanedNum').textContent = fmt(s.total.cleaned || 0);
  $('timeSaved').textContent = duration(blocked * s.avgMs);
  $('dataSaved').textContent = bytes(blocked * s.avgBytes);
  $('since').textContent = `Protecting you since ${new Date(s.since).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
  chartData = lastDays(s.days);
  drawChart(chartData);
  drawTable(chartData);
  const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8);
  rank($('topSites'), top(s.sites), 'No sites yet.');
  rank($('topDomains'), top(s.domains), 'Nothing blocked yet.');
}

let resetArmed = false;
$('reset').addEventListener('click', async () => {
  // two-step confirm instead of a browser dialog
  if (!resetArmed) {
    resetArmed = true;
    $('reset').textContent = 'Click again to reset';
    setTimeout(() => { resetArmed = false; $('reset').textContent = 'Reset stats'; }, 4000);
    return;
  }
  resetArmed = false;
  $('reset').textContent = 'Reset stats';
  await chrome.runtime.sendMessage({ type: 'stats:reset' });
  renderStats();
});

addEventListener('resize', () => drawChart(chartData));
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.stats) renderStats(); });

// ---------------------------------------------------------------- protection

function renderGroups(s) {
  const box = $('groups');
  box.replaceChildren();
  for (const g of groups) {
    const row = document.createElement('label');
    row.className = 'group';
    const rules = build?.rules?.[g.id];
    row.innerHTML = `<span class="text"><span class="name"></span><br><span class="meta"></span><br><span class="rules"></span></span>
      <span class="switch"><input type="checkbox"><span class="track"></span></span>`;
    row.querySelector('.name').textContent = g.name;
    row.querySelector('.meta').textContent = g.description || '';
    row.querySelector('.rules').textContent = rules ? `${fmt(rules)} network rules` : '';
    const input = row.querySelector('input');
    input.checked = g.locked || s.enabledGroups.includes(g.id);
    input.disabled = !!g.locked;
    input.addEventListener('change', async () => {
      const cur = await settings();
      const set = new Set(cur.enabledGroups);
      if (input.checked) set.add(g.id); else set.delete(g.id);
      await saveSettings({ enabledGroups: groups.map((x) => x.id).filter((id) => set.has(id)) });
    });
    box.append(row);
  }
}

// ---------------------------------------------------------------- paused sites

function renderSites(s) {
  const list = $('sites');
  list.replaceChildren();
  for (const site of s.disabledSites) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = site;
    const btn = document.createElement('button');
    btn.className = 'small';
    btn.textContent = 'Resume';
    btn.addEventListener('click', async () => {
      const cur = await settings();
      await saveSettings({ disabledSites: cur.disabledSites.filter((x) => x !== site) });
    });
    li.append(name, btn);
    list.append(li);
  }
  $('sitesEmpty').hidden = s.disabledSites.length > 0;
}

$('addSite').addEventListener('submit', async (e) => {
  e.preventDefault();
  let v = $('siteInput').value.trim().toLowerCase();
  try { v = new URL(v.includes('://') ? v : `https://${v}`).hostname; } catch { return; }
  v = v.replace(/^www\./, '');
  if (!v.includes('.')) return;
  const cur = await settings();
  if (!cur.disabledSites.includes(v)) await saveSettings({ disabledSites: [...cur.disabledSites, v].sort() });
  $('siteInput').value = '';
});

// ---------------------------------------------------------------- filters

$('save').addEventListener('click', async () => {
  const text = $('filtersText').value;
  const check = await chrome.runtime.sendMessage({ type: 'filters:check', text });
  const { filtersLocal } = await saveSettings({ userFilters: text });
  const status = $('filtersStatus');
  const where = filtersLocal ? ' Too many to sync, so they stay on this computer only.' : '';
  if (check?.errors.length) {
    status.className = 'status err';
    status.textContent = `Saved. ${check.errors.length} network filter(s) can't be used: ${check.errors.slice(0, 3).join(', ')}.${where}`;
  } else {
    status.className = filtersLocal ? 'status err' : 'status ok';
    status.textContent = `Saved. Applies to pages you load from now on.${where}`;
  }
});

// ---------------------------------------------------------------- about

const manifest = chrome.runtime.getManifest();
if (build) {
  const date = new Date(build.built).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  $('build').textContent = `Version ${manifest.version_name || manifest.version} · filter lists from ${date}`;
}
if (manifest.homepage_url) {
  const a = document.createElement('a');
  a.href = manifest.homepage_url;
  a.target = '_blank';
  a.textContent = 'Source code';
  $('sourceLink').replaceWith(a);
}

// ---------------------------------------------------------------- wiring

async function renderSettings(full = true) {
  const s = await settings();
  renderGroups(s);
  renderSites(s);
  if (full) $('filtersText').value = s.userFilters;
}

onSettingsChanged(async (changed) => {
  if (changed.has('enabledGroups') || changed.has('disabledSites')) renderSettings(false);
  // don't overwrite text the user is editing
  if (changed.has('userFilters') && document.activeElement !== $('filtersText')) $('filtersText').value = (await settings()).userFilters;
});

renderStats();
renderSettings();
