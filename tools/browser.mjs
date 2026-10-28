// Launches Chrome for Testing (Playwright) with the extension from dist/ loaded.

import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIST = fileURLToPath(new URL('../dist', import.meta.url));
export const CHROME = process.env.CHROME_PATH
  || join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
export const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';

// Regular Chrome UA: many sites reject "HeadlessChrome"
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export async function launch({ extension = true, executablePath = CHROME, headless = true, profile, dist = DIST } = {}) {
  const dir = profile || await mkdtemp(join(tmpdir(), 'hush-profile-'));
  const args = ['--no-first-run', '--no-default-browser-check', '--lang=en-US'];
  if (extension) args.push(`--disable-extensions-except=${dist}`, `--load-extension=${dist}`);
  const context = await chromium.launchPersistentContext(dir, {
    executablePath,
    headless,
    args,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    userAgent: UA,
    // Brave needs the component updater to download its filter lists
    ignoreDefaultArgs: ['--disable-component-update', ...(extension ? ['--disable-extensions'] : [])],
  });
  let sw = null;
  if (extension) {
    sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  return { context, sw };
}
