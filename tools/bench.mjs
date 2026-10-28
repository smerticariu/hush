// Compares Chrome with no blocking, Chrome + Hush and Brave on the same pages.
// For each page: total requests, blocked, "leaked" requests to domains the
// other blocker stopped, visible ads.
// Run: node tools/bench.mjs [url ...]

import { launch, BRAVE } from './browser.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const URLS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://www.libertatea.ro/',
  'https://adevarul.ro/',
  'https://www.gsp.ro/',
  'https://www.cancan.ro/',
  'https://www.antena3.ro/',
  'https://www.realitatea.net/',
  'https://www.dailymail.co.uk/home/index.html',
  'https://www.speedtest.net/',
  'https://www.accuweather.com/',
  'https://www.forbes.com/',
];

const AD_SELECTORS = [
  'iframe[id^="google_ads_iframe"]', 'ins.adsbygoogle', '[id^="div-gpt-ad"]', 'iframe[src*="doubleclick"]',
  'iframe[src*="googlesyndication"]', '[id^="taboola"]', '.OUTBRAIN', '[data-ad-slot]', 'iframe[src*="adnxs"]',
  '[id*="gemius"]', '[class*="advert"]', '[id^="ad-"]', '[class^="ad-"]', '[class*=" ad-"]',
];

const siteOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const base = (h) => h.split('.').slice(-2).join('.');

// Accept the consent banner (otherwise sites don't load ads at all).
const CONSENT = /^(accept(ă|a|ati|ați)?( tot| toate)?|accept all|agree|i agree|sunt de acord|de acord|accept și închid|allow all|accept cookies|consimt|ok, am înțeles)$/i;
async function acceptConsent(page) {
  await page.waitForTimeout(1500);
  for (const frame of page.frames()) {
    try {
      const clicked = await frame.evaluate((src) => {
        const re = new RegExp(src.slice(1, src.lastIndexOf('/')), 'i');
        for (const b of document.querySelectorAll('button, a[role=button], [role=button], input[type=button], input[type=submit]')) {
          const t = (b.innerText || b.value || '').trim().replace(/\s+/g, ' ');
          if (re.test(t)) { b.click(); return true; }
        }
        return false;
      }, CONSENT.toString());
      if (clicked) { await page.waitForTimeout(1500); return true; }
    } catch { }
  }
  return false;
}

async function visit(context, url, shotDir) {
  const page = await context.newPage();
  const requests = [];
  const blocked = [];
  page.on('request', (r) => {
    // redirect to a silent extension resource = neutralized request
    if (r.url().startsWith('chrome-extension://') && r.redirectedFrom()) blocked.push(r.redirectedFrom().url());
    else requests.push(r.url());
  });
  page.on('requestfailed', (r) => { if (/BLOCKED_BY_CLIENT/.test(r.failure()?.errorText || '')) blocked.push(r.url()); });
  let error = null;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  } catch (e) { error = e.message.split('\n')[0]; }
  await acceptConsent(page);
  // scroll so lazy ads load too
  try {
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 1200); await page.waitForTimeout(700); }
    await page.waitForTimeout(3000);
  } catch { }
  let visibleAds = -1;
  try {
    visibleAds = await page.evaluate((sels) => {
      const seen = new Set();
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width > 30 && r.height > 30 && cs.display !== 'none' && cs.visibility !== 'hidden') seen.add(el);
        }
      }
      // excluding elements nested in others
      return [...seen].filter((el) => ![...seen].some((o) => o !== el && o.contains(el))).length;
    }, AD_SELECTORS);
  } catch { }
  if (shotDir) await page.screenshot({ path: `${shotDir}/${siteOf(url)}.jpg`, quality: 50 }).catch(() => {});
  await page.close();
  return { requests, blocked, visibleAds, error };
}

async function runBrowser(name, opts) {
  const shots = new URL(`../.bench/shots/${name}`, import.meta.url).pathname;
  await mkdir(shots, { recursive: true });
  const { context, sw } = await launch(opts);
  if (sw) await new Promise((r) => setTimeout(r, 4000)); // the install-time sync
  const out = {};
  for (const url of URLS) {
    out[url] = await visit(context, url, shots);
    const r = out[url];
    console.log(`  ${name.padEnd(6)} ${siteOf(url).padEnd(26)} requests ${String(r.requests.length).padStart(4)}  blocked ${String(r.blocked.length).padStart(4)}  visible ads ${r.visibleAds}${r.error ? '  ! ' + r.error : ''}`);
  }
  await context.close();
  return out;
}

const results = {};
results.chrome = await runBrowser('chrome', { extension: false });
results.hush = await runBrowser('hush', {});
const braveProfile = new URL('../.bench/brave-profile', import.meta.url).pathname;
if (!existsSync(braveProfile)) {
  // on first start Brave downloads its filter lists as components
  console.log('  (warming up the Brave profile, ~60s)');
  const { context } = await launch({ extension: false, executablePath: BRAVE, profile: braveProfile });
  const p = await context.newPage();
  await p.goto('https://example.com').catch(() => {});
  await p.goto('brave://components').catch(() => {});
  await p.waitForTimeout(90000);
  await context.close();
}
results.brave = await runBrowser('brave', { extension: false, executablePath: BRAVE, profile: braveProfile });

console.log('\nLeaks: third-party domains loaded by one blocker but stopped by the other');
// Brave doesn't report blocked requests, so "stopped" = domain requested in plain Chrome and absent here.
const summary = [];
const domains = (r, site) => new Set(r.requests.filter((u) => !r.blocked.includes(u)).map(siteOf).filter((h) => h && base(h) !== site));
for (const url of URLS) {
  const site = base(siteOf(url));
  const c = domains(results.chrome[url], site);
  const s = domains(results.hush[url], site);
  const b = domains(results.brave[url], site);
  const stoppedByHush = new Set([...c].filter((d) => !s.has(d)));
  const stoppedByBrave = new Set([...c].filter((d) => !b.has(d)));
  const hushLeaks = [...s].filter((d) => stoppedByBrave.has(d));
  const braveLeaks = [...b].filter((d) => stoppedByHush.has(d));
  const eff = (r) => r.requests.length - r.blocked.length;
  const row = {
    site: siteOf(url),
    requests: { chrome: eff(results.chrome[url]), hush: eff(results.hush[url]), brave: eff(results.brave[url]) },
    thirdPartyDomains: { chrome: c.size, hush: s.size, brave: b.size },
    visibleAds: { chrome: results.chrome[url].visibleAds, hush: results.hush[url].visibleAds, brave: results.brave[url].visibleAds },
    hushLeaks, braveLeaks,
  };
  summary.push(row);
  const r = row.requests, d = row.thirdPartyDomains, a = row.visibleAds;
  console.log(`  ${row.site.padEnd(24)} requests ${r.chrome}/${r.hush}/${r.brave}  third-party domains ${d.chrome}/${d.hush}/${d.brave}  ads ${a.chrome}/${a.hush}/${a.brave}   (chrome/hush/brave)`);
  if (hushLeaks.length) console.log(`      only Hush let through:  ${hushLeaks.slice(0, 10).join(', ')}`);
  if (braveLeaks.length) console.log(`      only Brave let through: ${braveLeaks.slice(0, 10).join(', ')}`);
}
await writeFile(new URL('../.bench/results.json', import.meta.url), JSON.stringify({ when: new Date().toISOString(), summary }, null, 2));
