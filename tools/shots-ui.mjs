// Screenshots of the popup and the dashboard (light + dark), for checking the UI.
// Browses a few real sites first, then adds 30 days of sample history so the
// chart has something to draw (test profile only).
// Run: node tools/shots-ui.mjs   →  .bench/ui-*.png

import { launch } from './browser.mjs';

const { context, sw } = await launch({});
await new Promise((r) => setTimeout(r, 4000));
const id = new URL(sw.url()).host;

const site = await context.newPage();
for (const url of ['https://www.libertatea.ro/', 'https://www.speedtest.net/', 'https://www.gsp.ro/']) {
  await site.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
  await site.waitForTimeout(4000);
}
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => /gsp\.ro/.test(t.url))?.id);

await sw.evaluate(async () => {
  await self.hush.saveSettings({ disabledSites: ['example.com', 'my-bank.com'], userFilters: 'gsp.ro##.top-banner\n||ads.example.com^\n' });
  const s = await self.hush.stats.get();
  const d = new Date();
  for (let i = 1; i < 30; i++) {
    d.setDate(d.getDate() - 1);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ads = Math.round(120 + Math.random() * 260 * (d.getDay() % 6 ? 1 : 0.4));
    const trackers = Math.round(ads * (0.5 + Math.random() * 0.6));
    s.days[k] = { ads, trackers, threats: Math.random() < 0.1 ? 1 : 0, cleaned: Math.round(Math.random() * 6) };
    s.total.ads += ads; s.total.trackers += trackers; s.total.cleaned += s.days[k].cleaned;
  }
  s.since = d.getTime();
  await chrome.storage.local.set({ stats: s });
});

for (const scheme of ['light', 'dark']) {
  const p = await context.newPage();
  await p.emulateMedia({ colorScheme: scheme });
  await p.setViewportSize({ width: 320, height: 470 });
  await p.goto(`chrome-extension://${id}/popup/popup.html?tab=${tabId}`);
  await p.waitForTimeout(1000);
  await p.screenshot({ path: `.bench/ui-popup-${scheme}.png` });
  const o = await context.newPage();
  await o.emulateMedia({ colorScheme: scheme });
  await o.setViewportSize({ width: 1280, height: 1100 });
  await o.goto(`chrome-extension://${id}/dashboard/dashboard.html?welcome=1`);
  await o.waitForTimeout(1000);
  await o.screenshot({ path: `.bench/ui-dashboard-${scheme}.png` });
  if (scheme === 'light') {
    await o.goto(`chrome-extension://${id}/dashboard/dashboard.html#protection`);
    await o.waitForTimeout(600);
    await o.screenshot({ path: '.bench/ui-protection.png' });
    // hover a bar to see the tooltip
    await o.goto(`chrome-extension://${id}/dashboard/dashboard.html`);
    await o.waitForTimeout(800);
    const box = await o.locator('#chart').boundingBox();
    await o.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7);
    await o.waitForTimeout(300);
    await o.screenshot({ path: '.bench/ui-tooltip.png', clip: { x: box.x - 20, y: box.y - 80, width: box.width + 40, height: box.height + 100 } });
    await o.setViewportSize({ width: 390, height: 900 });
    await o.waitForTimeout(400);
    await o.screenshot({ path: '.bench/ui-mobile.png' });
  }
}
await context.close();
