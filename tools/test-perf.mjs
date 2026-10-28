// Cost of the data the service worker loads at startup (per chunk).
// Run: node tools/test-perf.mjs

import { launch } from './browser.mjs';

const { context, sw } = await launch({});
await new Promise((r) => setTimeout(r, 4000));
const t = await sw.evaluate(async () => {
  const time = async (url) => {
    const s = performance.now();
    const txt = await fetch(url).then((r) => r.text());
    JSON.parse(txt);
    return `${(performance.now() - s).toFixed(1)}ms (${(txt.length / 1024).toFixed(0)}KB)`;
  };
  return {
    core: await time('/data/cosmetic-core.json'),
    shard: await time('/data/cosmetic-specific-7.json'),
    generic: await time('/data/cosmetic-generic.json'),
  };
});
console.log(t);
await context.close();
