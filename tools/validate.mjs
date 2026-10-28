// Loads dist/ in Chrome and reports the DNR rules rejected at load time.
// Chrome stops at the first bad rule, so we remove it from a copy and try
// again until it loads. Run: node tools/validate.mjs

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROME, DIST } from './browser.mjs';

const copy = await mkdtemp(join(tmpdir(), 'hush-validate-'));
await cp(DIST, copy, { recursive: true });

function tryLoad() {
  return new Promise((resolve) => {
    const profile = join(copy, '..', `profile-${Date.now()}`);
    const sandbox = process.platform === 'linux' ? ['--no-sandbox'] : [];
    const proc = spawn(CHROME, ['--headless=new', ...sandbox, `--user-data-dir=${profile}`, '--enable-logging=stderr', '--v=0',
      `--disable-extensions-except=${copy}`, `--load-extension=${copy}`, 'about:blank']);
    let log = '';
    const done = (v) => { clearTimeout(t); proc.kill('SIGKILL'); rm(profile, { recursive: true, force: true }); resolve(v); };
    proc.stderr.on('data', (d) => {
      log += d;
      const m = log.match(/Failed to load extension from: [^.]+\. (.+)/);
      if (m) done(m[1]);
    });
    const t = setTimeout(() => done(null), 8000);
  });
}

const bad = [];
for (let i = 0; i < 200; i++) {
  const err = await tryLoad();
  if (!err) break;
  const m = err.match(/^(\S+\.json): Rule with id (\d+) (.+)$/);
  if (!m) { console.log('error:', err); process.exit(1); }
  const file = join(copy, 'rules', m[1]);
  const rules = JSON.parse(await readFile(file, 'utf8'));
  const idx = rules.findIndex((r) => r.id === +m[2]);
  bad.push({ file: m[1], reason: m[3], rule: rules[idx] });
  rules.splice(idx, 1);
  await writeFile(file, JSON.stringify(rules));
}
await rm(copy, { recursive: true, force: true });
for (const b of bad) console.log(`${b.file} — ${b.reason}\n   ${JSON.stringify(b.rule.condition)}`);
console.log(bad.length ? `${bad.length} rules rejected` : 'all rules are valid');
process.exit(bad.length ? 1 : 0);
