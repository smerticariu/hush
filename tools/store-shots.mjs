// Chrome Web Store images: 3 screenshots at 1280×800 and the 440×280 promo tile.
// Run: node tools/store-shots.mjs   →  store/*.png

import { mkdir, readFile, writeFile, cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, DIST } from './browser.mjs';

// copy of the extension with declarativeNetRequestFeedback, so the popup shows the counter
// without a click on the icon (in the published extension activeTab grants it)
const shotDist = await mkdtemp(join(tmpdir(), 'hush-shots-'));
await cp(DIST, shotDist, { recursive: true });
const m = JSON.parse(await readFile(join(shotDist, 'manifest.json'), 'utf8'));
m.permissions.push('declarativeNetRequestFeedback');
await writeFile(join(shotDist, 'manifest.json'), JSON.stringify(m));

const OUT = new URL('../store/', import.meta.url);
await mkdir(OUT, { recursive: true });
const SITE = 'https://www.gsp.ro/';
const b64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const icon = b64(await readFile(new URL('../src/icons/128.png', import.meta.url)));

async function shootSite(extension) {
  const { context, sw } = await launch({ extension, dist: shotDist });
  if (sw) await new Promise((r) => setTimeout(r, 4000));
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(SITE, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
  // the cookie banner, so the page loads its ads (without Hush)
  await page.waitForTimeout(1500);
  for (const f of page.frames()) {
    await f.evaluate(() => {
      for (const b of document.querySelectorAll('button')) if (/^(accept|accepta|accept all|sunt de acord)/i.test(b.innerText.trim())) { b.click(); return; }
    }).catch(() => {});
  }
  await page.waitForTimeout(6000);
  await page.mouse.wheel(0, 650);
  await page.waitForTimeout(2500);
  const shot = await page.screenshot();
  let popup = null;
  let options = null;
  if (sw) {
    const id = new URL(sw.url()).host;
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => /gsp\.ro/.test(t.url))?.id);
    const p = await context.newPage();
    await p.setViewportSize({ width: 320, height: 470 });
    await p.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
    await p.waitForTimeout(800);
    popup = await p.screenshot();
    // sample history so the 30-day chart isn't a single bar (clearly a UI demo, test profile only)
    await sw.evaluate(async () => {
      const s = await self.hush.stats.get();
      const d = new Date();
      for (let i = 1; i < 30; i++) {
        d.setDate(d.getDate() - 1);
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const ads = 140 + ((i * 37) % 180);
        const trackers = Math.round(ads * (0.55 + ((i * 13) % 40) / 100));
        s.days[k] = { ads, trackers, threats: i % 11 === 0 ? 1 : 0, cleaned: i % 4 };
        s.total.ads += ads; s.total.trackers += trackers; s.total.threats += s.days[k].threats; s.total.cleaned += i % 4;
      }
      s.since = d.getTime();
      await chrome.storage.local.set({ stats: s });
    });
    const o = await context.newPage();
    await o.setViewportSize({ width: 1100, height: 760 });
    await o.goto(`chrome-extension://${id}/dashboard/dashboard.html`);
    await o.waitForTimeout(800);
    options = await o.screenshot();
  }
  await context.close();
  return { shot, popup, options };
}

const plain = await shootSite(false);
const hush = await shootSite(true);

const { context } = await launch({ extension: false });
const page = await context.newPage();

const frame = (title, sub, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111827;
    background: linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%); }
  header { padding: 44px 64px 0; }
  h1 { margin: 0; font-size: 44px; letter-spacing: -.02em; }
  p.sub { margin: 10px 0 0; font-size: 22px; color: #9a3412; }
  .stage { position: absolute; left: 64px; right: 64px; top: 190px; bottom: 0; }
  .shot { border-radius: 14px 14px 0 0; box-shadow: 0 20px 60px rgba(124, 45, 18, .25); display: block; }
  .tag { position: absolute; top: 14px; left: 14px; padding: 6px 12px; border-radius: 8px; font-weight: 700; font-size: 16px; color: #fff; }
</style></head><body><header><h1>${title}</h1><p class="sub">${sub}</p></header><div class="stage">${body}</div></body></html>`;

// 1. before / after
await page.setViewportSize({ width: 1280, height: 800 });
await page.setContent(frame('No ads. No trackers.', 'Pages load cleaner and faster, with nothing following you around.', `
  <div style="display:flex;gap:24px;height:100%">
    <div style="position:relative;flex:1;overflow:hidden;border-radius:14px 14px 0 0"><img class="shot" src="${b64(plain.shot)}" style="width:100%;height:100%;object-fit:cover;object-position:top"><span class="tag" style="background:#6b7280">Without Hush</span></div>
    <div style="position:relative;flex:1;overflow:hidden;border-radius:14px 14px 0 0"><img class="shot" src="${b64(hush.shot)}" style="width:100%;height:100%;object-fit:cover;object-position:top"><span class="tag" style="background:#f97316">With Hush</span></div>
  </div>`));
await page.screenshot({ path: new URL('screenshot-1.png', OUT).pathname });

// 2. popup over the site
await page.setContent(frame('One click to pause on any site', 'See how much was blocked and hide anything that slips through.', `
  <div style="position:relative;height:100%;overflow:hidden;border-radius:14px 14px 0 0">
    <img class="shot" src="${b64(hush.shot)}" style="width:100%;filter:brightness(.92)">
    <img src="${b64(hush.popup)}" style="position:absolute;top:24px;right:32px;width:300px;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.35)">
  </div>`));
await page.screenshot({ path: new URL('screenshot-2.png', OUT).pathname });

// 3. dashboard
await page.setContent(frame('See everything Hush blocks', 'Daily stats, the sites that track you most, and the time and data you save.', `
  <div style="display:flex;justify-content:center;height:100%"><img class="shot" src="${b64(hush.options)}" style="height:100%"></div>`));
await page.screenshot({ path: new URL('screenshot-3.png', OUT).pathname });

// promo tile 440×280
await page.setViewportSize({ width: 440, height: 280 });
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 440px; height: 280px; }
  body { display: flex; align-items: center; gap: 22px; padding: 0 36px; box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: linear-gradient(135deg, #f97316, #c2410c); color: #fff; }
  h1 { margin: 0; font-size: 46px; letter-spacing: -.02em; }
  p { margin: 6px 0 0; font-size: 17px; opacity: .92; line-height: 1.35; }
  .tile { width: 124px; height: 124px; flex: none; border-radius: 28px; background: #fff; display: grid; place-items: center;
    box-shadow: 0 12px 28px rgba(0,0,0,.25); }
  .tile img { width: 92px; height: 92px; }
</style></head><body><div class="tile"><img src="${icon}"></div><div><h1>Hush</h1><p>Blocks ads<br>and trackers.</p></div></body></html>`);
await page.screenshot({ path: new URL('promo-440x280.png', OUT).pathname });

await context.close();
console.log('store/: screenshot-1..3.png, promo-440x280.png');
