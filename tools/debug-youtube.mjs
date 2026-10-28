// YouTube debugging: turns off parts of the extension and checks whether the page works.
// Run: node tools/debug-youtube.mjs [full|noscriptlets|norules|onlycosmetic|only:id1,id2]

import { launch } from './browser.mjs';
const mode = process.argv[2];
const { context, sw } = await launch({});
await new Promise((r) => setTimeout(r, 4000));
await sw.evaluate(async (mode) => {
  if (mode === 'noscriptlets' || mode === 'onlycosmetic') {
    const s = await chrome.scripting.getRegisteredContentScripts();
    await chrome.scripting.unregisterContentScripts({ ids: s.map((x) => x.id) });
  }
  if (mode === 'norules' || mode === 'onlycosmetic') {
    const r = await chrome.declarativeNetRequest.getEnabledRulesets();
    await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: r });
  }
  if (mode?.startsWith('only:')) {
    const keep = mode.slice(5).split(',');
    const s = await chrome.scripting.getRegisteredContentScripts();
    await chrome.scripting.unregisterContentScripts({ ids: s.map((x) => x.id).filter((id) => !keep.includes(id)) });
  }
}, mode);
const page = await context.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message.slice(0, 150)));
await page.goto('https://www.youtube.com/watch?v=kJQP7kiw5Fk', { waitUntil: 'domcontentloaded' });
if (/consent\./.test(page.url())) {
  await page.locator('button', { hasText: /Accept all|Acceptă tot|Reject all|Respinge tot/i }).first().click().catch(() => {});
  await page.waitForURL(/watch/).catch(() => {});
}
await page.waitForTimeout(8000);
const st = await page.evaluate(() => ({ video: !!document.querySelector('video'), ads: window.ytInitialPlayerResponse?.adPlacements?.length ?? 0 }));
console.log(mode || 'full', JSON.stringify(st), errs.join(' | '));
await context.close();
