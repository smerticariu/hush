// The https://adblock-tester.com/ score for Chrome, Hush and Brave.
// Run: node tools/test-adblock-tester.mjs

import { launch, BRAVE } from './browser.mjs';

const braveProfile = new URL('../.bench/brave-profile', import.meta.url).pathname;

async function score(name, opts) {
  const { context, sw } = await launch(opts);
  if (sw) await new Promise((r) => setTimeout(r, 4000));
  const page = await context.newPage();
  await page.goto('https://adblock-tester.com/', { waitUntil: 'load', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(25000);
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  // each test shows "test passed" / "test failed"; the header score is unreliable
  const passed = (text.match(/test (?:has most likely )?passed/gi) || []).length;
  const failed = (text.match(/test (?:has most likely )?failed/gi) || []).length;
  const failedNames = await page.evaluate(() => [...document.querySelectorAll('*')]
    .filter((e) => e.children.length === 0 && /test (has most likely )?failed/i.test(e.textContent))
    .map((e) => e.closest('div')?.parentElement?.querySelector('h3, h4, b, strong')?.textContent?.trim()).filter(Boolean));
  console.log(`${name.padEnd(6)} passed ${passed}, failed ${failed}${failed ? '  → ' + [...new Set(failedNames)].join(', ') : ''}`);
  await page.screenshot({ path: `.bench/tester-${name}.jpg`, quality: 50, fullPage: true });
  await context.close();
}

await score('chrome', { extension: false });
await score('hush', {});
await score('brave', { extension: false, executablePath: BRAVE, profile: braveProfile });
