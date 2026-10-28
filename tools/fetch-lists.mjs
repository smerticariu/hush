// Downloads the filter lists into lists/, with `!#include` directives already expanded.
// Run: node tools/fetch-lists.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import { LISTS, QUERY_FILTER } from './lists.mjs';

const OUT = new URL('../lists/', import.meta.url);

async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 Hush-build' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function expand(url, seen = new Set()) {
  if (seen.has(url)) return '';
  seen.add(url);
  const text = await download(url);
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^!#include\s+(\S+)/);
    if (m) {
      // uBO only accepts same-origin includes
      const child = new URL(m[1], url).href;
      out.push(await expand(child, seen));
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

await mkdir(OUT, { recursive: true });
const meta = {};
await Promise.all(LISTS.filter((l) => l.url).map(async (list) => {
  try {
    const text = await expand(list.url);
    await writeFile(new URL(`${list.id}.txt`, OUT), text);
    meta[list.id] = { url: list.url, lines: text.split('\n').length, fetched: new Date().toISOString() };
    console.log(`✓ ${list.id.padEnd(20)} ${meta[list.id].lines} lines`);
  } catch (err) {
    console.error(`✗ ${list.id}: ${err.message}`);
    process.exitCode = 1;
  }
}));
await writeFile(new URL('brave-query-filter.json', OUT), await download(QUERY_FILTER));
await writeFile(new URL('meta.json', OUT), JSON.stringify(meta, null, 2));
