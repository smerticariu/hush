// Functional tests on a local page: generic / specific / procedural cosmetics,
// user filters, network blocking, per-site disable, the picker.
// Run: node tools/test-functional.mjs

import http from 'node:http';
import { launch } from './browser.mjs';

const PAGE = `<!doctype html><html><head><title>Hush test</title></head><body>
  <h1 id="title">Test page</h1>
  <div class="adsbygoogle" id="g1" style="height:90px">generic ad</div>
  <div class="banner-ad" id="g2" style="height:90px">another banner</div>
  <div data-ad-cls="x" id="hg" style="height:90px">high-generic</div>
  <div class="card" id="p1"><span>Sponsored</span> paid content</div>
  <div class="card" id="p2"><span>News</span> regular content</div>
  <div class="wrap" id="u2"><div><b class="marker">upward target</b></div></div>
  <div class="del" id="r1">to remove</div>
  <div class="user-hide" id="uh">hidden by my filter</div>
  <div class="later-slot" id="later"></div>
  <p id="normal">regular text that must stay</p>
  <script src="/tracker.js"></script>
  <script>
    setTimeout(() => {
      const d = document.createElement('div');
      d.className = 'adsbygoogle'; d.id = 'dyn'; d.style.height = '50px'; d.textContent = 'added dynamically';
      document.body.append(d);
    }, 300);
  </script>
</body></html>`;

let trackerHits = 0;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/tracker.js')) { trackerHits++; res.end('window.trackerLoaded = true;'); return; }
  if (req.url.startsWith('/picker')) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<body style="margin:0"><div id="box" style="width:300px;height:200px;background:#c00">ad to pick</div><p id="keep">stays</p></body>'); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const URL_ = `http://localhost:${port}/`;

const { context, sw } = await launch({});
await new Promise((r) => setTimeout(r, 4000));

const USER_FILTERS = [
  'localhost##div.card:has-text(Sponsored)',
  'localhost##.marker:upward(2)',
  'localhost##.del:remove()',
  'localhost##.user-hide',
  '||localhost^*/tracker.js',
].join('\n');
await sw.evaluate((f) => self.hush.saveSettings({ userFilters: f }), USER_FILTERS);
await new Promise((r) => setTimeout(r, 1500));

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
};

async function state(page) {
  return page.evaluate(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      if (!el) return 'removed';
      return getComputedStyle(el).display === 'none' ? 'hidden' : 'visible';
    };
    return {
      g1: vis('g1'), g2: vis('g2'), hg: vis('hg'), p1: vis('p1'), p2: vis('p2'), u2: vis('u2'),
      r1: vis('r1'), uh: vis('uh'), dyn: vis('dyn'), normal: vis('normal'), title: vis('title'),
      tracker: !!window.trackerLoaded,
    };
  });
}

const page = await context.newPage();
await page.goto(URL_);
await page.waitForTimeout(1500);
let s = await state(page);
check('generic cosmetic (.adsbygoogle)', s.g1 === 'hidden');
check('generic cosmetic (.banner-ad)', s.g2 === 'hidden');
check('high-generic ([data-ad-cls])', s.hg === 'hidden');
check('dynamically added element', s.dyn === 'hidden', s.dyn);
check(':has-text hides only the sponsored card', s.p1 === 'hidden' && s.p2 === 'visible', `${s.p1}/${s.p2}`);
check(':upward(2)', s.u2 === 'hidden', s.u2);
check(':remove()', s.r1 === 'removed', s.r1);
check('user cosmetic filter', s.uh === 'hidden');
check('user network filter', !s.tracker, `requests that reached the server: ${trackerHits}`);
check('regular content stays', s.normal === 'visible' && s.title === 'visible');

// ---- stats: the blocked tracker.js shows up in totals, per page and per site
await page.waitForTimeout(2500); // stats are flushed in batches
const st = await sw.evaluate(async (u) => {
  return { all: await self.hush.stats.get() };
});
check('stats count blocked requests', st.all.total.ads + st.all.total.trackers >= 1, JSON.stringify(st.all.total));
check('stats rank the site', (st.all.sites.localhost || 0) >= 1, JSON.stringify(st.all.sites));
check('stats rank the blocked domain', (st.all.domains.localhost || 0) >= 1);

// ---- disabled on site
await sw.evaluate(() => self.hush.saveSettings({ disabledSites: ['localhost'] }));
await new Promise((r) => setTimeout(r, 1500));
await page.reload();
await page.waitForTimeout(1500);
s = await state(page);
check('disabled on site: nothing hidden', s.g1 === 'visible' && s.p1 === 'visible' && s.uh === 'visible', JSON.stringify({ g1: s.g1, p1: s.p1, uh: s.uh }));
check('disabled on site: the tracker loads', s.tracker);
const icon = await sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts())[0]?.excludeMatches?.length || 0);
check('disabled on site: scriptlets have excludeMatches', icon > 0);
await sw.evaluate(() => self.hush.saveSettings({ disabledSites: [] }));
await new Promise((r) => setTimeout(r, 1500));
await page.reload();
await page.waitForTimeout(1500);
s = await state(page);
check('re-enabled on site', s.g1 === 'hidden' && !s.tracker);

// ---- picker
const p2 = await context.newPage();
await p2.goto(`${URL_}picker`);
await p2.waitForTimeout(500);
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, `${URL_}picker`);
await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/picker.js'] }), tabId);
await p2.waitForTimeout(500);
await p2.mouse.move(100, 100);
await p2.mouse.click(100, 100);
await p2.waitForTimeout(300);
// the "Hide" button is in a closed shadow root: it can't be reached by keyboard, so click by coordinates
const okBox = await p2.evaluate(() => {
  const host = document.querySelector('hush-picker');
  return host ? true : false;
});
check('the picker appears', okBox);
// the panel sits in the bottom-right corner (360px wide); "Hide" is the last button
const vp = p2.viewportSize();
await p2.mouse.click(vp.width - 16 - 14 - 40, vp.height - 16 - 14 - 15);
await p2.waitForTimeout(800);
const saved = await sw.evaluate(async () => (await self.hush.loadSettings()).userFilters);
check('the picker saves the filter', /localhost##.*#box/.test(saved), saved.split('\n').filter((l) => l.includes('box')).join(' '));
await p2.reload();
await p2.waitForTimeout(1200);
const boxState = await p2.evaluate(() => ({ box: getComputedStyle(document.getElementById('box')).display, keep: getComputedStyle(document.getElementById('keep')).display }));
check('the picked element stays hidden after reload', boxState.box === 'none' && boxState.keep !== 'none', JSON.stringify(boxState));

// ---- sync: large filters split into chunks, read back identically
const big = Array.from({ length: 400 }, (_, i) => `example-${i}.com##.ad-é-${i}`).join('\n');
const sync = await sw.evaluate(async (text) => {
  await self.hush.saveSettings({ userFilters: text, disabledSites: ['a.ro'] });
  const raw = await chrome.storage.sync.get(null);
  const back = await self.hush.loadSettings();
  // what's left after the list shrinks
  await self.hush.saveSettings({ userFilters: 'small.com##.x' });
  const after = await chrome.storage.sync.get(null);
  return {
    chunks: raw.ufCount, same: back.userFilters === text, sites: back.disabledSites.join(),
    staleLeft: Object.keys(after).filter((k) => /^uf\d+$/.test(k)).length, small: (await self.hush.loadSettings()).userFilters,
  };
}, big);
check('large filters are split into chunks in sync', sync.chunks > 1, `${sync.chunks} chunks`);
check('filters read back identically', sync.same && sync.sites === 'a.ro');
check('stale chunks are removed', sync.staleLeft === 1 && sync.small === 'small.com##.x', `${sync.staleLeft} left`);

// ---- migration from storage.local (old version)
const mig = await sw.evaluate(async () => {
  await chrome.storage.sync.clear();
  await chrome.storage.local.clear();
  await chrome.storage.local.set({ disabledSites: ['old.com'], userFilters: 'old.com##.ad' });
  await self.hush.migrateFromLocal();
  return { s: await self.hush.loadSettings(), local: await chrome.storage.local.get(null) };
});
check('old settings move to sync', mig.s.disabledSites.join() === 'old.com' && mig.s.userFilters === 'old.com##.ad' && !mig.local.disabledSites);

await context.close();
server.close();
console.log(failures ? `\n${failures} tests failed` : '\nall tests passed');
process.exit(failures ? 1 : 0);
