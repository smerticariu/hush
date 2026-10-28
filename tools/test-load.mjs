// Checks that the extension loads: rulesets enabled, scriptlets registered,
// no errors in the service worker.

import { launch } from './browser.mjs';

const { context, sw } = await launch();
const errors = [];
sw.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// let onInstalled finish syncing
await new Promise((r) => setTimeout(r, 4000));
const state = await sw.evaluate(async () => ({
  rulesets: await chrome.declarativeNetRequest.getEnabledRulesets(),
  available: await chrome.declarativeNetRequest.getAvailableStaticRuleCount(),
  scripts: (await chrome.scripting.getRegisteredContentScripts()).map((s) => `${s.id} (${s.matches.length})`),
  dynamic: (await chrome.declarativeNetRequest.getDynamicRules()).length,
}));
console.log(JSON.stringify(state, null, 2));
if (errors.length) console.log('ERRORS:', errors);
await context.close();
