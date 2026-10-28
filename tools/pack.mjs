// Zips dist/ for the Chrome Web Store: release/hush-<version>.zip
// Run: node tools/pack.mjs   (after build)

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
await mkdir(`${ROOT}release`, { recursive: true });
const zip = `${ROOT}release/hush-${version}.zip`;
await rm(zip, { force: true });
execFileSync('zip', ['-qr9', '-X', zip, '.', '-x', '.*', '*/.*'], { cwd: `${ROOT}dist` });
console.log(zip);
