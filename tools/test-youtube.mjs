// Checks YouTube ads: the player data (adPlacements / playerAds)
// and whether the player enters ad mode (.ad-showing).
// Run: node tools/test-youtube.mjs

import { launch } from './browser.mjs';

const VIDEOS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=kJQP7kiw5Fk',
  'https://www.youtube.com/watch?v=9bZkp7q19f0',
];

async function consent(page) {
  if (!/consent\./.test(page.url())) return;
  const btn = page.locator('button', { hasText: /Accept all|Acceptă tot|Accepta tot|Reject all|Respinge tot/i }).first();
  await btn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForURL(/youtube\.com\/watch/, { timeout: 15000 }).catch(() => {});
}

async function check(name, opts) {
  const { context, sw } = await launch(opts);
  if (sw) await new Promise((r) => setTimeout(r, 4000));
  for (const url of VIDEOS) {
    const page = await context.newPage();
    const adRequests = [];
    page.on('request', (r) => { if (/doubleclick\.net|\/pagead\/|\/api\/stats\/ads|\/ptracking/.test(r.url())) adRequests.push(r.url()); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await consent(page);
    await page.waitForTimeout(4000);
    // start playback (headless won't autoplay with sound)
    await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(() => {}); } }).catch(() => {});
    let adShowing = false;
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1000);
      adShowing ||= await page.evaluate(() => !!document.querySelector('.html5-video-player.ad-showing, .ytp-ad-player-overlay, .ytp-ad-text')).catch(() => false);
    }
    const data = await page.evaluate(() => {
      const r = window.ytInitialPlayerResponse;
      return {
        title: document.title,
        adPlacements: r?.adPlacements?.length ?? 0,
        playerAds: r?.playerAds?.length ?? 0,
        adSlots: r?.adSlots?.length ?? 0,
        playing: (() => { const v = document.querySelector('video'); return v ? v.currentTime > 0 : false; })(),
      };
    }).catch((e) => ({ error: e.message }));
    console.log(`  ${name.padEnd(6)} ${url.slice(-11)}  adPlacements=${data.adPlacements} playerAds=${data.playerAds} adSlots=${data.adSlots}  ad-showing=${adShowing}  playing=${data.playing}  ad-requests=${adRequests.length}  (${data.title?.slice(0, 40)})`);
    await page.close();
  }
  await context.close();
}

await check('chrome', { extension: false });
await check('hush', {});
