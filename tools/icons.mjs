// Generates the PNG icons from SVG, rendered with Playwright's Chromium.
// Run: node tools/icons.mjs

import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const shield = (fill, mark) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <path d="M64 6 L112 22 V60 C112 92 91 112 64 122 C37 112 16 92 16 60 V22 Z" fill="${fill}"/>
  <path d="M64 18 L101 30.5 V60 C101 85 85 101 64 109.5 Z" fill="#000" opacity=".12"/>
  <path d="M42 64 L58 80 L88 48" fill="none" stroke="${mark}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const variants = { '': shield('#f97316', '#fff'), '-off': shield('#9ca3af', '#fff') };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage();
for (const [suffix, svg] of Object.entries(variants)) {
  for (const size of [16, 32, 48, 128]) {
    if (suffix && size > 32) continue;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${size}" height="${size}">`);
    const png = await page.screenshot({ omitBackground: true });
    await writeFile(new URL(`../src/icons/${size}${suffix}.png`, import.meta.url), png);
  }
}
await browser.close();
console.log('icons generated');
